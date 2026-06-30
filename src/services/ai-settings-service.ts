import { config, SUPPORTED_EMBEDDING_DIMENSIONS } from "../config/env.js";
import {
  defaultBiddingDomainConfig,
  normalizeBiddingDomainConfig,
  type BiddingDomainConfig
} from "../domain/bidding-domain.js";
import {
  getAiProviderSettings,
  upsertAiProviderSettings
} from "../db/repositories.js";
import type { AiProviderSettingsRecord, ChunkingMode, PublicAiProviderSettings, SearchMode } from "../types.js";

export const DEFAULT_SEARCH_TOP_K = 10;
export const MAX_SEARCH_TOP_K = 50;
export const DEFAULT_CHUNKING_MODE: ChunkingMode = "heading_strict";
export const DEFAULT_CHUNK_TOKEN_LIMIT = 512;
export const DEFAULT_CHUNK_OVERLAP_TOKENS = 100;

export interface AiRuntimeSettings {
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey: string;
  hasRemoteEmbedding: boolean;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  hasRemoteLlm: boolean;
  rerankModel: string;
  rerankInstruct: string;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
  biddingDomainConfig: BiddingDomainConfig;
}

export interface UpdateAiSettingsInput {
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey?: string;
  clearEmbeddingApiKey?: boolean;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string;
  clearLlmApiKey?: boolean;
  rerankModel?: string;
  rerankInstruct?: string;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
  biddingDomainConfig?: unknown;
}

export class AiSettingsService {
  async getPublicSettings(): Promise<PublicAiProviderSettings> {
    return toPublicSettings(await this.getSettingsOrFallback());
  }

  async getRuntimeSettings(): Promise<AiRuntimeSettings> {
    const settings = await this.getSettingsOrFallback();
    const embeddingApiKey = settings.embeddingApiKey?.trim() ?? "";
    const llmApiKey = settings.llmApiKey?.trim() ?? "";
    const chunkTokenLimit = readBoundedInteger(settings.metadata.chunkTokenLimit, DEFAULT_CHUNK_TOKEN_LIMIT, 64, 8192);
    return {
      embeddingBaseUrl: settings.embeddingBaseUrl,
      embeddingModel: settings.embeddingModel,
      embeddingDimensions: settings.embeddingDimensions,
      embeddingApiKey,
      hasRemoteEmbedding: embeddingApiKey.length > 0,
      llmBaseUrl: settings.llmBaseUrl,
      llmModel: settings.llmModel,
      llmApiKey,
      hasRemoteLlm: llmApiKey.length > 0,
      rerankModel: readString(settings.metadata.rerankModel, config.RERANK_MODEL),
      rerankInstruct: readString(settings.metadata.rerankInstruct, config.RERANK_INSTRUCT),
      llmTimeoutMs: settings.llmTimeoutMs,
      llmMaxRetries: settings.llmMaxRetries,
      defaultSearchMode: readDefaultSearchMode(settings.metadata),
      defaultSearchTopK: readBoundedInteger(settings.metadata.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K),
      defaultChunkingMode: readDefaultChunkingMode(settings.metadata),
      chunkTokenLimit,
      chunkOverlapTokens: readBoundedInteger(settings.metadata.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, chunkTokenLimit - 1),
      biddingDomainConfig: normalizeBiddingDomainConfig(settings.metadata.biddingDomainConfig)
    };
  }

  async updateSettings(input: UpdateAiSettingsInput): Promise<PublicAiProviderSettings> {
    if (input.embeddingDimensions !== SUPPORTED_EMBEDDING_DIMENSIONS) {
      throw new Error(`embeddingDimensions must be ${SUPPORTED_EMBEDDING_DIMENSIONS}`);
    }
    const chunkTokenLimit = clampInteger(input.chunkTokenLimit, DEFAULT_CHUNK_TOKEN_LIMIT, 64, 8192);
    const chunkOverlapTokens = clampInteger(input.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, chunkTokenLimit - 1);
    const current = await this.getSettingsOrFallback();
    const embeddingApiKey = input.clearEmbeddingApiKey ? null : normalizeOptionalSecret(input.embeddingApiKey);
    const llmApiKey = input.clearLlmApiKey ? null : normalizeOptionalSecret(input.llmApiKey);
    const updated = await upsertAiProviderSettings({
      embeddingBaseUrl: input.embeddingBaseUrl.trim(),
      embeddingModel: input.embeddingModel.trim(),
      embeddingDimensions: input.embeddingDimensions,
      embeddingApiKey,
      preserveEmbeddingApiKey: !input.clearEmbeddingApiKey && embeddingApiKey == null,
      llmBaseUrl: input.llmBaseUrl.trim(),
      llmModel: input.llmModel.trim(),
      llmApiKey,
      preserveLlmApiKey: !input.clearLlmApiKey && llmApiKey == null,
      llmTimeoutMs: input.llmTimeoutMs,
      llmMaxRetries: input.llmMaxRetries,
      metadata: {
        updatedVia: "webui",
        previousUpdatedAt: current.updatedAt,
        rerankModel: normalizeConfiguredString(input.rerankModel, config.RERANK_MODEL),
        rerankInstruct: normalizeConfiguredString(input.rerankInstruct, config.RERANK_INSTRUCT),
        defaultSearchMode: input.defaultSearchMode,
        defaultSearchTopK: clampInteger(input.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K),
        defaultChunkingMode: input.defaultChunkingMode,
        chunkTokenLimit,
        chunkOverlapTokens,
        biddingDomainConfig: normalizeBiddingDomainConfig(input.biddingDomainConfig)
      }
    });
    return toPublicSettings(updated);
  }

