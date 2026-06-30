import biddingDomain from "../../config/bidding-domain.json" with { type: "json" };

export interface BiddingEntityType {
  type: string;
  description: string;
}

interface MatchRule {
  match: string[];
}

interface QueryExpansionRule extends MatchRule {
  terms: string[];
}

interface TypeInferenceRule extends MatchRule {
  type: string;
}

export interface BiddingDomainConfig {
  canonicalEntities: string[];
  entityTypes: BiddingEntityType[];
  queryExpansions: QueryExpansionRule[];
  typeInference: TypeInferenceRule[];
}

const defaultConfig = biddingDomain as BiddingDomainConfig;

export function defaultBiddingDomainConfig(): BiddingDomainConfig {
  return cloneBiddingDomainConfig(defaultConfig);
}

export function normalizeBiddingDomainConfig(value: unknown): BiddingDomainConfig {
  if (!value || typeof value !== "object") {
    return defaultBiddingDomainConfig();
  }
  const record = value as Partial<BiddingDomainConfig>;
  return {
    canonicalEntities: normalizeStringArray(record.canonicalEntities, defaultConfig.canonicalEntities),
    entityTypes: normalizeEntityTypes(record.entityTypes, defaultConfig.entityTypes),
    queryExpansions: normalizeQueryExpansions(record.queryExpansions, defaultConfig.queryExpansions),
    typeInference: normalizeTypeInference(record.typeInference, defaultConfig.typeInference)
  };
}

export function biddingCanonicalEntities(config: BiddingDomainConfig = defaultConfig): string[] {
  return config.canonicalEntities;
}

export function biddingEntityTypes(config: BiddingDomainConfig = defaultConfig): BiddingEntityType[] {
  return config.entityTypes;
}

export function expandBiddingQuery(query: string, config: BiddingDomainConfig = defaultConfig): string[] {
  const terms: string[] = [];
  for (const rule of config.queryExpansions) {
    if (matchesAny(query, rule.match)) {
      terms.push(...rule.terms);
    }
  }
  return unique(terms);
}

export function extractBiddingDomainEntities(
  text: string,
  config: BiddingDomainConfig = defaultConfig,
  options: { includeExpansions?: boolean; expansionLimit?: number } = {}
): string[] {
  if (!isBiddingLikeText(text)) {
    return [];
  }
  const includeExpansions = options.includeExpansions ?? true;
  const expansionLimit = options.expansionLimit ?? 6;
  const terms: string[] = [];
  for (const entity of config.canonicalEntities) {
    if (matchesAny(text, [entity])) {
      terms.push(entity);
    }
  }
  for (const rule of config.queryExpansions) {
    if (matchesAny(text, rule.match) || matchesAny(text, rule.terms)) {
      if (includeExpansions) {
        terms.push(...rule.terms.slice(0, expansionLimit));
      }
      terms.push(...rule.terms.filter((term) => matchesAny(text, [term])));
    }
  }
  for (const rule of config.typeInference) {
    if (matchesAny(text, rule.match)) {
      terms.push(...rule.match.slice(0, 4));
    }
  }
  return unique(terms).slice(0, 40);
}

export function inferBiddingEntityType(name: string, config: BiddingDomainConfig = defaultConfig): string | null {
  for (const rule of config.typeInference) {
    if (matchesAny(name, rule.match)) {
      return rule.type;
    }
  }
  return null;
}

function matchesAny(text: string, keywords: string[]): boolean {
  const normalized = text.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function isBiddingLikeText(text: string): boolean {
  return matchesAny(text, [
    "招标",
    "投标",
    "应标",
    "编标",
    "采购",
    "供应商",
    "响应文件",
    "响应",
    "资格",
    "资质",
    "业绩",
    "评分",
    "评审",
    "评标",
    "证书",
    "废标",
    "无效响应",
    "报价",
    "最高限价",
    "证明材料",
    "承诺函",
    "采购标的"
  ]);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const normalized = unique(value.map(String));
  return normalized.length > 0 ? normalized : [...fallback];
}

function normalizeEntityTypes(value: unknown, fallback: BiddingEntityType[]): BiddingEntityType[] {
  if (!Array.isArray(value)) {
    return fallback.map((entityType) => ({ ...entityType }));
  }
  const normalized = value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const type = String(record.type ?? "").trim();
      const description = String(record.description ?? "").trim();
      return type && description ? { type, description } : null;
    })
    .filter((item): item is BiddingEntityType => Boolean(item));
  return normalized.length > 0 ? normalized : fallback.map((entityType) => ({ ...entityType }));
}

function normalizeQueryExpansions(value: unknown, fallback: QueryExpansionRule[]): QueryExpansionRule[] {
  if (!Array.isArray(value)) {
    return fallback.map((rule) => ({ match: [...rule.match], terms: [...rule.terms] }));
  }
  const normalized = value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const match = normalizeStringArray(record.match, []);
      const terms = normalizeStringArray(record.terms, []);
      return match.length > 0 && terms.length > 0 ? { match, terms } : null;
    })
    .filter((item): item is QueryExpansionRule => Boolean(item));
  return normalized.length > 0 ? normalized : fallback.map((rule) => ({ match: [...rule.match], terms: [...rule.terms] }));
}

function normalizeTypeInference(value: unknown, fallback: TypeInferenceRule[]): TypeInferenceRule[] {
  if (!Array.isArray(value)) {
    return fallback.map((rule) => ({ type: rule.type, match: [...rule.match] }));
  }
  const normalized = value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const type = String(record.type ?? "").trim();
      const match = normalizeStringArray(record.match, []);
      return type && match.length > 0 ? { type, match } : null;
    })
    .filter((item): item is TypeInferenceRule => Boolean(item));
  return normalized.length > 0 ? normalized : fallback.map((rule) => ({ type: rule.type, match: [...rule.match] }));
}

function cloneBiddingDomainConfig(config: BiddingDomainConfig): BiddingDomainConfig {
  return {
    canonicalEntities: [...config.canonicalEntities],
    entityTypes: config.entityTypes.map((entityType) => ({ ...entityType })),
    queryExpansions: config.queryExpansions.map((rule) => ({
      match: [...rule.match],
      terms: [...rule.terms]
    })),
    typeInference: config.typeInference.map((rule) => ({
      type: rule.type,
      match: [...rule.match]
    }))
  };
}
