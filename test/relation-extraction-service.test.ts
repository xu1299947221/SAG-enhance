import { beforeEach, describe, expect, it, vi } from "vitest";
import { RelationExtractionService, scoreRelation } from "../src/services/relation-extraction-service.js";
import type { AiRuntimeSettings } from "../src/services/ai-settings-service.js";

const runtimeSettings = vi.hoisted(() => ({
  current: {
    llmBaseUrl: "https://example.test/v1",
    llmModel: "test-llm",
    llmApiKey: "",
    hasRemoteLlm: false,
    llmTimeoutMs: 10_000,
    llmMaxRetries: 0,
    embeddingBaseUrl: "https://example.test/v1",
    embeddingModel: "test-embedding",
    embeddingApiKey: "",
    hasRemoteEmbedding: false,
    embeddingDimensions: 1024,
    rerankModel: "test-rerank",
    rerankInstruct: "rank",
    defaultSearchMode: "fast" as const,
    defaultSearchTopK: 10,
    defaultChunkingMode: "heading_strict" as const,
    chunkTokenLimit: 512,
    chunkOverlapTokens: 100,
    biddingDomainConfig: {
      canonicalEntities: [],
      entityTypes: [],
      queryExpansions: [],
      typeInference: []
    }
  } as AiRuntimeSettings
}));

vi.mock("../src/services/ai-settings-service.js", () => ({
  aiSettingsService: {
    getRuntimeSettings: vi.fn(async () => runtimeSettings.current)
  }
}));

describe("RelationExtractionService", () => {
  beforeEach(() => {
    runtimeSettings.current = {
      ...runtimeSettings.current,
      llmApiKey: "",
      hasRemoteLlm: false
    };
  });

  it("extracts conservative local strong relations with evidence", async () => {
    const service = new RelationExtractionService();
    const relations = await service.extractRelations({
      documentTitle: "招标文件",
      documentType: "招投标/应标文件",
      chunkContent: "拟派项目负责人须具备信息系统项目管理师证书。",
      extractedEntities: [
        { type: "personnel_requirement", name: "项目负责人", description: "人员要求" },
        { type: "certificate", name: "信息系统项目管理师证书", description: "证书" }
      ]
    });

    expect(relations).toEqual([expect.objectContaining({
      subject: "项目负责人",
      predicate: "REQUIRES",
      object: "信息系统项目管理师证书",
      evidence: expect.stringContaining("项目负责人"),
      confidence: expect.any(Number),
      qualityScore: expect.any(Number)
    })]);
  });

  it("scores RELATED_TO below strong reasoning relations", () => {
    const strong = scoreRelation({
      predicate: "PROVES",
      confidence: 0.8,
      evidence: "证书扫描件可证明人员证书要求。",
      subject: "证书扫描件",
      object: "人员证书要求"
    });
    const weak = scoreRelation({
      predicate: "RELATED_TO",
      confidence: 0.8,
      evidence: "证书扫描件和人员证书要求相关。",
      subject: "证书扫描件",
      object: "人员证书要求"
    });
    expect(strong).toBeGreaterThan(weak);
  });
});
