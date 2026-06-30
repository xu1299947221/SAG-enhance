import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool } from "./pool.js";
import { toVectorLiteral } from "./vector.js";
import type {
  ChunkRecord,
  DocumentRecord,
  EntityRecord,
  EntityDetailRecord,
  EntityWithEventsRecord,
  EventRecord,
  EventDetailRecord,
  EmbeddingPreview,
  KnowledgeGraphPath,
  KnowledgeEdgeRecord,
  RelationConfigRecord,
  RelationStatsRecord,
  AiProviderSettingsRecord,
  McpMessageRecord,
  McpMessageRole,
  McpSessionRecord,
  McpToolCallRecord,
  ProjectGraphEntityRecord,
  ProjectGraphEventRecord,
  ProjectGraphRecord,
  ProjectStatsRecord,
  SourceRecord
} from "../types.js";
import { isReasoningRelation, relationStrength } from "../domain/relation-ontology.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

function db(client?: Queryable): Queryable {
  return client ?? pool;
}

function sourceFromRow(row: Record<string, unknown>): SourceRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    archivedAt: row.archived_at == null ? null : new Date(String(row.archived_at)).toISOString(),
    createdAt: row.created_at == null ? undefined : new Date(String(row.created_at)).toISOString(),
    updatedAt: row.updated_at == null ? undefined : new Date(String(row.updated_at)).toISOString()
  };
}

function eventFromRow(row: Record<string, unknown>): EventRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? null : String(row.document_id),
    chunkId: row.chunk_id == null ? null : String(row.chunk_id),
    title: String(row.title),
    summary: String(row.summary ?? ""),
    content: String(row.content ?? ""),
    rank: Number(row.rank ?? 0),
    score: row.score == null ? undefined : Number(row.score),
    titleEmbedding: embeddingPreviewFromText(row.title_embedding_preview),
    contentEmbedding: embeddingPreviewFromText(row.content_embedding_preview)
  };
}

function entityFromRow(row: Record<string, unknown>): EntityRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    type: String(row.type),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    score: row.score == null ? undefined : Number(row.score),
    embedding: embeddingPreviewFromText(row.embedding_preview)
  };
}

function knowledgeEdgeFromRow(row: Record<string, unknown>): KnowledgeEdgeRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? null : String(row.document_id),
    chunkId: row.chunk_id == null ? null : String(row.chunk_id),
    eventId: row.event_id == null ? null : String(row.event_id),
    subjectEntityId: String(row.subject_entity_id),
    objectEntityId: String(row.object_entity_id),
    subjectName: String(row.subject_name),
    objectName: String(row.object_name),
    relationType: String(row.relation_type),
    relationLabel: String(row.relation_label),
    evidence: row.evidence == null ? null : String(row.evidence),
    evidenceStart: row.evidence_start == null ? null : Number(row.evidence_start),
    evidenceEnd: row.evidence_end == null ? null : Number(row.evidence_end),
    confidence: Number(row.confidence ?? 0),
    qualityScore: row.quality_score == null ? undefined : Number(row.quality_score),
    extractionMethod: row.extraction_method == null ? undefined : String(row.extraction_method),
    extractionModel: row.extraction_model == null ? null : String(row.extraction_model),
    promptVersion: row.prompt_version == null ? null : String(row.prompt_version),
    status: row.status == null ? undefined : String(row.status) as KnowledgeEdgeRecord["status"],
    score: row.score == null ? undefined : Number(row.score),
    metadata: (row.metadata ?? {}) as Record<string, unknown>
  };
}

function relationConfigFromRow(row: Record<string, unknown>): RelationConfigRecord {
  return {
    sourceId: String(row.source_id),
    disabledRelations: Array.isArray(row.disabled_relations) ? row.disabled_relations.map(String) : [],
    relationAliases: (row.relation_aliases ?? {}) as Record<string, string[]>,
    entityAliases: (row.entity_aliases ?? {}) as Record<string, string>,
    minConfidence: (row.min_confidence ?? {}) as Record<string, number>,
    customRelations: Array.isArray(row.custom_relations) ? row.custom_relations : [],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.created_at == null ? undefined : new Date(String(row.created_at)).toISOString(),
    updatedAt: row.updated_at == null ? undefined : new Date(String(row.updated_at)).toISOString()
  };
}

function documentFromRow(row: Record<string, unknown>): DocumentRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    title: String(row.title),
    status: String(row.status),
    parseStatus: String(row.parse_status),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    archivedAt: row.archived_at == null ? null : new Date(String(row.archived_at)).toISOString()
  };
}

function chunkFromRow(row: Record<string, unknown>): ChunkRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? null : String(row.document_id),
    heading: row.heading == null ? null : String(row.heading),
    content: String(row.content),
    rawContent: row.raw_content == null ? null : String(row.raw_content),
    rank: Number(row.rank ?? 0),
    references: Array.isArray(row.references) ? row.references.map(String) : [],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    embedding: embeddingPreviewFromText(row.embedding_preview)
  };
}

function embeddingPreviewFromText(value: unknown): EmbeddingPreview | null | undefined {
  if (value == null) {
    return undefined;
  }
  const numbers = String(value)
    .match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)
    ?.map(Number)
    .filter((item) => Number.isFinite(item)) ?? [];
  if (numbers.length === 0) {
    return null;
  }
  return {
    dimensions: numbers.length,
    sample: numbers.slice(0, 8)
  };
}

function mcpSessionFromRow(row: Record<string, unknown>): McpSessionRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    title: String(row.title),
    status: String(row.status),
    model: row.model == null ? null : String(row.model),
    sourceIds: Array.isArray(row.source_ids) ? row.source_ids.map(String) : [],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

function mcpMessageFromRow(row: Record<string, unknown>): McpMessageRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    role: String(row.role) as McpMessageRole,
    content: String(row.content),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

function mcpToolCallFromRow(row: Record<string, unknown>): McpToolCallRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    messageId: row.message_id == null ? null : String(row.message_id),
    toolName: String(row.tool_name),
    arguments: (row.arguments ?? {}) as Record<string, unknown>,
    result: row.result,
    status: String(row.status) as McpToolCallRecord["status"],
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    error: row.error == null ? null : String(row.error),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

