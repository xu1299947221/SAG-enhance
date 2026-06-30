import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { toVectorLiteral } from "../db/vector.js";
import { createSource, deleteDocumentByExternalId, getRelationConfig, upsertEntity, upsertKnowledgeEdge } from "../db/repositories.js";
import { config } from "../config/env.js";
import { embeddingClient, type EmbeddingClient } from "../ai/embedding-client.js";
import { llmClient, type LlmClient } from "../ai/llm-client.js";
import { chunkMarkdown, type ChunkDraft } from "../ingestion/chunking/markdown.js";
import { extractEventsFromChunk } from "../ingestion/extract/extractor.js";
import { discoverDomainObjects } from "../domain/domain-object-discovery.js";
import { cleanExtractedEntities } from "../domain/entity-cleaning.js";
import { normalizeRelation } from "../domain/relation-ontology.js";
import { domainProfileService, type DomainProfileObject, type DomainProfileRelation, type DomainProfileResult } from "./domain-profile-service.js";
import { relationExtractionService, scoreRelation, type ExtractedStrongRelation } from "./relation-extraction-service.js";
import { biddingAlignmentService } from "./bidding-alignment-service.js";
import type {
  BatchIngestDocumentResult,
  ExtractedEntity,
  ExtractedEvent,
  IngestDocumentInput,
  IngestDocumentResult,
  IngestProgressUpdate
} from "../types.js";
import { logger } from "../observability/logger.js";
import { aiSettingsService } from "./ai-settings-service.js";

type ExtractedChunkEvents = {
  chunk: ChunkDraft;
  events: ExtractedEvent[];
};

type EventInput = {
  chunk: ChunkDraft;
  event: ExtractedEvent;
  eventId: string;
  rank: number;
};

type EventEmbeddingInput = EventInput & {
  titleEmbedding: number[];
  contentEmbedding: number[];
};

type EntityEmbeddingInput = {
  key: string;
  entity: ExtractedEntity;
};

type RelationEmbeddingInput = {
  eventId: string;
  eventTitle: string;
  entity: ExtractedEntity;
};

type PreparedEvent = EventEmbeddingInput & {
  entities: Array<ExtractedEntity & {
    entityEmbedding: number[];
    relationEmbedding: number[];
  }>;
  profileRelations: DomainProfileRelation[];
  strongRelations: ExtractedStrongRelation[];
};

export class IngestionService {
  constructor(
    private readonly embeddings: EmbeddingClient = embeddingClient,
    private readonly llm: LlmClient = llmClient
  ) {}

