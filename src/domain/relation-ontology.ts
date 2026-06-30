export type RelationStrength = "strong" | "weak";
export type RelationScope = "base" | "bidding";

export interface RelationDefinition {
  type: string;
  label: string;
  description: string;
  aliases: string[];
  strength: RelationStrength;
  scope: RelationScope;
  inverseType?: string;
  transitive?: boolean;
  reasoning: boolean;
  defaultMinConfidence: number;
}

export interface NormalizedRelation {
  type: string;
  label: string;
  definition: RelationDefinition;
}

export const BASE_RELATIONS: RelationDefinition[] = [
  {
    type: "CONTAINS",
    label: "包含",
    description: "A 包含 B，适用于章节、系统、方案、功能模块、清单和集合。",
    aliases: ["包含", "包括", "含有", "由...组成", "组成", "覆盖", "contain", "include", "has part"],
    strength: "strong",
    scope: "base",
    inverseType: "PART_OF",
    transitive: true,
    reasoning: true,
    defaultMinConfidence: 0.62
  },
  {
    type: "PART_OF",
    label: "属于/组成部分",
    description: "A 是 B 的组成部分或所属部分。",
    aliases: ["属于", "隶属", "组成部分", "一部分", "归属", "part of", "belongs to"],
    strength: "strong",
    scope: "base",
    inverseType: "CONTAINS",
    transitive: true,
    reasoning: true,
    defaultMinConfidence: 0.62
  },
  {
    type: "IS_A",
    label: "是一种",
    description: "A 是 B 的一种类型或子类。",
    aliases: ["是一种", "属于类型", "类型为", "类别为", "is a", "subclass"],
    strength: "strong",
    scope: "base",
    transitive: true,
    reasoning: true,
    defaultMinConfidence: 0.65
  },
  {
    type: "INSTANCE_OF",
    label: "实例属于",
    description: "A 是 B 这个类别的具体实例。",
    aliases: ["实例", "实例属于", "是具体", "instance of"],
    strength: "strong",
    scope: "base",
    reasoning: true,
    defaultMinConfidence: 0.65
  },
  {
    type: "EQUIVALENT_TO",
    label: "等价/同义",
    description: "A 与 B 可以视为同义或等价概念。",
    aliases: ["等价", "同义", "别名", "即", "也称", "简称", "equivalent", "same as", "exact match"],
    strength: "strong",
    scope: "base",
    inverseType: "EQUIVALENT_TO",
    transitive: true,
    reasoning: true,
    defaultMinConfidence: 0.72
  },
  {
    type: "SIMILAR_TO",
    label: "相似",
    description: "A 与 B 语义接近，但不能直接视为等价。",
    aliases: ["相似", "类似", "近似", "similar", "close match"],
    strength: "weak",
    scope: "base",
    inverseType: "SIMILAR_TO",
    reasoning: false,
    defaultMinConfidence: 0.78
  },
  {
    type: "REFERS_TO",
    label: "引用/指向",
    description: "A 引用、提到或指向 B。",
    aliases: ["引用", "指向", "提到", "参见", "refer", "mention", "citation"],
    strength: "weak",
    scope: "base",
    reasoning: false,
    defaultMinConfidence: 0.72
  },
  {
    type: "BASED_ON",
    label: "基于/来源于",
    description: "A 基于 B 形成，B 是 A 的依据或来源。",
    aliases: ["基于", "依据", "来源于", "根据", "based on", "source"],
    strength: "strong",
    scope: "base",
    reasoning: true,
    defaultMinConfidence: 0.66
  },
  {
    type: "DERIVED_FROM",
    label: "派生自",
    description: "A 从 B 转换、生成、改写或派生而来。",
    aliases: ["派生自", "转换自", "改写自", "生成自", "derived from"],
    strength: "strong",
    scope: "base",
    reasoning: true,
    defaultMinConfidence: 0.66
  },
  {
    type: "USES",
    label: "使用",
    description: "A 使用 B 作为工具、资源、材料、能力或输入。",
    aliases: ["使用", "采用", "调用", "利用", "依托", "use", "used"],
    strength: "strong",
    scope: "base",
    reasoning: true,
    defaultMinConfidence: 0.62
  },
  {
    type: "PRODUCES",
    label: "产生/输出",
    description: "A 产生、生成或输出 B。",
    aliases: ["产生", "生成", "输出", "形成", "产出", "produce", "generate", "output"],
    strength: "strong",
    scope: "base",
    reasoning: true,
    defaultMinConfidence: 0.62
  },
  {
    type: "DEPENDS_ON",
    label: "依赖/前置",
    description: "A 的成立、执行或可用依赖 B。",
    aliases: ["依赖", "前置", "前提", "取决于", "depends on", "requires before"],
    strength: "strong",
    scope: "base",
    reasoning: true,
    defaultMinConfidence: 0.68
  },
  {
    type: "PRECEDES",
    label: "先于",
    description: "A 在时间、步骤或流程顺序上先于 B。",
    aliases: ["先于", "之前", "前置步骤", "然后", "precedes", "before"],
    strength: "strong",
    scope: "base",
    reasoning: true,
    defaultMinConfidence: 0.68
  },
  {
    type: "REQUIRES",
    label: "要求/需要",
    description: "A 对 B 有明确要求、需要或必须条件。",
    aliases: ["要求", "需要", "必须", "须", "应当", "需提供", "require", "must"],
    strength: "strong",
    scope: "base",
    reasoning: true,
    defaultMinConfidence: 0.65
  },
  {
    type: "SATISFIES",
    label: "满足/符合",
    description: "A 满足、符合或响应 B 的条件、要求或标准。",
    aliases: ["满足", "符合", "响应", "匹配", "达成", "satisfy", "match", "comply"],
    strength: "strong",
    scope: "base",
    reasoning: true,
    defaultMinConfidence: 0.65
  },
  {
    type: "PROVES",
    label: "证明/支撑",
    description: "A 作为证据、材料或事实证明 B。",
    aliases: ["证明", "支撑", "佐证", "证明材料", "证据", "prove", "support", "evidence"],
    strength: "strong",
    scope: "base",
    reasoning: true,
    defaultMinConfidence: 0.65
  },
  {
    type: "LIMITS",
    label: "限制/约束",
    description: "A 限制或约束 B 的时间、金额、范围、数量、条件或格式。",
    aliases: ["限制", "约束", "不得", "不超过", "不少于", "期限", "金额", "limit", "constraint"],
    strength: "strong",
    scope: "base",
    reasoning: true,
    defaultMinConfidence: 0.68
  },
  {
    type: "CAUSES",
    label: "导致",
    description: "A 明确导致 B 这个结果、风险、后果或状态。",
    aliases: ["导致", "造成", "引起", "触发", "cause", "lead to", "result in"],
    strength: "strong",
    scope: "base",
    reasoning: true,
    defaultMinConfidence: 0.7
  },
  {
    type: "AFFECTS",
    label: "影响",
    description: "A 影响 B，但文本证据不足以判定为明确因果。",
    aliases: ["影响", "关系到", "关联影响", "affect", "impact"],
    strength: "weak",
    scope: "base",
    reasoning: false,
    defaultMinConfidence: 0.75
  },
  {
    type: "RELATED_TO",
    label: "相关",
    description: "A 与 B 有弱相关，但无法判断更具体关系；低权重兜底边。",
    aliases: ["相关", "关联", "有关", "related"],
    strength: "weak",
    scope: "base",
    inverseType: "RELATED_TO",
    reasoning: false,
    defaultMinConfidence: 0.82
  }
];

