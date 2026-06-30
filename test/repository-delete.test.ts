import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../src/db/pool.js", () => ({
  pool: db.pool
}));

import { deleteDocument, deleteDocumentByExternalId } from "../src/db/repositories.js";

describe("deleteDocument repository operation", () => {
  beforeEach(() => {
    db.client.query.mockReset();
    db.client.release.mockReset();
    db.pool.connect.mockReset();
    db.pool.connect.mockResolvedValue(db.client);
  });

  it("deletes a document in one tenant-scoped transaction and removes only unshared entities first", async () => {
    db.client.query
      .mockResolvedValueOnce({ rows: [] }) // begin
      .mockResolvedValueOnce({ rows: [{ id: "00000000-0000-0000-0000-000000000011" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // commit

    await expect(deleteDocument({
      documentId: "00000000-0000-0000-0000-000000000011",
      tenantId: "default"
    })).resolves.toBe(true);

    expect(db.client.query).toHaveBeenCalledTimes(4);
    expect(normalizeSql(db.client.query.mock.calls[0][0])).toBe("begin");
    expect(normalizeSql(db.client.query.mock.calls[1][0])).toContain("join sources s on s.id = d.source_id");
    expect(normalizeSql(db.client.query.mock.calls[1][0])).toContain("where d.id = $1 and s.tenant_id = $2");
    expect(normalizeSql(db.client.query.mock.calls[1][0])).toContain("for update");
    expect(normalizeSql(db.client.query.mock.calls[2][0])).toContain("candidate_entities");
    expect(normalizeSql(db.client.query.mock.calls[2][0])).toContain("shared_entities");
    expect(normalizeSql(db.client.query.mock.calls[2][0])).toContain("delete from documents");
    expect(normalizeSql(db.client.query.mock.calls[2][0])).toContain("id not in (select entity_id from shared_entities)");
    expect(normalizeSql(db.client.query.mock.calls[3][0])).toBe("commit");
    expect(db.client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and returns false when the document is outside the tenant or missing", async () => {
    db.client.query
      .mockResolvedValueOnce({ rows: [] }) // begin
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // rollback

    await expect(deleteDocument({
      documentId: "00000000-0000-0000-0000-000000000011",
      tenantId: "other-tenant"
    })).resolves.toBe(false);

    expect(db.client.query).toHaveBeenCalledTimes(3);
    expect(normalizeSql(db.client.query.mock.calls[0][0])).toBe("begin");
    expect(normalizeSql(db.client.query.mock.calls[1][0])).toContain("s.tenant_id = $2");
    expect(normalizeSql(db.client.query.mock.calls[2][0])).toBe("rollback");
    expect(db.client.release).toHaveBeenCalledTimes(1);
  });

  it("deletes every document matching a source external id using the provided transaction client", async () => {
    const externalClient = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [
            { id: "00000000-0000-0000-0000-000000000021" },
            { id: "00000000-0000-0000-0000-000000000022" }
          ]
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
    };

    await expect(deleteDocumentByExternalId({
      sourceId: "00000000-0000-0000-0000-000000000001",
      externalId: "rag-resource-1",
      tenantId: "default"
    }, externalClient)).resolves.toEqual([
      "00000000-0000-0000-0000-000000000021",
      "00000000-0000-0000-0000-000000000022"
    ]);

    expect(externalClient.query).toHaveBeenCalledTimes(3);
    expect(normalizeSql(externalClient.query.mock.calls[0][0])).toContain("where d.source_id = $1 and d.external_id = $2 and s.tenant_id = $3");
    expect(normalizeSql(externalClient.query.mock.calls[0][0])).not.toContain("limit 1");
    expect(normalizeSql(externalClient.query.mock.calls[1][0])).toContain("delete from documents");
    expect(normalizeSql(externalClient.query.mock.calls[2][0])).toContain("delete from documents");
  });
});

function normalizeSql(value: unknown): string {
  return String(value).replace(/\s+/g, " ").trim();
}