  async ingestDocument(
    input: IngestDocumentInput,
    tenantId = config.DEFAULT_TENANT_ID,
    onProgress?: (update: IngestProgressUpdate) => void
  ): Promise<IngestDocumentResult> {
    const traceId = randomUUID();
    const taskId = randomUUID();
    const documentId = randomUUID();
    const extract = input.extract ?? true;
    const externalId = input.externalId?.trim();
    const ingestConcurrency = config.INGEST_CONCURRENCY;
    const runtimeSettings = await aiSettingsService.getRuntimeSettings();
    const chunkingOptions = {
      mode: input.chunking?.mode ?? runtimeSettings.defaultChunkingMode,
      maxTokens: input.chunking?.maxTokens ?? runtimeSettings.chunkTokenLimit,
      overlapTokens: input.chunking?.overlapTokens ?? runtimeSettings.chunkOverlapTokens
    };

    onProgress?.({
      stage: "PARSING",
      message: "正在解析文档内容",
      progress: 8
    });
    const source = await createSource({
      id: input.sourceId,
      tenantId,
      name: input.title,
      description: "Created by SAG ingestDocument",
      metadata: { ...(input.metadata ?? {}), traceId, chunking: chunkingOptions, ...(externalId ? { externalId } : {}) }
    });

    const chunking = chunkMarkdown(input.content, chunkingOptions);
    onProgress?.({
      stage: "CHUNKING",
      message: `已生成 ${chunking.chunks.length} 个切片`,
      progress: 18,
      chunkCount: chunking.chunks.length,
      totalChunks: chunking.chunks.length
    });

    onProgress?.({
      stage: "EXTRACTING_EVENTS",
      message: "正在自动分析文档领域对象",
      progress: 28,
      chunkCount: chunking.chunks.length,
      totalChunks: chunking.chunks.length
    });
    const domainProfile = await domainProfileService.profileDocument({
      title: input.title,
      content: input.content,
      candidates: discoverDomainObjects(input.content, 120)
    });

    onProgress?.({
      stage: "EMBEDDING_CHUNKS",
      message: "正在生成切片向量",
      progress: 35,
      chunkCount: chunking.chunks.length,
      totalChunks: chunking.chunks.length
    });
    const chunkEmbeddings = await this.embeddings.batchGenerate(chunking.chunks.map((chunk) => `${chunk.heading}\n${chunk.content}`));

    const projectRelationConfig = await getRelationConfig({
      sourceId: source.id,
      tenantId
    });

    const preparedEvents = extract
      ? await this.prepareEvents({
          input,
          chunks: chunking.chunks,
          domainProfile,
          projectRelationConfig,
          onProgress,
          concurrency: ingestConcurrency
        })
      : [];

    const client = await pool.connect();
    let replacedDocumentIds: string[] = [];
    try {
      await client.query("begin");
      if (input.replaceExisting && externalId) {
        replacedDocumentIds = await deleteDocumentByExternalId({
          sourceId: source.id,
          externalId,
          tenantId
        }, client);
      }
      await client.query(
        `
          insert into documents (id, source_id, external_id, title, content, status, parse_status, metadata)
          values ($1, $2, $3, $4, $5, 'PARSING', 'PARSING', $6::jsonb)
        `,
        [
          documentId,
          source.id,
          externalId ?? null,
          input.title,
          input.content,
          JSON.stringify({ ...(input.metadata ?? {}), chunking: chunkingOptions, domainProfile, ...(externalId ? { externalId } : {}) })
        ]
      );
      onProgress?.({
        stage: "WRITING_GRAPH",
        message: "正在写入文档记录",
        progress: 24,
        chunkCount: chunking.chunks.length,
        eventCount: preparedEvents.length,
        totalChunks: chunking.chunks.length
      });

      for (const section of chunking.sections) {
        await client.query(
          `
            insert into document_sections (
              id, document_id, order_index, render_group_index, type, heading, content,
              raw_content, metadata, token_count
            )
            values ($1, $2, $3, 0, 'TEXT', $4, $5, $6, '{}'::jsonb, $7)
          `,
          [
            section.id,
            documentId,
            Math.trunc(section.orderIndex * 1000),
            section.heading,
            section.content,
            section.rawContent,
            section.tokenCount
          ]
        );
      }

      for (const [index, chunk] of chunking.chunks.entries()) {
        await client.query(
          `
            insert into source_chunks (
              id, source_id, document_id, source_type, external_source_id, heading, content,
              raw_content, rank, "references", metadata, embedding
            )
            values ($1, $2, $3, 'ARTICLE', $3::uuid::text, $4, $5, $6, $7, $8::uuid[], '{}'::jsonb, $9::vector)
          `,
          [
            chunk.id,
            source.id,
            documentId,
            chunk.heading,
            chunk.content,
            chunk.rawContent,
            chunk.rank,
            chunk.sectionIds,
            toVectorLiteral(chunkEmbeddings[index])
          ]
        );
      }

      for (const preparedEvent of preparedEvents) {
        await client.query(
          `
            insert into events (
              id, source_id, document_id, chunk_id, source_type, external_source_id,
              level, rank, title, summary, content, category, keywords, priority, status,
              "references", metadata, title_embedding, content_embedding
            )
            values (
              $1, $2, $3, $4, 'ARTICLE', $3::uuid::text,
              0, $5, $6, $7, $8, $9, $10::text[], $11, $12,
              $13::uuid[], $14::jsonb, $15::vector, $16::vector
            )
          `,
          [
            preparedEvent.eventId,
            source.id,
            documentId,
            preparedEvent.chunk.id,
            preparedEvent.rank,
            preparedEvent.event.title,
            preparedEvent.event.summary,
            preparedEvent.event.content,
            preparedEvent.event.category ?? null,
            preparedEvent.event.keywords,
            preparedEvent.event.priority ?? "UNKNOWN",
            preparedEvent.event.status ?? "COMPLETED",
            preparedEvent.event.references,
            JSON.stringify({
              traceId,
              ...(preparedEvent.profileRelations.length > 0 ? { domainProfileRelations: preparedEvent.profileRelations } : {})
            }),
            toVectorLiteral(preparedEvent.titleEmbedding),
            toVectorLiteral(preparedEvent.contentEmbedding)
          ]
        );

        const savedEntities = new Map<string, { id: string; name: string; type: string }>();
        for (const entity of preparedEvent.entities) {
          const saved = await upsertEntity({
            sourceId: source.id,
            type: entity.type,
            name: entity.name,
            description: entity.description,
            embedding: entity.entityEmbedding
          }, client);
          await client.query(
            `
              insert into event_entities (id, event_id, entity_id, weight, description, embedding)
              values ($1, $2, $3, 1.0, $4, $5::vector)
              on conflict (event_id, entity_id) do update set
                description = excluded.description,
                embedding = excluded.embedding
            `,
            [
              randomUUID(),
              preparedEvent.eventId,
              saved.id,
              entity.description,
              toVectorLiteral(entity.relationEmbedding)
            ]
          );
          savedEntities.set(entity.name, {
            id: saved.id,
            name: saved.name,
            type: saved.type
          });
        }
        for (const relation of preparedEvent.profileRelations) {
          const subject = savedEntities.get(relation.source);
          const object = savedEntities.get(relation.target);
          if (!subject || !object || subject.id === object.id) {
            continue;
          }
          const normalizedRelation = normalizeRelation(relation.predicate || relation.relation);
          await upsertKnowledgeEdge({
            sourceId: source.id,
            documentId,
            chunkId: preparedEvent.chunk.id,
            eventId: preparedEvent.eventId,
            subjectEntityId: subject.id,
            objectEntityId: object.id,
            subjectName: subject.name,
            objectName: object.name,
            relationType: normalizedRelation.type,
            relationLabel: relation.relation || normalizedRelation.label,
            evidence: relation.evidence || preparedEvent.event.summary || preparedEvent.event.content.slice(0, 240),
            confidence: relation.confidence,
            qualityScore: scoreRelation({
              predicate: normalizedRelation.type,
              confidence: relation.confidence,
              evidence: relation.evidence || preparedEvent.event.summary || preparedEvent.event.content.slice(0, 240),
              subject: subject.name,
              object: object.name,
              status: "AUTO"
            }),
            extractionMethod: "domain_profile_relation",
            extractionModel: runtimeSettings.hasRemoteLlm ? runtimeSettings.llmModel : null,
            promptVersion: "domain-profile-v1",
            metadata: {
              extraction: "domain_profile_relation",
              subjectType: subject.type,
              objectType: object.type,
              documentType: domainProfile.documentType
            }
          }, client);
        }
        for (const relation of preparedEvent.strongRelations) {
          const subject = savedEntities.get(relation.subject);
          const object = savedEntities.get(relation.object);
          if (!subject || !object || subject.id === object.id) {
            continue;
          }
          await upsertKnowledgeEdge({
            sourceId: source.id,
            documentId,
            chunkId: preparedEvent.chunk.id,
            eventId: preparedEvent.eventId,
            subjectEntityId: subject.id,
            objectEntityId: object.id,
            subjectName: subject.name,
            objectName: object.name,
            relationType: relation.predicate,
            relationLabel: relation.displayLabel,
            evidence: relation.evidence,
            evidenceStart: relation.evidenceStart ?? null,
            evidenceEnd: relation.evidenceEnd ?? null,
            confidence: relation.confidence,
            qualityScore: relation.qualityScore,
            extractionMethod: relation.extractionMethod,
            extractionModel: relation.extractionModel ?? null,
            promptVersion: relation.promptVersion,
            metadata: {
              extraction: relation.extractionMethod,
              reason: relation.reason,
              subjectType: subject.type,
              objectType: object.type,
              documentType: domainProfile.documentType
            }
          }, client);
        }
      }

      onProgress?.({
        stage: "WRITING_GRAPH",
        message: "正在完成图谱关系写入",
        progress: 95,
        chunkCount: chunking.chunks.length,
        eventCount: preparedEvents.length,
        totalChunks: chunking.chunks.length
      });
      await client.query(
        "update documents set status = 'COMPLETED', parse_status = 'COMPLETED', updated_at = now() where id = $1",
        [documentId]
      );
      await client.query("commit");

      try {
        await biddingAlignmentService.alignSource(source.id, tenantId);
      } catch (error) {
        logger.warn({ traceId, error }, "bidding graph alignment failed");
      }

      logger.info({ traceId, documentId, chunkCount: chunking.chunks.length, eventCount: preparedEvents.length }, "document ingested");
      onProgress?.({
        stage: "COMPLETED",
        message: `处理完成：${chunking.chunks.length} 个切片，${preparedEvents.length} 个事件`,
        progress: 100,
        chunkCount: chunking.chunks.length,
        eventCount: preparedEvents.length,
        totalChunks: chunking.chunks.length
      });
      return {
        sourceId: source.id,
        documentId,
        ...(externalId ? { externalId } : {}),
        ...(replacedDocumentIds[0] ? { replacedDocumentId: replacedDocumentIds[0] } : {}),
        ...(replacedDocumentIds.length > 0 ? { replacedDocumentIds } : {}),
        chunkCount: chunking.chunks.length,
        eventCount: preparedEvents.length,
        taskId,
        traceId
      };
    } catch (error) {
      await client.query("rollback");
      logger.error({ traceId, error }, "document ingest failed");
      throw error;
    } finally {
      client.release();
    }
  }

