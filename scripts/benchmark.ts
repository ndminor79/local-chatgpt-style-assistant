import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultSettings, modePresets } from "../server/config";
import type { ChatMode } from "../server/types";

type Result = {
  mode: ChatMode;
  prompt: string;
  firstTokenMs: number | null;
  totalMs: number;
  characters: number;
  approxTokensPerSecond: number;
  error?: string;
};

const prompts = [
  "Answer in one paragraph: what is retrieval augmented generation?",
  "Solve this carefully: A train leaves at 3pm traveling 60 mph. Another leaves at 4pm traveling 90 mph from the same station. When does the second catch the first?",
  "Write a TypeScript function that groups objects by a string key."
];

const modes: ChatMode[] = ["fast", "balanced", "think"];

async function runOne(mode: ChatMode, prompt: string): Promise<Result> {
  const preset = modePresets[mode];
  const started = performance.now();
  let firstTokenAt: number | null = null;
  let content = "";

  try {
    const response = await fetch(`${defaultSettings.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: defaultSettings.defaultModel,
        stream: true,
        messages: [{ role: "user", content: `${prompt}\n\n${preset.suffix}` }],
        options: {
          temperature: preset.temperature,
          top_p: preset.top_p,
          top_k: preset.top_k,
          num_predict: Math.min(preset.num_predict, 900)
        }
      })
    });

    if (!response.ok || !response.body) {
      throw new Error(`Ollama returned ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as { message?: { content?: string } };
        const token = parsed.message?.content ?? "";
        if (token && firstTokenAt === null) firstTokenAt = performance.now();
        content += token;
      }
    }

    const totalMs = performance.now() - started;
    const approxTokens = Math.max(1, Math.round(content.length / 4));
    return {
      mode,
      prompt,
      firstTokenMs: firstTokenAt ? Math.round(firstTokenAt - started) : null,
      totalMs: Math.round(totalMs),
      characters: content.length,
      approxTokensPerSecond: Number((approxTokens / (totalMs / 1000)).toFixed(2))
    };
  } catch (error) {
    return {
      mode,
      prompt,
      firstTokenMs: null,
      totalMs: Math.round(performance.now() - started),
      characters: content.length,
      approxTokensPerSecond: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

const results: Result[] = [];
for (const mode of modes) {
  for (const prompt of prompts) {
    console.log(`Benchmarking ${mode}: ${prompt.slice(0, 48)}...`);
    results.push(await runOne(mode, prompt));
  }
}

await mkdir("benchmark-results", { recursive: true });
const file = join("benchmark-results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(file, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
console.table(results.map(({ mode, firstTokenMs, totalMs, approxTokensPerSecond, error }) => ({
  mode,
  firstTokenMs,
  totalMs,
  approxTokensPerSecond,
  error: error ?? ""
})));
console.log(`Saved benchmark results to ${file}`);
