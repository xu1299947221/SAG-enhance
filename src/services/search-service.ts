import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import { embeddingClient, type EmbeddingClient } from "../ai/embedding-client.js";
import { llmClient, type LlmClient } from "../ai/llm-client.js";
import { rerankClient, type RerankClient } from "../ai/rerank-client.js";
import { MAX_SEARCH_TOP_K, aiSettingsService } from "./ai-settings-service.js";
import { expandBiddingQuery, extractBiddingDomainEntities } from "../domain/bidding-domain.js";
import {
  assertSourcesAccessible,
  coarseRankEventsByContent,
  getEntitiesByIds,
  getEdgesForSections,
  getEventIdsByEntityIds,
  getEventsWithEntityIds,
  getRelationConfig,
  getSectionsForKnowledgeEdges,
  getSectionsForEvents,
  searchChunksByVector,
  searchEntitiesByName,
  searchEntitiesByText,
  searchEntitiesByVector,
  searchEventsByTitleVector
} from "../db/repositories.js";
import { graphStore } from "./graph-store.js";
import { normalizeRelation } from "../domain/relation-ontology.js";
import type {
  EntityRecord,
  EventRecord,
  MultiSubStrategy,
  SearchInput,
  SearchProgressEvent,
  SearchResult,
  SearchResultWhy,
  SearchSection,
  SearchTrace,
  SearchTraceEvent
} from "../types.js";

interface MultiOptions {
  subStrategy: MultiSubStrategy;
  entityTopK: number;
  multiTopK: number;
  keySimilarityThreshold: number;
  similarityThreshold: number;
  maxHops: number;
  maxEvents: number;
  maxEventsA: number;
  maxEventsB: number;
  maxHopRetries: number;
  rerankTopK: number;
  maxSections: number;
}

type SearchProgressEmitter = (event: SearchProgressEvent) => void;
const MAX_SEARCH_RESULTS = MAX_SEARCH_TOP_K;

export class SearchService {
  constructor(
    private readonly embeddings: EmbeddingClient = embeddingClient,
    private readonly llm: LlmClient = llmClient,
    private readonly reranker: RerankClient = rerankClient
  ) {}

  async search(input: SearchInput, tenantId = config.DEFAULT_TENANT_ID, emit?: SearchProgressEmitter): Promise<SearchResult> {
    const strategy = input.strategy ?? "multi";
    if (strategy !== "vector" && strategy !== "multi") {
      throw new Error(`Unsupported search strategy: ${String(strategy)}`);
    }

    await assertSourcesAccessible(input.sourceIds, tenantId);
    if (strategy === "vector") {
      return this.vectorSearch(input, emit);
    }
    return this.multiSearch(input, tenantId, emit);
  }

  async vectorSearch(input: SearchInput, emit?: SearchProgressEmitter): Promise<SearchResult> {
    const runtimeSettings = await aiSettingsService.getRuntimeSettings();
    const topK = resolveFinalSearchTopK(input.multi?.maxSections ?? input.topK ?? runtimeSettings.defaultSearchTopK);
    const traceId = randomUUID();
    const timings: Record<string, number> = {};
    const queryVector = await timed(timings, "queryEmbedding", () => this.embeddings.generate(input.query), emit, {
      title: "查询向量化",
      detail: "把用户问题转成向量，用于向量召回。"
    });
    const sections = await timed(timings, "vectorSearchChunks", () => searchChunksByVector({
      sourceIds: input.sourceIds,
      queryVector,
      topK
    }), emit, {
      title: "向量召回切片",
      detail: "按查询向量召回最相近的文档切片。"
    });
    return {
      traceId,
      sections: sections.slice(0, topK).map((section) => ({ ...section }))
    };
  }