  async ingestDocuments(input: {
    documents: IngestDocumentInput[];
    continueOnError?: boolean;
  }, tenantId = config.DEFAULT_TENANT_ID): Promise<BatchIngestDocumentResult> {
    const results: BatchIngestDocumentResult["results"] = [];
    for (const [index, document] of input.documents.entries()) {
      try {
        const result = await this.ingestDocument(document, tenantId);
        results.push({
          index,
          ok: true,
          externalId: document.externalId,
          title: document.title,
          result
        });
      } catch (error) {
        results.push({
          index,
          ok: false,
          externalId: document.externalId,
          title: document.title,
          error: error instanceof Error ? error.message : String(error)
        });
        if (!input.continueOnError) {
          break;
        }
      }
    }
    const succeeded = results.filter((item) => item.ok).length;
    return {
      total: input.documents.length,
      succeeded,
      failed: results.length - succeeded,
      results
    };
  }

  private async prepareEvents(input: {
    input: IngestDocumentInput;
    chunks: ChunkDraft[];
    domainProfile: DomainProfileResult;
    projectRelationConfig: Awaited<ReturnType<typeof getRelationConfig>>;
    concurrency: number;
    onProgress?: (update: IngestProgressUpdate) => void;
  }): Promise<PreparedEvent[]> {
    let extractedChunks = 0;
    let extractedEventCount = 0;
    const extracted = await mapWithConcurrency(input.chunks, input.concurrency, async (chunk) => {
      input.onProgress?.({
        stage: "EXTRACTING_EVENTS",
        message: `正在并行抽取事件（并发 ${input.concurrency}），已完成 ${extractedChunks}/${input.chunks.length} 个切片`,
        progress: progressForCompleted(extractedChunks, input.chunks.length, 48, 74),
        chunkCount: input.chunks.length,
        eventCount: extractedEventCount,
        currentChunk: extractedChunks,
        totalChunks: input.chunks.length
      });
      const events = await extractEventsFromChunk({
        llm: this.llm,
        documentTitle: input.input.title,
        heading: chunk.heading,
        content: chunk.content,
        references: chunk.sectionIds
      });
      extractedChunks += 1;
      extractedEventCount += events.length;
      input.onProgress?.({
        stage: "EXTRACTING_EVENTS",
        message: `已完成 ${extractedChunks}/${input.chunks.length} 个切片事件抽取`,
        progress: progressForCompleted(extractedChunks, input.chunks.length, 48, 74),
        chunkCount: input.chunks.length,
        eventCount: extractedEventCount,
        currentChunk: extractedChunks,
        totalChunks: input.chunks.length
      });
      return { chunk, events } satisfies ExtractedChunkEvents;
    });

    const eventInputs: EventInput[] = extracted
      .flatMap((item) => item.events.map((event) => ({ chunk: item.chunk, event })))
      .map((item) => ({
        ...item,
        event: enrichEventWithDomainProfile(item.event, item.chunk, input.domainProfile)
      }))
      .map((item, rank) => ({
        ...item,
        eventId: randomUUID(),
        rank
      }));

    const relationEntries = await mapWithConcurrency(eventInputs, input.concurrency, async (eventInput) => {
      const strongRelations = await relationExtractionService.extractRelations({
        documentTitle: input.input.title,
        documentType: input.domainProfile.documentType,
        chunkHeading: eventInput.chunk.heading,
        chunkContent: eventInput.chunk.content,
        eventTitle: eventInput.event.title,
        eventSummary: eventInput.event.summary,
        eventContent: eventInput.event.content,
        extractedEntities: eventInput.event.entities,
        projectRelationConfig: input.projectRelationConfig
      });
      const eventWithRelationEntities = {
        ...eventInput.event,
        entities: mergeRelationEntities(eventInput.event.entities, strongRelations)
      };
      return [eventInput.eventId, {
        ...eventInput,
        event: eventWithRelationEntities,
        strongRelations
      }] as const;
    });
    const relationInputByEventId = new Map(relationEntries);
    const relationAwareEventInputs = eventInputs.map((eventInput) => relationInputByEventId.get(eventInput.eventId) ?? {
      ...eventInput,
      strongRelations: []
    });

    let embeddedEvents = 0;
    const eventEmbeddingInputs = await mapWithConcurrency(relationAwareEventInputs, input.concurrency, async (eventInput) => {
      const [titleEmbedding, contentEmbedding] = await this.embeddings.batchGenerate([
        eventInput.event.title,
        `${eventInput.event.title}\n\n${eventInput.event.content}`
      ]);
      embeddedEvents += 1;
      input.onProgress?.({
        stage: "EMBEDDING_EVENTS",
        message: `正在并行生成事件向量（并发 ${input.concurrency}），已完成 ${embeddedEvents}/${eventInputs.length} 个事件`,
        progress: progressForCompleted(embeddedEvents, Math.max(eventInputs.length, 1), 74, 82),
        chunkCount: input.chunks.length,
        eventCount: eventInputs.length,
        totalChunks: input.chunks.length
      });
      return {
        ...eventInput,
        titleEmbedding,
        contentEmbedding
      } satisfies EventEmbeddingInput;
    });

    const entityInputs = dedupeEntityEmbeddingInputs(relationAwareEventInputs.flatMap((item) => item.event.entities));
    let embeddedEntities = 0;
    const entityEmbeddingEntries = await mapWithConcurrency(entityInputs, input.concurrency, async (inputItem) => {
      const embedding = await this.embeddings.generate(inputItem.entity.name);
      embeddedEntities += 1;
      input.onProgress?.({
        stage: "EMBEDDING_EVENTS",
        message: `正在并行生成实体向量（并发 ${input.concurrency}），已完成 ${embeddedEntities}/${entityInputs.length} 个实体`,
        progress: progressForCompleted(embeddedEntities, Math.max(entityInputs.length, 1), 82, 88),
        chunkCount: input.chunks.length,
        eventCount: eventInputs.length,
        totalChunks: input.chunks.length
      });
      return [inputItem.key, embedding] as const;
    });
    const entityEmbeddings = new Map(entityEmbeddingEntries);

    const relationInputs: RelationEmbeddingInput[] = relationAwareEventInputs.flatMap((item) => (
      item.event.entities.map((entity) => ({
        eventId: item.eventId,
        eventTitle: item.event.title,
        entity
      }))
    ));
    let embeddedRelations = 0;
    const relationEmbeddingEntries = await mapWithConcurrency(relationInputs, input.concurrency, async (inputItem) => {
      const embedding = await this.embeddings.generate(inputItem.entity.description || `${inputItem.eventTitle} ${inputItem.entity.name}`);
      embeddedRelations += 1;
      input.onProgress?.({
        stage: "EMBEDDING_EVENTS",
        message: `正在并行生成关系向量（并发 ${input.concurrency}），已完成 ${embeddedRelations}/${relationInputs.length} 条关系`,
        progress: progressForCompleted(embeddedRelations, Math.max(relationInputs.length, 1), 88, 92),
        chunkCount: input.chunks.length,
        eventCount: eventInputs.length,
        totalChunks: input.chunks.length
      });
      return [relationEmbeddingKey(inputItem.eventId, inputItem.entity), embedding] as const;
    });
    const relationEmbeddings = new Map(relationEmbeddingEntries);

    return eventEmbeddingInputs.map((eventInput) => ({
      ...eventInput,
      profileRelations: relationsForEvent(eventInput.event, input.domainProfile.relations),
      strongRelations: relationInputByEventId.get(eventInput.eventId)?.strongRelations ?? [],
      entities: eventInput.event.entities.map((entity) => {
        const entityEmbedding = entityEmbeddings.get(entityEmbeddingKey(entity));
        const relationEmbedding = relationEmbeddings.get(relationEmbeddingKey(eventInput.eventId, entity));
        if (!entityEmbedding || !relationEmbedding) {
          throw new Error("实体或关系向量生成不完整");
        }
        return {
          ...entity,
          entityEmbedding,
          relationEmbedding
        };
      })
    }));
  }
}

