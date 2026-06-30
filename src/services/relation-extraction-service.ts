import { aiSettingsService, type AiRuntimeSettings } from "./ai-settings-service.js";
import { createModelCallLogger } from "../observability/model-call-log.js";
import {
  getRelationDefinition,
  isReasoningRelation,
  normalizeRelation,
  relationMinConfidence,
  relationPromptCatalog,
  relationStrength
} from "../domain/relation-ontology.js";
import type { ExtractedEntity, RelationConfigRecord } from "../types.js";

export interface RelationExtractionInput {
  documentTitle: string;
  documentType?: string;
  chunkHeading?: string;
  chunkContent: string;
  eventTitle?: string;
  eventSummary?: string;
  eventContent?: string;
  extractedEntities: ExtractedEntity[];
  projectRelationConfig?: Partial<RelationConfigRecord>;
}

export interface ExtractedStrongRelation {
  subject: string;
  predicate: string;
  object: string;
  displayLabel: string;
  evidence: string;
  confidence: number;
  qualityScore: number;
  reason?: string;
  evidenceStart?: number;
  evidenceEnd?: number;
  extractionMethod: "llm_relation_extraction" | "local_relation_extraction";
  extractionModel?: string | null;
  promptVersion: string;
}

const PROMPT_VERSION = "relation-extraction-v1";
const MAX_RELATIONS_PER_EVENT = 12;

export class RelationExtractionService {
  async extractRelations(input: RelationExtractionInput): Promise<ExtractedStrongRelation[]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    const fallback = localExtractRelations(input);
    if (!settings.hasRemoteLlm || input.extractedEntities.length < 2) {
      return fallback;
    }

    try {
      return normalizeRemoteRelations(await callRemoteRelationExtraction(settings, input), input, settings.llmModel);
    } catch {
      return fallback;
    }
  }
}

export const relationExtractionService = new RelationExtractionService();