  async multiSearch(input: SearchInput, tenantId = config.DEFAULT_TENANT_ID, emit?: SearchProgressEmitter): Promise<SearchResult> {
    const runtimeSettings = await aiSettingsService.getRuntimeSettings();
    const relationConfigs = await Promise.all(input.sourceIds.map((sourceId) => getRelationConfig({ sourceId, tenantId }).catch(() => null)));
    const options = resolveMultiOptions(input, runtimeSettings.defaultSearchTopK);
    const searchMode = input.searchMode ?? runtimeSettings.defaultSearchMode;
    const traceId = randomUUID();
    const timings: Record<string, number> = {};
    const trace: SearchTrace = {
      traceId,
      query: input.query,
      searchMode,
      relationIntent: inferRelationIntent(input.query, input.relationTypes),
      queryEntities: [],
      recalledEntities: [],
      entityEventIds: [],
      queryEventIds: [],
      expandedEventIds: [],
      coarseRankedEventIds: [],
      rerankedEventIds: [],
      timings
    };

    const queryVector = await timed(timings, "queryEmbedding", () => this.embeddings.generate(input.query), emit, {
      title: "查询向量化",
      detail: "把用户问题转成向量，用于召回相关事件和切片。"
    });
    const configuredEntityAliases = relationConfigs.flatMap((item) => {
      if (!item) return [];
      return Object.entries(item.entityAliases).flatMap(([alias, canonical]) => [alias, canonical]);
    });
    const configuredRelationAliases = relationConfigs.flatMap((item) => {
      if (!item) return [];
      return Object.entries(item.relationAliases).flatMap(([type, aliases]) => [type, ...aliases]);
    });
    const expandedQueryEntities = expandBidQueryEntities(input.query, runtimeSettings.biddingDomainConfig);
    const domainQueryEntities = extractBiddingDomainEntities(input.query, runtimeSettings.biddingDomainConfig);
    const expandedTextQuery = buildExpandedTextQuery(input.query, [
      ...expandedQueryEntities,
      ...configuredEntityAliases,
      ...configuredRelationAliases
    ]);

    let queryEntities: string[] = [];
    let recalledEntities: EntityRecord[] = [];
    if (searchMode === "fast") {
      recalledEntities = await timed(timings, "step1Bm25Entities", () => searchEntitiesByText({
        sourceIds: input.sourceIds,
        query: expandedTextQuery,
        limit: options.entityTopK
      }), emit, {
        title: "BM25 匹配查询实体",
        detail: "直接用用户问题和应标同义词在实体库做全文/BM25 匹配，不调用 LLM 抽取 key。"
      });
      queryEntities = unique([...domainQueryEntities, ...expandedQueryEntities, ...configuredEntityAliases, ...recalledEntities.map((entity) => entity.name)]);
      if (recalledEntities.length === 0) {
        const vectorEntities = await timed(timings, "step1VectorEntities", () => searchEntitiesByVector({
          sourceIds: input.sourceIds,
          queryVector,
          topK: options.entityTopK,
          threshold: Math.min(options.keySimilarityThreshold, 0.72)
        }), emit, {
          title: "向量召回查询实体",
          detail: "BM25 没有命中时，使用用户问题向量直接召回图谱实体。"
        });
        recalledEntities = dedupeEntities(vectorEntities);
        queryEntities = unique([...queryEntities, ...recalledEntities.map((entity) => entity.name)]);
      }
      trace.queryEntities = queryEntities;
      emitSearchStep(emit, timings, "step1Bm25Entities", {
        title: "BM25 匹配查询实体",
        detail: recalledEntities.length === 0 ? "没有匹配到查询实体" : `匹配到 ${recalledEntities.length} 个查询实体`,
        payload: recalledEntities.map((entity) => ({
          id: entity.id,
          name: entity.name,
          type: entity.type,
          score: entity.score ?? 0
        }))
      });
    } else {
      queryEntities = await timed(timings, "step1ExtractEntities", () => this.llm.extractNamedEntities(input.query), emit, {
        title: "抽取查询实体",
        detail: "识别用户问题中的关键实体。"
      });
      queryEntities = unique([...domainQueryEntities, ...queryEntities, ...expandedQueryEntities, ...configuredEntityAliases]);
      trace.queryEntities = queryEntities;
      emitSearchStep(emit, timings, "step1ExtractEntities", {
        title: "抽取查询实体",
        detail: queryEntities.length === 0 ? "没有识别到查询实体" : `识别/扩展到 ${queryEntities.length} 个查询实体`,
        payload: queryEntities
      });

      recalledEntities = await timed(timings, "step2RetrieveEntities", async () => {
        const exact = await searchEntitiesByName({
          sourceIds: input.sourceIds,
          names: queryEntities,
          limit: options.entityTopK
        });
        const byVector: EntityRecord[] = [];
        for (const entityName of queryEntities) {
          const vector = await this.embeddings.generate(entityName);
          byVector.push(...await searchEntitiesByVector({
            sourceIds: input.sourceIds,
            queryVector: vector,
            topK: options.entityTopK,
            threshold: options.keySimilarityThreshold
          }));
        }
        return dedupeEntities([...exact, ...byVector]);
      }, emit, {
        title: "召回相关实体",
        detail: "按实体名称和实体向量召回相关实体。"
      });
    }
    trace.recalledEntities = recalledEntities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      score: entity.score ?? 0
    }));
    if (searchMode !== "fast") {
      emitSearchStep(emit, timings, "step2RetrieveEntities", {
        title: "召回相关实体",
        detail: `召回 ${trace.recalledEntities.length} 个实体`,
        payload: trace.recalledEntities
      });
    }

    const entityEventIds = await timed(timings, "step3EntityEvents", () => getEventIdsByEntityIds({
      entityIds: recalledEntities.map((entity) => entity.id),
      sourceIds: input.sourceIds
    }), emit, {
      title: "实体关联事件",
      detail: "读取召回实体关联的候选事件。"
    });
    trace.entityEventIds = entityEventIds;
    emitSearchStep(emit, timings, "step3EntityEvents", {
      title: "实体关联事件",
      detail: `找到 ${entityEventIds.length} 个实体关联事件`
    });

    const queryEvents = await timed(timings, "step3QueryEvents", () => searchEventsByTitleVector({
      sourceIds: input.sourceIds,
      queryVector,
      topK: options.multiTopK * 3,
      threshold: options.similarityThreshold
    }).then((events) => events.slice(0, options.multiTopK)), emit, {
      title: "标题向量召回事件",
      detail: "按查询向量召回标题相关事件。"
    });
    trace.queryEventIds = queryEvents.map((event) => event.id);
    trace.queryEvents = toTraceEvents(queryEvents);
    appendEventSnapshots(trace, trace.queryEvents);
    emitSearchStep(emit, timings, "step3QueryEvents", {
      title: "标题向量召回事件",
      detail: `召回 ${trace.queryEvents.length} 个标题相关事件`,
      payload: trace.queryEvents
    });

    const disabledRelations = new Set(relationConfigs.flatMap((item) => item?.disabledRelations ?? []));
    const relationTypes = normalizeRelationTypes(input.relationTypes ?? trace.relationIntent ?? []).filter((type) => !disabledRelations.has(type));
    const configuredMinConfidence = Math.max(0, ...relationConfigs.flatMap((item) => Object.values(item?.minConfidence ?? {}).filter((value): value is number => typeof value === "number")));
    const minEdgeConfidence = input.minEdgeConfidence ?? Math.max(0.65, configuredMinConfidence);
    const useGraphPaths = input.useGraphPaths ?? true;
    const recalledEdges = await timed(timings, "step3KnowledgeEdges", () => graphStore.searchEdges({
      sourceIds: input.sourceIds,
      query: expandedTextQuery,
      entityIds: recalledEntities.map((entity) => entity.id),
      eventIds: unique([...entityEventIds, ...queryEvents.map((event) => event.id)]),
      relationTypes,
      minConfidence: minEdgeConfidence,
      limit: Math.min(options.entityTopK, 20)
    }), emit, {
      title: "强关系召回",
      detail: "按查询、实体和候选事件召回 subject-relation-object 强关系边。"
    });
    trace.recalledEdges = recalledEdges;
    const graphPaths = useGraphPaths
      ? await timed(timings, "step3GraphPaths", () => graphStore.expandPaths({
          sourceIds: input.sourceIds,
          seedEntityIds: unique([
            ...recalledEntities.map((entity) => entity.id),
            ...recalledEdges.flatMap((edge) => [edge.subjectEntityId, edge.objectEntityId])
          ]),
          relationTypes,
          minConfidence: minEdgeConfidence,
          maxDepth: Math.max(1, Math.min(options.maxHops || 2, 3)),
          limit: Math.min(options.entityTopK, 20)
        }), emit, {
          title: "关系路径扩展",
          detail: "沿强关系边扩展 1-3 跳路径，并保留证据链。"
        })
      : [];
    trace.graphPaths = graphPaths;
    trace.explanation = {
      recallTypes: [
        ...(recalledEntities.length > 0 ? ["entity"] : []),
        ...(recalledEdges.length > 0 ? ["knowledge_edge"] : []),
        ...(graphPaths.length > 0 ? ["graph_path"] : []),
        ...(queryEvents.length > 0 ? ["vector_event"] : [])
      ],
      edgeCount: recalledEdges.length,
      pathCount: graphPaths.length
    };
    emitSearchStep(emit, timings, "step3KnowledgeEdges", {
      title: "强关系召回",
      detail: recalledEdges.length === 0 ? "没有召回强关系边" : `召回 ${recalledEdges.length} 条强关系边`,
      payload: recalledEdges.map((edge) => ({
        id: edge.id,
        subject: edge.subjectName,
        relation: edge.relationLabel,
        relationType: edge.relationType,
        object: edge.objectName,
        confidence: edge.confidence,
        score: edge.score ?? 0,
        eventId: edge.eventId
      }))
    });
    if (useGraphPaths) {
      emitSearchStep(emit, timings, "step3GraphPaths", {
        title: "关系路径扩展",
        detail: graphPaths.length === 0 ? "没有扩展出强关系路径" : `扩展出 ${graphPaths.length} 条强关系路径`,
        payload: graphPaths.map((path) => ({
          reason: path.reason,
          score: path.score,
          evidence: path.evidence
        }))
      });
    }

    const relationEventIds = recalledEdges
      .map((edge) => edge.eventId)
      .filter((id): id is string => Boolean(id));
    const pathEventIds = graphPaths
      .flatMap((path) => path.edges.map((edge) => edge.eventId))
      .filter((id): id is string => Boolean(id));
    const seedEventIds = unique([...entityEventIds, ...queryEvents.map((event) => event.id), ...relationEventIds, ...pathEventIds]);
    if (seedEventIds.length === 0) {
      trace.fallbackReason = "no seed events; used vector chunk search";
      emitSearchStep(emit, timings, "fallback", {
        title: "降级路径",
        detail: trace.fallbackReason
      });
      const fallback = await this.vectorSearch({ ...input, strategy: "vector", topK: options.maxSections }, emit);
      return { ...fallback, trace: input.returnTrace ? trace : undefined };
    }

    const seedEvents = await timed(timings, "step4FetchDetails", () => getEventsWithEntityIds(seedEventIds), emit, {
      title: "读取候选事件详情",
      detail: "读取候选事件及其关联实体。"
    });
    trace.entityEvents = idsToTraceEvents(entityEventIds, seedEvents);
    appendEventSnapshots(trace, trace.entityEvents);
    emitSearchStep(emit, timings, "step4FetchDetails", {
      title: "读取候选事件详情",
      detail: `读取 ${seedEvents.size} 个候选事件详情`,
      payload: toTraceEvents([...seedEvents.values()])
    });
    if (recalledEntities.length === 0) {
      const inferredEntityIds = collectEntityIdsFromRankedEvents(
        queryEvents.map((event) => event.id),
        seedEvents,
        Math.min(options.entityTopK, 8)
      );
      const inferredEntities = await timed(timings, "step4InferEntitiesFromEvents", () => getEntitiesByIds({
        sourceIds: input.sourceIds,
        entityIds: inferredEntityIds,
        limit: Math.min(options.entityTopK, 8)
      }), emit, {
        title: "从语义事件回填实体",
        detail: "实体召回为空时，从语义召回事件反推关联实体，补齐图谱链路。"
      });
      recalledEntities = dedupeEntities(inferredEntities);
      queryEntities = unique([...queryEntities, ...recalledEntities.map((entity) => entity.name)]);
      trace.queryEntities = queryEntities;
      trace.recalledEntities = recalledEntities.map((entity) => ({
        id: entity.id,
        name: entity.name,
        type: entity.type,
        score: entity.score ?? 0
      }));
      emitSearchStep(emit, timings, "step4InferEntitiesFromEvents", {
        title: "从语义事件回填实体",
        detail: recalledEntities.length === 0 ? "语义事件没有可回填实体" : `回填 ${recalledEntities.length} 个实体`,
        payload: trace.recalledEntities
      });
    }
    const expanded = await timed(timings, "step5Expand", () => this.expandEvents({
      seedEvents,
      initialEntityIds: recalledEntities.map((entity) => entity.id),
      sourceIds: input.sourceIds,
      query: input.query,
      queryVector,
      options
    }), emit, {
      title: "事件扩展",
      detail: "沿事件实体关系扩展候选事件集合。"
    });
    trace.expandedEventIds = expanded.expandedEventIds;
    emitSearchStep(emit, timings, "step5Expand", {
      title: "事件扩展",
      detail: `扩展 ${expanded.expandedEventIds.length} 个事件`
    });

    const coarseRanked = await timed(timings, "step6CoarseRank", async () => {
      if (options.subStrategy === "multi") {
        return coarseRankEventsByContent({
          sourceIds: input.sourceIds,
          eventIds: unique([...seedEventIds, ...expanded.eventsetIds]),
          queryVector,
          maxEvents: options.maxEvents
        });
      }

      const eventsetRanked = await coarseRankEventsByContent({
        sourceIds: input.sourceIds,
        eventIds: unique([...seedEventIds, ...expanded.eventsetIds]),
        queryVector,
        maxEvents: options.maxEventsA
      });
      const eventset1Ranked = expanded.eventset1Ids.length > 0 && options.maxEventsB > 0
        ? await coarseRankEventsByContent({
            sourceIds: input.sourceIds,
            eventIds: expanded.eventset1Ids,
            queryVector,
            maxEvents: options.maxEventsB
          })
        : [];
      return [...eventsetRanked, ...eventset1Ranked];
    }, emit, {
      title: "粗排事件",
      detail: "按事件内容向量相似度粗排候选事件。"
    });
    trace.coarseRankedEventIds = coarseRanked.map((event) => event.id);
    trace.coarseRankedEvents = toTraceEvents(coarseRanked);
    trace.expandedEvents = trace.expandedEventIds.length > 0
      ? trace.coarseRankedEvents.filter((event) => trace.expandedEventIds.includes(event.id))
      : [];
    appendEventSnapshots(trace, trace.coarseRankedEvents);
    emitSearchStep(emit, timings, "step6CoarseRank", {
      title: "粗排事件",
      detail: `粗排得到 ${trace.coarseRankedEvents.length} 个候选事件`,
      payload: trace.coarseRankedEvents
    });

    const rerankStepKey = searchMode === "fast" ? "step7RerankModel" : "step7LlmRerank";
    let selectedIds = await timed(timings, rerankStepKey, () => (
      searchMode === "fast"
        ? this.reranker.rerankEvents({
            query: input.query,
            candidates: coarseRanked,
            topK: options.rerankTopK
          })
        : this.llm.rerankEvents({
            query: input.query,
            candidates: coarseRanked,
            topK: options.rerankTopK
          })
    ), emit, {
      title: searchMode === "fast" ? "Rerank 模型重排" : "LLM 重排",
      detail: searchMode === "fast"
        ? "用 qwen3-rerank 对候选事件排序，不调用 LLM 过滤。"
        : "让 LLM 根据问题从候选事件中选择最终事件。"
    });
    if (selectedIds.length === 0) {
      trace.fallbackReason = searchMode === "fast"
        ? "rerank model returned no ids; used coarse rank"
        : "llm rerank returned no ids; used coarse rank";
      selectedIds = coarseRanked.slice(0, options.rerankTopK).map((event) => event.id);
    }
    trace.rerankedEventIds = selectedIds;
    const eventSnapshotById = new Map((trace.eventSnapshots ?? []).map((event) => [event.id, event]));
    trace.rerankedEvents = selectedIds.map((id) => eventSnapshotById.get(id)).filter((event): event is SearchTraceEvent => Boolean(event));
    emitSearchStep(emit, timings, rerankStepKey, {
      title: searchMode === "fast" ? "Rerank 模型重排" : "LLM 重排",
      detail: `选出 ${trace.rerankedEvents.length || selectedIds.length} 个最终候选事件`,
      payload: trace.rerankedEvents.length > 0 ? trace.rerankedEvents : undefined
    });

    const sections = await timed(timings, "step8FetchChunks", () => this.sectionsForSelectedEvents(selectedIds, coarseRanked, options.maxSections), emit, {
      title: "回取关联切片",
      detail: "读取最终事件关联的原文切片。"
    });
    const graphSections = await timed(timings, "step8FetchGraphChunks", () => getSectionsForKnowledgeEdges(unique([
      ...recalledEdges.map((edge) => edge.id),
      ...graphPaths.flatMap((path) => path.edges.map((edge) => edge.id))
    ])), emit, {
      title: "回取关系证据切片",
      detail: "读取强关系边直接指向的原文证据切片。"
    });
    mergeGraphSections(sections, graphSections, options.maxSections);
    if (sections.length < options.maxSections) {
      const supplemental = await searchChunksByVector({
        sourceIds: input.sourceIds,
        queryVector,
        topK: options.maxSections * 2
      });
      const seen = new Set(sections.map((section) => section.chunkId));
      for (const section of supplemental) {
        if (seen.has(section.chunkId)) {
          continue;
        }
        sections.push(section);
        seen.add(section.chunkId);
        if (sections.length >= options.maxSections) {
          break;
        }
      }
    }
    emitSearchStep(emit, timings, "step8FetchChunks", {
      title: "回取关联切片",
      detail: `读取 ${sections.slice(0, options.maxSections).length} 个最终上下文切片`,
      payload: sections.slice(0, options.maxSections).map((section) => ({
        heading: section.heading,
        contentPreview: previewText(section.content, 160),
        score: section.score,
        rank: section.rank
      }))
    });
    const edgesForSections = await getEdgesForSections({
      chunkIds: sections.slice(0, options.maxSections).map((section) => section.chunkId)
    });
    const finalSections = attachWhyToSections({
      sections: sections.slice(0, options.maxSections),
      recalledEntities,
      recalledEdges,
      graphPaths,
      edgesForSections,
      fallback: Boolean(trace.fallbackReason)
    });

    return {
      traceId,
      sections: finalSections,
      trace: input.returnTrace ? trace : undefined
    };
  }

  private async expandEvents(input: {
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>;
    initialEntityIds: string[];
    sourceIds: string[];
    query: string;
    queryVector: number[];
    options: MultiOptions;
  }): Promise<{ eventsetIds: string[]; eventset1Ids: string[]; expandedEventIds: string[] }> {
    if (input.options.subStrategy === "multi") {
      return this.expandFixedHops(input.seedEvents, input.initialEntityIds, input.sourceIds, input.options.maxHops);
    }
    const stageA = await this.expandOneHop(input.seedEvents, input.initialEntityIds, input.sourceIds, new Set(input.seedEvents.keys()));
    const trackedEntityIdsForB = unique([...input.initialEntityIds, ...stageA.expandedEntityIds]);
    let seedForB = stageA.events;
    if (input.options.subStrategy === "hopllm") {
      const eventsetIds = unique([...input.seedEvents.keys(), ...stageA.eventIds]);
      const ranked = await coarseRankEventsByContent({
        sourceIds: input.sourceIds,
        eventIds: eventsetIds,
        queryVector: input.queryVector,
        maxEvents: input.options.maxEventsA
      });
      seedForB = await getEventsWithEntityIds(ranked.map((event) => event.id));
    }
    const stageB = await this.expandDynamic(seedForB, trackedEntityIdsForB, input.sourceIds, new Set([...input.seedEvents.keys(), ...stageA.eventIds]), input.options.maxEventsB, input.options.maxHopRetries);
    return {
      eventsetIds: stageA.eventIds,
      eventset1Ids: stageB.eventIds,
      expandedEventIds: unique([...stageA.eventIds, ...stageB.eventIds])
    };
  }

  private async expandFixedHops(
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>,
    initialEntityIds: string[],
    sourceIds: string[],
    maxHops: number
  ): Promise<{ eventsetIds: string[]; eventset1Ids: string[]; expandedEventIds: string[] }> {
    const trackedEvents = new Set(seedEvents.keys());
    const trackedEntities = new Set(initialEntityIds);
    let current = seedEvents;
    const expandedEventIds: string[] = [];
    for (let hop = 0; hop < maxHops; hop += 1) {
      const newEntityIds = collectNewEntityIds(current, trackedEntities);
      newEntityIds.forEach((id) => trackedEntities.add(id));
      if (newEntityIds.length === 0) {
        break;
      }
      const newEventIds = await getEventIdsByEntityIds({
        entityIds: newEntityIds,
        sourceIds,
        excludeEventIds: [...trackedEvents]
      });
      if (newEventIds.length === 0) {
        break;
      }
      newEventIds.forEach((id) => trackedEvents.add(id));
      expandedEventIds.push(...newEventIds);
      current = await getEventsWithEntityIds(newEventIds);
    }
    return { eventsetIds: expandedEventIds, eventset1Ids: [], expandedEventIds };
  }

  private async expandOneHop(
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>,
    initialEntityIds: string[],
    sourceIds: string[],
    excludeEvents: Set<string>
  ): Promise<{ eventIds: string[]; events: Map<string, EventRecord & { entityIds: string[] }>; expandedEntityIds: string[] }> {
    const trackedEntities = new Set(initialEntityIds);
    const entityIds = collectNewEntityIds(seedEvents, trackedEntities);
    const eventIds = await getEventIdsByEntityIds({
      entityIds,
      sourceIds,
      excludeEventIds: [...excludeEvents]
    });
    return {
      eventIds,
      events: await getEventsWithEntityIds(eventIds),
      expandedEntityIds: entityIds
    };
  }

  private async expandDynamic(
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>,
    initialEntityIds: string[],
    sourceIds: string[],
    excludeEvents: Set<string>,
    targetEvents: number,
    maxHopRetries: number
  ): Promise<{ eventIds: string[] }> {
    if (targetEvents === 0 || seedEvents.size === 0) {
      return { eventIds: [] };
    }
    const trackedEntities = new Set(initialEntityIds);
    const collected: string[] = [];
    let current = seedEvents;
    for (let hop = 0; hop < maxHopRetries; hop += 1) {
      const newEntityIds = collectNewEntityIds(current, trackedEntities);
      newEntityIds.forEach((id) => trackedEntities.add(id));
      if (newEntityIds.length === 0) {
        break;
      }
      const newEventIds = await getEventIdsByEntityIds({
        entityIds: newEntityIds,
        sourceIds,
        excludeEventIds: [...excludeEvents, ...collected]
      });
      if (newEventIds.length === 0) {
        break;
      }
      collected.push(...newEventIds);
      if (collected.length >= targetEvents) {
        break;
      }
      current = await getEventsWithEntityIds(newEventIds);
    }
    return { eventIds: collected };
  }

  private async sectionsForSelectedEvents(
    eventIds: string[],
    rankedEvents: EventRecord[],
    maxSections: number
  ): Promise<SearchSection[]> {
    const scoreByEventId = new Map(rankedEvents.map((event) => [event.id, event.score ?? 0]));
    const rawSections = await getSectionsForEvents(eventIds);
    const seenChunks = new Set<string>();
    const sections: SearchSection[] = [];
    for (const section of rawSections) {
      if (seenChunks.has(section.chunkId)) {
        continue;
      }
      seenChunks.add(section.chunkId);
      sections.push({
        chunkId: section.chunkId,
        sourceId: section.sourceId,
        documentId: section.documentId,
        externalId: section.externalId,
        documentTitle: section.documentTitle,
        documentMetadata: section.documentMetadata,
        heading: section.heading,
        content: section.content,
        rank: section.rank,
        score: scoreByEventId.get(section.eventId) ?? 0
      });
      if (sections.length >= maxSections) {
        break;
      }
    }
    return sections;
  }
}

