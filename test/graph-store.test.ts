import { describe, expect, it, vi } from "vitest";

const repositories = vi.hoisted(() => ({
  expandKnowledgeGraphPaths: vi.fn(),
  getEdgesByEntityIds: vi.fn(),
  getEdgesByEventIds: vi.fn(),
  searchKnowledgeEdges: vi.fn(),
  upsertKnowledgeEdge: vi.fn()
}));

vi.mock("../src/db/repositories.js", () => repositories);

import { PostgresGraphStore } from "../src/services/graph-store.js";

describe("PostgresGraphStore", () => {
  it("delegates edge search and path expansion to repository functions", async () => {
    const store = new PostgresGraphStore();
    repositories.searchKnowledgeEdges.mockResolvedValue([{ id: "edge-1" }]);
    repositories.expandKnowledgeGraphPaths.mockResolvedValue([{ reason: "path" }]);

    await expect(store.searchEdges({
      sourceIds: ["00000000-0000-0000-0000-000000000001"],
      query: "证书",
      limit: 5
    })).resolves.toEqual([{ id: "edge-1" }]);
    await expect(store.expandPaths({
      sourceIds: ["00000000-0000-0000-0000-000000000001"],
      seedEntityIds: ["00000000-0000-0000-0000-000000000002"],
      maxDepth: 2,
      limit: 5
    })).resolves.toEqual([{ reason: "path" }]);

    expect(repositories.searchKnowledgeEdges).toHaveBeenCalledWith(expect.objectContaining({ query: "证书" }));
    expect(repositories.expandKnowledgeGraphPaths).toHaveBeenCalledWith(expect.objectContaining({ maxDepth: 2 }));
  });
});
