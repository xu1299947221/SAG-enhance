import { config } from "../config/env.js";
import { listDocumentContentsBySource } from "../db/repositories.js";
import { ingestionService } from "./ingestion-service.js";

export interface RelationRebuildResult {
  sourceId: string;
  total: number;
  rebuilt: number;
  failed: number;
  items: Array<{
    documentId: string;
    title: string;
    ok: boolean;
    newDocumentId?: string;
    error?: string;
  }>;
}

export class RelationRebuildService {
  async rebuildSource(sourceId: string, tenantId = config.DEFAULT_TENANT_ID): Promise<RelationRebuildResult> {
    const documents = await listDocumentContentsBySource({
      sourceId,
      tenantId,
      limit: 500
    });
    const items: RelationRebuildResult["items"] = [];
    for (const document of documents) {
      try {
        const result = await ingestionService.ingestDocument({
          sourceId,
          externalId: document.externalId ?? document.id,
          title: document.title,
          content: document.content,
          extract: true,
          replaceExisting: true,
          metadata: {
            rebuiltFromDocumentId: document.id,
            rebuildReason: "relation_rebuild"
          }
        }, tenantId);
        items.push({
          documentId: document.id,
          title: document.title,
          ok: true,
          newDocumentId: result.documentId
        });
      } catch (error) {
        items.push({
          documentId: document.id,
          title: document.title,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const rebuilt = items.filter((item) => item.ok).length;
    return {
      sourceId,
      total: documents.length,
      rebuilt,
      failed: items.length - rebuilt,
      items
    };
  }
}

export const relationRebuildService = new RelationRebuildService();