function resolveMultiOptions(input: SearchInput, defaultSearchTopK: number): MultiOptions {
  const multi = input.multi ?? {};
  const topK = resolveFinalSearchTopK(input.topK ?? defaultSearchTopK);
  const rerankTopK = resolveFinalSearchTopK(multi.rerankTopK ?? topK);
  const maxSections = resolveFinalSearchTopK(multi.maxSections ?? topK);
  return {
    subStrategy: input.subStrategy ?? "multi",
    entityTopK: multi.entityTopK ?? 20,
    multiTopK: multi.multiTopK ?? 20,
    keySimilarityThreshold: multi.keySimilarityThreshold ?? 0.9,
    similarityThreshold: multi.similarityThreshold ?? 0.4,
    maxHops: multi.maxHops ?? 1,
    maxEvents: multi.maxEvents ?? 100,
    maxEventsA: multi.maxEventsA ?? 100,
    maxEventsB: multi.maxEventsB ?? 0,
    maxHopRetries: multi.maxHopRetries ?? 3,
    rerankTopK,
    maxSections
  };
}

function resolveFinalSearchTopK(value?: number): number {
  if (!Number.isFinite(value) || value == null) {
    return MAX_SEARCH_RESULTS;
  }
  return Math.max(1, Math.min(Math.trunc(value), MAX_SEARCH_RESULTS));
}

