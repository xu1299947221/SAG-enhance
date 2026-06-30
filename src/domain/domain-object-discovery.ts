import type { ExtractedEntity } from "../types.js";

export interface DiscoveredDomainObject {
  name: string;
  type: string;
  description: string;
  count: number;
}

const GENERIC_PATTERNS: Array<{
  type: string;
  description: string;
  suffixes: string[];
}> = [
  {
    type: "requirement",
    description: "从文件内容自动发现的要求、条件、规则或约束对象",
    suffixes: ["要求", "条件", "规则", "标准", "规范", "约束", "限制", "指标", "参数"]
  },
  {
    type: "document_material",
    description: "从文件内容自动发现的文档、材料、附件、报告或表单对象",
    suffixes: ["文件", "材料", "附件", "报告", "表格", "表单", "清单", "一览表", "说明书", "手册", "证明", "承诺函"]
  },
  {
    type: "process",
    description: "从文件内容自动发现的流程、任务、步骤或操作对象",
    suffixes: ["流程", "任务", "步骤", "操作", "处理", "审核", "审批", "预审", "生成", "上传", "下载", "导入", "导出", "同步", "解析", "维护"]
  },
  {
    type: "system_object",
    description: "从文件内容自动发现的系统、平台、模块、功能或页面对象",
    suffixes: ["系统", "平台", "模块", "功能", "页面", "界面", "工具", "助手", "模型", "智能体", "应用", "场景"]
  },
  {
    type: "data_object",
    description: "从文件内容自动发现的数据、字段、记录、日志或权限对象",
    suffixes: ["数据", "字段", "记录", "日志", "权限", "账号", "用户", "角色", "配置", "状态", "结果", "历史"]
  },
  {
    type: "time_constraint",
    description: "从文件内容自动发现的时间、期限、周期或截止对象",
    suffixes: ["时间", "期限", "周期", "日期", "截止", "有效期", "服务期", "工期"]
  },
  {
    type: "amount_or_score",
    description: "从文件内容自动发现的金额、报价、费用、分值或数量对象",
    suffixes: ["金额", "报价", "费用", "价格", "分值", "评分", "得分", "数量", "比例", "限价", "预算"]
  },
  {
    type: "risk_or_exception",
    description: "从文件内容自动发现的风险、异常、错误、限制或失败对象",
    suffixes: ["风险", "异常", "错误", "失败", "无效", "限制", "告警", "问题", "提示"]
  }
];

const STOP_PREFIXES = [
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
  "如果",
  "然后",
  "当前",
  "本页",
  "该"
];

export function discoverDomainObjects(text: string, limit = 24): DiscoveredDomainObject[] {
  const counts = new Map<string, DiscoveredDomainObject>();
  const normalizedText = text.replace(/\s+/g, " ");

  for (const group of GENERIC_PATTERNS) {
    for (const phrase of splitPhrases(normalizedText)) {
      for (const suffix of group.suffixes) {
        if (!phrase.includes(suffix)) {
          continue;
        }
        const name = normalizeCandidate(extractObjectPhrase(phrase, suffix));
        if (!isGoodCandidate(name)) {
          continue;
        }
        const key = `${group.type}:${name.toLowerCase()}`;
        const existing = counts.get(key);
        if (existing) {
          existing.count += 1;
          continue;
        }
        counts.set(key, {
          name,
          type: group.type,
          description: `${group.description}：${name}`,
          count: 1
        });
      }
    }
  }

  return [...counts.values()]
    .sort((a, b) => (b.count - a.count) || scoreCandidate(b.name) - scoreCandidate(a.name) || a.name.localeCompare(b.name, "zh-Hans-CN"))
    .slice(0, limit);
}

export function enrichEntitiesWithDiscoveredObjects(
  entities: ExtractedEntity[],
  text: string,
  limit = 24
): ExtractedEntity[] {
  const existing = new Set(entities.map((entity) => entity.name.trim().toLowerCase()));
  const enriched = [...entities];
  for (const object of mergeDiscoveredObjects(discoverDomainObjects(text, limit * 3)).slice(0, limit)) {
    const key = object.name.toLowerCase();
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    enriched.push({
      type: object.type,
      name: object.name,
      description: object.description
    });
  }
  return enriched.slice(0, Math.max(limit, entities.length));
}