async function callRemoteRelationExtraction(settings: AiRuntimeSettings, input: RelationExtractionInput): Promise<unknown> {
  const url = `${settings.llmBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: settings.llmModel,
    messages: [
      {
        role: "system",
        content: [
          "你是 SAG 强关系抽取器。只抽取原文明确支持的 subject-predicate-object 关系。",
          "返回 JSON，不要 markdown。",
          "规则：",
          "1. predicate 必须从 relation_catalog.type 中选择。",
          "2. 每条关系必须有 evidence，evidence 必须来自原文短句。",
          "3. 不要因为两个对象同段出现就连边。",
          "4. RELATED_TO 只能在确实无法判断更具体关系时少量使用，并给低 confidence。",
          "5. 优先抽取可用于推理的强关系，例如 REQUIRES、SATISFIES、PROVES、HOLDS、HAS_EXPERIENCE、MATCHES_TYPE、SCORES_FOR、CAUSES_RISK、SUBMITS。",
          "6. subject/object 使用 extracted_entities 中的实体名；确有必要时可输出原文中的新实体名。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          document_title: input.documentTitle,
          document_type: input.documentType,
          chunk_heading: input.chunkHeading,
          text: compactText([input.eventTitle, input.eventSummary, input.eventContent || input.chunkContent].filter(Boolean).join("\n"), 6000),
          extracted_entities: input.extractedEntities.map((entity) => ({
            name: entity.name,
            type: entity.type,
            description: entity.description
          })),
          relation_catalog: relationPromptCatalog(),
          project_relation_config: input.projectRelationConfig ?? {},
          output_schema: {
            relations: [{
              subject: "entity name",
              predicate: "relation type",
              object: "entity name",
              displayLabel: "中文关系短标签",
              evidence: "原文证据短句",
              confidence: "0-1 number",
              reason: "why"
            }]
          }
        })
      }
    ],
    response_format: { type: "json_object" },
    temperature: 0.1
  };
  const log = createModelCallLogger({
    kind: "llm",
    operation: "relation.extractStrongRelations",
    request: {
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body
    }
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.llmTimeoutMs);
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
    const text = await response.text();
    const parsedBody = parseJsonOrText(text);
    if (!response.ok) {
      const error = new Error(`relation extraction request failed: ${response.status} ${text.slice(0, 500)}`);
      log.fail(error, { status: response.status, body: parsedBody });
      throw error;
    }
    const content = (parsedBody as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content);
    log.succeed({ status: response.status, parsed });
    return parsed;
  } catch (error) {
    log.fail(error);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRemoteRelations(raw: unknown, input: RelationExtractionInput, model: string): ExtractedStrongRelation[] {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const items = Array.isArray(record.relations) ? record.relations : [];
  return items
    .map((item) => normalizeRelationItem(item, input, "llm_relation_extraction", model))
    .filter((item): item is ExtractedStrongRelation => Boolean(item))
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, MAX_RELATIONS_PER_EVENT);
}

function localExtractRelations(input: RelationExtractionInput): ExtractedStrongRelation[] {
  const text = relationText(input);
  const entities = input.extractedEntities.filter((entity) => text.includes(entity.name));
  const relations: ExtractedStrongRelation[] = [];
  for (const subject of entities) {
    for (const object of entities) {
      if (subject.name === object.name) continue;
      const predicate = inferLocalPredicate(subject, object, text);
      if (!predicate) continue;
      const definition = normalizeRelation(predicate);
      const evidence = pickEvidence(text, subject.name, object.name);
      if (!evidence) continue;
      const confidence = definition.type === "RELATED_TO" ? 0.55 : 0.68;
      const qualityScore = scoreRelation({
        predicate: definition.type,
        confidence,
        evidence,
        subject: subject.name,
        object: object.name,
        status: "AUTO"
      });
      if (!passesRelation(input, definition.type, confidence, evidence)) continue;
      relations.push({
        subject: subject.name,
        predicate: definition.type,
        object: object.name,
        displayLabel: definition.label,
        evidence,
        confidence,
        qualityScore,
        reason: "本地规则从同一句明确触发词抽取",
        evidenceStart: text.indexOf(evidence) >= 0 ? text.indexOf(evidence) : undefined,
        evidenceEnd: text.indexOf(evidence) >= 0 ? text.indexOf(evidence) + evidence.length : undefined,
        extractionMethod: "local_relation_extraction",
        promptVersion: PROMPT_VERSION
      });
    }
  }
  return dedupeRelations(relations).slice(0, MAX_RELATIONS_PER_EVENT);
}

function normalizeRelationItem(
  item: unknown,
  input: RelationExtractionInput,
  extractionMethod: ExtractedStrongRelation["extractionMethod"],
  model?: string | null
): ExtractedStrongRelation | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const subject = normalizeEntityName(String(record.subject ?? ""));
  const object = normalizeEntityName(String(record.object ?? ""));
  if (!subject || !object || subject === object) return null;
  const normalized = normalizeRelation(String(record.predicate ?? record.relation ?? record.displayLabel ?? ""));
  const evidence = normalizeEvidence(record.evidence);
  const confidence = clampNumber(Number(record.confidence), 0, 1, 0.7);
  if (!passesRelation(input, normalized.type, confidence, evidence)) return null;
  const text = relationText(input);
  const evidenceStart = evidence && text.includes(evidence) ? text.indexOf(evidence) : undefined;
  const qualityScore = scoreRelation({
    predicate: normalized.type,
    confidence,
    evidence,
    subject,
    object,
    status: "AUTO"
  });
  return {
    subject,
    predicate: normalized.type,
    object,
    displayLabel: normalizeText(record.displayLabel ?? record.relation) || normalized.label,
    evidence,
    confidence,
    qualityScore,
    reason: normalizeText(record.reason),
    evidenceStart,
    evidenceEnd: evidenceStart == null ? undefined : evidenceStart + evidence.length,
    extractionMethod,
    extractionModel: model ?? null,
    promptVersion: PROMPT_VERSION
  };
}

function passesRelation(input: RelationExtractionInput, predicate: string, confidence: number, evidence: string): boolean {
  if (!evidence) return false;
  const definition = getRelationDefinition(predicate);
  if (!definition) return false;
  if (definition.type === "RELATED_TO" && confidence < 0.82) return false;
  const configured = input.projectRelationConfig?.minConfidence?.[definition.type];
  const minConfidence = typeof configured === "number" ? configured : relationMinConfidence(definition.type);
  if (confidence < minConfidence) return false;
  if (input.projectRelationConfig?.disabledRelations?.includes(definition.type)) return false;
  return true;
}

export function scoreRelation(input: {
  predicate: string;
  confidence: number;
  evidence?: string | null;
  subject?: string;
  object?: string;
  status?: "AUTO" | "CONFIRMED" | "REJECTED" | "DISABLED";
}): number {
  const confidence = clampNumber(input.confidence, 0, 1, 0.7);
  const strengthWeight = relationStrength(input.predicate) === "strong" ? 0.12 : -0.08;
  const reasoningWeight = isReasoningRelation(input.predicate) ? 0.06 : -0.04;
  const evidence = input.evidence ?? "";
  const evidenceWeight = evidence.length >= 8 ? 0.08 : -0.25;
  const mentionWeight = input.subject && input.object && evidence.includes(input.subject) && evidence.includes(input.object) ? 0.06 : 0;
  const confirmedWeight = input.status === "CONFIRMED" ? 0.12 : 0;
  const rejectedPenalty = input.status === "REJECTED" || input.status === "DISABLED" ? -1 : 0;
  const relatedPenalty = input.predicate === "RELATED_TO" ? -0.18 : 0;
  return Math.max(0, Math.min(1, confidence + strengthWeight + reasoningWeight + evidenceWeight + mentionWeight + confirmedWeight + rejectedPenalty + relatedPenalty));
}

function inferLocalPredicate(subject: ExtractedEntity, object: ExtractedEntity, text: string): string | null {
  const evidence = pickEvidence(text, subject.name, object.name);
  if (!evidence) return null;
  if (/certificate|proof_material|document_material/.test(subject.type) && /持有|具备|拥有|取得|须|必须|应当|需/.test(evidence)) {
    if (/personnel|requirement|subject/.test(object.type)) return null;
  }
  if (/须|必须|应当|需|要求|提供|具备/.test(evidence) && /要求|资格|人员|证书|资质|材料|条件/.test(`${subject.type}${object.type}${evidence}`)) {
    return subject.type.includes("requirement") ? "REQUIRES" : "HOLDS";
  }
  if (/证明|佐证|支撑|可用于响应|用于响应/.test(evidence)) return "PROVES";
  if (/满足|符合|响应|匹配/.test(evidence)) return "SATISFIES";
  if (/持有|具备|拥有|取得/.test(evidence)) return "HOLDS";
  if (/业绩|案例|经验/.test(evidence) && /具备|具有|拥有|提供/.test(evidence)) return "HAS_EXPERIENCE";
  if (/评分|得分|加分/.test(evidence)) return "SCORES_FOR";
  if (/废标|无效响应|风险|扣分/.test(evidence)) return "CAUSES_RISK";
  if (/生成|产生|输出|形成/.test(evidence)) return "PRODUCES";
  if (/包含|包括|组成/.test(evidence)) return "CONTAINS";
  return null;
}

function pickEvidence(text: string, subject: string, object: string): string {
  const sentences = text
    .split(/(?<=[。！？.!?；;])|\n+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return sentences.find((sentence) => sentence.includes(subject) && sentence.includes(object) && sentence.length <= 260)
    ?? sentences.find((sentence) => sentence.includes(subject) && sentence.length <= 220)
    ?? "";
}

function dedupeRelations(relations: ExtractedStrongRelation[]): ExtractedStrongRelation[] {
  const byKey = new Map<string, ExtractedStrongRelation>();
  for (const relation of relations) {
    const key = `${relation.subject}\u0000${relation.predicate}\u0000${relation.object}`;
    const existing = byKey.get(key);
    if (!existing || relation.qualityScore > existing.qualityScore) {
      byKey.set(key, relation);
    }
  }
  return [...byKey.values()].sort((a, b) => b.qualityScore - a.qualityScore);
}

function relationText(input: RelationExtractionInput): string {
  return [input.eventTitle, input.eventSummary, input.eventContent, input.chunkHeading, input.chunkContent]
    .filter(Boolean)
    .join("\n");
}

function normalizeEntityName(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^[：:，,。；;\s]+|[：:，,。；;\s]+$/g, "").trim();
}

function normalizeEvidence(value: unknown): string {
  return normalizeText(value).slice(0, 500);
}

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function compactText(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function parseJsonOrText(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
