export type SearchStrategy = "vector" | "multi";
export type SearchMode = "standard" | "fast";
export type MultiSubStrategy = "multi" | "multi1" | "hopllm";
export type ChunkingMode = "heading_strict" | "token";

export interface SearchInput {
  query: string;
  sourceIds: string[];
  strategy?: SearchStrategy;
  searchMode?: SearchMode;
  subStrategy?: MultiSubStrategy;
  topK?: number;
  returnTrace?: boolean;
  useGraphPaths?: boolean;
  relationTypes?: string[];
  minEdgeConfidence?: number;
  multi?: {
    entityTopK?: number;
    multiTopK?: number;
    keySimilarityThreshold?: number;
    similarityThreshold?: number;
    maxHops?: number;
    maxEvents?: number;
    maxEventsA?: number;
    maxEventsB?: number;
    maxHopRetries?: number;
    rerankTopK?: number;
    maxSections?: number;
  };
}

export interface SearchSection {
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
}

export interface SearchResultWhy {
  matchedEntities: Array<{ id: string; name: string; type: string; score?: number }>;
  matchedEdges: KnowledgeEdgeRecord[];
  graphPaths: KnowledgeGraphPath[];
  evidence: Array<{ edgeId?: string; chunkId?: string; text: string; score?: number }>;
  recallType: "graph_path" | "knowledge_edge" | "entity" | "vector" | "fallback";
  fallback: boolean;
}

export interface SearchTrace {
  traceId: string;
  query: string;
  searchMode: SearchMode;
  relationIntent?: string[];
  queryEntities: string[];
  recalledEntities: Array<{ id: string; name: string; type: string; score: number }>;
  recalledEdges?: KnowledgeEdgeRecord[];
  graphPaths?: KnowledgeGraphPath[];
  explanation?: {
    recallTypes: string[];
    edgeCount: number;
    pathCount: number;
    fallback?: string;
  };
  entityEventIds: string[];
  entityEvents?: SearchTraceEvent[];
  queryEventIds: string[];
  queryEvents?: SearchTraceEvent[];
  expandedEventIds: string[];
  expandedEvents?: SearchTraceEvent[];
  coarseRankedEventIds: string[];
  coarseRankedEvents?: SearchTraceEvent[];
  rerankedEventIds: string[];
  rerankedEvents?: SearchTraceEvent[];
  eventSnapshots?: SearchTraceEvent[];
  fallbackReason?: string;
  timings: Record<string, number>;
}

export interface SearchTraceEvent {
  id: string;
  title: string;
  summary: string;
  contentPreview: string;
  score?: number;
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

export interface SearchResult {
  sections: SearchSection[];
  traceId: string;
  trace?: SearchTrace;
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

export interface IngestDocumentInput {
  sourceId?: string;
  externalId?: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  extract?: boolean;
  replaceExisting?: boolean;
  waitForCompletion?: boolean;
  chunking?: {
    mode?: ChunkingMode;
    maxTokens?: number;
    overlapTokens?: number;
  };
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

export type IngestProgressStage =
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

export interface IngestProgressUpdate {
  stage: IngestProgressStage;
  message: string;
  progress: number;
  chunkCount?: number;
  eventCount?: number;
  currentChunk?: number;
  totalChunks?: number;
}

export interface ExtractedEvent {
  title: string;
  summary: string;
  content: string;
  category?: string;
  keywords: string[];
  priority?: string;
  status?: string;
  references: string[];
  entities: ExtractedEntity[];
}

export interface ExtractedEntity {
  type: string;
  name: string;
  description: string;
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
  nodes: Array<{
    entityId: string;
    name: string;
    type?: string;
  }>;
  edges: KnowledgeEdgeRecord[];
  evidence: Array<{
    edgeId: string;
    text: string;
    confidence: number;
  }>;
  score: number;
  reason: string;
}

export interface RelationOntologyRecord {
  relations: Array<{
    type: string;
    label: string;
    description: string;
    aliases: string[];
    strength: string;
    scope: string;
    inverseType?: string;
    transitive?: boolean;
    reasoning: boolean;
    defaultMinConfidence: number;
  }>;
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

export interface EmbeddingPreview {
  dimensions: number;
  sample: number[];
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
  entities?: EntityRecord[];
  entityCount?: number;
  titleEmbedding?: EmbeddingPreview | null;
  contentEmbedding?: EmbeddingPreview | null;
}

export interface EntityRecord {
  id: string;
  sourceId: string;
  type: string;
  name: string;
  normalizedName: string;
  score?: number;
  embedding?: EmbeddingPreview | null;
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

export interface EntityWithEventsRecord extends EntityRecord {
  description?: string | null;
  eventCount: number;
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
  entity: EntityWithEventsRecord;
  events: EventRecord[];
  source?: SourceRecord | null;
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

export type McpMessageRole = "user" | "assistant" | "tool" | "system";

export interface McpMessageRecord {
  id: string;
  sessionId: string;
  role: McpMessageRole;
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

export interface AiProviderSettingsRecord {
  id: "global";
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey?: string | null;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string | null;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

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
