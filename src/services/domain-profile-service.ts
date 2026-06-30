import { aiSettingsService, type AiRuntimeSettings } from "./ai-settings-service.js";
import { createModelCallLogger } from "../observability/model-call-log.js";
import type { DiscoveredDomainObject } from "../domain/domain-object-discovery.js";
import { normalizeRelation, relationPromptCatalog } from "../domain/relation-ontology.js";

export interface DomainProfileInput {
  title: string;
  content: string;
  candidates: DiscoveredDomainObject[];
}

export interface DomainProfileObject {
  name: string;
  type: string;
  aliases: string[];
  count: number;
  confidence: number;
  reason: string;
}

export interface DomainProfileRelation {
  source: string;
  target: string;
  predicate: string;
  relation: string;
  evidence?: string;
  confidence: number;
}

export interface DomainProfileResult {
  documentType: string;
  objects: DomainProfileObject[];
  relations: DomainProfileRelation[];
}

const ALLOWED_PROFILE_TYPES = new Set([
  "requirement",
  "document_material",
  "process",
  "system_object",
  "data_object",
  "time_constraint",
  "amount_or_score",
  "risk_or_exception",
  "qualification_requirement",
  "performance_requirement",
  "certificate",
  "personnel_requirement",
  "scoring_item",
  "invalid_response_clause",
  "proof_material",
  "business_requirement",
  "project_scope",
  "technical_requirement",
  "security_requirement",
  "operation_requirement",
  "response_strategy",
  "subject",
  "product",
  "organization",
  "metric"
]);

export class DomainProfileService {
  async profileDocument(input: DomainProfileInput): Promise<DomainProfileResult> {
    const settings = await aiSettingsService.getRuntimeSettings();
    const fallback = localProfileDocument(input);
    if (!settings.hasRemoteLlm || input.candidates.length === 0) {
      return fallback;
    }

    try {
      return normalizeProfileResult(await callRemoteProfile(settings, input), fallback);
    } catch {
      return fallback;
    }
  }
}

export const domainProfileService = new DomainProfileService();

