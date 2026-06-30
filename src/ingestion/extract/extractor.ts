import type { ExtractedEvent } from "../../types.js";
import type { LlmClient } from "../../ai/llm-client.js";

export async function extractEventsFromChunk(input: {
  llm: LlmClient;
  documentTitle: string;
  heading?: string;
  content: string;
  references: string[];
}): Promise<ExtractedEvent[]> {
  const events = await input.llm.extractEventsFromChunk({
    title: input.documentTitle,
    heading: input.heading,
    content: input.content,
    references: input.references
  });
  return events
    .filter((event) => event.content.trim().length > 0)
    .map((event) => ({
      ...event,
      title: normalizeExtractedTitle(event.title, input),
      summary: event.summary.trim() || normalizeExtractedTitle(event.title, input),
      references: event.references.length > 0 ? event.references : input.references,
      entities: event.entities.filter((entity) => entity.name.trim().length > 1)
    }))
    .slice(0, 1);
}

function normalizeExtractedTitle(title: string, input: {
  documentTitle: string;
  heading?: string;
  content: string;
}): string {
  const candidates = [
    title,
    input.heading,
    firstSentence(input.content),
    input.documentTitle
  ];
  for (const candidate of candidates) {
    const normalized = cleanTitle(candidate ?? "");
    if (!normalized || isGenericTitle(normalized)) {
      continue;
    }
    return normalized.length > 64 ? normalized.slice(0, 64).trim() : normalized;
  }
  return "文档事项";
}

function isGenericTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return /^\d+[.．、)]?$/.test(normalized) ||
    ["introduction", "untitled", "untitled event", "general", "正文", "文档", "内容", "首页"].includes(normalized);
}

function firstSentence(text: string): string {
  return text.trim().split(/(?<=[.!?。！？])\s+/u)[0] ?? "";
}

function cleanTitle(title: string): string {
  return title
    .replace(/\[图片\]/g, " ")
    .replace(/blob:file:\/\/\/[A-Za-z0-9._-]+/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^(首页|返回|当前位置)[\s：:]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
}
