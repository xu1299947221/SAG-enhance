import { aiSettingsService, type AiRuntimeSettings } from "../services/ai-settings-service.js";
import type { ExtractedEntity, ExtractedEvent, EventRecord } from "../types.js";
import { createModelCallLogger } from "../observability/model-call-log.js";
import { biddingCanonicalEntities, biddingEntityTypes, extractBiddingDomainEntities, inferBiddingEntityType } from "../domain/bidding-domain.js";
import { enrichEntitiesWithDiscoveredObjects } from "../domain/domain-object-discovery.js";
import { cleanExtractedEntities } from "../domain/entity-cleaning.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface LlmClient {
  extractNamedEntities(query: string): Promise<string[]>;
  extractEventsFromChunk(input: {
    title: string;
    heading?: string;
    content: string;
    references: string[];
  }): Promise<ExtractedEvent[]>;
  rerankEvents(input: {
    query: string;
    candidates: EventRecord[];
    topK: number;
  }): Promise<string[]>;
}

export class OpenAICompatibleLlmClient implements LlmClient {
  async extractNamedEntities(query: string): Promise<string[]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.hasRemoteLlm) {
      const log = createModelCallLogger({
        kind: "llm",
        operation: "extractNamedEntities.local",
        request: { query }
      });
      const entities = uniqueStrings([
        ...extractBiddingDomainEntities(query, settings.biddingDomainConfig),
        ...localNamedEntities(query)
      ]);
      log.succeed({ named_entities: entities });
      return entities;
    }
    const result = await this.chatJson(settings, {
      system: [
        "Extract named entities important for answering the question. Return JSON only.",
        `For Chinese bidding/procurement questions, prefer canonical bid entities: ${biddingCanonicalEntities(settings.biddingDomainConfig).join(", ")}.`,
        "Keep entities concise and reusable; do not return long sentence fragments."
      ].join("\n"),
      user: JSON.stringify({
        question: query,
        schema: { named_entities: ["string"] }
      })
    });
    const entities = Array.isArray(result.named_entities) ? result.named_entities : result.entities;
    return uniqueStrings([
      ...extractBiddingDomainEntities(query, settings.biddingDomainConfig),
      ...(Array.isArray(entities) ? entities.map(String).filter(Boolean) : localNamedEntities(query))
    ]);
  }

  async extractEventsFromChunk(input: {
    title: string;
    heading?: string;
    content: string;
    references: string[];
  }): Promise<ExtractedEvent[]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.hasRemoteLlm) {
      const log = createModelCallLogger({
        kind: "llm",
        operation: "extractEventsFromChunk.local",
        request: input
      });
      const events = [localExtractEvent(input)];
      log.succeed({ events });
      return events;
    }
    const result = await this.chatJson(settings, {
      operation: "extractEventsFromChunk.benchmarkPipeline",
      messages: buildBenchmarkExtractionMessages(input, settings)
    });
    const items = Array.isArray(result.items) ? result.items : result.data?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return [localExtractEvent(input)];
    }
    const inputIsChinese = isMostlyChinese(input.content);
    const event = buildSingleExtractedEvent(items, input, inputIsChinese, settings.biddingDomainConfig);
    return event ? [event] : [localExtractEvent(input)];
  }

  async rerankEvents(input: {
    query: string;
    candidates: EventRecord[];
    topK: number;
  }): Promise<string[]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.hasRemoteLlm) {
      const log = createModelCallLogger({
        kind: "llm",
        operation: "rerankEvents.local",
        request: input
      });
      const ids = localRerank(input.query, input.candidates, input.topK);
      log.succeed({ useful_event_ids: ids });
      return ids;
    }
    const result = await this.chatJson(settings, {
      system: `Select exactly ${input.topK} event ids most useful for answering the question. Return JSON only.`,
      user: JSON.stringify({
        question: input.query,
        candidates: input.candidates.map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          content: candidate.content.slice(0, 1200),
          score: candidate.score ?? 0
        })),
        output_schema: { useful_event_ids: ["uuid"] }
      })
    });
    const ids = result.useful_event_ids ?? result.event_ids;
    return Array.isArray(ids)
      ? ids.map(String).filter((id) => input.candidates.some((candidate) => candidate.id === id)).slice(0, input.topK)
      : localRerank(input.query, input.candidates, input.topK);
  }

  private async chatJson(settings: AiRuntimeSettings, input: {
    system?: string;
    user?: string;
    messages?: ChatMessage[];
    operation?: string;
  }): Promise<Record<string, any>> {
    const url = `${settings.llmBaseUrl.replace(/\/$/, "")}/chat/completions`;
    const messages = input.messages ?? [
      { role: "system" as const, content: input.system ?? "" },
      { role: "user" as const, content: input.user ?? "" }
    ];
    const body = {
      model: settings.llmModel,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.1
    };

    let lastError: unknown;
    const maxAttempts = settings.llmMaxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), settings.llmTimeoutMs);
      const log = createModelCallLogger({
        kind: "llm",
        operation: input.operation ?? "chatJson",
        request: {
          url,
          method: "POST",
          attempt,
          maxAttempts,
          headers: {
            "Content-Type": "application/json"
          },
          body
        }
      });
      let logged = false;
      try {
        const response = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${settings.llmApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
        const { responseText, responseBody } = await readResponseBody(response);
        if (!response.ok) {
          const error = new Error(`llm request failed: ${response.status} ${responseText.slice(0, 500)}`);
          log.fail(error, {
            status: response.status,
            body: responseBody
          });
          logged = true;
          lastError = error;
          if (attempt < maxAttempts && isRetryableHttpStatus(response.status)) {
            await waitBeforeRetry(attempt);
            continue;
          }
          throw error;
        }
        const json = responseBody as { choices?: Array<{ message?: { content?: string } }> };
        const content = json.choices?.[0]?.message?.content ?? "{}";
        const parsed = JSON.parse(content);
        log.succeed({
          status: response.status,
          body: responseBody,
          parsed
        });
        return parsed;
      } catch (error) {
        lastError = error;
        if (!logged) {
          log.fail(error);
        }
        if (attempt < maxAttempts && isRetryableFetchError(error)) {
          await waitBeforeRetry(attempt);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function parseJsonOrText(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readResponseBody(response: Response): Promise<{ responseText: string; responseBody: unknown }> {
  const maybeText = (response as Response & { text?: () => Promise<string> }).text;
  if (typeof maybeText === "function") {
    const responseText = await maybeText.call(response);
    return {
      responseText,
      responseBody: parseJsonOrText(responseText)
    };
  }
  const responseBody = await (response as Response & { json: () => Promise<unknown> }).json();
  return {
    responseText: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
    responseBody
  };
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || error.message.includes("fetch failed");
}

async function waitBeforeRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(1_000, 100 * 2 ** Math.max(0, attempt - 1));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function buildBenchmarkExtractionMessages(input: {
  title: string;
  heading?: string;
  content: string;
  references: string[];
}, settings?: AiRuntimeSettings): ChatMessage[] {
  const domainConfig = settings?.biddingDomainConfig;
  const userInput = {
    type: "request",
    data: {
      items: [{
        id: 1,
        content: [
          input.heading ? `# ${input.heading}` : "",
          input.content
        ].filter(Boolean).join("\n\n")
      }],
      meta: {
        source_type: "article",
        source_title: input.title,
        source_summary: "",
        previous_context: "",
        related_events: [],
        entity_types: benchmarkEntityTypes(domainConfig),
        output_language: "Use the same main language as the input text. Chinese input must produce Chinese fields; English input must produce English fields."
      }
    },
    output_schema: benchmarkExtractionSchema(domainConfig)
  };
  return [
    { role: "system", content: buildBenchmarkExtractionSystemPrompt() },
    { role: "user", content: JSON.stringify(benchmarkExtractionExampleInput(domainConfig)) },
    { role: "assistant", content: JSON.stringify(benchmarkExtractionExampleOutput()) },
    { role: "user", content: JSON.stringify(userInput) }
  ];
}

function benchmarkEntityTypes(domainConfig?: AiRuntimeSettings["biddingDomainConfig"]) {
  return [
    { type: "person", description: "人物、作者、用户、负责人等具体个人" },
    { type: "organization", description: "公司、机构、团体、政府部门、学校、团队等组织" },
    { type: "location", description: "地点、地域、国家、城市、场所、地址" },
    { type: "time", description: "日期、年份、时期、时间表达" },
    { type: "product", description: "产品、系统、平台、模型、软件、服务、数据库" },
    { type: "metric", description: "数字、指标、金额、比例、数量、评分、性能数据" },
    { type: "action", description: "动作、行为、流程、操作、状态变化" },
    { type: "work", description: "作品、文档、论文、项目、任务、计划" },
    { type: "group", description: "人群、角色群体、职业群体、用户群体" },
    ...biddingEntityTypes(domainConfig),
    { type: "subject", description: "主题、概念、领域、技术、专业术语、事件名称" },
    { type: "tags", description: "其他类型均不匹配时使用的标签实体" }
  ];
}

function benchmarkExtractionExampleInput(domainConfig?: AiRuntimeSettings["biddingDomainConfig"]) {
  return {
    type: "request",
    data: {
      items: [{
        id: 1,
        content: "# SAG 检索\n\nSAG 将文档切成 chunk，抽取单个融合事项和实体，再通过 entity-event 关系进行多跳检索。"
      }],
      meta: {
        source_type: "article",
        source_title: "SAG 说明",
        source_summary: "",
        previous_context: "",
        related_events: [],
        entity_types: benchmarkEntityTypes(domainConfig)
      }
    },
    output_schema: benchmarkExtractionSchema(domainConfig)
  };
}

function benchmarkExtractionExampleOutput() {
  return {
    type: "response",
    data: {
      items: [{
        title: "SAG 文档入库与多跳检索流程",
        summary: "SAG 通过 chunk、融合事项、实体和 entity-event 关系组织文档，以支持多跳检索。",
        content: "SAG 将文档切分为 chunk，并从每个 chunk 中抽取单个融合事项和关键实体，再利用 entity-event 关系进行多跳检索。",
        category: "检索流程",
        keywords: ["SAG", "chunk", "融合事项", "实体", "多跳检索"],
        priority: "UNKNOWN",
        status: "COMPLETED",
        references: [1],
        entities: [
          { type: "product", name: "SAG", description: "执行文档入库和多跳检索的系统" },
          { type: "subject", name: "chunk", description: "SAG 文档入库时形成的原文切片" },
          { type: "subject", name: "entity-event 关系", description: "SAG 多跳检索依赖的事项与实体连接关系" }
        ],
        is_valid: true,
        children: []
      }],
      meta: {
        reason: "识别出一个围绕 SAG 入库与检索的统一主题；覆盖 id1 的 chunk、事项、实体和多跳检索信息；无孤立有效片段。",
        confidence: 0.9
      }
    }
  };
}

function benchmarkExtractionSchema(domainConfig?: AiRuntimeSettings["biddingDomainConfig"]) {
  return {
    type: "object",
    required: ["type", "data"],
    properties: {
      type: { const: "response" },
      data: {
        type: "object",
        required: ["items", "meta"],
        properties: {
          items: {
            type: "array",
            minItems: 0,
            maxItems: 1,
            items: {
              type: "object",
              required: ["title", "summary", "content", "category", "keywords", "references", "entities", "is_valid"],
              properties: {
                title: { type: "string" },
                summary: { type: "string" },
                content: { type: "string" },
                category: { type: "string" },
                keywords: { type: "array", items: { type: "string" } },
                priority: { enum: ["HIGH", "MEDIUM", "LOW", "UNKNOWN"] },
                status: { enum: ["COMPLETED", "PROCESSING", "PENDING", "UNKNOWN"] },
                references: { type: "array", items: { type: "integer" } },
                entities: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["type", "name", "description"],
                    properties: {
                      type: { enum: benchmarkEntityTypes(domainConfig).map((entityType) => entityType.type) },
                      name: { type: "string" },
                      description: { type: "string" }
                    }
                  }
                },
                is_valid: { type: "boolean" },
                children: { type: "array", maxItems: 0 }
              }
            }
          },
          meta: {
            type: "object",
            required: ["reason"],
            properties: {
              reason: { type: "string" },
              confidence: { type: "number" }
            }
          }
        }
      }
    }
  };
}

function buildBenchmarkExtractionSystemPrompt(): string {
  const now = new Date().toISOString();
  return `
## Role

You are a professional SAG content extractor. Extract exactly two structured objects from raw documents: events and entities.

## Benchmark-aligned Event Principles

- Mandatory single event: all valid fragments in the input must be fused into one comprehensive top-level event. Do not split different topics into multiple top-level events.
- Global scan first: identify time, location, subject, action, object, data, evaluation, cause/effect, comparison, and relationship units before writing the event.
- Cross-fragment association: resolve subject continuity, temporal continuity, causal/progressive links, contrasts, aliases, and references.
- Information coverage: every valid information unit must be represented in the single event or explicitly treated as noise in data.meta.reason.
- Faithfulness: do not invent facts, omit core facts, change the subject, or mechanically copy long original text.
- Panoramic integration: the event content should be an organic narrative thread, not a bullet list.
- Preserve relative time expressions unless the source already gives exact dates.

## Entity Principles

- Extract the entities required to understand the event, especially subjects, actions/predicates, objects, products, systems, models, metrics, organizations, people, locations, dates, and key concepts.
- Split coordinated entities such as "A and B" into separate entities.
- Use only the provided entity_types. Prefer specific types; use tags only when no specific type fits.
- Each entity.description must explain that entity's concrete role or relationship in the event.

## Chinese Bidding/Procurement Adaptation

When the input is a Chinese 招标文件、采购文件、磋商文件、投标/响应文件, treat it as intelligent-bidding material:

- Prefer bid-domain entities over generic fragments. Use canonical names such as "供应商资格条件", "类似业绩要求", "项目负责人要求", "人员证书要求", "评分标准", "无效响应条款", "付款方式", "服务期限", "验收要求", "质保期", "证明材料".
- Extract relationships that matter for response writing: who must satisfy a requirement, what certificate/performance/material is required, what time or amount limit applies, what project type is referenced, what clause causes invalid response, and what scoring item it affects.
- Do not create vague broken names like "投标人拟派本项目的项目" or "具有履行合同所必需的设备和专业技术". Rewrite them to concise reusable entities, for example "拟派项目负责人", "履约设备和专业技术能力证明".
- Event title/category should expose the bidding purpose, for example "供应商资格审查要求", "项目团队人员与证书要求", "类似业绩评分规则", "无效响应情形".
- The event content should preserve clause logic across nearby paragraphs: condition, object, evidence material, threshold/time/amount, consequence.

## Input Contract

The user message is JSON:
- type: "request"
- data.items: content fragments, each with 1-based id and content
- data.meta.source_type, source_title, source_summary, previous_context, related_events, entity_types
- output_schema: JSON schema for the response

Current time: ${now}

## Output Contract

Return JSON only. Do not wrap it in markdown.
The response must be:
{
  "type": "response",
  "data": {
    "items": [
      {
        "title": "...",
        "summary": "...",
        "content": "...",
        "category": "...",
        "keywords": ["..."],
        "priority": "HIGH|MEDIUM|LOW|UNKNOWN",
        "status": "COMPLETED|PROCESSING|PENDING|UNKNOWN",
        "references": [1],
        "entities": [{ "type": "...", "name": "...", "description": "..." }],
        "is_valid": true,
        "children": []
      }
    ],
    "meta": {
      "reason": "...",
      "confidence": 0.9
    }
  }
}

## Strict Rules

- data.items must contain exactly one valid event unless the input has no useful factual content.
- children must be an empty array.
- references must cite all valid fragments used by the fused event and no unrelated fragments.
- meta.reason must state the topic identification logic, cross-fragment association evidence, semantic restructuring choices, coverage status, and noise handling.
- Output language must follow the main input language. Chinese input requires Chinese title, summary, content, category, entity descriptions, and reason.
`.trim();
}

function normalizeEntities(
  raw: unknown,
  inputIsChinese: boolean,
  domainConfig?: AiRuntimeSettings["biddingDomainConfig"]
): ExtractedEntity[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      const record = item as Record<string, unknown>;
      const name = String(record.name ?? "").trim();
      const description = String(record.description ?? "").trim();
      return {
        type: normalizeEntityType(String(record.type ?? "subject"), domainConfig),
        name,
        description: normalizeEntityDescription(description, inputIsChinese)
      };
    })
    .filter((entity) => entity.name.length > 1);
}

