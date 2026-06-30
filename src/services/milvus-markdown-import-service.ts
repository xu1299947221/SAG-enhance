import { MilvusClient } from "@zilliz/milvus2-sdk-node";
import type { QueryResults } from "@zilliz/milvus2-sdk-node";
import { config } from "../config/env.js";
import { ingestionService } from "./ingestion-service.js";
import type {
  IngestDocumentInput,
  MilvusMarkdownImportInput,
  MilvusMarkdownImportResult,
  MilvusMarkdownPreviewResult
} from "../types.js";

const DEFAULT_OUTPUT_FIELDS = [
  "doc_id",
  "doc_name",
  "md_url",
  "knowledge_id",
  "knowledge_type",
  "parent_doc_id",
  "doc_url",
  "doc_user_id",
  "doc_upload_time",
  "doc_tenant_id",
  "doc_file_type",
  "doc_analysis_type",
  "doc_type",
  "status",
  "source_type"
];

const FETCH_MARKDOWN_TIMEOUT_MS = 30_000;

export class MilvusMarkdownImportService {
  async previewDocuments(input: MilvusMarkdownImportInput): Promise<MilvusMarkdownPreviewResult> {
    const normalized = normalizeInput(input);
    const rows = await this.queryRows(normalized);
    return {
      total: rows.length,
      rows: rows.map((row, index) => ({
        index,
        externalId: readOptionalString(row, normalized.idField),
        title: readOptionalString(row, normalized.titleField),
        markdownUrl: readOptionalString(row, normalized.markdownUrlField),
        metadata: metadataFromRow(row)
      }))
    };
  }

  async importDocuments(
    input: MilvusMarkdownImportInput,
    tenantId = config.DEFAULT_TENANT_ID
  ): Promise<MilvusMarkdownImportResult> {
    const normalized = normalizeInput(input);
    const rows = await this.queryRows(normalized);
    return await this.ingestRows({
      input: normalized,
      rows,
      tenantId
    });
  }

  private async queryRows(normalized: NormalizedMilvusMarkdownImportInput): Promise<MilvusRow[]> {
    const client = new MilvusClient({
      address: normalized.connection.address,
      username: normalized.connection.username,
      password: normalized.connection.password,
      database: normalized.connection.database,
      timeout: "30s"
    });

    try {
      if (normalized.connection.database) {
        await client.useDatabase({ db_name: normalized.connection.database });
      }

      const queryResult = await client.query({
        collection_name: normalized.collectionName,
        db_name: normalized.connection.database,
        filter: normalized.filter,
        output_fields: outputFieldsFor(normalized),
        limit: normalized.limit,
        offset: normalized.offset
      });
      return readRows(queryResult);
    } finally {
      await client.closeConnection().catch(() => undefined);
    }
  }

  private async ingestRows(input: {
    input: NormalizedMilvusMarkdownImportInput;
    rows: MilvusRow[];
    tenantId: string;
  }): Promise<MilvusMarkdownImportResult> {
    const { input: normalized, rows, tenantId } = input;
    const items: MilvusMarkdownImportResult["items"] = [];
    let resolvedSourceId = normalized.sourceId;

    for (const [index, row] of rows.entries()) {
      try {
        const externalId = readRequiredString(row, normalized.idField, "external id");
        const title = readOptionalString(row, normalized.titleField) || externalId;
        const markdownUrl = readRequiredString(row, normalized.markdownUrlField, "markdown url");
        const content = await fetchMarkdown(markdownUrl);
        const document: IngestDocumentInput = {
          sourceId: resolvedSourceId,
          externalId,
          title,
          content,
          metadata: {
            sourceSystem: "milvus-doc-markdown",
            milvusCollection: normalized.collectionName,
            milvusDatabase: normalized.connection.database,
            markdownUrl,
            ...metadataFromRow(row)
          },
          extract: normalized.extract,
          replaceExisting: normalized.replaceExisting
        };
        const result = await ingestionService.ingestDocument(document, tenantId);
        resolvedSourceId = result.sourceId;
        items.push({
          index,
          ok: true,
          externalId,
          title,
          markdownUrl,
          documentId: result.documentId,
          chunkCount: result.chunkCount,
          eventCount: result.eventCount
        });
      } catch (error) {
        items.push({
          index,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
        if (!normalized.continueOnError) {
          break;
        }
      }
    }

    const succeeded = items.filter((item) => item.ok).length;
    return {
      total: rows.length,
      fetched: rows.length,
      succeeded,
      failed: items.length - succeeded,
      sourceId: resolvedSourceId,
      items
    };
  }
}

type MilvusRow = Record<string, unknown>;

type NormalizedMilvusMarkdownImportInput = Required<
  Pick<
    MilvusMarkdownImportInput,
    | "collectionName"
    | "filter"
    | "limit"
    | "offset"
    | "idField"
    | "titleField"
    | "markdownUrlField"
    | "extract"
    | "replaceExisting"
    | "continueOnError"
  >
> & {
  connection: {
    address: string;
    username?: string;
    password?: string;
    database?: string;
  };
  sourceId?: string;
};

export const milvusMarkdownImportService = new MilvusMarkdownImportService();

function normalizeInput(input: MilvusMarkdownImportInput): NormalizedMilvusMarkdownImportInput {
  return {
    connection: {
      address: input.connection.address.trim(),
      username: normalizeOptionalString(input.connection.username),
      password: normalizeOptionalString(input.connection.password),
      database: normalizeOptionalString(input.connection.database)
    },
    collectionName: input.collectionName.trim(),
    sourceId: normalizeOptionalString(input.sourceId),
    filter: normalizeOptionalString(input.filter) ?? 'doc_id != ""',
    limit: clampInteger(input.limit, 10, 1, 100),
    offset: clampInteger(input.offset, 0, 0, 10_000),
    idField: normalizeOptionalString(input.idField) ?? "doc_id",
    titleField: normalizeOptionalString(input.titleField) ?? "doc_name",
    markdownUrlField: normalizeOptionalString(input.markdownUrlField) ?? "md_url",
    extract: input.extract ?? true,
    replaceExisting: input.replaceExisting ?? true,
    continueOnError: input.continueOnError ?? true
  };
}

function outputFieldsFor(input: NormalizedMilvusMarkdownImportInput): string[] {
  return unique([...DEFAULT_OUTPUT_FIELDS, input.idField, input.titleField, input.markdownUrlField]);
}

function readRows(result: QueryResults): MilvusRow[] {
  return Array.isArray(result.data) ? result.data : [];
}

function readRequiredString(row: MilvusRow, field: string, label: string): string {
  const value = readOptionalString(row, field);
  if (!value) {
    throw new Error(`Milvus row missing ${label}: ${field}`);
  }
  return value;
}

function readOptionalString(row: MilvusRow, field: string): string | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function metadataFromRow(row: MilvusRow): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith("_")) continue;
    metadata[key] = value;
  }
  return metadata;
}

async function fetchMarkdown(url: string): Promise<string> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`Unsupported markdown url protocol: ${parsedUrl.protocol}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_MARKDOWN_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Fetch markdown failed: ${response.status} ${previewText(text, 160)}`);
    }
    if (!text.trim()) {
      throw new Error("Markdown content is empty");
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value as number));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim())));
}

function previewText(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}