export const BIDDING_RELATIONS: RelationDefinition[] = [
  {
    type: "HOLDS",
    label: "持有/具备",
    description: "人员、公司或主体持有/具备证书、资质、能力。",
    aliases: ["持有", "具备", "拥有", "取得", "hold", "has"],
    strength: "strong",
    scope: "bidding",
    reasoning: true,
    defaultMinConfidence: 0.66
  },
  {
    type: "HAS_EXPERIENCE",
    label: "具备业绩",
    description: "主体、人员或公司具备某类业绩、经验或案例。",
    aliases: ["具备业绩", "具有业绩", "项目经验", "类似业绩", "experience"],
    strength: "strong",
    scope: "bidding",
    reasoning: true,
    defaultMinConfidence: 0.66
  },
  {
    type: "MATCHES_TYPE",
    label: "匹配项目类型",
    description: "业绩、材料或能力匹配指定项目类型、行业或场景。",
    aliases: ["匹配项目类型", "类似项目", "同类项目", "符合项目类型", "matches type"],
    strength: "strong",
    scope: "bidding",
    reasoning: true,
    defaultMinConfidence: 0.66
  },
  {
    type: "SCORES_FOR",
    label: "对应评分项",
    description: "材料、能力或响应内容对应某个评分项。",
    aliases: ["评分", "得分", "对应评分项", "加分", "score"],
    strength: "strong",
    scope: "bidding",
    reasoning: true,
    defaultMinConfidence: 0.66
  },
  {
    type: "CAUSES_RISK",
    label: "导致风险/废标",
    description: "条款、缺失或不满足项导致废标、扣分、无效响应或合规风险。",
    aliases: ["废标", "无效响应", "扣分", "风险", "导致风险", "reject", "risk"],
    strength: "strong",
    scope: "bidding",
    reasoning: true,
    defaultMinConfidence: 0.7
  },
  {
    type: "SUBMITS",
    label: "提交/响应材料",
    description: "投标人、响应文件或流程提交某份材料。",
    aliases: ["提交", "递交", "提供", "响应材料", "submit"],
    strength: "strong",
    scope: "bidding",
    reasoning: true,
    defaultMinConfidence: 0.64
  }
];