function collectValidEventItems(items: unknown[]): Array<Record<string, unknown>> {
  const collected: Array<Record<string, unknown>> = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.is_valid !== false) {
      collected.push(record);
    }
    if (Array.isArray(record.children)) {
      collected.push(...collectValidEventItems(record.children));
    }
  }
  return collected;
}

function buildSingleExtractedEvent(
  items: unknown[],
  input: { title: string; heading?: string; content: string; references: string[] },
  inputIsChinese: boolean,
  domainConfig?: AiRuntimeSettings["biddingDomainConfig"]
): ExtractedEvent | null {
  const eventItems = collectValidEventItems(items);
  if (eventItems.length === 0) {
    return null;
  }

  const primary = eventItems[0];
  const content = buildConciseEventContent(eventItems, input.content, inputIsChinese);
  if (isLikelyLanguageDrift(content, inputIsChinese)) {
    return null;
  }
  const keywords = uniqueStrings(
    eventItems.flatMap((item) => Array.isArray(item.keywords) ? item.keywords.map(String) : [])
  );
  const discoveredEntities = cleanExtractedEntities(enrichEntitiesWithDiscoveredObjects(
    uniqueEntities(eventItems.flatMap((item) => normalizeEntities(item.entities, inputIsChinese, domainConfig))),
    input.content,
    24
  ), { text: input.content, inputIsChinese, limit: 24 });
  const entities = cleanExtractedEntities(
    enrichWithBiddingDomainEntities(discoveredEntities, input.content, inputIsChinese, domainConfig),
    {
      text: input.content,
      inputIsChinese,
      preserveNames: extractBiddingDomainEntities(input.content, domainConfig, { includeExpansions: false }),
      limit: 24
    }
  );
  const title = normalizeEventTitle(String(primary.title ?? ""), input, content, inputIsChinese);
  const summary = normalizeEventText(String(primary.summary ?? ""), title, inputIsChinese);
  const category = normalizeCategory(primary.category, inputIsChinese);

  return {
    title,
    summary,
    content,
    category,
    keywords: keywords.length > 0 ? keywords : localKeywords(input.content),
    references: input.references,
    entities
  };
}

