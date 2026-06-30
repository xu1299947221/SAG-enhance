import { config } from "../config/env.js";
import { listKnowledgeEdgesBySource, upsertKnowledgeEdge } from "../db/repositories.js";
import { scoreRelation } from "./relation-extraction-service.js";
import type { KnowledgeEdgeRecord } from "../types.js";

const REQUIREMENT_RELATIONS = new Set(["REQUIRES", "SCORES_FOR"]);
const MATERIAL_RELATIONS = new Set(["HOLDS", "PROVES", "HAS_EXPERIENCE", "MATCHES_TYPE", "SUBMITS", "SATISFIES"]);

export interface BiddingAlignmentResult {
  sourceId: string;
  created: number;
  candidates: number;
}

export class BiddingAlignmentService {
  async alignSource(sourceId: string, tenantId = config.DEFAULT_TENANT_ID): Promise<BiddingAlignmentResult> {
    const edges = await listKnowledgeEdgesBySource({
      sourceId,
      tenantId,
      includeInactive: false,
      limit: 1000
    });
    const requirements = edges.filter((edge) => REQUIREMENT_RELATIONS.has(edge.relationType));
    const materials = edges.filter((edge) => MATERIAL_RELATIONS.has(edge.relationType));
    let candidates = 0;
    let created = 0;
    const seen = new Set(edges.map((edge) => `${edge.subjectEntityId}\u0000${edge.relationType}\u0000${edge.objectEntityId}`));
    for (const requirement of requirements) {
      for (const material of materials) {
        if (!canAlign(requirement, material)) continue;
        candidates += 1;
        const relationType = material.relationType === "PROVES" || /材料|扫描件|附件|承诺函|证明/.test(material.subjectName)
          ? "PROVES"
          : "SATISFIES";
        const key = `${material.subjectEntityId}\u0000${relationType}\u0000${requirement.subjectEntityId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const documentId = material.documentId ?? requirement.documentId;
        const eventId = material.eventId ?? requirement.eventId;
        if (!documentId || !eventId) continue;
        const evidence = [material.evidence, requirement.evidence].filter(Boolean).join(" / ").slice(0, 500);
        const confidence = Math.max(0.5, Math.min(material.confidence, requirement.confidence) * 0.86);
        await upsertKnowledgeEdge({
          sourceId,
          documentId,
          chunkId: material.chunkId ?? requirement.chunkId ?? null,
          eventId,
          subjectEntityId: material.subjectEntityId,
          objectEntityId: requirement.subjectEntityId,
          subjectName: material.subjectName,
          objectName: requirement.subjectName,
          relationType,
          relationLabel: relationType === "PROVES" ? "证明/支撑" : "满足/符合",
          evidence,
          confidence,
          qualityScore: scoreRelation({
            predicate: relationType,
            confidence,
            evidence,
            subject: material.subjectName,
            object: requirement.subjectName,
            status: "AUTO"
          }),
          extractionMethod: "bidding_alignment",
          promptVersion: "bidding-alignment-v1",
          metadata: {
            alignedFromRequirementEdgeId: requirement.id,
            alignedFromMaterialEdgeId: material.id,
            requirementObject: requirement.objectName,
            materialObject: material.objectName
          }
        });
        created += 1;
      }
    }
    return { sourceId, created, candidates };
  }
}

export const biddingAlignmentService = new BiddingAlignmentService();

function canAlign(requirement: KnowledgeEdgeRecord, material: KnowledgeEdgeRecord): boolean {
  if (requirement.id === material.id) return false;
  if (requirement.subjectEntityId === material.subjectEntityId) return false;
  if (!requirement.objectName || !material.objectName) return false;
  const requirementTarget = normalize(requirement.objectName);
  const materialTarget = normalize(material.objectName);
  if (!requirementTarget || !materialTarget) return false;
  return requirementTarget === materialTarget
    || requirementTarget.includes(materialTarget)
    || materialTarget.includes(requirementTarget);
}

function normalize(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}
