import type { ChatMode, Settings } from "./types";

export const defaultSettings: Settings = {
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  defaultModel: process.env.OLLAMA_MODEL ?? "qwen3:8b",
  allowedDirectoryRoots: [process.cwd()],
  allowRemoteOllama: false,
  searchTimeoutMs: 12000,
  searchResultCount: 5,
  researchMaxSteps: 4,
  researchTimeoutMs: 45000,
  contextMaxFiles: 250,
  contextMaxFileBytes: 180000,
  contextMaxPromptChars: 14000
};

export const modePresets: Record<
  ChatMode,
  { suffix: string; think: boolean; temperature: number; top_p: number; top_k: number; num_predict: number }
> = {
  fast: {
    suffix: "/no_think",
    think: false,
    temperature: 0.7,
    top_p: 0.8,
    top_k: 20,
    num_predict: 768
  },
  balanced: {
    suffix: "/no_think",
    think: false,
    temperature: 0.7,
    top_p: 0.85,
    top_k: 20,
    num_predict: 1400
  },
  think: {
    suffix: "/think",
    think: true,
    temperature: 0.6,
    top_p: 0.95,
    top_k: 20,
    num_predict: 2600
  }
};