  private async getSettingsOrFallback(): Promise<AiProviderSettingsRecord> {
    if (config.NODE_ENV === "test") {
      return envSettings();
    }
    try {
      const settings = await getAiProviderSettings();
      if (settings) {
        return settings;
      }
    } catch {
      // Tests and fresh installs can run before migrations. Runtime callers still
      // need a deterministic fallback so local operation stays bootstrappable.
    }
    return envSettings();
  }
}

function envSettings(): AiProviderSettingsRecord {
  const now = new Date().toISOString();
  return {
    id: "global",
    embeddingBaseUrl: config.EMBEDDING_BASE_URL,
    embeddingModel: config.EMBEDDING_MODEL,
    embeddingDimensions: SUPPORTED_EMBEDDING_DIMENSIONS,
    embeddingApiKey: config.EMBEDDING_API_KEY || null,
    llmBaseUrl: config.LLM_BASE_URL,
    llmModel: config.LLM_MODEL,
    llmApiKey: config.LLM_API_KEY || null,
    llmTimeoutMs: config.LLM_TIMEOUT_MS,
    llmMaxRetries: config.LLM_MAX_RETRIES,
    metadata: {
      defaultSearchMode: config.DEFAULT_SEARCH_MODE,
      rerankModel: config.RERANK_MODEL,
      rerankInstruct: config.RERANK_INSTRUCT,
      defaultSearchTopK: DEFAULT_SEARCH_TOP_K,
      defaultChunkingMode: DEFAULT_CHUNKING_MODE,
      chunkTokenLimit: DEFAULT_CHUNK_TOKEN_LIMIT,
      chunkOverlapTokens: DEFAULT_CHUNK_OVERLAP_TOKENS,
      biddingDomainConfig: defaultBiddingDomainConfig()
    },
    createdAt: now,
    updatedAt: now
  };
}

function toPublicSettings(settings: AiProviderSettingsRecord): PublicAiProviderSettings {
  const chunkTokenLimit = readBoundedInteger(settings.metadata.chunkTokenLimit, DEFAULT_CHUNK_TOKEN_LIMIT, 64, 8192);
  return {
    id: "global",
    embeddingBaseUrl: settings.embeddingBaseUrl,
    embeddingModel: settings.embeddingModel,
    embeddingDimensions: settings.embeddingDimensions,
    hasEmbeddingApiKey: (settings.embeddingApiKey?.trim() ?? "").length > 0,
    llmBaseUrl: settings.llmBaseUrl,
    llmModel: settings.llmModel,
    hasLlmApiKey: (settings.llmApiKey?.trim() ?? "").length > 0,
    rerankModel: readString(settings.metadata.rerankModel, config.RERANK_MODEL),
    rerankInstruct: readString(settings.metadata.rerankInstruct, config.RERANK_INSTRUCT),
    llmTimeoutMs: settings.llmTimeoutMs,
    llmMaxRetries: settings.llmMaxRetries,
    defaultSearchMode: readDefaultSearchMode(settings.metadata),
    defaultSearchTopK: readBoundedInteger(settings.metadata.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K),
    defaultChunkingMode: readDefaultChunkingMode(settings.metadata),
    chunkTokenLimit,
    chunkOverlapTokens: readBoundedInteger(settings.metadata.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, chunkTokenLimit - 1),
    biddingDomainConfig: normalizeBiddingDomainConfig(settings.metadata.biddingDomainConfig),
    updatedAt: settings.updatedAt
  };
}

function readDefaultSearchMode(metadata: Record<string, unknown>): SearchMode {
  return metadata.defaultSearchMode === "standard" ? "standard" : "fast";
}

function readDefaultChunkingMode(metadata: Record<string, unknown>): ChunkingMode {
  return metadata.defaultChunkingMode === "token" ? "token" : DEFAULT_CHUNKING_MODE;
}

function readBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return clampInteger(value, fallback, min, max);
}

function readString(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(numberValue), max));
}

function normalizeOptionalSecret(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeConfiguredString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : fallback;
}

export const aiSettingsService = new AiSettingsService();