function collectNewEntityIds(
  events: Map<string, EventRecord & { entityIds: string[] }>,
  trackedEntities: Set<string>
): string[] {
  const ids = unique([...events.values()].flatMap((event) => event.entityIds));
  return ids.filter((id) => !trackedEntities.has(id));
}

function collectEntityIdsFromRankedEvents(
  rankedEventIds: string[],
  events: Map<string, EventRecord & { entityIds: string[] }>,
  limit: number
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const eventId of rankedEventIds.slice(0, 5)) {
    const event = events.get(eventId);
    if (!event) {
      continue;
    }
    for (const entityId of event.entityIds) {
      if (seen.has(entityId)) {
        continue;
      }
      seen.add(entityId);
      ids.push(entityId);
      if (ids.length >= limit) {
        return ids;
      }
    }
  }
  return ids;
}

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

function dedupeEntities(entities: EntityRecord[]): EntityRecord[] {
  const seen = new Set<string>();
  const result: EntityRecord[] = [];
  for (const entity of entities) {
    if (seen.has(entity.id)) {
      continue;
    }
    seen.add(entity.id);
    result.push(entity);
  }
  return result;
}

export function expandBidQueryEntities(query: string, domainConfig?: Parameters<typeof expandBiddingQuery>[1]): string[] {
  return expandBiddingQuery(query, domainConfig);
}