export const ingestionService = new IngestionService();

function enrichEventWithDomainProfile(
  event: ExtractedEvent,
  chunk: ChunkDraft,
  profile: DomainProfileResult
): ExtractedEvent {
  const text = `${event.title}\n${event.summary}\n${event.content}\n${chunk.heading ?? ""}\n${chunk.content}`;
  const cleanedOriginalEntities = cleanExtractedEntities(event.entities, {
    text,
    inputIsChinese: /[\u4e00-\u9fa5]/.test(text),
    limit: 8
  });
  if (profile.objects.length === 0) {
    return {
      ...event,
      entities: cleanedOriginalEntities
    };
  }
  const existing = new Set<string>();
  const profileEntities: ExtractedEntity[] = [];
  const matchedNames: string[] = [];
  for (const object of profile.objects) {
    if (!objectMatchesText(object, text)) {
      continue;
    }
    const key = entityKey(object.type, object.name);
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    matchedNames.push(object.name);
    profileEntities.push({
      type: object.type,
      name: object.name,
      description: profileObjectDescription(object)
    });
  }
  const supportingEntities = profileEntities.length > 0
    ? cleanedOriginalEntities.filter((entity) => shouldKeepSupportingEntity(entity, text, existing)).slice(0, 3)
    : cleanedOriginalEntities;
  const entities = [...profileEntities, ...supportingEntities];
  return {
    ...event,
    keywords: uniqueStrings([...event.keywords, ...matchedNames]).slice(0, 24),
    entities: cleanExtractedEntities(entities, {
      text,
      inputIsChinese: /[\u4e00-\u9fa5]/.test(text),
      preserveNames: profile.objects.map((object) => object.name),
      limit: 24
    })
  };
}

