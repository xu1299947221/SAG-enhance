import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainProfileService } from "../src/services/domain-profile-service.js";
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

describe("DomainProfileService", () => {
  beforeEach(() => {
    runtimeSettings.current = {
      ...runtimeSettings.current,
      llmApiKey: "",
      hasRemoteLlm: false
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a local profile when no remote LLM is configured", async () => {
    const service = new DomainProfileService();
    const profile = await service.profileDocument({
      title: "操作手册",
      content: "系统支持文件上传、预审任务创建和报告生成。",
      candidates: [
        { name: "文件上传", type: "process", description: "候选", count: 2 },
        { name: "预审任务", type: "process", description: "候选", count: 2 },
        { name: "报告生成", type: "process", description: "候选", count: 2 },
        { name: "任务", type: "process", description: "噪声", count: 5 }
      ]
    });

    expect(profile.documentType).toBe("操作手册");
    expect(profile.objects.map((object) => object.name)).toEqual(expect.arrayContaining(["文件上传", "预审任务", "报告生成"]));
    expect(profile.objects.some((object) => object.name === "任务")).toBe(false);
  });

  it("uses remote LLM profile to denoise and merge candidate objects", async () => {
    runtimeSettings.current = {
      ...runtimeSettings.current,
      llmApiKey: "key",
      hasRemoteLlm: true
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              document_type: "操作手册",
              objects: [
                { name: "文件上传", type: "process", aliases: ["上传文件"], count: 3, confidence: 0.91, reason: "核心流程" },
                { name: "报告生成", type: "process", aliases: ["生成报告"], count: 2, confidence: 0.88, reason: "核心流程" }
              ],
              relations: [
                { source: "文件上传", target: "报告生成", predicate: "PRODUCES", relation: "产生", evidence: "上传后生成报告", confidence: 0.8 }
              ]
            })
          }
        }]
      })
    } as Response)));
    const service = new DomainProfileService();
    const profile = await service.profileDocument({
      title: "操作手册",
      content: "系统支持上传文件后生成报告。",
      candidates: [
        { name: "系统支持上传文件", type: "document_material", description: "噪声", count: 1 },
        { name: "生成报告", type: "process", description: "候选", count: 1 }
      ]
    });

    expect(profile.documentType).toBe("操作手册");
    expect(profile.objects).toHaveLength(2);
    expect(profile.objects[0]).toMatchObject({ name: "文件上传", aliases: ["上传文件"] });
    expect(profile.relations).toEqual([expect.objectContaining({
      source: "文件上传",
      target: "报告生成",
      predicate: "PRODUCES",
      relation: "产生"
    })]);
  });
});
