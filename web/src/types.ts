export interface SourceRecord {
  id: string;
  tenantId: string;
  name: string;
  description?: string | null;
  metadata: Record<string, unknown>;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface DocumentRecord {
  id: string;
  sourceId: string;
  title: string;
  status: string;
  parseStatus: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  source?: SourceRecord;
}

export interface EmbeddingPreview {
  dimensions: number;
  sample: number[];
}

export interface ChunkRecord {
  id: string;
  sourceId: string;
  documentId?: string | null;
  heading?: string | null;
  content: string;
  rawContent?: string | null;
  rank: number;
  references: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  embedding?: EmbeddingPreview | null;
}

export interface EventRecord {
  id: string;
  sourceId: string;
  documentId?: string | null;
  chunkId?: string | null;
  title: string;
  summary: string;
  content: string;
  rank: number;
  score?: number;
  entityCount?: number;
  entities?: EntityRecord[];
  titleEmbedding?: EmbeddingPreview | null;
  contentEmbedding?: EmbeddingPreview | null;
}

export interface EntityRecord {
  id: string;
  sourceId: string;
  type: string;
  name: string;
  normalizedName: string;
  description?: string | null;
  eventCount?: number;
  score?: number;
  embedding?: EmbeddingPreview | null;
}

export interface EventDetailRecord {
  event: EventRecord;
  entities: EntityRecord[];
  document?: DocumentRecord | null;
  source?: SourceRecord | null;
  chunk?: {
    chunkId: string;
    sourceId?: string;
    documentId?: string | null;
    heading?: string;
    content: string;
    rank?: number;
  };
}

export interface EntityDetailRecord {
  entity: EntityRecord & { eventCount: number };
  events: EventRecord[];
  source?: SourceRecord | null;
}

export interface SearchResult {
  traceId: string;
  sections: Array<{
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
    why?: SearchResultWhy;
  }>;
  trace?: Record<string, unknown>;
}

export interface SearchResultWhy {
  matchedEntities: Array<{ id: string; name: string; type: string; score?: number }>;
  matchedEdges: KnowledgeEdgeRecord[];
  graphPaths: KnowledgeGraphPath[];
  evidence: Array<{ edgeId?: string; chunkId?: string; text: string; score?: number }>;
  recallType: "graph_path" | "knowledge_edge" | "entity" | "vector" | "fallback";
  fallback: boolean;
}

export type SearchMode = "standard" | "fast";
export type ChunkingMode = "heading_strict" | "token";

export interface IngestDocumentInput {
  sourceId?: string;
  externalId?: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  extract?: boolean;
  replaceExisting?: boolean;
}

export interface IngestDocumentResult {
  sourceId: string;
  documentId: string;
  externalId?: string;
  replacedDocumentId?: string;
  replacedDocumentIds?: string[];
  chunkCount: number;
  eventCount: number;
  taskId: string;
  traceId: string;
}

export interface BatchIngestDocumentResult {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{
    index: number;
    ok: boolean;
    externalId?: string;
    title?: string;
    result?: IngestDocumentResult;
    error?: string;
  }>;
}

export interface MilvusMarkdownImportInput {
  connection: {
    address: string;
    username?: string;
    password?: string;
    database?: string;
  };
  collectionName: string;
  sourceId?: string;
  filter?: string;
  limit?: number;
  offset?: number;
  idField?: string;
  titleField?: string;
  markdownUrlField?: string;
  extract?: boolean;
  replaceExisting?: boolean;
  continueOnError?: boolean;
}

export interface MilvusMarkdownImportResult {
  total: number;
  fetched: number;
  succeeded: number;
  failed: number;
  sourceId?: string;
  items: Array<{
    index: number;
    ok: boolean;
    externalId?: string;
    title?: string;
    markdownUrl?: string;
    documentId?: string;
    chunkCount?: number;
    eventCount?: number;
    error?: string;
  }>;
}

export interface MilvusMarkdownPreviewResult {
  total: number;
  rows: Array<{
    index: number;
    externalId?: string;
    title?: string;
    markdownUrl?: string;
    metadata: Record<string, unknown>;
  }>;
}

export interface BiddingDomainAnalyzeResult {
  sourceId: string;
  documentCount: number;
  documentType?: string;
  entities: Array<{
    name: string;
    type: string;
    count: number;
    aliases?: string[];
    confidence?: number;
    reason?: string;
    documents: Array<{
      documentId: string;
      title: string;
    }>;
  }>;
  relations?: Array<{
    source: string;
    target: string;
    relation: string;
    evidence?: string;
    confidence?: number;
  }>;
}

export interface SearchProgressEvent {
  type: "step";
  status: "running" | "done" | "failed";
  key: string;
  title: string;
  detail: string;
  payload?: unknown;
  durationMs?: number;
}

export interface ProjectStatsRecord {
  documentCount: number;
  chunkCount: number;
  eventCount: number;
  entityCount: number;
  knowledgeEdgeCount?: number;
  lowConfidenceEdgeCount?: number;
}

export interface ProjectGraphEntityRecord {
  id: string;
  sourceId: string;
  type: string;
  name: string;
  normalizedName: string;
  eventCount: number;
}

export interface ProjectGraphEventRecord {
  id: string;
  sourceId: string;
  documentId?: string | null;
  title: string;
  rank: number;
  entityIds: string[];
}

export interface ProjectGraphRecord {
  entities: ProjectGraphEntityRecord[];
  events: ProjectGraphEventRecord[];
  edges: Array<{
    entityId: string;
    eventId: string;
  }>;
  knowledgeEdges?: KnowledgeEdgeRecord[];
}

export interface KnowledgeEdgeRecord {
  id: string;
  sourceId: string;
  documentId?: string | null;
  chunkId?: string | null;
  eventId?: string | null;
  subjectEntityId: string;
  objectEntityId: string;
  subjectName: string;
  objectName: string;
  relationType: string;
  relationLabel: string;
  evidence?: string | null;
  evidenceStart?: number | null;
  evidenceEnd?: number | null;
  confidence: number;
  qualityScore?: number;
  extractionMethod?: string;
  extractionModel?: string | null;
  promptVersion?: string | null;
  status?: "AUTO" | "CONFIRMED" | "REJECTED" | "DISABLED";
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeGraphPath {
  nodes: Array<{ entityId: string; name: string; type?: string }>;
  edges: KnowledgeEdgeRecord[];
  evidence: Array<{ edgeId: string; text: string; confidence: number }>;
  score: number;
  reason: string;
}

export interface RelationConfigRecord {
  sourceId: string;
  disabledRelations: string[];
  relationAliases: Record<string, string[]>;
  entityAliases: Record<string, string>;
  minConfidence: Record<string, number>;
  customRelations: unknown[];
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface RelationStatsRecord {
  total: number;
  active: number;
  confirmed: number;
  rejected: number;
  disabled: number;
  lowConfidence: number;
  byType: Array<{
    relationType: string;
    relationLabel: string;
    count: number;
    activeCount: number;
    avgConfidence: number;
    avgQualityScore: number;
  }>;
}

export type SearchStreamEvent =
  | SearchProgressEvent
  | { type: "done"; result: SearchResult }
  | { type: "error"; message: string };

export interface ModelCallLogRecord {
  sequence: number;
  id: string;
  kind: "llm" | "embedding";
  operation: string;
  status: "SUCCEEDED" | "FAILED";
  createdAt: string;
  durationMs: number;
  request: unknown;
  response?: unknown;
  error?: string;
}

export type UploadJobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

export type UploadJobStage =
  | "QUEUED"
  | "READING"
  | "PARSING"
  | "CHUNKING"
  | "EMBEDDING_CHUNKS"
  | "EXTRACTING_EVENTS"
  | "EMBEDDING_EVENTS"
  | "WRITING_GRAPH"
  | "COMPLETED"
  | "FAILED";

export interface UploadJobRecord {
  id: string;
  sourceId: string;
  fileName: string;
  title: string;
  status: UploadJobStatus;
  stage: UploadJobStage;
  message: string;
  progress: number;
  chunkCount?: number;
  eventCount?: number;
  currentChunk?: number;
  totalChunks?: number;
  documentId?: string;
  traceId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface McpSessionRecord {
  id: string;
  tenantId: string;
  title: string;
  status: string;
  model?: string | null;
  sourceIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface McpMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface McpToolCallRecord {
  id: string;
  sessionId: string;
  messageId?: string | null;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  durationMs?: number | null;
  error?: string | null;
  createdAt: string;
}

export interface McpSessionDetail {
  session: McpSessionRecord;
  messages: McpMessageRecord[];
  toolCalls: McpToolCallRecord[];
}

export type McpStreamEvent =
  | { type: "stage"; label: string; detail?: string }
  | { type: "message"; message: McpMessageRecord }
  | { type: "assistant_delta"; delta: string }
  | { type: "tool_start"; toolName: string; arguments: Record<string, unknown> }
  | { type: "search_progress"; event: SearchProgressEvent }
  | { type: "tool_end"; toolCall: McpToolCallRecord }
  | { type: "done"; detail: McpSessionDetail }
  | { type: "error"; message: string };

export interface PublicAiProviderSettings {
  id: "global";
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  hasEmbeddingApiKey: boolean;
  llmBaseUrl: string;
  llmModel: string;
  hasLlmApiKey: boolean;
  rerankModel: string;
  rerankInstruct: string;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
  biddingDomainConfig: unknown;
  updatedAt: string;
}

export interface PublicMcpSettings {
  toolTimeoutMs: number;
  clientConfigs: Array<{
    id: string;
    title: string;
    description: string;
    config: Record<string, unknown>;
  }>;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    example: Record<string, unknown>;
  }>;
}