function inferRelationIntent(query: string, explicitTypes?: string[]): string[] {
  if (explicitTypes && explicitTypes.length > 0) {
    return normalizeRelationTypes(explicitTypes);
  }
  const intents: string[] = [];
  if (/要求|需要|必须|须|资质|证书|资格|条件/.test(query)) intents.push("REQUIRES");
  if (/证明|佐证|支撑|材料|依据|为什么|链路/.test(query)) intents.push("PROVES");
  if (/满足|符合|响应|怎么响应|匹配/.test(query)) intents.push("SATISFIES");
  if (/持有|具备|人员|证书/.test(query)) intents.push("HOLDS");
  if (/业绩|案例|经验|项目类型/.test(query)) intents.push("HAS_EXPERIENCE", "MATCHES_TYPE");
  if (/评分|得分|加分/.test(query)) intents.push("SCORES_FOR");
  if (/废标|无效|风险|扣分/.test(query)) intents.push("CAUSES_RISK");
  if (/提交|递交|提供|响应文件/.test(query)) intents.push("SUBMITS");
  return normalizeRelationTypes(intents);
}

function normalizeRelationTypes(types: string[]): string[] {
  return unique(types.map((type) => normalizeRelation(type).type)).filter((type) => type !== "RELATED_TO");
}

