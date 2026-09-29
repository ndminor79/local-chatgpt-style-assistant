import type { Source } from "./types";
import { assertSafeFetchUrl, untrustedEvidenceHeader } from "./security";

const userAgent = "LocalLLMAssistant/0.1 (+http://localhost)";

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function extractTitle(html: string, fallback: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return stripHtml(title ?? fallback).slice(0, 120);
}

function extractSearchResults(html: string, limit: number): Source[] {
  const results: Source[] = [];
  const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = resultRegex.exec(html)) && results.length < limit) {
    const rawUrl = decodeHtml(match[1]);
    const redirected = rawUrl.match(/[?&]uddg=([^&]+)/);
    const url = redirected ? decodeURIComponent(redirected[1]) : rawUrl;
    if (!/^https?:\/\//.test(url)) continue;
    results.push({
      id: results.length + 1,
      title: stripHtml(match[2]),
      url,
      snippet: stripHtml(match[3]).slice(0, 400)
    });
  }

  return results;
}

export async function searchWeb(query: string, limit: number, timeoutMs: number): Promise<Source[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": userAgent }
    });
    if (!response.ok) throw new Error(`Search failed with ${response.status}`);
    return extractSearchResults(await response.text(), limit);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchReadableSource(source: Source, timeoutMs: number): Promise<Source> {
  assertSafeFetchUrl(source.url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: { "User-Agent": userAgent }
    });
    if (!response.ok) return source;
    const html = await response.text();
    const text = stripHtml(html).slice(0, 1800);
    return {
      ...source,
      title: source.title || extractTitle(html, source.url),
      snippet: text || source.snippet
    };
  } catch {
    return source;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildEvidencePrompt(userQuestion: string, sources: Source[]): string {
  const evidence = sources
    .map((source) => `[${source.id}] ${source.title}\nURL: ${source.url}\nEvidence: ${source.snippet}`)
    .join("\n\n");

  return [
    untrustedEvidenceHeader("web"),
    "If the evidence is insufficient, say what is missing instead of guessing.",
    "",
    evidence,
    "",
    `User question: ${userQuestion}`
  ].join("\n");
}