async function callRemoteProfile(settings: AiRuntimeSettings, input: DomainProfileInput): Promise<unknown> {
  const url = `${settings.llmBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: settings.llmModel,
    messages: [
      {
        role: "system",
        content: [
          "你是 SAG 文件自动画像器。你的任务不是按固定词表匹配，而是从文件内容和候选对象中去噪、合并、命名、分类。",
          "返回 JSON，不要 markdown。",
          "要求：",
          "1. 判断 document_type，例如：操作手册、招标文件、应标素材、技术方案、合同材料、未知文档。",
          "2. objects 只保留文件里真正重要、可复用、适合构建图谱的领域对象；过滤普通动词、整句、提示语、过泛词。",
          "3. 合并同义对象，例如 文件上传/上传文件，报告生成/生成报告。",
          "4. name 必须简短，通常 2-12 个中文字符；不要输出长句。",
          "5. type 使用候选 type 或更合适的通用类型。",
          "6. relations 只输出有明确证据的对象关系，不能只因为两个对象同段出现就连边。",
          "7. predicate 必须从 relation_catalog 的 type 中选择；不确定时才用 RELATED_TO，并降低 confidence。",
          "8. relation 写中文短标签，例如 包含、证明、满足、产生、限制。",
          "9. 不要为了凑数输出低价值对象。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          title: input.title,
          content_preview: compactText(input.content, 6000),
          candidates: input.candidates.slice(0, 80).map((candidate) => ({
            name: candidate.name,
            type: candidate.type,
            count: candidate.count,
            description: candidate.description
          })),
          relation_catalog: relationPromptCatalog(),
          output_schema: {
            document_type: "string",
            objects: [{
              name: "string",
              type: "string",
              aliases: ["string"],
              count: "number",
              confidence: "number",
              reason: "string"
            }],
            relations: [{
              source: "object name",
              target: "object name",
              predicate: "relation type from relation_catalog",
              relation: "string",
              evidence: "string",
              confidence: "number"
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
    operation: "domain.profileDocument",
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
      const error = new Error(`domain profile request failed: ${response.status} ${text.slice(0, 500)}`);
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

export function localProfileDocument(input: DomainProfileInput): DomainProfileResult {
  const objects = mergeLocalCandidates(input.candidates)
    .filter((object) => object.count > 1 || object.name.length >= 4 || /要求|材料|文件|任务|报告|配置|权限|系统|助手|模型/.test(object.name))
    .slice(0, 40)
    .map((object) => ({
      name: object.name,
      type: normalizeType(object.type),
      aliases: [],
      count: object.count,
      confidence: localConfidence(object),
      reason: "由文件内容中的候选对象自动归并得到"
    }));
  return {
    documentType: inferDocumentType(input.title, input.content),
    objects,
    relations: inferLocalRelations(objects, input.content)
  };
}

function mergeLocalCandidates(candidates: DiscoveredDomainObject[]): DiscoveredDomainObject[] {
  const byName = new Map<string, DiscoveredDomainObject>();
  for (const candidate of candidates) {
    const name = normalizeName(candidate.name);
    if (!isUsefulName(name)) {
      continue;
    }
    const existing = byName.get(name);
    if (existing) {
      existing.count += candidate.count;
      if (existing.type === "subject" && candidate.type !== "subject") {
        existing.type = candidate.type;
      }
      continue;
    }
    byName.set(name, {
      ...candidate,
      name,
      type: normalizeType(candidate.type)
    });
  }
  return [...byName.values()].sort((a, b) => (b.count - a.count) || scoreName(b.name) - scoreName(a.name));
}

function normalizeProfileResult(raw: unknown, fallback: DomainProfileResult): DomainProfileResult {
  if (!raw || typeof raw !== "object") {
    return fallback;
  }
  const record = raw as Record<string, unknown>;
  const rawObjects = Array.isArray(record.objects) ? record.objects : [];
  const objects = rawObjects
    .map((item) => normalizeRemoteObject(item))
    .filter((item): item is DomainProfileObject => Boolean(item))
    .slice(0, 50);
  if (objects.length === 0) {
    return fallback;
  }
  const objectNames = new Set(objects.map((object) => object.name));
  const relations = (Array.isArray(record.relations) ? record.relations : [])
    .map((item) => normalizeRemoteRelation(item, objectNames))
    .filter((item): item is DomainProfileRelation => Boolean(item))
    .slice(0, 80);
  return {
    documentType: normalizeText(record.document_type ?? record.documentType) || fallback.documentType,
    objects,
    relations
  };
}

function normalizeRemoteObject(item: unknown): DomainProfileObject | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const name = normalizeName(String(record.name ?? ""));
  if (!isUsefulName(name)) return null;
  return {
    name,
    type: normalizeType(String(record.type ?? "subject")),
    aliases: Array.isArray(record.aliases) ? record.aliases.map(String).map(normalizeName).filter(Boolean).slice(0, 8) : [],
    count: readNumber(record.count, 1),
    confidence: clamp(readNumber(record.confidence, 0.7), 0, 1),
    reason: normalizeText(record.reason) || "由 LLM 文件画像确认"
  };
}

function normalizeRemoteRelation(item: unknown, objectNames: Set<string>): DomainProfileRelation | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const source = normalizeName(String(record.source ?? ""));
  const target = normalizeName(String(record.target ?? ""));
  const relation = normalizeText(record.relation);
  const normalized = normalizeRelation(normalizeText(record.predicate) || relation);
  if (!objectNames.has(source) || !objectNames.has(target) || !relation) return null;
  return {
    source,
    target,
    predicate: normalized.type,
    relation,
    evidence: normalizeText(record.evidence) || undefined,
    confidence: clamp(readNumber(record.confidence, 0.7), 0, 1)
  };
}

function inferDocumentType(title: string, content: string): string {
  const text = `${title}\n${content}`;
  if (/招标|投标|采购文件|磋商|响应文件/.test(text)) return "招投标/应标文件";
  if (/操作手册|使用说明|用户手册|操作步骤|登录|页面/.test(text)) return "操作手册";
  if (/合同|协议|付款|验收/.test(text)) return "合同/商务材料";
  if (/技术方案|架构|接口|部署|实施/.test(text)) return "技术方案";
  return "未知文档";
}

function inferLocalRelations(objects: DomainProfileObject[], content: string): DomainProfileRelation[] {
  const relations: DomainProfileRelation[] = [];
  const byType = new Map(objects.map((object) => [object.name, object]));
  for (const source of objects) {
    for (const target of objects) {
      if (source.name === target.name) continue;
      if (!content.includes(source.name) || !content.includes(target.name)) continue;
      const relation = inferRelation(source.type, target.type);
      if (!relation) continue;
      relations.push({
        source: source.name,
        target: target.name,
        predicate: normalizeRelation(relation).type,
        relation,
        confidence: Math.min(source.confidence, target.confidence, 0.65)
      });
      if (relations.length >= 40) return relations;
    }
  }
  return relations.filter((relation) => byType.has(relation.source) && byType.has(relation.target));
}

function inferRelation(sourceType: string, targetType: string): string | null {
  if (sourceType === "process" && targetType === "document_material") return "产生";
  if (sourceType === "system_object" && sourceType !== targetType) return "包含";
  if (sourceType === "document_material" && targetType === "requirement") return "证明";
  if (sourceType === "requirement" && targetType !== "requirement") return "要求";
  if (sourceType === "process" && targetType === "system_object") return "使用";
  if (sourceType === "risk_or_exception" && targetType !== "risk_or_exception") return "影响";
  return null;
}

function normalizeName(value: string): string {
  return value
    .replace(/^[，。、；：,.!?！？;:\s"'“”‘’（）()【】\[\]<>《》]+/g, "")
    .replace(/[，。、；：,.!?！？;:\s"'“”‘’（）()【】\[\]<>《》]+$/g, "")
    .replace(/^(一个|一种|一份|这份|该|本|其|以|于|关于|确保|包括)/u, "")
    .trim();
}

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isUsefulName(name: string): boolean {
  if (name.length < 2 || name.length > 18) return false;
  if (["任务", "生成", "上传", "下载", "操作", "规则", "时间", "记录", "功能", "模型", "文件", "材料", "报告", "问题", "证明"].includes(name)) return false;
  if (/^\d+$/.test(name)) return false;
  return /[\u4e00-\u9fa5]/.test(name) || /[A-Za-z]{3,}/.test(name);
}

function normalizeType(type: string): string {
  return ALLOWED_PROFILE_TYPES.has(type) ? type : "subject";
}

function localConfidence(object: DiscoveredDomainObject): number {
  return clamp(0.55 + Math.min(0.3, object.count * 0.04) + Math.min(0.1, scoreName(object.name) * 0.02), 0, 0.9);
}

function scoreName(name: string): number {
  let score = 0;
  if (name.length >= 4 && name.length <= 12) score += 3;
  if (/(要求|材料|文件|系统|平台|模块|功能|流程|任务|权限|数据|报告|标准|规则|配置|助手|模型)$/.test(name)) score += 3;
  if (/(的|了|和|与|或)$/.test(name)) score -= 4;
  return score;
}

function readNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function compactText(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function parseJsonOrText(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