function mergeGraphSections(
  sections: SearchSection[],
  graphSections: Array<SearchSection & { edgeId?: string }>,
  maxSections: number
) {
  const seen = new Set(sections.map((section) => section.chunkId));
  for (const section of graphSections) {
    if (seen.has(section.chunkId)) continue;
    sections.unshift({
      chunkId: section.chunkId,
      sourceId: section.sourceId,
      documentId: section.documentId,
      externalId: section.externalId,
      documentTitle: section.documentTitle,
      documentMetadata: section.documentMetadata,
      heading: section.heading,
      content: section.content,
      rank: section.rank,
      score: Math.max(section.score ?? 0, 0.75)
    });
    seen.add(section.chunkId);
    if (sections.length >= maxSections) {
      return;
    }
  }
}

function attachWhyToSections(input: {
  sections: SearchSection[];
  recalledEntities: EntityRecord[];
  recalledEdges: NonNullable<SearchTrace["recalledEdges"]>;
  graphPaths: NonNullable<SearchTrace["graphPaths"]>;
  edgesForSections: NonNullable<SearchTrace["recalledEdges"]>;
  fallback: boolean;
}): SearchSection[] {
  const edgesByChunk = new Map<string, typeof input.edgesForSections>();
  for (const edge of input.edgesForSections) {
    if (!edge.chunkId) continue;
    const list = edgesByChunk.get(edge.chunkId) ?? [];
    list.push(edge);
    edgesByChunk.set(edge.chunkId, list);
  }
  return input.sections.map((section) => {
    const sectionEdges = edgesByChunk.get(section.chunkId) ?? [];
    const pathEdges = new Set(sectionEdges.map((edge) => edge.id));
    const graphPaths = input.graphPaths.filter((path) => path.edges.some((edge) => pathEdges.has(edge.id)));
    const matchedEdges = sectionEdges.length > 0 ? sectionEdges : input.recalledEdges.filter((edge) => edge.chunkId === section.chunkId);
    const recallType: SearchResultWhy["recallType"] = graphPaths.length > 0
      ? "graph_path"
      : matchedEdges.length > 0
        ? "knowledge_edge"
        : input.recalledEntities.length > 0
          ? "entity"
          : input.fallback
            ? "fallback"
            : "vector";
    return {
      ...section,
      why: {
        matchedEntities: input.recalledEntities.map((entity) => ({
          id: entity.id,
          name: entity.name,
          type: entity.type,
          score: entity.score
        })),
        matchedEdges,
        graphPaths,
        evidence: uniqueEvidence([
          ...matchedEdges.map((edge) => ({ edgeId: edge.id, chunkId: edge.chunkId ?? undefined, text: edge.evidence ?? "", score: edge.qualityScore ?? edge.confidence })),
          ...graphPaths.flatMap((path) => path.evidence.map((item) => ({ edgeId: item.edgeId, chunkId: section.chunkId, text: item.text, score: item.confidence })))
        ]),
        recallType,
        fallback: input.fallback || recallType === "fallback"
      }
    };
  });
}