function shouldKeepSupportingEntity(entity: ExtractedEntity, text: string, existingProfileKeys: Set<string>): boolean {
  if (existingProfileKeys.has(entityKey(entity.type, entity.name))) {
    return false;
  }
  if (!text.includes(entity.name)) {
    return false;
  }
  if (entity.type === "subject" || entity.type === "metric" || entity.type === "product") {
    return false;
  }
  return /(公司|集团|单位|部门|人员|证书|材料|文件|要求|规则|标准|期限|金额|评分|权限|数据|报告|知识库|系统|流程|预审)$/.test(entity.name);
}

function relationsForEvent(event: ExtractedEvent, relations: DomainProfileRelation[]): DomainProfileRelation[] {
  if (relations.length === 0) {
    return [];
  }
  const entityNames = new Set(event.entities.map((entity) => entity.name));
  return relations
    .filter((relation) => entityNames.has(relation.source) && entityNames.has(relation.target))
    .slice(0, 12);
}

function mergeRelationEntities(entities: ExtractedEntity[], relations: ExtractedStrongRelation[]): ExtractedEntity[] {
  const byKey = new Map(entities.map((entity) => [entityKey(entity.type, entity.name), entity]));
  const byName = new Map(entities.map((entity) => [entity.name, entity]));
  for (const relation of relations) {
    for (const [name, role] of [[relation.subject, "subject"], [relation.object, "object"]] as const) {
      if (byName.has(name)) {
        continue;
      }
      const entity: ExtractedEntity = {
        type: inferRelationEntityType(name, relation, role),
        name,
        description: `由强关系抽取补充：${relation.subject} ${relation.displayLabel} ${relation.object}`
      };
      const key = entityKey(entity.type, entity.name);
      if (!byKey.has(key)) {
        byKey.set(key, entity);
        byName.set(entity.name, entity);
      }
    }
  }
  return [...byKey.values()];
}

