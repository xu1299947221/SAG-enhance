import { describe, expect, it, vi } from "vitest";

const repositories = vi.hoisted(() => ({
  listKnowledgeEdgesBySource: vi.fn(),
  upsertKnowledgeEdge: vi.fn()
}));

vi.mock("../src/db/repositories.js", () => repositories);

import { BiddingAlignmentService } from "../src/services/bidding-alignment-service.js";

describe("BiddingAlignmentService", () => {
  it("creates SATISFIES/PROVES edges between material graph and requirement graph", async () => {
    const sourceId = "00000000-0000-0000-0000-000000000001";
    repositories.listKnowledgeEdgesBySource.mockResolvedValue([
      edge({
        id: "requirement-edge",
        relationType: "REQUIRES",
        relationLabel: "要求",
        subjectEntityId: "00000000-0000-0000-0000-000000000101",
        subjectName: "项目负责人证书要求",
        objectEntityId: "00000000-0000-0000-0000-000000000102",
        objectName: "信息系统项目管理师证书"
      }),
      edge({
        id: "material-edge",
        relationType: "HOLDS",
        relationLabel: "持有",
        subjectEntityId: "00000000-0000-0000-0000-000000000201",
        subjectName: "张三",
        objectEntityId: "00000000-0000-0000-0000-000000000102",
        objectName: "信息系统项目管理师证书"
      })
    ]);
    repositories.upsertKnowledgeEdge.mockResolvedValue({});

    const result = await new BiddingAlignmentService().alignSource(sourceId);

    expect(result.created).toBe(1);
    expect(repositories.upsertKnowledgeEdge).toHaveBeenCalledWith(expect.objectContaining({
      sourceId,
      subjectName: "张三",
      objectName: "项目负责人证书要求",
      relationType: "SATISFIES",
      extractionMethod: "bidding_alignment"
    }));
  });
});

function edge(input: {
  id: string;
  relationType: string;
  relationLabel: string;
  subjectEntityId: string;
  subjectName: string;
  objectEntityId: string;
  objectName: string;
}) {
  return {
    sourceId: "00000000-0000-0000-0000-000000000001",
    documentId: "00000000-0000-0000-0000-000000000002",
    chunkId: "00000000-0000-0000-0000-000000000003",
    eventId: "00000000-0000-0000-0000-000000000004",
    evidence: "证据",
    confidence: 0.9,
    qualityScore: 0.9,
    status: "AUTO" as const,
    metadata: {},
    ...input
  };
}