export const DEFAULT_RELATIONS = [...BASE_RELATIONS, ...BIDDING_RELATIONS] as const;

const RELATION_BY_TYPE = new Map(DEFAULT_RELATIONS.map((relation) => [relation.type, relation]));

export function getRelationDefinition(type: string): RelationDefinition | undefined {
  return RELATION_BY_TYPE.get(type.trim().toUpperCase());
}

export function normalizeRelation(input: string): NormalizedRelation {
  const raw = input.trim();
  const upper = raw.toUpperCase();
  const direct = RELATION_BY_TYPE.get(upper);
  if (direct) {
    return {
      type: direct.type,
      label: direct.label,
      definition: direct
    };
  }

  const lower = raw.toLowerCase();
  const matched = DEFAULT_RELATIONS.find((relation) => relation.aliases.some((alias) => {
    const normalizedAlias = alias.toLowerCase();
    return lower === normalizedAlias || lower.includes(normalizedAlias);
  })) ?? RELATION_BY_TYPE.get("RELATED_TO")!;

  return {
    type: matched.type,
    label: matched.label,
    definition: matched
  };
}

export function relationPromptCatalog(): Array<{
  type: string;
  label: string;
  description: string;
  strength: RelationStrength;
  scope: RelationScope;
  defaultMinConfidence: number;
}> {
  return DEFAULT_RELATIONS.map((relation) => ({
    type: relation.type,
    label: relation.label,
    description: relation.description,
    strength: relation.strength,
    scope: relation.scope,
    defaultMinConfidence: relation.defaultMinConfidence
  }));
}

export function isReasoningRelation(type: string): boolean {
  return getRelationDefinition(type)?.reasoning ?? false;
}

export function relationMinConfidence(type: string): number {
  return getRelationDefinition(type)?.defaultMinConfidence ?? RELATION_BY_TYPE.get("RELATED_TO")!.defaultMinConfidence;
}

export function relationStrength(type: string): RelationStrength {
  return getRelationDefinition(type)?.strength ?? "weak";
}
