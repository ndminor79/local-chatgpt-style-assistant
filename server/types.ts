export type ChatRole = "system" | "user" | "assistant";

export type ChatMode = "fast" | "balanced" | "think";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type Source = {
  id: number;
  title: string;
  url: string;
  snippet: string;
  kind?: "web" | "file";
};

export type ChatRequest = {
  conversationId?: string;
  messages: ChatMessage[];
  model?: string;
  mode?: ChatMode;
  enableSearch?: boolean;
  enableResearch?: boolean;
  enableDirectoryContext?: boolean;
  directoryPath?: string;
  maxTokens?: number;
  temperature?: number;
};

export type Settings = {
  ollamaBaseUrl: string;
  defaultModel: string;
  allowedDirectoryRoots: string[];
  allowRemoteOllama: boolean;
  searchTimeoutMs: number;
  searchResultCount: number;
  researchMaxSteps: number;
  researchTimeoutMs: number;
  contextMaxFiles: number;
  contextMaxFileBytes: number;
  contextMaxPromptChars: number;
};

export type DirectoryChunk = {
  id: string;
  filePath: string;
  relativePath: string;
  text: string;
  startLine: number;
  endLine: number;
};

export type DirectoryIndex = {
  rootPath: string;
  indexedAt: string;
  filesIndexed: number;
  chunks: DirectoryChunk[];
  skipped: string[];
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

export type StreamEvent =
  | { type: "token"; content: string }
  | { type: "source"; source: Source }
  | { type: "research_step"; content: string }
  | { type: "final"; conversation?: Conversation; content: string; sources?: Source[] }
  | { type: "error"; error: string };
