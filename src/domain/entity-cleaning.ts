import type { ExtractedEntity } from "../types.js";

export interface CleanExtractedEntitiesOptions {
  text?: string;
  inputIsChinese?: boolean;
  preserveNames?: string[];
  limit?: number;
}

const GENERIC_NAMES = new Set([
  "任务",
  "生成",
  "上传",
  "下载",
  "操作",
  "规则",
  "时间",
  "记录",
  "功能",
  "模型",
  "文件",
  "材料",
  "报告",
  "问题",
  "证明",
  "修改",
  "配置",
  "用户",
  "系统",
  "页面",
  "维护",
  "历史",
  "结果"
]);

const NOISY_LATIN_NAMES = new Set([
  "introduction",
  "ctrl",
  "shift",
  "alt",
  "esc",
  "enter",
  "tab",
  "mb",
  "ai",
  "pdf",
  "word",
  "excel",
  "ppt",
  "ofd",
  "txt",
  "v1",
  "xxxx"
]);

const NOISY_PREFIXES = [
  "一个",
  "一种",
  "一份",
  "这份",
  "该",
  "本",
  "其",
  "以",
  "于",
  "关于",
  "为了",
  "可能",
  "如果",
  "点击",
  "选择",
  "输入",
  "查看",
  "进入",
  "进行",
  "通过",
  "支持",
  "可以",
  "需要",
  "将",
  "对",
  "在",
  "后续",
  "如明确",
  "能会",
  "确认",
  "确保",
  "帮助",
  "提升",
  "建议",
  "默认",
  "帮我",
  "分析这份",
  "总结",
  "选中",
  "移动到",
  "降移动",
  "如明确",
  "对文件",
  "他用",
  "这是",
  "的"
];

export function cleanExtractedEntities(
  entities: ExtractedEntity[],
  options: CleanExtractedEntitiesOptions = {}
): ExtractedEntity[] {
  const preserve = new Set((options.preserveNames ?? []).map(normalizeEntityName).filter(Boolean));
  const byName = new Map<string, ExtractedEntity>();
  const scored: Array<{ entity: ExtractedEntity; score: number }> = [];
  for (const entity of entities) {
    const cleanedName = normalizeEntityName(entity.name);
    if (!cleanedName) {
      continue;
    }
    const normalizedEntity = {
      ...entity,
      name: cleanedName,
      description: normalizeDescription(entity.description)
    };
    const preserved = preserve.has(cleanedName);
    if (!preserved && isNoisyEntityName(cleanedName, options)) {
      continue;
    }
    const existing = byName.get(cleanedName);
    const score = entityScore(normalizedEntity, preserved);
    if (!existing) {
      byName.set(cleanedName, normalizedEntity);
      scored.push({ entity: normalizedEntity, score });
      continue;
    }
    if (entityScore(existing, preserve.has(existing.name)) < score) {
      byName.set(cleanedName, normalizedEntity);
      const item = scored.find((entry) => entry.entity.name === cleanedName);
      if (item) {
        item.entity = normalizedEntity;
        item.score = score;
      }
    }
  }
  return scored
    .map((entry) => ({ ...entry, entity: byName.get(entry.entity.name) ?? entry.entity }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.entity)
    .slice(0, options.limit ?? 24);
}

export function normalizeEntityName(value: string): string {
  const raw = value
    .replace(/\s+/g, " ")
    .replace(/^[#*\-—:：，。、；;,.!?！？\s"'“”‘’（）()【】\[\]<>《》]+/g, "")
    .replace(/[#*\-—:：，。、；;,.!?！？\s"'“”‘’（）()【】\[\]<>《》]+$/g, "")
    .trim();
  if (!raw) {
    return "";
  }
  return normalizeActionObject(raw);
}

function normalizeActionObject(name: string): string {
  const compact = name.replace(/\s+/g, "");
  if (/^(上传|导入)(本地)?文件$/.test(compact)) return "文件上传";
  if (/^下载(有下载权限的)?文件$/.test(compact)) return "文件下载";
  if (/^(单独)?修改文件$/.test(compact)) return "文件修改";
  if (/^删除(选中的)?文件$/.test(compact)) return "文件删除";
  if (/^(总结|提取).{0,4}会议记录$/.test(compact)) return "会议记录";
  if (/^预审规则配置$/.test(compact)) return "预审规则";
  return name;
}

function isNoisyEntityName(name: string, options: CleanExtractedEntitiesOptions): boolean {
  if (name.length < 2 || name.length > 28) return true;
  if (/^\d+(?:\.\d+)?$/.test(name)) return true;
  if (/[。！？；;]/.test(name)) return true;
  if (/\.(docx?|xlsx?|pptx?|pdf|ofd|txt|md)$/i.test(name)) return true;
  if (/^[A-Za-z]{1,2}\d*$/.test(name)) return true;
  if (GENERIC_NAMES.has(name)) return true;
  if (/(的|了|和|与|或|及|于|为)$/.test(name)) return true;
  if (/(您的问题|仅供参考|准确回答|常规提示|软件实际界面|可能还需要|缺乏直接相关|符合所有适用标准|内容由AI生成|内容由 AI 生成)/.test(name)) return true;
  if (/(帮我|请你|如何|怎么|这份文件|这份材料|选中需要|如明确|他用|调查研究是|先做学生)/.test(name)) return true;
  if (isLongSentenceFragment(name)) return true;
  if (options.inputIsChinese && isNoisyLatinName(name)) return true;
  if (NOISY_PREFIXES.some((prefix) => name.startsWith(prefix) && name.length > prefix.length + 2)) return true;
  return false;
}

function isLongSentenceFragment(name: string): boolean {
  const cjkLength = (name.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  if (cjkLength >= 15 && !/(要求|材料|文件|系统|平台|模块|功能|流程|任务|权限|数据|报告|标准|规则|配置|助手|模型|证书)$/.test(name)) {
    return true;
  }
  return name.length > 18 && /(是否|如果|可以|需要|通过|进行|确保|帮助|提升|建议|位于|包括|特别是)/.test(name);
}

function isNoisyLatinName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/\s+/g, " ").trim();
  if (NOISY_LATIN_NAMES.has(normalized)) return true;
  if (/^[A-Za-z]+(?: [A-Za-z]+){0,2}$/.test(name) && normalized.split(" ").every((part) => NOISY_LATIN_NAMES.has(part))) {
    return true;
  }
  return false;
}

function entityScore(entity: ExtractedEntity, preserved: boolean): number {
  let score = preserved ? 100 : 0;
  if (entity.type !== "subject") score += 8;
  if (/[\u4e00-\u9fa5]/.test(entity.name)) score += 6;
  if (entity.name.length >= 4 && entity.name.length <= 12) score += 4;
  if (/(要求|材料|文件|系统|平台|模块|功能|流程|任务|权限|数据|报告|标准|规则|配置|助手|模型|证书)$/.test(entity.name)) score += 6;
  if (/^[A-Za-z0-9_-]+$/.test(entity.name)) score -= 3;
  return score;
}

function normalizeDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