function normalizeEventText(value: string, fallback: string, inputIsChinese: boolean): string {
  const text = value.trim();
  if (!text || isLikelyLanguageDrift(text, inputIsChinese)) {
    return fallback;
  }
  return text;
}

function normalizeEventTitle(
  value: string,
  input: { title: string; heading?: string; content: string },
  eventContent: string,
  inputIsChinese: boolean
): string {
  const candidates = [
    value,
    input.heading,
    firstSentence(eventContent),
    firstSentence(input.content),
    input.title
  ];
  for (const candidate of candidates) {
    const title = cleanTitle(candidate ?? "");
    if (!title || isGenericEventTitle(title) || isLikelyLanguageDrift(title, inputIsChinese)) {
      continue;
    }
    return conciseTitle(title, inputIsChinese);
  }
  return inputIsChinese ? "文档事项" : "Document event";
}

function enrichWithBiddingDomainEntities(
  entities: ExtractedEntity[],
  content: string,
  inputIsChinese: boolean,
  domainConfig?: AiRuntimeSettings["biddingDomainConfig"]
): ExtractedEntity[] {
  const existing = new Set(entities.map((entity) => entity.name.trim().toLowerCase()));
  const enriched = [...entities];
  for (const name of extractBiddingDomainEntities(content, domainConfig, { includeExpansions: false })) {
    const key = name.toLowerCase();
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    enriched.push({
      type: normalizeEntityType(inferBiddingEntityType(name, domainConfig) ?? "subject", domainConfig),
      name,
      description: inputIsChinese ? `从应标领域词表和原文命中补充的实体：${name}` : `Bid-domain entity matched from content: ${name}`
    });
  }
  return enriched.slice(0, 24);
}