function uniqueEvidence(items: Array<{ edgeId?: string; chunkId?: string; text: string; score?: number }>): Array<{ edgeId?: string; chunkId?: string; text: string; score?: number }> {
  const seen = new Set<string>();
  const result: Array<{ edgeId?: string; chunkId?: string; text: string; score?: number }> = [];
  for (const item of items) {
    const text = item.text.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push({ ...item, text });
  }
  return result.slice(0, 6);
}

function buildExpandedTextQuery(query: string, entities: string[]): string {
  return unique([query, ...entities]).join(" ");
}

async function timed<T>(
  timings: Record<string, number>,
  key: string,
  fn: () => Promise<T>,
  emit?: SearchProgressEmitter,
  step?: { title: string; detail: string; payload?: unknown }
): Promise<T> {
  const start = performance.now();
  if (emit && step) {
    emitSearchStep(emit, timings, key, step, "running");
  }
  try {
    const result = await fn();
    timings[key] = Math.round((performance.now() - start) * 100) / 100;
    if (emit && step) {
      emitSearchStep(emit, timings, key, step, "done");
    }
    return result;
  } catch (error) {
    timings[key] = Math.round((performance.now() - start) * 100) / 100;
    if (emit && step) {
      emitSearchStep(emit, timings, key, {
        ...step,
        detail: `${step.detail} 失败：${error instanceof Error ? error.message : String(error)}`
      }, "failed");
    }
    throw error;
  }
}