function aiProviderSettingsFromRow(row: Record<string, unknown>): AiProviderSettingsRecord {
  return {
    id: "global",
    embeddingBaseUrl: String(row.embedding_base_url),
    embeddingModel: String(row.embedding_model),
    embeddingDimensions: Number(row.embedding_dimensions),
    embeddingApiKey: row.embedding_api_key == null ? null : String(row.embedding_api_key),
    llmBaseUrl: String(row.llm_base_url),
    llmModel: String(row.llm_model),
    llmApiKey: row.llm_api_key == null ? null : String(row.llm_api_key),
    llmTimeoutMs: Number(row.llm_timeout_ms),
    llmMaxRetries: Number(row.llm_max_retries),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

export async function createSource(input: {
  id?: string;
  tenantId: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}, client?: Queryable): Promise<SourceRecord> {
  const id = input.id ?? randomUUID();
  const result = await db(client).query(
    `
      insert into sources (id, tenant_id, name, description, metadata)
      values ($1, $2, $3, $4, $5::jsonb)
      on conflict (id) do update set
        name = sources.name,
        description = sources.description,
        metadata = sources.metadata || excluded.metadata,
        updated_at = now()
      returning *
    `,
    [id, input.tenantId, input.name, input.description ?? null, JSON.stringify(input.metadata ?? {})]
  );
  return sourceFromRow(result.rows[0]);
}

export async function getSource(sourceId: string, tenantId: string): Promise<SourceRecord | null> {
  const result = await pool.query(
    "select * from sources where id = $1 and tenant_id = $2",
    [sourceId, tenantId]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function listSources(input: {
  tenantId: string;
  limit: number;
  cursor?: string;
  includeArchived?: boolean;
}): Promise<SourceRecord[]> {
  const params: unknown[] = [input.tenantId, input.limit];
  let cursorSql = "";
  if (input.cursor) {
    params.push(input.cursor);
    cursorSql = "and id::text > $3";
  }
  const archiveSql = input.includeArchived ? "" : "and archived_at is null";
  const result = await pool.query(
    `
      select *
      from sources
      where tenant_id = $1 ${archiveSql} ${cursorSql}
      order by id
      limit $2
    `,
    params
  );
  return result.rows.map(sourceFromRow);
}

export async function updateSource(input: {
  sourceId: string;
  tenantId: string;
  name?: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<SourceRecord | null> {
  const result = await pool.query(
    `
      update sources
      set
        name = coalesce($3, name),
        description = case when $4::boolean then $5 else description end,
        metadata = metadata || $6::jsonb,
        updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [
      input.sourceId,
      input.tenantId,
      input.name?.trim() || null,
      Object.prototype.hasOwnProperty.call(input, "description"),
      input.description ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function archiveSource(input: {
  sourceId: string;
  tenantId: string;
}): Promise<SourceRecord | null> {
  const result = await pool.query(
    `
      update sources
      set archived_at = coalesce(archived_at, now()), updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [input.sourceId, input.tenantId]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function restoreSource(input: {
  sourceId: string;
  tenantId: string;
}): Promise<SourceRecord | null> {
  const result = await pool.query(
    `
      update sources
      set archived_at = null, updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [input.sourceId, input.tenantId]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function deleteSource(input: {
  sourceId: string;
  tenantId: string;
}): Promise<boolean> {
  const result = await pool.query(
    "delete from sources where id = $1 and tenant_id = $2",
    [input.sourceId, input.tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function assertSourcesAccessible(sourceIds: string[], tenantId: string): Promise<void> {
  if (sourceIds.length === 0) {
    throw new Error("sourceIds must not be empty");
  }
  const result = await pool.query(
    "select id from sources where tenant_id = $1 and archived_at is null and id = any($2::uuid[])",
    [tenantId, sourceIds]
  );
  const found = new Set(result.rows.map((row) => String(row.id)));
  const missing = sourceIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`source not found or not accessible: ${missing.join(",")}`);
  }
}

export async function getDefaultEntityType(type: string, client?: Queryable): Promise<string | null> {
  const result = await db(client).query(
    `
      select id
      from entity_types
      where type = $1 and is_active = true
      order by is_default desc
      limit 1
    `,
    [type]
  );
  return result.rows[0]?.id ? String(result.rows[0].id) : null;
}

export async function getAnyDefaultEntityType(client?: Queryable): Promise<string> {
  const result = await db(client).query(
    `
      select id
      from entity_types
      where is_active = true
      order by case when type = 'subject' then 0 else 1 end, is_default desc
      limit 1
    `
  );
  if (!result.rows[0]?.id) {
    throw new Error("entity_types seed data is missing; run npm run seed");
  }
  return String(result.rows[0].id);
}

export async function upsertEntity(input: {
  sourceId: string;
  type: string;
  name: string;
  description?: string;
  embedding: number[];
}, client?: Queryable): Promise<EntityRecord> {
  const normalizedName = input.name.trim().toLowerCase();
  const entityTypeId = (await getDefaultEntityType(input.type, client)) ?? await getAnyDefaultEntityType(client);
  const result = await db(client).query(
    `
      insert into entities (
        id, source_id, entity_type_id, type, name, normalized_name, description, embedding
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::vector)
      on conflict (source_id, type, normalized_name) do update set
        name = excluded.name,
        description = coalesce(nullif(entities.description, ''), excluded.description),
        embedding = coalesce(entities.embedding, excluded.embedding),
        updated_at = now()
      returning *
    `,
    [
      randomUUID(),
      input.sourceId,
      entityTypeId,
      input.type,
      input.name,
      normalizedName,
      input.description ?? "",
      toVectorLiteral(input.embedding)
    ]
  );
  return entityFromRow(result.rows[0]);
}

export async function upsertKnowledgeEdge(input: {
  sourceId: string;
  documentId: string;
  chunkId?: string | null;
  eventId: string;
  subjectEntityId: string;
  objectEntityId: string;
  subjectName: string;
  objectName: string;
  relationType: string;
  relationLabel: string;
  evidence?: string;
  evidenceStart?: number | null;
  evidenceEnd?: number | null;
  confidence?: number;
  qualityScore?: number;
  extractionMethod?: string;
  extractionModel?: string | null;
  promptVersion?: string | null;
  status?: KnowledgeEdgeRecord["status"];
  metadata?: Record<string, unknown>;
}, client?: Queryable): Promise<KnowledgeEdgeRecord> {
  const confidence = Math.max(0, Math.min(1, input.confidence ?? 0.7));
  const qualityScore = Math.max(0, Math.min(1, input.qualityScore ?? confidence));
  const result = await db(client).query(
    `
      insert into knowledge_edges (
        id, source_id, document_id, chunk_id, event_id,
        subject_entity_id, object_entity_id, subject_name, object_name,
        relation_type, relation_label, evidence, evidence_start, evidence_end,
        confidence, quality_score, extraction_method, extraction_model, prompt_version, status, metadata
      )
      values (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21::jsonb
      )
      on conflict (event_id, subject_entity_id, relation_type, object_entity_id) do update set
        subject_name = excluded.subject_name,
        object_name = excluded.object_name,
        relation_label = excluded.relation_label,
        evidence = coalesce(nullif(excluded.evidence, ''), knowledge_edges.evidence),
        evidence_start = coalesce(excluded.evidence_start, knowledge_edges.evidence_start),
        evidence_end = coalesce(excluded.evidence_end, knowledge_edges.evidence_end),
        confidence = greatest(knowledge_edges.confidence, excluded.confidence),
        quality_score = greatest(knowledge_edges.quality_score, excluded.quality_score),
        extraction_method = excluded.extraction_method,
        extraction_model = coalesce(excluded.extraction_model, knowledge_edges.extraction_model),
        prompt_version = coalesce(excluded.prompt_version, knowledge_edges.prompt_version),
        status = case when knowledge_edges.status = 'CONFIRMED' then knowledge_edges.status else excluded.status end,
        metadata = knowledge_edges.metadata || excluded.metadata,
        updated_at = now()
      returning *
    `,
    [
      randomUUID(),
      input.sourceId,
      input.documentId,
      input.chunkId ?? null,
      input.eventId,
      input.subjectEntityId,
      input.objectEntityId,
      input.subjectName,
      input.objectName,
      input.relationType,
      input.relationLabel,
      input.evidence ?? null,
      input.evidenceStart ?? null,
      input.evidenceEnd ?? null,
      confidence,
      qualityScore,
      input.extractionMethod ?? "domain_profile_relation",
      input.extractionModel ?? null,
      input.promptVersion ?? null,
      input.status ?? "AUTO",
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return knowledgeEdgeFromRow(result.rows[0]);
}

export async function searchEntitiesByVector(input: {
  sourceIds: string[];
  queryVector: number[];
  topK: number;
  threshold: number;
}): Promise<EntityRecord[]> {
  const result = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name,
             1 - (ent.embedding <=> $1::vector) as score
      from entities ent
      where ent.source_id = any($2::uuid[])
        and ent.embedding is not null
        and exists (
          select 1
          from event_entities ee
          join events e on e.id = ee.event_id
          join documents d on d.id = e.document_id
          join sources s on s.id = e.source_id
          where ee.entity_id = ent.id
            and e.deleted_at is null
            and d.archived_at is null
            and s.archived_at is null
        )
      order by ent.embedding <=> $1::vector
      limit $3
    `,
    [toVectorLiteral(input.queryVector), input.sourceIds, input.topK]
  );
  return result.rows
    .map(entityFromRow)
    .filter((entity) => (entity.score ?? 0) >= input.threshold);
}

export async function searchEntitiesByName(input: {
  sourceIds: string[];
  names: string[];
  limit: number;
}): Promise<EntityRecord[]> {
  if (input.names.length === 0) {
    return [];
  }
  const normalizedNames = input.names.map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (normalizedNames.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name, 1.0 as score
      from entities ent
      where ent.source_id = any($1::uuid[])
        and exists (
          select 1
          from unnest($2::text[]) as query_name(name)
          where ent.normalized_name = query_name.name
             or ent.normalized_name % query_name.name
        )
        and exists (
          select 1
          from event_entities ee
          join events e on e.id = ee.event_id
          join documents d on d.id = e.document_id
          join sources s on s.id = e.source_id
          where ee.entity_id = ent.id
            and e.deleted_at is null
            and d.archived_at is null
            and s.archived_at is null
        )
      limit $3
    `,
    [input.sourceIds, normalizedNames, input.limit]
  );
  return result.rows.map(entityFromRow);
}

export async function searchEntitiesByText(input: {
  sourceIds: string[];
  query: string;
  limit: number;
}): Promise<EntityRecord[]> {
  const query = input.query.trim();
  if (!query) {
    return [];
  }
  const result = await pool.query(
    `
      with q as (
        select
          websearch_to_tsquery('simple', $2) as tsq,
          lower($2) as raw_query
      )
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name,
             greatest(
               coalesce(ts_rank_cd(ent.search_text, q.tsq), 0),
               similarity(ent.normalized_name, q.raw_query),
               similarity(lower(coalesce(ent.description, '')), q.raw_query),
               case when q.raw_query like '%' || ent.normalized_name || '%' then 1.0 else 0 end,
               case when ent.normalized_name = q.raw_query then 1.2 else 0 end,
               case
                 when exists (
                   select 1
                   from regexp_split_to_table(q.raw_query, '\\s+') as term(value)
                   where length(term.value) >= 2
                     and (
                       ent.normalized_name like '%' || term.value || '%'
                       or lower(coalesce(ent.description, '')) like '%' || term.value || '%'
                     )
                 ) then 0.8
                 else 0
               end
             ) as score
      from entities ent
      cross join q
      where ent.source_id = any($1::uuid[])
        and (
          ent.search_text @@ q.tsq
          or ent.normalized_name % q.raw_query
          or lower(coalesce(ent.description, '')) % q.raw_query
          or q.raw_query like '%' || ent.normalized_name || '%'
          or exists (
            select 1
            from regexp_split_to_table(q.raw_query, '\\s+') as term(value)
            where length(term.value) >= 2
              and (
                ent.normalized_name like '%' || term.value || '%'
                or lower(coalesce(ent.description, '')) like '%' || term.value || '%'
              )
          )
        )
        and exists (
          select 1
          from event_entities ee
          join events e on e.id = ee.event_id
          join documents d on d.id = e.document_id
          join sources s on s.id = e.source_id
          where ee.entity_id = ent.id
            and e.deleted_at is null
            and d.archived_at is null
            and s.archived_at is null
        )
      order by score desc, ent.name
      limit $3
    `,
    [input.sourceIds, query, input.limit]
  );
  return result.rows.map(entityFromRow);
}

export async function getEntitiesByIds(input: {
  sourceIds: string[];
  entityIds: string[];
  limit: number;
}): Promise<EntityRecord[]> {
  if (input.entityIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name, 1.0 as score
      from entities ent
      where ent.source_id = any($1::uuid[])
        and ent.id = any($2::uuid[])
        and exists (
          select 1
          from event_entities ee
          join events e on e.id = ee.event_id
          join documents d on d.id = e.document_id
          join sources s on s.id = e.source_id
          where ee.entity_id = ent.id
            and e.deleted_at is null
            and d.archived_at is null
            and s.archived_at is null
        )
      order by array_position($2::uuid[], ent.id), ent.name
      limit $3
    `,
    [input.sourceIds, input.entityIds, input.limit]
  );
  return result.rows.map(entityFromRow);
}

export async function searchKnowledgeEdges(input: {
  sourceIds: string[];
  query: string;
  entityIds?: string[];
  eventIds?: string[];
  relationTypes?: string[];
  minConfidence?: number;
  limit: number;
}): Promise<KnowledgeEdgeRecord[]> {
  const entityIds = input.entityIds ?? [];
  const eventIds = input.eventIds ?? [];
  const relationTypes = input.relationTypes ?? [];
  const minConfidence = input.minConfidence ?? 0;
  const query = input.query.trim();
  if (!query && entityIds.length === 0 && eventIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      with q as (
        select
          case when length($2) > 0 then websearch_to_tsquery('simple', $2) else null end as tsq,
          lower($2) as raw_query
      )
      select ke.*,
             greatest(
               case when q.tsq is null then 0 else coalesce(ts_rank_cd(ke.search_text, q.tsq), 0) end,
               similarity(lower(ke.subject_name), q.raw_query),
               similarity(lower(ke.object_name), q.raw_query),
               similarity(lower(ke.relation_label), q.raw_query),
               case when ke.subject_entity_id = any($3::uuid[]) or ke.object_entity_id = any($3::uuid[]) then 1.0 else 0 end,
               case when ke.event_id = any($4::uuid[]) then 0.8 else 0 end
             ) as score
      from knowledge_edges ke
      cross join q
      join documents d on d.id = ke.document_id
      join sources s on s.id = ke.source_id
      where ke.source_id = any($1::uuid[])
        and d.archived_at is null
        and s.archived_at is null
        and ke.status not in ('REJECTED', 'DISABLED')
        and ke.confidence >= $6
        and (cardinality($7::text[]) = 0 or ke.relation_type = any($7::text[]))
        and (
          (q.tsq is not null and ke.search_text @@ q.tsq)
          or ke.subject_entity_id = any($3::uuid[])
          or ke.object_entity_id = any($3::uuid[])
          or ke.event_id = any($4::uuid[])
          or lower(ke.subject_name) % q.raw_query
          or lower(ke.object_name) % q.raw_query
          or lower(ke.relation_label) % q.raw_query
        )
      order by score desc, ke.quality_score desc, ke.confidence desc, ke.created_at desc
      limit $5
    `,
    [input.sourceIds, query, entityIds, eventIds, input.limit, minConfidence, relationTypes]
  );
  return result.rows.map(knowledgeEdgeFromRow);
}

export async function getEdgesByEntityIds(input: {
  sourceIds: string[];
  entityIds: string[];
  relationTypes?: string[];
  minConfidence?: number;
  includeInactive?: boolean;
  limit: number;
}): Promise<KnowledgeEdgeRecord[]> {
  if (input.entityIds.length === 0) return [];
  const statusSql = input.includeInactive ? "" : "and ke.status not in ('REJECTED', 'DISABLED')";
  const result = await pool.query(
    `
      select ke.*,
             case when ke.subject_entity_id = any($2::uuid[]) or ke.object_entity_id = any($2::uuid[]) then 1.0 else 0 end as score
      from knowledge_edges ke
      join documents d on d.id = ke.document_id
      join sources s on s.id = ke.source_id
      where ke.source_id = any($1::uuid[])
        and (ke.subject_entity_id = any($2::uuid[]) or ke.object_entity_id = any($2::uuid[]))
        and d.archived_at is null
        and s.archived_at is null
        ${statusSql}
        and ke.confidence >= $3
        and (cardinality($4::text[]) = 0 or ke.relation_type = any($4::text[]))
      order by ke.quality_score desc, ke.confidence desc, ke.created_at desc
      limit $5
    `,
    [input.sourceIds, input.entityIds, input.minConfidence ?? 0, input.relationTypes ?? [], input.limit]
  );
  return result.rows.map(knowledgeEdgeFromRow);
}

export async function getEdgesByEventIds(input: {
  sourceIds: string[];
  eventIds: string[];
  relationTypes?: string[];
  minConfidence?: number;
  includeInactive?: boolean;
  limit: number;
}): Promise<KnowledgeEdgeRecord[]> {
  if (input.eventIds.length === 0) return [];
  const statusSql = input.includeInactive ? "" : "and ke.status not in ('REJECTED', 'DISABLED')";
  const result = await pool.query(
    `
      select ke.*, 1.0 as score
      from knowledge_edges ke
      join documents d on d.id = ke.document_id
      join sources s on s.id = ke.source_id
      where ke.source_id = any($1::uuid[])
        and ke.event_id = any($2::uuid[])
        and d.archived_at is null
        and s.archived_at is null
        ${statusSql}
        and ke.confidence >= $3
        and (cardinality($4::text[]) = 0 or ke.relation_type = any($4::text[]))
      order by ke.quality_score desc, ke.confidence desc, ke.created_at desc
      limit $5
    `,
    [input.sourceIds, input.eventIds, input.minConfidence ?? 0, input.relationTypes ?? [], input.limit]
  );
  return result.rows.map(knowledgeEdgeFromRow);
}

export async function expandKnowledgeGraphPaths(input: {
  sourceIds: string[];
  seedEntityIds: string[];
  relationTypes?: string[];
  minConfidence?: number;
  maxDepth: number;
  limit: number;
}): Promise<KnowledgeGraphPath[]> {
  const seedEntityIds = [...new Set(input.seedEntityIds)].filter(Boolean);
  if (seedEntityIds.length === 0 || input.maxDepth <= 0) return [];
  const allEdges = await getEdgesByEntityIds({
    sourceIds: input.sourceIds,
    entityIds: seedEntityIds,
    relationTypes: input.relationTypes,
    minConfidence: input.minConfidence,
    limit: Math.max(input.limit * 8, 80)
  });
  const frontier = allEdges.map((edge) => ({
    nodes: [edge.subjectEntityId, edge.objectEntityId],
    edges: [edge]
  }));
  const paths: KnowledgeGraphPath[] = [];
  const seen = new Set<string>();
  while (frontier.length > 0 && paths.length < input.limit * 3) {
    const current = frontier.shift()!;
    const key = current.edges.map((edge) => edge.id).join(">");
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(toKnowledgePath(current.nodes, current.edges));
    if (current.edges.length >= input.maxDepth) continue;
    const tail = current.nodes[current.nodes.length - 1];
    const nextEdges = await getEdgesByEntityIds({
      sourceIds: input.sourceIds,
      entityIds: [tail],
      relationTypes: input.relationTypes,
      minConfidence: input.minConfidence,
      limit: 30
    });
    for (const edge of nextEdges) {
      if (current.edges.some((item) => item.id === edge.id)) continue;
      if (!isReasoningRelation(edge.relationType) || edge.relationType === "RELATED_TO") continue;
      const nextNode = edge.subjectEntityId === tail ? edge.objectEntityId : edge.subjectEntityId;
      if (current.nodes.includes(nextNode)) continue;
      frontier.push({
        nodes: [...current.nodes, nextNode],
        edges: [...current.edges, edge]
      });
    }
  }
  return paths
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit);
}

function toKnowledgePath(entityIds: string[], edges: KnowledgeEdgeRecord[]): KnowledgeGraphPath {
  const nameByEntityId = new Map<string, { name: string; type?: string }>();
  for (const edge of edges) {
    nameByEntityId.set(edge.subjectEntityId, { name: edge.subjectName });
    nameByEntityId.set(edge.objectEntityId, { name: edge.objectName });
  }
  const avgConfidence = edges.reduce((sum, edge) => sum + edge.confidence, 0) / Math.max(edges.length, 1);
  const avgQuality = edges.reduce((sum, edge) => sum + (edge.qualityScore ?? edge.confidence), 0) / Math.max(edges.length, 1);
  const strengthScore = edges.reduce((sum, edge) => sum + (relationStrength(edge.relationType) === "strong" ? 0.08 : -0.08), 0);
  const score = Math.max(0, Math.min(1, avgConfidence * 0.45 + avgQuality * 0.45 + strengthScore - (edges.length - 1) * 0.03));
  return {
    nodes: entityIds.map((entityId) => ({
      entityId,
      name: nameByEntityId.get(entityId)?.name ?? entityId,
      type: nameByEntityId.get(entityId)?.type
    })),
    edges,
    evidence: edges.map((edge) => ({
      edgeId: edge.id,
      text: edge.evidence ?? "",
      confidence: edge.confidence
    })).filter((item) => item.text),
    score,
    reason: edges.map((edge) => `${edge.subjectName} ${edge.relationLabel} ${edge.objectName}`).join(" -> ")
  };
}

export async function getEventIdsByEntityIds(input: {
  entityIds: string[];
  sourceIds: string[];
  excludeEventIds?: string[];
}): Promise<string[]> {
  if (input.entityIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      select distinct ee.event_id
      from event_entities ee
      join events e on e.id = ee.event_id
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where ee.entity_id = any($1::uuid[])
        and e.source_id = any($2::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
        and not (ee.event_id = any($3::uuid[]))
    `,
    [input.entityIds, input.sourceIds, input.excludeEventIds ?? []]
  );
  return result.rows.map((row) => String(row.event_id));
}

export async function searchEventsByTitleVector(input: {
  sourceIds: string[];
  queryVector: number[];
  topK: number;
  threshold: number;
}): Promise<EventRecord[]> {
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
             1 - (e.title_embedding <=> $1::vector) as score
      from events e
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.source_id = any($2::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
        and e.title_embedding is not null
      order by e.title_embedding <=> $1::vector
      limit $3
    `,
    [toVectorLiteral(input.queryVector), input.sourceIds, input.topK]
  );
  return result.rows
    .map(eventFromRow)
    .filter((event) => (event.score ?? 0) >= input.threshold);
}

export async function coarseRankEventsByContent(input: {
  sourceIds: string[];
  eventIds: string[];
  queryVector: number[];
  maxEvents: number;
}): Promise<EventRecord[]> {
  if (input.eventIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
             1 - (e.content_embedding <=> $1::vector) as score
      from events e
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.id = any($2::uuid[])
        and e.source_id = any($3::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
        and e.content_embedding is not null
      order by e.content_embedding <=> $1::vector
      limit $4
    `,
    [toVectorLiteral(input.queryVector), input.eventIds, input.sourceIds, input.maxEvents]
  );
  return result.rows.map(eventFromRow);
}

export async function getEventsWithEntityIds(eventIds: string[]): Promise<Map<string, EventRecord & { entityIds: string[] }>> {
  const map = new Map<string, EventRecord & { entityIds: string[] }>();
  if (eventIds.length === 0) {
    return map;
  }
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
             coalesce(array_agg(ee.entity_id) filter (where ee.entity_id is not null), '{}') as entity_ids
      from events e
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      left join event_entities ee on ee.event_id = e.id
      where e.id = any($1::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
      group by e.id
    `,
    [eventIds]
  );
  for (const row of result.rows) {
    const event = eventFromRow(row) as EventRecord & { entityIds: string[] };
    event.entityIds = (row.entity_ids ?? []).map(String);
    map.set(event.id, event);
  }
  return map;
}

export async function getSectionsForEvents(eventIds: string[]): Promise<Array<{
  eventId: string;
  chunkId: string;
  sourceId: string;
  documentId?: string;
  externalId?: string;
  documentTitle?: string;
  documentMetadata?: Record<string, unknown>;
  heading?: string;
  content: string;
  rank: number;
}>> {
  if (eventIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      select e.id as event_id, c.id as chunk_id, c.source_id, c.document_id,
             d.external_id, d.title as document_title, d.metadata as document_metadata,
             c.heading, c.content, c.rank
      from events e
      join source_chunks c on c.id = e.chunk_id
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.id = any($1::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
      order by array_position($1::uuid[], e.id), c.rank
    `,
    [eventIds]
  );
  return result.rows.map((row) => ({
    eventId: String(row.event_id),
    chunkId: String(row.chunk_id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? undefined : String(row.document_id),
    externalId: row.external_id == null ? undefined : String(row.external_id),
    documentTitle: row.document_title == null ? undefined : String(row.document_title),
    documentMetadata: row.document_metadata == null ? undefined : row.document_metadata as Record<string, unknown>,
    heading: row.heading == null ? undefined : String(row.heading),
    content: String(row.content),
    rank: Number(row.rank)
  }));
}

export async function searchChunksByVector(input: {
  sourceIds: string[];
  queryVector: number[];
  topK: number;
}): Promise<Array<{
  chunkId: string;
  sourceId: string;
  documentId?: string;
  externalId?: string;
  documentTitle?: string;
  documentMetadata?: Record<string, unknown>;
  heading?: string;
  content: string;
  rank: number;
  score: number;
}>> {
  const result = await pool.query(
    `
      select c.id, c.source_id, c.document_id, d.external_id,
             d.title as document_title, d.metadata as document_metadata,
             c.heading, c.content, c.rank,
             1 - (c.embedding <=> $1::vector) as score
      from source_chunks c
      join documents d on d.id = c.document_id
      join sources s on s.id = c.source_id
      where c.source_id = any($2::uuid[])
        and c.embedding is not null
        and d.archived_at is null
        and s.archived_at is null
      order by c.embedding <=> $1::vector
      limit $3
    `,
    [toVectorLiteral(input.queryVector), input.sourceIds, input.topK]
  );
  return result.rows.map((row) => ({
    chunkId: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? undefined : String(row.document_id),
    externalId: row.external_id == null ? undefined : String(row.external_id),
    documentTitle: row.document_title == null ? undefined : String(row.document_title),
    documentMetadata: row.document_metadata == null ? undefined : row.document_metadata as Record<string, unknown>,
    heading: row.heading == null ? undefined : String(row.heading),
    content: String(row.content),
    rank: Number(row.rank),
    score: Number(row.score)
  }));
}

export async function getSectionsForKnowledgeEdges(edgeIds: string[]): Promise<Array<{
  edgeId: string;
  chunkId: string;
  sourceId: string;
  documentId?: string;
  externalId?: string;
  documentTitle?: string;
  documentMetadata?: Record<string, unknown>;
  heading?: string;
  content: string;
  rank: number;
  score: number;
}>> {
  if (edgeIds.length === 0) return [];
  const result = await pool.query(
    `
      select ke.id as edge_id, c.id as chunk_id, c.source_id, c.document_id,
             d.external_id, d.title as document_title, d.metadata as document_metadata,
             c.heading, c.content, c.rank,
             greatest(ke.quality_score, ke.confidence) as score
      from knowledge_edges ke
      join source_chunks c on c.id = ke.chunk_id
      join documents d on d.id = ke.document_id
      join sources s on s.id = ke.source_id
      where ke.id = any($1::uuid[])
        and ke.status not in ('REJECTED', 'DISABLED')
        and d.archived_at is null
        and s.archived_at is null
      order by array_position($1::uuid[], ke.id), c.rank
    `,
    [edgeIds]
  );
  return result.rows.map((row) => ({
    edgeId: String(row.edge_id),
    chunkId: String(row.chunk_id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? undefined : String(row.document_id),
    externalId: row.external_id == null ? undefined : String(row.external_id),
    documentTitle: row.document_title == null ? undefined : String(row.document_title),
    documentMetadata: row.document_metadata == null ? undefined : row.document_metadata as Record<string, unknown>,
    heading: row.heading == null ? undefined : String(row.heading),
    content: String(row.content),
    rank: Number(row.rank),
    score: Number(row.score)
  }));
}

export async function getEdgesForSections(input: {
  chunkIds: string[];
  includeInactive?: boolean;
}): Promise<KnowledgeEdgeRecord[]> {
  if (input.chunkIds.length === 0) return [];
  const statusSql = input.includeInactive ? "" : "and ke.status not in ('REJECTED', 'DISABLED')";
  const result = await pool.query(
    `
      select ke.*
      from knowledge_edges ke
      where ke.chunk_id = any($1::uuid[])
        ${statusSql}
      order by ke.quality_score desc, ke.confidence desc
    `,
    [input.chunkIds]
  );
  return result.rows.map(knowledgeEdgeFromRow);
}

export async function getEventDetail(input: {
  eventId: string;
  tenantId: string;
  includeArchived?: boolean;
}): Promise<EventDetailRecord | null> {
  const archiveSql = input.includeArchived
    ? ""
    : "and s.archived_at is null and (d.id is null or d.archived_at is null)";
  const eventResult = await pool.query(
    `
      select
        e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
        d.id as document_id_for_detail,
        d.title as document_title,
        d.status as document_status,
        d.parse_status as document_parse_status,
        d.metadata as document_metadata,
        d.created_at as document_created_at,
        d.updated_at as document_updated_at,
        d.archived_at as document_archived_at,
        s.id as source_id_for_detail,
        s.tenant_id as source_tenant_id,
        s.name as source_name,
        s.description as source_description,
        s.metadata as source_metadata,
        s.archived_at as source_archived_at,
        s.created_at as source_created_at,
        s.updated_at as source_updated_at
      from events e
      join sources s on s.id = e.source_id
      left join documents d on d.id = e.document_id
      where e.id = $1
        and s.tenant_id = $2
        and e.deleted_at is null
        ${archiveSql}
    `,
    [input.eventId, input.tenantId]
  );
  if (!eventResult.rows[0]) {
    return null;
  }
  const event = eventFromRow(eventResult.rows[0]);
  const entityResult = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name
      from event_entities ee
      join entities ent on ent.id = ee.entity_id
      join sources s on s.id = ent.source_id
      where ee.event_id = $1
        and s.tenant_id = $2
      order by ent.type, ent.name
    `,
    [input.eventId, input.tenantId]
  );
  const chunkResult = event.chunkId
    ? await pool.query(
        `
          select c.id, c.source_id, c.document_id, c.heading, c.content, c.rank
          from source_chunks c
          join sources s on s.id = c.source_id
          left join documents d on d.id = c.document_id
          where c.id = $1
            and s.tenant_id = $2
            ${archiveSql}
        `,
        [event.chunkId, input.tenantId]
      )
    : { rows: [] };
  const row = eventResult.rows[0] as Record<string, unknown>;

  return {
    event,
    entities: entityResult.rows.map(entityFromRow),
    source: row.source_id_for_detail == null
      ? null
      : sourceFromRow({
          id: row.source_id_for_detail,
          tenant_id: row.source_tenant_id,
          name: row.source_name,
          description: row.source_description,
          metadata: row.source_metadata,
          archived_at: row.source_archived_at,
          created_at: row.source_created_at,
          updated_at: row.source_updated_at
        }),
    document: row.document_id_for_detail == null
      ? null
      : documentFromRow({
          id: row.document_id_for_detail,
          source_id: row.source_id_for_detail,
          title: row.document_title,
          status: row.document_status,
          parse_status: row.document_parse_status,
          metadata: row.document_metadata,
          created_at: row.document_created_at,
          updated_at: row.document_updated_at,
          archived_at: row.document_archived_at
        }),
    chunk: chunkResult.rows[0]
      ? {
          chunkId: String(chunkResult.rows[0].id),
          sourceId: String(chunkResult.rows[0].source_id),
          documentId: chunkResult.rows[0].document_id == null ? null : String(chunkResult.rows[0].document_id),
          heading: chunkResult.rows[0].heading == null ? undefined : String(chunkResult.rows[0].heading),
          content: String(chunkResult.rows[0].content),
          rank: Number(chunkResult.rows[0].rank ?? 0)
        }
      : undefined
  };
}

export async function listDocumentsBySource(input: {
  sourceId: string;
  tenantId: string;
  limit: number;
  includeArchived?: boolean;
}): Promise<DocumentRecord[]> {
  const archiveSql = input.includeArchived ? "" : "and d.archived_at is null";
  const result = await pool.query(
    `
      select d.*
      from documents d
      join sources s on s.id = d.source_id
      where d.source_id = $1 and s.tenant_id = $2 ${archiveSql}
      order by d.created_at desc, d.id
      limit $3
    `,
    [input.sourceId, input.tenantId, input.limit]
  );
  return result.rows.map(documentFromRow);
}

export async function getRelationConfig(input: {
  sourceId: string;
  tenantId: string;
}): Promise<RelationConfigRecord> {
  await assertSourcesAccessible([input.sourceId], input.tenantId);
  const result = await pool.query(
    "select * from relation_configs where source_id = $1",
    [input.sourceId]
  );
  if (result.rows[0]) {
    return relationConfigFromRow(result.rows[0]);
  }
  return {
    sourceId: input.sourceId,
    disabledRelations: [],
    relationAliases: {},
    entityAliases: {},
    minConfidence: {},
    customRelations: [],
    metadata: {}
  };
}

export async function upsertRelationConfig(input: {
  sourceId: string;
  tenantId: string;
  disabledRelations?: string[];
  relationAliases?: Record<string, string[]>;
  entityAliases?: Record<string, string>;
  minConfidence?: Record<string, number>;
  customRelations?: unknown[];
  metadata?: Record<string, unknown>;
}): Promise<RelationConfigRecord> {
  await assertSourcesAccessible([input.sourceId], input.tenantId);
  const result = await pool.query(
    `
      insert into relation_configs (
        id, source_id, disabled_relations, relation_aliases, entity_aliases,
        min_confidence, custom_relations, metadata
      )
      values ($1, $2, $3::text[], $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)
      on conflict (source_id) do update set
        disabled_relations = excluded.disabled_relations,
        relation_aliases = excluded.relation_aliases,
        entity_aliases = excluded.entity_aliases,
        min_confidence = excluded.min_confidence,
        custom_relations = excluded.custom_relations,
        metadata = relation_configs.metadata || excluded.metadata,
        updated_at = now()
      returning *
    `,
    [
      randomUUID(),
      input.sourceId,
      input.disabledRelations ?? [],
      JSON.stringify(input.relationAliases ?? {}),
      JSON.stringify(input.entityAliases ?? {}),
      JSON.stringify(input.minConfidence ?? {}),
      JSON.stringify(input.customRelations ?? []),
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return relationConfigFromRow(result.rows[0]);
}

export async function updateKnowledgeEdge(input: {
  edgeId: string;
  tenantId: string;
  relationType?: string;
  relationLabel?: string;
  subjectName?: string;
  objectName?: string;
  evidence?: string | null;
  confidence?: number;
  qualityScore?: number;
  status?: KnowledgeEdgeRecord["status"];
  metadata?: Record<string, unknown>;
  note?: string;
}): Promise<KnowledgeEdgeRecord | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const beforeResult = await client.query(
      `
        select ke.*
        from knowledge_edges ke
        join sources s on s.id = ke.source_id
        where ke.id = $1 and s.tenant_id = $2
        for update
      `,
      [input.edgeId, input.tenantId]
    );
    if (!beforeResult.rows[0]) {
      await client.query("rollback");
      return null;
    }
    const before = knowledgeEdgeFromRow(beforeResult.rows[0]);
    const result = await client.query(
      `
        update knowledge_edges
        set
          relation_type = coalesce($3, relation_type),
          relation_label = coalesce($4, relation_label),
          subject_name = coalesce($5, subject_name),
          object_name = coalesce($6, object_name),
          evidence = case when $7::boolean then $8 else evidence end,
          confidence = coalesce($9, confidence),
          quality_score = coalesce($10, quality_score),
          status = coalesce($11, status),
          metadata = metadata || $12::jsonb,
          updated_at = now()
        where id = $1
        returning *
      `,
      [
        input.edgeId,
        input.tenantId,
        input.relationType ?? null,
        input.relationLabel ?? null,
        input.subjectName ?? null,
        input.objectName ?? null,
        Object.prototype.hasOwnProperty.call(input, "evidence"),
        input.evidence ?? null,
        input.confidence ?? null,
        input.qualityScore ?? null,
        input.status ?? null,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    const after = knowledgeEdgeFromRow(result.rows[0]);
    await client.query(
      `
        insert into edge_feedback (
          id, edge_id, source_id, action, previous_status, next_status,
          previous_value, next_value, note
        )
        values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
      `,
      [
        randomUUID(),
        after.id,
        after.sourceId,
        feedbackAction(after.status),
        before.status ?? null,
        after.status ?? null,
        JSON.stringify(before),
        JSON.stringify(after),
        input.note ?? null
      ]
    );
    await client.query("commit");
    return after;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function feedbackAction(status: KnowledgeEdgeRecord["status"] | undefined): "CONFIRM" | "REJECT" | "DISABLE" | "UPDATE" {
  if (status === "CONFIRMED") return "CONFIRM";
  if (status === "REJECTED") return "REJECT";
  if (status === "DISABLED") return "DISABLE";
  return "UPDATE";
}

export async function listDocumentContentsBySource(input: {
  sourceId: string;
  tenantId: string;
  limit: number;
  includeArchived?: boolean;
}): Promise<Array<{
  id: string;
  externalId?: string;
  title: string;
  content: string;
}>> {
  const archiveSql = input.includeArchived ? "" : "and d.archived_at is null";
  const result = await pool.query(
    `
      select d.id, d.external_id, d.title, d.content
      from documents d
      join sources s on s.id = d.source_id
      where d.source_id = $1 and s.tenant_id = $2 ${archiveSql}
      order by d.created_at desc, d.id
      limit $3
    `,
    [input.sourceId, input.tenantId, input.limit]
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    externalId: row.external_id == null ? undefined : String(row.external_id),
    title: String(row.title),
    content: String(row.content ?? "")
  }));
}

export async function updateDocument(input: {
  documentId: string;
  tenantId: string;
  title?: string;
  metadata?: Record<string, unknown>;
}): Promise<DocumentRecord | null> {
  const result = await pool.query(
    `
      update documents d
      set
        title = coalesce($3, d.title),
        metadata = d.metadata || $4::jsonb,
        updated_at = now()
      from sources s
      where d.source_id = s.id and d.id = $1 and s.tenant_id = $2
      returning d.*
    `,
    [
      input.documentId,
      input.tenantId,
      input.title?.trim() || null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0] ? documentFromRow(result.rows[0]) : null;
}

export async function archiveDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<DocumentRecord | null> {
  const result = await pool.query(
    `
      update documents d
      set archived_at = coalesce(d.archived_at, now()), updated_at = now()
      from sources s
      where d.source_id = s.id and d.id = $1 and s.tenant_id = $2
      returning d.*
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows[0] ? documentFromRow(result.rows[0]) : null;
}

export async function restoreDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<DocumentRecord | null> {
  const result = await pool.query(
    `
      update documents d
      set archived_at = null, updated_at = now()
      from sources s
      where d.source_id = s.id and d.id = $1 and s.tenant_id = $2
      returning d.*
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows[0] ? documentFromRow(result.rows[0]) : null;
}

export async function deleteDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const documentResult = await client.query(
      `
        select d.id
        from documents d
        join sources s on s.id = d.source_id
        where d.id = $1 and s.tenant_id = $2
        for update
      `,
      [input.documentId, input.tenantId]
    );
    if (!documentResult.rows[0]) {
      await client.query("rollback");
      return false;
    }

    await deleteDocumentGraphById(input.documentId, client);
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteDocumentByExternalId(input: {
  sourceId: string;
  externalId: string;
  tenantId: string;
}, client?: Queryable): Promise<string[]> {
  const result = await db(client).query(
    `
      select d.id
      from documents d
      join sources s on s.id = d.source_id
      where d.source_id = $1 and d.external_id = $2 and s.tenant_id = $3
      order by d.created_at desc
    `,
    [input.sourceId, input.externalId, input.tenantId]
  );
  const documentIds = result.rows.map((row) => String(row.id)).filter(Boolean);
  for (const documentId of documentIds) {
    await deleteDocumentGraphById(documentId, client);
  }
  return documentIds;
}

export async function deleteDocumentGraphById(documentId: string, client?: Queryable): Promise<void> {
  await db(client).query(
    `
      with document_events as (
        select id
        from events
        where document_id = $1
      ),
      candidate_entities as (
        select distinct ee.entity_id
        from event_entities ee
        join document_events de on de.id = ee.event_id
      ),
      shared_entities as (
        select distinct ee.entity_id
        from event_entities ee
        join events e on e.id = ee.event_id
        where e.document_id <> $1
          and ee.entity_id in (select entity_id from candidate_entities)
      ),
      deleted_event_entities as (
        delete from event_entities
        where event_id in (select id from document_events)
        returning entity_id
      ),
      deleted_events as (
        delete from events
        where document_id = $1
        returning id
      ),
      deleted_chunks as (
        delete from source_chunks
        where document_id = $1
        returning id
      ),
      deleted_sections as (
        delete from document_sections
        where document_id = $1
        returning id
      ),
      deleted_document as (
        delete from documents
        where id = $1
        returning id
      )
      delete from entities
      where id in (select entity_id from candidate_entities)
        and id not in (select entity_id from shared_entities)
    `,
    [documentId]
  );
}

export async function getProjectStats(input: {
  sourceId: string;
  tenantId: string;
}): Promise<ProjectStatsRecord> {
  const result = await pool.query(
    `
      select
        count(distinct d.id)::int as document_count,
        count(distinct c.id)::int as chunk_count,
        count(distinct e.id)::int as event_count,
        count(distinct ent.id)::int as entity_count,
        count(distinct ke.id)::int as knowledge_edge_count,
        count(distinct ke.id) filter (where ke.confidence < 0.65 or ke.quality_score < 0.65)::int as low_confidence_edge_count
      from sources s
      left join documents d
        on d.source_id = s.id
       and d.archived_at is null
      left join source_chunks c
        on c.document_id = d.id
      left join events e
        on e.document_id = d.id
       and e.deleted_at is null
      left join event_entities ee
        on ee.event_id = e.id
      left join entities ent
        on ent.id = ee.entity_id
      left join knowledge_edges ke
        on ke.document_id = d.id
       and ke.status not in ('REJECTED', 'DISABLED')
      where s.id = $1
        and s.tenant_id = $2
      group by s.id
    `,
    [input.sourceId, input.tenantId]
  );
  const row = result.rows[0];
  return {
    documentCount: Number(row?.document_count ?? 0),
    chunkCount: Number(row?.chunk_count ?? 0),
    eventCount: Number(row?.event_count ?? 0),
    entityCount: Number(row?.entity_count ?? 0),
    knowledgeEdgeCount: Number(row?.knowledge_edge_count ?? 0),
    lowConfidenceEdgeCount: Number(row?.low_confidence_edge_count ?? 0)
  };
}

export async function listKnowledgeEdgesBySource(input: {
  sourceId: string;
  tenantId: string;
  includeInactive?: boolean;
  limit?: number;
}): Promise<KnowledgeEdgeRecord[]> {
  const statusSql = input.includeInactive ? "" : "and ke.status not in ('REJECTED', 'DISABLED')";
  const result = await pool.query(
    `
      select ke.*
      from knowledge_edges ke
      join sources s on s.id = ke.source_id
      left join documents d on d.id = ke.document_id
      where ke.source_id = $1
        and s.tenant_id = $2
        and (d.id is null or d.archived_at is null)
        ${statusSql}
      order by
        case ke.status when 'CONFIRMED' then 0 when 'AUTO' then 1 when 'REJECTED' then 2 else 3 end,
        ke.quality_score desc,
        ke.confidence desc,
        ke.created_at desc
      limit $3
    `,
    [input.sourceId, input.tenantId, Math.min(Math.max(input.limit ?? 300, 1), 1000)]
  );
  return result.rows.map(knowledgeEdgeFromRow);
}

export async function listKnowledgeEdgesByDocument(input: {
  documentId: string;
  tenantId: string;
  includeInactive?: boolean;
}): Promise<KnowledgeEdgeRecord[]> {
  const statusSql = input.includeInactive ? "" : "and ke.status not in ('REJECTED', 'DISABLED')";
  const result = await pool.query(
    `
      select ke.*
      from knowledge_edges ke
      join documents d on d.id = ke.document_id
      join sources s on s.id = ke.source_id
      where ke.document_id = $1
        and s.tenant_id = $2
        and d.archived_at is null
        ${statusSql}
      order by ke.quality_score desc, ke.confidence desc, ke.created_at desc
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows.map(knowledgeEdgeFromRow);
}

export async function getRelationStats(input: {
  sourceId: string;
  tenantId: string;
}): Promise<RelationStatsRecord> {
  const summary = await pool.query(
    `
      select
        count(*)::int as total,
        count(*) filter (where ke.status not in ('REJECTED', 'DISABLED'))::int as active,
        count(*) filter (where ke.status = 'CONFIRMED')::int as confirmed,
        count(*) filter (where ke.status = 'REJECTED')::int as rejected,
        count(*) filter (where ke.status = 'DISABLED')::int as disabled,
        count(*) filter (where ke.confidence < 0.65 or ke.quality_score < 0.65)::int as low_confidence
      from knowledge_edges ke
      join sources s on s.id = ke.source_id
      where ke.source_id = $1
        and s.tenant_id = $2
    `,
    [input.sourceId, input.tenantId]
  );
  const byType = await pool.query(
    `
      select
        ke.relation_type,
        max(ke.relation_label) as relation_label,
        count(*)::int as count,
        count(*) filter (where ke.status not in ('REJECTED', 'DISABLED'))::int as active_count,
        avg(ke.confidence)::float as avg_confidence,
        avg(ke.quality_score)::float as avg_quality_score
      from knowledge_edges ke
      join sources s on s.id = ke.source_id
      where ke.source_id = $1
        and s.tenant_id = $2
      group by ke.relation_type
      order by active_count desc, count desc, ke.relation_type
    `,
    [input.sourceId, input.tenantId]
  );
  const row = summary.rows[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    active: Number(row.active ?? 0),
    confirmed: Number(row.confirmed ?? 0),
    rejected: Number(row.rejected ?? 0),
    disabled: Number(row.disabled ?? 0),
    lowConfidence: Number(row.low_confidence ?? 0),
    byType: byType.rows.map((item) => ({
      relationType: String(item.relation_type),
      relationLabel: String(item.relation_label),
      count: Number(item.count ?? 0),
      activeCount: Number(item.active_count ?? 0),
      avgConfidence: Number(item.avg_confidence ?? 0),
      avgQualityScore: Number(item.avg_quality_score ?? 0)
    }))
  };
}

export async function getProjectGraph(input: {
  sourceId: string;
  tenantId: string;
}): Promise<ProjectGraphRecord> {
  const entitiesResult = await pool.query(
    `
      select
        ent.id,
        ent.source_id,
        ent.type,
        ent.name,
        ent.normalized_name,
        count(distinct e.id)::int as event_count
      from entities ent
      join event_entities ee on ee.entity_id = ent.id
      join events e on e.id = ee.event_id
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where ent.source_id = $1
        and s.tenant_id = $2
        and d.archived_at is null
        and e.deleted_at is null
      group by ent.id
      order by event_count desc, ent.type, ent.name
    `,
    [input.sourceId, input.tenantId]
  );

  const entities: ProjectGraphEntityRecord[] = entitiesResult.rows.map((row) => ({
    id: String(row.id),
    sourceId: String(row.source_id),
    type: String(row.type),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    eventCount: Number(row.event_count ?? 0)
  }));

  const entityIds = entities.map((entity) => entity.id);
  const eventsResult = await pool.query(
    `
      select
        e.id,
        e.source_id,
        e.document_id,
        e.title,
        e.rank,
        coalesce(
          array_agg(ee.entity_id order by ent.name) filter (where ee.entity_id is not null),
          '{}'
        ) as entity_ids
      from events e
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      join event_entities ee on ee.event_id = e.id
      join entities ent on ent.id = ee.entity_id
      where e.source_id = $1
        and s.tenant_id = $2
        and d.archived_at is null
        and e.deleted_at is null
        and (cardinality($3::uuid[]) = 0 or ee.entity_id = any($3::uuid[]))
      group by e.id
      order by e.rank, e.id
    `,
    [input.sourceId, input.tenantId, entityIds]
  );

  const events: ProjectGraphEventRecord[] = eventsResult.rows.map((row) => ({
    id: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? null : String(row.document_id),
    title: String(row.title),
    rank: Number(row.rank ?? 0),
    entityIds: Array.isArray(row.entity_ids) ? row.entity_ids.map(String) : []
  }));
  const edges = events.flatMap((event) => event.entityIds.map((entityId) => ({
    entityId,
    eventId: event.id
  })));

  const knowledgeEdgesResult = await pool.query(
    `
      select ke.*
      from knowledge_edges ke
      join documents d on d.id = ke.document_id
      join sources s on s.id = ke.source_id
      where ke.source_id = $1
        and s.tenant_id = $2
        and d.archived_at is null
        and ke.status not in ('REJECTED', 'DISABLED')
      order by ke.confidence desc, ke.created_at desc
      limit 300
    `,
    [input.sourceId, input.tenantId]
  );

  return {
    entities,
    events,
    edges,
    knowledgeEdges: knowledgeEdgesResult.rows.map(knowledgeEdgeFromRow)
  };
}

export async function getDocumentDetail(input: {
  documentId: string;
  tenantId: string;
}): Promise<(DocumentRecord & { source: SourceRecord }) | null> {
  const result = await pool.query(
    `
      select d.*, s.id as source_id_for_source, s.tenant_id, s.name as source_name,
             s.description as source_description, s.metadata as source_metadata
      from documents d
      join sources s on s.id = d.source_id
      where d.id = $1 and s.tenant_id = $2
    `,
    [input.documentId, input.tenantId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    ...documentFromRow(row),
    source: {
      id: String(row.source_id),
      tenantId: String(row.tenant_id),
      name: String(row.source_name),
      description: row.source_description == null ? null : String(row.source_description),
      metadata: (row.source_metadata ?? {}) as Record<string, unknown>
    }
  };
}

export async function listChunksByDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<ChunkRecord[]> {
  const result = await pool.query(
    `
      select c.*, c.embedding::text as embedding_preview
      from source_chunks c
      join sources s on s.id = c.source_id
      where c.document_id = $1 and s.tenant_id = $2
      order by c.rank, c.id
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows.map(chunkFromRow);
}

export async function listEventsByDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<Array<EventRecord & { entityCount: number; entities: EntityRecord[] }>> {
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary,
             e.content, e.rank, e.title_embedding::text as title_embedding_preview,
             e.content_embedding::text as content_embedding_preview,
             count(ee.entity_id)::int as entity_count,
             coalesce(
               jsonb_agg(
                 distinct jsonb_build_object(
                   'id', ent.id,
                   'source_id', ent.source_id,
                   'type', ent.type,
                   'name', ent.name,
                   'normalized_name', ent.normalized_name,
                   'description', ent.description
                 )
               ) filter (where ent.id is not null),
               '[]'::jsonb
             ) as entities
      from events e
      join sources s on s.id = e.source_id
      left join event_entities ee on ee.event_id = e.id
      left join entities ent on ent.id = ee.entity_id
      where e.document_id = $1 and s.tenant_id = $2 and e.deleted_at is null
      group by e.id
      order by e.rank, e.id
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows.map((row) => ({
    ...eventFromRow(row),
    entityCount: Number(row.entity_count ?? 0),
    entities: Array.isArray(row.entities)
      ? row.entities.map((entityRow: Record<string, unknown>) => entityFromRow(entityRow))
      : []
  }));
}

export async function listEntitiesByDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<EntityWithEventsRecord[]> {
  const result = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name,
             ent.description, ent.embedding::text as embedding_preview,
             count(distinct ee.event_id)::int as event_count
      from entities ent
      join event_entities ee on ee.entity_id = ent.id
      join events e on e.id = ee.event_id
      join sources s on s.id = e.source_id
      where e.document_id = $1 and s.tenant_id = $2 and e.deleted_at is null
      group by ent.id
      order by event_count desc, ent.type, ent.name
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows.map((row) => ({
    ...entityFromRow(row),
    description: row.description == null ? null : String(row.description),
    eventCount: Number(row.event_count ?? 0)
  }));
}

export async function getEntityDetail(input: {
  entityId: string;
  tenantId: string;
  includeArchived?: boolean;
}): Promise<EntityDetailRecord | null> {
  const archiveSql = input.includeArchived
    ? ""
    : "and s.archived_at is null and d.archived_at is null";
  const entityResult = await pool.query(
    `
      select
        ent.id,
        ent.source_id,
        ent.type,
        ent.name,
        ent.normalized_name,
        ent.description,
        count(distinct ee.event_id)::int as event_count,
        s.tenant_id,
        s.name as source_name,
        s.description as source_description,
        s.metadata as source_metadata,
        s.archived_at as source_archived_at,
        s.created_at as source_created_at,
        s.updated_at as source_updated_at
      from entities ent
      join sources s on s.id = ent.source_id
      join event_entities ee on ee.entity_id = ent.id
      join events e on e.id = ee.event_id
      join documents d on d.id = e.document_id
      where ent.id = $1
        and s.tenant_id = $2
        and e.deleted_at is null
        ${archiveSql}
      group by ent.id, s.id
    `,
    [input.entityId, input.tenantId]
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) {
    return null;
  }
  const eventsResult = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank
      from event_entities ee
      join events e on e.id = ee.event_id
      join sources s on s.id = e.source_id
      join documents d on d.id = e.document_id
      where ee.entity_id = $1
        and s.tenant_id = $2
        and e.deleted_at is null
        ${archiveSql}
      order by e.rank, e.id
    `,
    [input.entityId, input.tenantId]
  );
  return {
    entity: {
      ...entityFromRow(entityRow),
      description: entityRow.description == null ? null : String(entityRow.description),
      eventCount: Number(entityRow.event_count ?? 0)
    },
    events: eventsResult.rows.map(eventFromRow),
    source: sourceFromRow({
      id: entityRow.source_id,
      tenant_id: entityRow.tenant_id,
      name: entityRow.source_name,
      description: entityRow.source_description,
      metadata: entityRow.source_metadata,
      archived_at: entityRow.source_archived_at,
      created_at: entityRow.source_created_at,
      updated_at: entityRow.source_updated_at
    })
  };
}

export async function getAiProviderSettings(): Promise<AiProviderSettingsRecord | null> {
  const result = await pool.query("select * from ai_provider_settings where id = 'global'");
  return result.rows[0] ? aiProviderSettingsFromRow(result.rows[0]) : null;
}

export async function upsertAiProviderSettings(input: {
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey?: string | null;
  preserveEmbeddingApiKey?: boolean;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string | null;
  preserveLlmApiKey?: boolean;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  metadata?: Record<string, unknown>;
}): Promise<AiProviderSettingsRecord> {
  const result = await pool.query(
    `
      insert into ai_provider_settings (
        id,
        embedding_base_url,
        embedding_model,
        embedding_dimensions,
        embedding_api_key,
        llm_base_url,
        llm_model,
        llm_api_key,
        llm_timeout_ms,
        llm_max_retries,
        metadata
      )
      values (
        'global',
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10::jsonb
      )
      on conflict (id) do update set
        embedding_base_url = excluded.embedding_base_url,
        embedding_model = excluded.embedding_model,
        embedding_dimensions = excluded.embedding_dimensions,
        embedding_api_key = case
          when $11::boolean then ai_provider_settings.embedding_api_key
          else excluded.embedding_api_key
        end,
        llm_base_url = excluded.llm_base_url,
        llm_model = excluded.llm_model,
        llm_api_key = case
          when $12::boolean then ai_provider_settings.llm_api_key
          else excluded.llm_api_key
        end,
        llm_timeout_ms = excluded.llm_timeout_ms,
        llm_max_retries = excluded.llm_max_retries,
        metadata = ai_provider_settings.metadata || excluded.metadata,
        updated_at = now()
      returning *
    `,
    [
      input.embeddingBaseUrl,
      input.embeddingModel,
      input.embeddingDimensions,
      input.embeddingApiKey ?? null,
      input.llmBaseUrl,
      input.llmModel,
      input.llmApiKey ?? null,
      input.llmTimeoutMs,
      input.llmMaxRetries,
      JSON.stringify(input.metadata ?? {}),
      input.preserveEmbeddingApiKey ?? false,
      input.preserveLlmApiKey ?? false
    ]
  );
  return aiProviderSettingsFromRow(result.rows[0]);
}

export async function createMcpSession(input: {
  tenantId: string;
  title: string;
  model?: string;
  sourceIds?: string[];
  metadata?: Record<string, unknown>;
}): Promise<McpSessionRecord> {
  const result = await pool.query(
    `
      insert into mcp_sessions (id, tenant_id, title, model, source_ids, metadata)
      values ($1, $2, $3, $4, $5::uuid[], $6::jsonb)
      returning *
    `,
    [
      randomUUID(),
      input.tenantId,
      input.title,
      input.model ?? null,
      input.sourceIds ?? [],
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return mcpSessionFromRow(result.rows[0]);
}

export async function listMcpSessions(input: {
  tenantId: string;
  limit: number;
  sourceId?: string;
}): Promise<McpSessionRecord[]> {
  const params: unknown[] = [input.tenantId, input.limit];
  const sourceSql = input.sourceId ? "and source_ids @> $3::uuid[]" : "";
  if (input.sourceId) {
    params.push([input.sourceId]);
  }
  const result = await pool.query(
    `
      select *
      from mcp_sessions
      where tenant_id = $1 ${sourceSql}
      order by updated_at desc, id
      limit $2
    `,
    params
  );
  return result.rows.map(mcpSessionFromRow);
}

export async function getMcpSession(input: {
  sessionId: string;
  tenantId: string;
}): Promise<McpSessionRecord | null> {
  const result = await pool.query(
    "select * from mcp_sessions where id = $1 and tenant_id = $2",
    [input.sessionId, input.tenantId]
  );
  return result.rows[0] ? mcpSessionFromRow(result.rows[0]) : null;
}

export async function updateMcpSessionTitle(input: {
  sessionId: string;
  tenantId: string;
  title: string;
  metadata?: Record<string, unknown>;
}): Promise<McpSessionRecord | null> {
  const result = await pool.query(
    `
      update mcp_sessions
      set
        title = $3,
        metadata = metadata || $4::jsonb,
        updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [
      input.sessionId,
      input.tenantId,
      input.title.trim(),
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0] ? mcpSessionFromRow(result.rows[0]) : null;
}

export async function clearMcpSession(input: {
  sessionId: string;
  tenantId: string;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sessionResult = await client.query(
      "select id from mcp_sessions where id = $1 and tenant_id = $2 for update",
      [input.sessionId, input.tenantId]
    );
    if (!sessionResult.rows[0]) {
      await client.query("rollback");
      return false;
    }
    await client.query("delete from mcp_tool_calls where session_id = $1", [input.sessionId]);
    await client.query("delete from mcp_messages where session_id = $1", [input.sessionId]);
    await client.query(
      "update mcp_sessions set updated_at = now() where id = $1",
      [input.sessionId]
    );
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteMcpSession(input: {
  sessionId: string;
  tenantId: string;
}): Promise<boolean> {
  const result = await pool.query(
    "delete from mcp_sessions where id = $1 and tenant_id = $2",
    [input.sessionId, input.tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function addMcpMessage(input: {
  sessionId: string;
  role: McpMessageRole;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<McpMessageRecord> {
  const result = await pool.query(
    `
      insert into mcp_messages (id, session_id, role, content, metadata)
      values ($1, $2, $3, $4, $5::jsonb)
      returning *
    `,
    [randomUUID(), input.sessionId, input.role, input.content, JSON.stringify(input.metadata ?? {})]
  );
  await touchMcpSession(input.sessionId);
  return mcpMessageFromRow(result.rows[0]);
}

export async function addMcpToolCall(input: {
  sessionId: string;
  messageId?: string | null;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  durationMs?: number | null;
  error?: string | null;
}): Promise<McpToolCallRecord> {
  const queryResult = await pool.query(
    `
      insert into mcp_tool_calls (
        id, session_id, message_id, tool_name, arguments, result, status, duration_ms, error
      )
      values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
      returning *
    `,
    [
      randomUUID(),
      input.sessionId,
      input.messageId ?? null,
      input.toolName,
      JSON.stringify(input.arguments),
      JSON.stringify(input.result ?? null),
      input.status,
      input.durationMs ?? null,
      input.error ?? null
    ]
  );
  await touchMcpSession(input.sessionId);
  return mcpToolCallFromRow(queryResult.rows[0]);
}

export async function getMcpSessionDetail(input: {
  sessionId: string;
  tenantId: string;
}): Promise<{
  session: McpSessionRecord;
  messages: McpMessageRecord[];
  toolCalls: McpToolCallRecord[];
} | null> {
  const session = await getMcpSession(input);
  if (!session) {
    return null;
  }
  const [messagesResult, callsResult] = await Promise.all([
    pool.query(
      "select * from mcp_messages where session_id = $1 order by created_at, id",
      [input.sessionId]
    ),
    pool.query(
      "select * from mcp_tool_calls where session_id = $1 order by created_at, id",
      [input.sessionId]
    )
  ]);
  return {
    session,
    messages: messagesResult.rows.map(mcpMessageFromRow),
    toolCalls: callsResult.rows.map(mcpToolCallFromRow)
  };
}

async function touchMcpSession(sessionId: string): Promise<void> {
  await pool.query(
    "update mcp_sessions set updated_at = now() where id = $1",
    [sessionId]
  );
}