function normalizeCategory(value: unknown, inputIsChinese: boolean): string {
  const fallback = inputIsChinese ? "一般事项" : "general";
  const category = value == null ? "" : String(value).trim();
  const hasChinese = /[\u4e00-\u9fa5]/.test(category);
  if (!category || isLikelyLanguageDrift(category, inputIsChinese) || (inputIsChinese && !hasChinese)) {
    return fallback;
  }
  return category;
}

function normalizeEntityDescription(description: string, inputIsChinese: boolean): string {
  if (!description || isLikelyLanguageDrift(description, inputIsChinese)) {
    return inputIsChinese ? "在当前事项中被提及" : "Mentioned in the current event";
  }
  return description;
}

function buildConciseEventContent(
  eventItems: Array<Record<string, unknown>>,
  fallbackContent: string,
  inputIsChinese: boolean
): string {
  const candidates = uniqueStrings(
    eventItems.flatMap((item) => [
      String(item.summary ?? "").trim(),
      String(item.content ?? "").trim()
    ]).filter(Boolean)
  );
  const raw = candidates.join(inputIsChinese ? "；" : "; ") || fallbackContent.trim();
  return conciseText(raw, inputIsChinese);
}

function conciseText(text: string, inputIsChinese: boolean): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const maxLength = inputIsChinese ? 180 : 360;
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  const sentencePattern = inputIsChinese ? /[^。！？；;]+[。！？；;]?/gu : /[^.!?;]+[.!?;]?/g;
  const sentences = cleaned.match(sentencePattern)?.map((item) => item.trim()).filter(Boolean) ?? [cleaned];
  const selected: string[] = [];
  let length = 0;
  for (const sentence of sentences) {
    if (selected.length >= 3) {
      break;
    }
    if (length + sentence.length > maxLength && selected.length > 0) {
      break;
    }
    selected.push(sentence);
    length += sentence.length;
  }
  const result = selected.join(inputIsChinese ? "" : " ").trim();
  if (result.length <= maxLength) {
    return result;
  }
  return `${result.slice(0, maxLength - 1).trim()}…`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Set<string>();
  const result: ExtractedEntity[] = [];
  for (const entity of entities) {
    const key = `${entity.type}:${entity.name.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entity);
  }
  return result;
}

function localExtractEvent(input: {
  title: string;
  heading?: string;
  content: string;
  references: string[];
}): ExtractedEvent {
  const zh = isMostlyChinese(input.content);
  const title = normalizeEventTitle("", input, input.content, zh);
  const keywords = localKeywords(`${title} ${input.content}`);
  const baseEntities = localNamedEntities(`${title} ${input.content}`).slice(0, 12).map((name) => ({
    type: inferEntityType(name),
    name,
    description: zh ? `在事项「${title}」中被提及` : `Mentioned in event: ${title}`
  }));
  const discoveredEntities = enrichEntitiesWithDiscoveredObjects(baseEntities, `${title} ${input.content}`, 24);
  const text = `${title} ${input.content}`;
  const entities = cleanExtractedEntities(
    enrichWithBiddingDomainEntities(discoveredEntities, text, zh),
    {
      text,
      inputIsChinese: zh,
      preserveNames: extractBiddingDomainEntities(text, undefined, { includeExpansions: false }),
      limit: 24
    }
  );
  return {
    title,
    summary: conciseText(firstSentence(input.content) || title, zh),
    content: conciseText(input.content, zh),
    category: zh ? "一般事项" : "general",
    keywords,
    priority: "UNKNOWN",
    status: "COMPLETED",
    references: input.references,
    entities
  };
}

function localNamedEntities(text: string): string[] {
  const candidates = new Set<string>();
  const titleCaseMatches = text.match(/\b[A-Z][A-Za-z0-9]+(?:[-\s][A-Z][A-Za-z0-9]+){0,4}\b/g) ?? [];
  for (const match of titleCaseMatches) {
    candidates.add(match.trim());
  }
  const quotedMatches = text.match(/["'“”]([^"'“”]{2,80})["'“”]/g) ?? [];
  for (const match of quotedMatches) {
    candidates.add(match.replace(/["'“”]/g, "").trim());
  }
  const cjkMatches = text.match(/[\u4e00-\u9fa5A-Za-z0-9_-]{2,24}(?:公司|集团|大学|模型|系统|产品|项目|技术|平台|算法|数据库|方案)/g) ?? [];
  for (const match of cjkMatches) {
    candidates.add(match.trim());
  }
  return [...candidates].filter((item) => item.length > 1).slice(0, 20);
}

function localKeywords(text: string): string[] {
  if (isMostlyChinese(text)) {
    const cjkTerms = text.match(/[\u4e00-\u9fa5A-Za-z0-9_-]{2,18}/g) ?? [];
    return [...new Set(cjkTerms)].slice(0, 10);
  }
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !["the", "and", "for", "with", "from", "that"].includes(token));
  return [...new Set(tokens)].slice(0, 10);
}

function localRerank(query: string, candidates: EventRecord[], topK: number): string[] {
  const queryTokens = new Set(localKeywords(query));
  return [...candidates]
    .sort((a, b) => {
      const overlapA = overlapScore(queryTokens, `${a.title} ${a.content}`);
      const overlapB = overlapScore(queryTokens, `${b.title} ${b.content}`);
      return (overlapB + (b.score ?? 0)) - (overlapA + (a.score ?? 0));
    })
    .slice(0, topK)
    .map((candidate) => candidate.id);
}

function overlapScore(queryTokens: Set<string>, text: string): number {
  const tokens = new Set(localKeywords(text));
  let score = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) {
      score += 1;
    }
  }
  return score;
}

function firstSentence(text: string): string {
  return text.trim().split(/(?<=[.!?。！？])\s+/u)[0]?.slice(0, 120) ?? "";
}

function cleanTitle(text: string): string {
  return text.replace(/^#+\s*/, "").trim().slice(0, 160) || "Untitled event";
}

function isGenericEventTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  if (/^\d+[.．、)]?$/.test(normalized)) {
    return true;
  }
  return [
    "introduction",
    "untitled",
    "untitled event",
    "general",
    "正文",
    "文档",
    "内容",
    "首页"
  ].includes(normalized);
}

function conciseTitle(title: string, inputIsChinese: boolean): string {
  const cleaned = title
    .replace(/\[图片\]/g, " ")
    .replace(/blob:file:\/\/\/[A-Za-z0-9._-]+/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^(首页|返回|当前位置)[\s：:]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
  const maxLength = inputIsChinese ? 32 : 80;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
}

function isMostlyChinese(text: string): boolean {
  const cjkChars = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  const latinWords = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  return cjkChars > latinWords * 2;
}

function isLikelyLanguageDrift(text: string, inputIsChinese: boolean): boolean {
  const cjkChars = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  const latinWords = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  if (inputIsChinese) {
    return cjkChars === 0 && latinWords >= 4;
  }
  return cjkChars >= 8 && latinWords <= 2;
}

function inferEntityType(name: string): string {
  const biddingType = inferBiddingEntityType(name);
  if (biddingType) return biddingType;
  if (/\d/.test(name)) return "metric";
  if (/(Inc|Corp|LLC|Ltd|Company|Group|公司|集团|大学|组织)$/i.test(name)) return "organization";
  if (/(System|Platform|Product|系统|平台|产品|模型|数据库)$/i.test(name)) return "product";
  if (/(Search|Retrieval|检索|搜索|算法|技术|方案)$/i.test(name)) return "subject";
  return "subject";
}

function normalizeEntityType(type: string, domainConfig?: AiRuntimeSettings["biddingDomainConfig"]): string {
  const allowed = new Set(benchmarkEntityTypes(domainConfig).map((entityType) => entityType.type));
  return allowed.has(type) ? type : "subject";
}

export const llmClient = new OpenAICompatibleLlmClient();
