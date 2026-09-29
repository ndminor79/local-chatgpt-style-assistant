import type { ChatMessage, Source } from "./types";
import { buildEvidencePrompt, fetchReadableSource, searchWeb } from "./search";
import { streamChat } from "./ollama";

export async function runResearch(args: {
  baseUrl: string;
  model: string;
  question: string;
  maxSteps: number;
  timeoutMs: number;
  searchResultCount: number;
  onStep: (step: string) => void;
  onSource: (source: Source) => void;
  onToken: (token: string) => void;
}): Promise<{ answer: string; sources: Source[] }> {
  const started = Date.now();
  const queries = [
    args.question,
    `${args.question} official source`,
    `${args.question} latest analysis`
  ].slice(0, args.maxSteps);

  const seen = new Set<string>();
  const sources: Source[] = [];

  for (const query of queries) {
    if (Date.now() - started > args.timeoutMs) break;
    args.onStep(`Searching: ${query}`);
    const results = await searchWeb(query, args.searchResultCount, Math.min(12000, args.timeoutMs));

    for (const result of results) {
      if (seen.has(result.url) || sources.length >= args.searchResultCount * 2) continue;
      seen.add(result.url);
      args.onStep(`Reading: ${result.title}`);
      const source = { ...(await fetchReadableSource(result, 9000)), id: sources.length + 1 };
      sources.push(source);
      args.onSource(source);
    }
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a careful local research assistant. Synthesize only from supplied evidence, cite claims, and call out uncertainty."
    },
    {
      role: "user",
      content: buildEvidencePrompt(args.question, sources)
    }
  ];

  args.onStep("Synthesizing answer");
  const answer = await streamChat({
    baseUrl: args.baseUrl,
    model: args.model,
    mode: "think",
    messages,
    onToken: args.onToken
  });

  return { answer, sources };
}