function mergeDiscoveredObjects(objects: DiscoveredDomainObject[]): DiscoveredDomainObject[] {
  const byName = new Map<string, DiscoveredDomainObject>();
  for (const object of objects) {
    const name = normalizeCandidate(object.name);
    if (!isGoodCandidate(name)) {
      continue;
    }
    const existing = byName.get(name);
    if (existing) {
      existing.count += object.count;
      continue;
    }
    byName.set(name, { ...object, name });
  }
  return [...byName.values()]
    .filter((object) => object.count > 1 || object.name.length >= 4 || /要求|材料|文件|任务|报告|配置|权限|系统|助手|模型/.test(object.name))
    .sort((a, b) => (b.count - a.count) || scoreCandidate(b.name) - scoreCandidate(a.name));
}

function normalizeCandidate(value: string): string {
  let text = value
    .replace(/^[，。、；：,.!?！？;:\s"'“”‘’（）()【】\[\]<>《》]+/g, "")
    .replace(/[，。、；：,.!?！？;:\s"'“”‘’（）()【】\[\]<>《》]+$/g, "")
    .trim();
  for (const prefix of STOP_PREFIXES) {
    if (text.startsWith(prefix) && text.length > prefix.length + 2) {
      text = text.slice(prefix.length);
    }
  }
  return text.trim();
}

function splitPhrases(text: string): string[] {
  return text
    .split(/[。！？；;，,、\n\r\t]|(?:并且|以及|同时|然后|并|且|及|和|与|或)/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 40);
}

function extractObjectPhrase(phrase: string, suffix: string): string {
  const suffixIndex = phrase.lastIndexOf(suffix);
  if (suffixIndex < 0) return phrase;
  const end = suffixIndex + suffix.length;
  const prefix = phrase.slice(0, end);
  const tokens = prefix.match(/[\u4e00-\u9fa5A-Za-z0-9_-]+/gu) ?? [prefix];
  let token = tokens[tokens.length - 1] ?? prefix;
  token = token
    .replace(/^(用户在|系统支持|系统可|管理员可以|管理员可|供应商须提供|供应商应提供|供应商需要提供|供应商|投标人须提供|投标人应提供|应满足|须满足|需要满足|满足|提供|查看|选择|点击|输入|进行|完成|支持|可以|可|应|须|需要)/u, "")
    .trim();
  token = keepObjectAfterLastAction(token, suffix);
  if (token.length <= 12) {
    return token;
  }
  const tail = token.slice(Math.max(0, token.length - 12));
  const boundary = tail.search(/[的之及与和]/u);
  return boundary >= 0 && boundary < tail.length - 2 ? tail.slice(boundary + 1) : tail;
}

function keepObjectAfterLastAction(token: string, suffix: string): string {
  const suffixIndex = token.lastIndexOf(suffix);
  if (suffixIndex < 0) return token;
  const actions = ["应满足", "须满足", "需要满足", "满足", "选择", "维护", "查看", "点击", "输入", "提供", "创建", "生成"];
  let cut = -1;
  for (const action of actions) {
    const index = token.lastIndexOf(action, suffixIndex);
    if ((suffix === "页面" || suffix === "界面") && action === "选择" && index + action.length === suffixIndex) {
      continue;
    }
    if (index >= 0 && index + action.length <= suffixIndex && index + action.length > cut) {
      cut = index + action.length;
    }
  }
  return cut >= 0 ? token.slice(cut) : token;
}

function isGoodCandidate(value: string): boolean {
  if (value.length < 2 || value.length > 28) return false;
  if (["文件", "材料", "报告", "系统", "页面", "权限", "历史", "用户", "维护", "预审"].includes(value)) return false;
  if (/^\d+$/.test(value)) return false;
  if (/^[A-Za-z]+$/.test(value) && value.length < 3) return false;
  if (/[。！？；;] /.test(value)) return false;
  return /[\u4e00-\u9fa5]/.test(value) || /[A-Za-z]{3,}/.test(value);
}

function scoreCandidate(value: string): number {
  let score = 0;
  if (value.length >= 4 && value.length <= 12) score += 2;
  if (/(要求|材料|文件|系统|平台|模块|功能|流程|任务|权限|数据|报告|标准|规则)$/.test(value)) score += 3;
  if (/(的|了|和|与|或)$/.test(value)) score -= 2;
  return score;
}
