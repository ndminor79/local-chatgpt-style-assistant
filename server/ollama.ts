import type { ChatMessage, ChatMode } from "./types";
import { modePresets } from "./config";

type OllamaModel = {
  name?: string;
  model?: string;
  modified_at?: string;
  size?: number;
};

export async function listOllamaModels(baseUrl: string): Promise<OllamaModel[]> {
  const response = await fetch(`${baseUrl}/api/tags`);
  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status} while listing models.`);
  }
  const data = (await response.json()) as { models?: OllamaModel[] };
  return data.models ?? [];
}

export async function checkOllama(baseUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await listOllamaModels(baseUrl);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function prepareMessages(messages: ChatMessage[], mode: ChatMode): ChatMessage[] {
  const preset = modePresets[mode];
  const cloned = messages.map((message) => ({ ...message }));
  const lastUserIndex = cloned.map((message) => message.role).lastIndexOf("user");
  if (lastUserIndex >= 0 && !/\/(?:no_)?think\b/.test(cloned[lastUserIndex].content)) {
    cloned[lastUserIndex].content = `${cloned[lastUserIndex].content.trim()}\n\n${preset.suffix}`;
  }
  return cloned;
}

export async function streamChat(args: {
  baseUrl: string;
  model: string;
  mode: ChatMode;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onToken: (token: string) => void;
  onThinking?: (token: string) => void;
}): Promise<string> {
  const preset = modePresets[args.mode];
  const response = await fetch(`${args.baseUrl}/api/chat`, {
    method: "POST",
    signal: args.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: args.model,
      messages: prepareMessages(args.messages, args.mode),
      think: preset.think,
      stream: true,
      options: {
        temperature: args.temperature ?? preset.temperature,
        top_p: preset.top_p,
        top_k: preset.top_k,
        num_predict: args.maxTokens ?? preset.num_predict
      }
    })
  });

  if (!response.ok || !response.body) {
    throw new Error(`Ollama chat failed with ${response.status}. Is Ollama running and is the model pulled?`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let thinkingLength = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as { message?: { content?: string; thinking?: string }; error?: string };
      if (parsed.error) throw new Error(parsed.error);
      const thinking = parsed.message?.thinking ?? "";
      if (thinking) {
        thinkingLength += thinking.length;
        args.onThinking?.(thinking);
      }
      const token = parsed.message?.content ?? "";
      if (token) {
        full += token;
        args.onToken(token);
      }
    }
  }

  if (!full.trim() && thinkingLength > 0) {
    throw new Error(
      "Ollama returned only thinking tokens and no final answer. Try Fast or Balanced mode, or increase the response token budget."
    );
  }

  return full;
}
