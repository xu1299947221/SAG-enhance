import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractedEvent } from "../src/types.js";

const db = vi.hoisted(() => {
  const client = {
    query: vi.fn(),
    release: vi.fn()
  };
  return {
    client,
    pool: {
      connect: vi.fn()
    }
  };
});

const profileService = vi.hoisted(() => ({
  profileDocument: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  pool: db.pool
}));

vi.mock("../src/services/domain-profile-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/domain-profile-service.js")>()),
  domainProfileService: profileService
}));

vi.mock("../src/db/repositories.js", () => ({
  createSource: vi.fn(async (input: { id?: string; tenantId: string; name: string; description?: string; metadata?: Record<string, unknown> }) => ({
    id: input.id ?? "00000000-0000-0000-0000-000000000101",
    tenantId: input.tenantId,
    name: input.name,
    description: input.description ?? null,
    metadata: input.metadata ?? {}
  })),
  deleteDocumentByExternalId: vi.fn(async () => []),
  getRelationConfig: vi.fn(async (input: { sourceId: string }) => ({
    sourceId: input.sourceId,
    disabledRelations: [],
    relationAliases: {},
    entityAliases: {},
    minConfidence: {},
    customRelations: [],
    metadata: {}
  })),
  listKnowledgeEdgesBySource: vi.fn(async () => []),
  upsertKnowledgeEdge: vi.fn(async (input: {
    sourceId: string;
    documentId: string;
    eventId: string;
    subjectEntityId: string;
    objectEntityId: string;
    relationType: string;
    relationLabel: string;
  }) => ({
    id: "edge-1",
    ...input,
    confidence: 0.8
  })),
  upsertEntity: vi.fn(async (input: { sourceId: string; type: string; name: string }) => ({
    id: `entity-${input.type}-${input.name}`,
    sourceId: input.sourceId,
    type: input.type,
    name: input.name,
    normalizedName: input.name.toLowerCase()
  }))
}));

vi.mock("../src/services/ai-settings-service.js", () => ({
  aiSettingsService: {
    getRuntimeSettings: vi.fn(async () => ({
      defaultChunkingMode: "heading_strict",
      chunkTokenLimit: 512,
      chunkOverlapTokens: 80
    }))
  }
}));

import { IngestionService } from "../src/services/ingestion-service.js";

describe("IngestionService domain profile integration", () => {
  beforeEach(() => {
    db.client.query.mockReset();
    db.client.release.mockReset();
    db.pool.connect.mockReset();
    db.pool.connect.mockResolvedValue(db.client);
    db.client.query.mockResolvedValue({ rows: [] });
    profileService.profileDocument.mockReset();
  });

  it("adds auto-profiled document objects to matching event entities", async () => {
    profileService.profileDocument.mockResolvedValue({
      documentType: "操作手册",
      objects: [
        { name: "文件上传", type: "process", aliases: ["上传文件"], count: 3, confidence: 0.91, reason: "核心流程" },
        { name: "报告生成", type: "document_material", aliases: ["生成报告"], count: 2, confidence: 0.88, reason: "核心产物" }
      ],
      relations: [
        { source: "文件上传", target: "报告生成", predicate: "PRODUCES", relation: "产生", confidence: 0.8 }
      ]
    });
    const embeddings = {
      generate: vi.fn(async () => [0.1, 0.2, 0.3]),
      batchGenerate: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]))
    };
    const event: ExtractedEvent = {
      title: "上传后生成报告",
      summary: "用户上传文件后系统生成报告",
      content: "用户上传文件后，系统会生成报告供查看。",
      category: "操作",
      keywords: [],
      references: [],
      entities: [
        { type: "system_object", name: "系统", description: "原始抽取实体" }
      ]
    };
    const llm = {
      extractNamedEntities: vi.fn(async () => []),
      rerankEvents: vi.fn(async () => []),
      extractEventsFromChunk: vi.fn(async () => [event])
    };
    const service = new IngestionService(embeddings, llm);

    await service.ingestDocument({
      sourceId: "00000000-0000-0000-0000-000000000101",
      title: "AI 预审助手操作手册",
      content: "## 上传\n用户上传文件后，系统会生成报告供查看。"
    });

    const eventEntityInserts = db.client.query.mock.calls.filter((call) => normalizeSql(call[0]).startsWith("insert into event_entities"));
    expect(eventEntityInserts.map((call) => call[1][3])).toEqual(expect.arrayContaining([
      expect.stringContaining("核心流程"),
      expect.stringContaining("核心产物")
    ]));
    expect(eventEntityInserts.map((call) => call[1][3])).not.toEqual(expect.arrayContaining([
      expect.stringContaining("原始抽取实体")
    ]));
    const eventInsert = db.client.query.mock.calls.find((call) => normalizeSql(call[0]).startsWith("insert into events"));
    expect(JSON.parse(String(eventInsert?.[1][13]))).toMatchObject({
      domainProfileRelations: [
        { source: "文件上传", target: "报告生成", predicate: "PRODUCES", relation: "产生" }
      ]
    });
    const { upsertKnowledgeEdge } = await import("../src/db/repositories.js");
    expect(upsertKnowledgeEdge).toHaveBeenCalledWith(expect.objectContaining({
      subjectName: "文件上传",
      objectName: "报告生成",
      relationType: "PRODUCES",
      relationLabel: "产生"
    }), db.client);
  });
});

function normalizeSql(value: unknown): string {
  return String(value).replace(/\s+/g, " ").trim();
}
