import { config } from "../config/env.js";
import { inferBiddingEntityType, extractBiddingDomainEntities } from "../domain/bidding-domain.js";
import { discoverDomainObjects } from "../domain/domain-object-discovery.js";
import { listDocumentContentsBySource } from "../db/repositories.js";
import { aiSettingsService } from "./ai-settings-service.js";
import { domainProfileService } from "./domain-profile-service.js";
import type { BiddingDomainAnalyzeResult } from "../types.js";

export class BiddingDomainAnalysisService {
  async analyzeSource(sourceId: string, tenantId = config.DEFAULT_TENANT_ID): Promise<BiddingDomainAnalyzeResult> {
    const runtimeSettings = await aiSettingsService.getRuntimeSettings();
    const documents = await listDocumentContentsBySource({
      sourceId,
      tenantId,
      limit: 100
    });
    const documentTypes = new Map<string, number>();
    const relations: NonNullable<BiddingDomainAnalyzeResult["relations"]> = [];
    const byName = new Map<string, {
      name: string;
      type: string;
      count: number;
      aliases: Set<string>;
      confidence: number;
      reason?: string;
      documents: Map<string, { documentId: string; title: string }>;
    }>();

    for (const document of documents) {
      const documentText = `${document.title}\n${document.content}`;
      const discovered = discoverDomainObjects(documentText, 80);
      const profile = await domainProfileService.profileDocument({
        title: document.title,
        content: document.content,
        candidates: discovered
      });
      documentTypes.set(profile.documentType, (documentTypes.get(profile.documentType) ?? 0) + 1);
      const biddingEntities = extractBiddingDomainEntities(
        documentText,
        runtimeSettings.biddingDomainConfig,
        { includeExpansions: false }
      ).map((name) => ({
        name,
        type: inferBiddingEntityType(name, runtimeSettings.biddingDomainConfig) ?? "subject",
        count: countOccurrences(documentText, name)
      }));
      for (const object of [...profile.objects, ...biddingEntities]) {
        const existing = byName.get(object.name) ?? {
          name: object.name,
          type: object.type,
          count: 0,
          aliases: new Set<string>(),
          confidence: 0,
          reason: undefined,
          documents: new Map()
        };
        if (existing.type === "subject" && object.type !== "subject") {
          existing.type = object.type;
        }
        existing.count += object.count;
        for (const alias of "aliases" in object && Array.isArray(object.aliases) ? object.aliases : []) {
          existing.aliases.add(alias);
        }
        existing.confidence = Math.max(existing.confidence, "confidence" in object && typeof object.confidence === "number" ? object.confidence : 0.65);
        if (!existing.reason && "reason" in object && typeof object.reason === "string") {
          existing.reason = object.reason;
        }
        existing.documents.set(document.id, {
          documentId: document.id,
          title: document.title
        });
        byName.set(object.name, existing);
      }
      for (const relation of profile.relations) {
        relations.push(relation);
      }
    }

    return {
      sourceId,
      documentCount: documents.length,
      documentType: mostCommon(documentTypes),
      entities: [...byName.values()]
        .map((entity) => ({
          name: entity.name,
          type: entity.type,
          count: entity.count,
          aliases: [...entity.aliases],
          confidence: entity.confidence,
          reason: entity.reason,
          documents: [...entity.documents.values()]
        }))
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || (b.count - a.count) || a.name.localeCompare(b.name, "zh-Hans-CN"))
        .slice(0, 120),
      relations: dedupeRelations(relations).slice(0, 120)
    };
  }
}

export const biddingDomainAnalysisService = new BiddingDomainAnalysisService();

function countOccurrences(text: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let index = 0;
  const normalizedText = text.toLowerCase();
  const normalizedTerm = term.toLowerCase();
  while ((index = normalizedText.indexOf(normalizedTerm, index)) >= 0) {
    count += 1;
    index += normalizedTerm.length;
  }
  return Math.max(count, 1);
}

function mostCommon(values: Map<string, number>): string | undefined {
  return [...values.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function dedupeRelations(relations: NonNullable<BiddingDomainAnalyzeResult["relations"]>) {
  const seen = new Set<string>();
  const result: NonNullable<BiddingDomainAnalyzeResult["relations"]> = [];
  for (const relation of relations) {
    const key = `${relation.source}\t${relation.relation}\t${relation.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(relation);
  }
  return result;
}
