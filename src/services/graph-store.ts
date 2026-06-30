import type {
  KnowledgeEdgeRecord,
  KnowledgeGraphPath
} from "../types.js";
import {
  expandKnowledgeGraphPaths,
  getEdgesByEntityIds,
  getEdgesByEventIds,
  searchKnowledgeEdges,
  upsertKnowledgeEdge
} from "../db/repositories.js";

export interface GraphStore {
  upsertEdge(input: Parameters<typeof upsertKnowledgeEdge>[0]): Promise<KnowledgeEdgeRecord>;
  searchEdges(input: Parameters<typeof searchKnowledgeEdges>[0]): Promise<KnowledgeEdgeRecord[]>;
  getEdgesByEntityIds(input: Parameters<typeof getEdgesByEntityIds>[0]): Promise<KnowledgeEdgeRecord[]>;
  getEdgesByEventIds(input: Parameters<typeof getEdgesByEventIds>[0]): Promise<KnowledgeEdgeRecord[]>;
  expandPaths(input: Parameters<typeof expandKnowledgeGraphPaths>[0]): Promise<KnowledgeGraphPath[]>;
  deleteDocumentGraph(documentId: string): Promise<void>;
}

export class PostgresGraphStore implements GraphStore {
  async upsertEdge(input: Parameters<typeof upsertKnowledgeEdge>[0]): Promise<KnowledgeEdgeRecord> {
    return upsertKnowledgeEdge(input);
  }

  async searchEdges(input: Parameters<typeof searchKnowledgeEdges>[0]): Promise<KnowledgeEdgeRecord[]> {
    return searchKnowledgeEdges(input);
  }

  async getEdgesByEntityIds(input: Parameters<typeof getEdgesByEntityIds>[0]): Promise<KnowledgeEdgeRecord[]> {
    return getEdgesByEntityIds(input);
  }

  async getEdgesByEventIds(input: Parameters<typeof getEdgesByEventIds>[0]): Promise<KnowledgeEdgeRecord[]> {
    return getEdgesByEventIds(input);
  }

  async expandPaths(input: Parameters<typeof expandKnowledgeGraphPaths>[0]): Promise<KnowledgeGraphPath[]> {
    return expandKnowledgeGraphPaths(input);
  }

  async deleteDocumentGraph(_documentId: string): Promise<void> {
    // Document graph deletion is currently handled transactionally by the
    // repository deleteDocumentGraphById function. This hook keeps the store
    // interface ready for external graph backends.
  }
}

export class Neo4jGraphStore implements GraphStore {
  async upsertEdge(): Promise<KnowledgeEdgeRecord> {
    throw new Error("Neo4jGraphStore is reserved but not configured. Use PostgresGraphStore.");
  }

  async searchEdges(): Promise<KnowledgeEdgeRecord[]> {
    throw new Error("Neo4jGraphStore is reserved but not configured. Use PostgresGraphStore.");
  }

  async getEdgesByEntityIds(): Promise<KnowledgeEdgeRecord[]> {
    throw new Error("Neo4jGraphStore is reserved but not configured. Use PostgresGraphStore.");
  }

  async getEdgesByEventIds(): Promise<KnowledgeEdgeRecord[]> {
    throw new Error("Neo4jGraphStore is reserved but not configured. Use PostgresGraphStore.");
  }

  async expandPaths(): Promise<KnowledgeGraphPath[]> {
    throw new Error("Neo4jGraphStore is reserved but not configured. Use PostgresGraphStore.");
  }

  async deleteDocumentGraph(): Promise<void> {
    throw new Error("Neo4jGraphStore is reserved but not configured. Use PostgresGraphStore.");
  }
}

export const graphStore = new PostgresGraphStore();
