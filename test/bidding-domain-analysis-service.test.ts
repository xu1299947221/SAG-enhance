import { beforeEach, describe, expect, it, vi } from "vitest";

const repositories = vi.hoisted(() => ({
  listDocumentContentsBySource: vi.fn()
}));

const profileService = vi.hoisted(() => ({
  profileDocument: vi.fn()
}));

vi.mock("../src/db/repositories.js", () => repositories);
vi.mock("../src/services/domain-profile-service.js", () => ({
  domainProfileService: profileService
}));
vi.mock("../src/services/ai-settings-service.js", () => ({
  aiSettingsService: {
    getRuntimeSettings: vi.fn(async () => ({
      biddingDomainConfig: {
        canonicalEntities: [],
        entityTypes: [],
        queryExpansions: [],
        typeInference: []
      }
    }))
  }
}));

import { BiddingDomainAnalysisService } from "../src/services/bidding-domain-analysis-service.js";

describe("BiddingDomainAnalysisService", () => {
  beforeEach(() => {
    repositories.listDocumentContentsBySource.mockReset();
    profileService.profileDocument.mockReset();
  });

  it("aggregates LLM-cleaned document profile objects and relations", async () => {
    repositories.listDocumentContentsBySource.mockResolvedValue([
      {
        id: "doc-1",
        title: "操作手册",
        content: "系统支持文件上传和报告生成。"
      }
    ]);
    profileService.profileDocument.mockResolvedValue({
      documentType: "操作手册",
      objects: [
        { name: "文件上传", type: "process", aliases: ["上传文件"], count: 3, confidence: 0.9, reason: "核心流程" },
        { name: "报告生成", type: "process", aliases: [], count: 2, confidence: 0.85, reason: "核心流程" }
      ],
      relations: [
        { source: "文件上传", target: "报告生成", relation: "前置流程", confidence: 0.8 }
      ]
    });
    const service = new BiddingDomainAnalysisService();
    const result = await service.analyzeSource("00000000-0000-0000-0000-000000000001");

    expect(result.documentType).toBe("操作手册");
    expect(result.entities.map((entity) => entity.name)).toEqual(["文件上传", "报告生成"]);
    expect(result.entities[0]).toMatchObject({
      aliases: ["上传文件"],
      confidence: 0.9,
      documents: [{ documentId: "doc-1", title: "操作手册" }]
    });
    expect(result.relations).toEqual([expect.objectContaining({ source: "文件上传", target: "报告生成", relation: "前置流程" })]);
  });
});