function inferRelationEntityType(name: string, relation: ExtractedStrongRelation, role: "subject" | "object"): string {
  if (/证书|资质|资格|许可|认证/.test(name)) return "certificate";
  if (/人员|负责人|经理|工程师|专家|团队|张|李|王|赵/.test(name)) return "personnel_requirement";
  if (/业绩|合同|项目|案例|经验/.test(name)) return "performance_requirement";
  if (/材料|扫描件|附件|承诺函|证明/.test(name)) return "proof_material";
  if (/评分|得分|分值/.test(name)) return "scoring_item";
  if (/废标|无效|风险/.test(name)) return "invalid_response_clause";
  if (role === "object" && relation.predicate === "REQUIRES") return "requirement";
  if (role === "subject" && relation.predicate === "PROVES") return "proof_material";
  return "subject";
}

function objectMatchesText(object: DomainProfileObject, text: string): boolean {
  return [object.name, ...object.aliases].some((name) => name && text.includes(name));
}

function profileObjectDescription(object: DomainProfileObject): string {
  const confidence = Number.isFinite(object.confidence) ? `，置信度 ${Math.round(object.confidence * 100)}%` : "";
  return `${object.reason || "由文档自动画像识别"}${confidence}`;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function entityKey(type: string, name: string): string {
  return `${type.trim().toLowerCase()}\u0000${name.trim().toLowerCase()}`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function dedupeEntityEmbeddingInputs(entities: ExtractedEntity[]): EntityEmbeddingInput[] {
  const map = new Map<string, EntityEmbeddingInput>();
  for (const entity of entities) {
    const key = entityEmbeddingKey(entity);
    if (!map.has(key)) {
      map.set(key, { key, entity });
    }
  }
  return [...map.values()];
}

function entityEmbeddingKey(entity: ExtractedEntity): string {
  return `${entity.type.trim().toLowerCase()}\u0000${entity.name.trim().toLowerCase()}`;
}

function relationEmbeddingKey(eventId: string, entity: ExtractedEntity): string {
  return `${eventId}\u0000${entityEmbeddingKey(entity)}\u0000${entity.description.trim().toLowerCase()}`;
}

function progressForCompleted(completed: number, total: number, start: number, end: number): number {
  if (total <= 0) {
    return end;
  }
  return Math.min(end, Math.round(start + (completed / total) * (end - start)));
}