function emitSearchStep(
  emit: SearchProgressEmitter | undefined,
  timings: Record<string, number>,
  key: string,
  step: { title: string; detail: string; payload?: unknown },
  status: SearchProgressEvent["status"] = "done"
) {
  emit?.({
    type: "step",
    status,
    key,
    title: step.title,
    detail: step.detail,
    payload: step.payload,
    durationMs: timings[key]
  });
}

function toTraceEvents(events: Array<EventRecord & { entityIds?: string[] }>): SearchTraceEvent[] {
  return events.map((event) => ({
    id: event.id,
    title: event.title,
    summary: event.summary,
    contentPreview: previewText(event.content || event.summary || event.title, 160),
    score: event.score
  }));
}

function idsToTraceEvents(
  ids: string[],
  events: Map<string, EventRecord & { entityIds: string[] }>
): SearchTraceEvent[] {
  return ids
    .map((id) => events.get(id))
    .filter((event): event is EventRecord & { entityIds: string[] } => Boolean(event))
    .map((event) => toTraceEvents([event])[0]);
}

function appendEventSnapshots(trace: SearchTrace, events: SearchTraceEvent[]) {
  const byId = new Map((trace.eventSnapshots ?? []).map((event) => [event.id, event]));
  for (const event of events) {
    byId.set(event.id, event);
  }
  trace.eventSnapshots = [...byId.values()];
}

function previewText(text: string, limit: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

export const searchService = new SearchService();
