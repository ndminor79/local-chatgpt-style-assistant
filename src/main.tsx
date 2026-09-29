import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import {
  Brain,
  Check,
  Copy,
  Database,
  FolderOpen,
  Globe,
  Microscope,
  Play,
  RefreshCcw,
  Send,
  Settings,
  Square,
  Zap
} from "lucide-react";
import "./styles.css";

type Role = "system" | "user" | "assistant";
type Mode = "fast" | "balanced" | "think";

type Message = {
  role: Role;
  content: string;
};

type Source = {
  id: number;
  title: string;
  url: string;
  snippet: string;
  kind?: "web" | "file";
};

type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
};

type StreamEvent =
  | { type: "token"; content: string }
  | { type: "source"; source: Source }
  | { type: "research_step"; content: string }
  | { type: "final"; conversation?: Conversation; content: string; sources?: Source[] }
  | { type: "error"; error: string };

type ModelInfo = {
  name?: string;
  model?: string;
  size?: number;
};

type DirectoryStatus = {
  indexed: boolean;
  rootPath?: string;
  indexedAt?: string;
  filesIndexed?: number;
  chunks?: number;
  skipped?: string[];
};

type SettingsState = {
  allowedDirectoryRoots?: string[];
};

const modeLabels: Record<Mode, string> = {
  fast: "Fast",
  balanced: "Balanced",
  think: "Think"
};

function cleanAnswer(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("balanced");
  const [enableSearch, setEnableSearch] = useState(false);
  const [enableResearch, setEnableResearch] = useState(false);
  const [enableDirectoryContext, setEnableDirectoryContext] = useState(false);
  const [directoryPath, setDirectoryPath] = useState("");
  const [directoryStatus, setDirectoryStatus] = useState<DirectoryStatus>({ indexed: false });
  const [settingsState, setSettingsState] = useState<SettingsState>({});
  const [isIndexing, setIsIndexing] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState("qwen3:8b");
  const [sources, setSources] = useState<Source[]>([]);
  const [steps, setSteps] = useState<string[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const canSend = input.trim().length > 0 && !isStreaming;

  const activeMessages = useMemo(
    () => messages.filter((message) => message.role !== "system"),
    [messages]
  );

  useEffect(() => {
    void refreshConversations();
    void refreshModels();
    void refreshSettings();
    void refreshDirectoryStatus();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, steps, sources]);

  async function refreshConversations() {
    const response = await fetch("/api/conversations");
    if (response.ok) setConversations(await response.json());
  }

  async function refreshModels() {
    const response = await fetch("/api/models");
    if (!response.ok) return;
    const data = await response.json();
    setModels(data.models ?? []);
    setSelectedModel(data.defaultModel ?? "qwen3:8b");
  }

  async function refreshDirectoryStatus() {
    const response = await fetch("/api/context/directory");
    if (!response.ok) return;
    const status = (await response.json()) as DirectoryStatus;
    setDirectoryStatus(status);
    if (status.rootPath) setDirectoryPath(status.rootPath);
  }

  async function refreshSettings() {
    const response = await fetch("/api/settings");
    if (!response.ok) return;
    setSettingsState(await response.json());
  }

  async function allowDirectoryRoot() {
    if (!directoryPath.trim()) return;
    setError(null);
    const currentRoots = settingsState.allowedDirectoryRoots ?? [];
    const nextRoots = Array.from(new Set([...currentRoots, directoryPath.trim()]));
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedDirectoryRoots: nextRoots })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Failed to allow directory");
      setSettingsState(data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function indexDirectory() {
    if (!directoryPath.trim()) return;
    setIsIndexing(true);
    setError(null);
    try {
      const response = await fetch("/api/context/directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: directoryPath.trim() })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Failed to index directory");
      setDirectoryStatus(data);
      setEnableDirectoryContext(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsIndexing(false);
    }
  }

  async function openConversation(id: string) {
    const response = await fetch(`/api/conversations/${id}`);
    if (!response.ok) return;
    const conversation = (await response.json()) as Conversation;
    setConversationId(conversation.id);
    setMessages(conversation.messages);
    setSources([]);
    setSteps([]);
    setError(null);
  }

  function newChat() {
    setConversationId(undefined);
    setMessages([]);
    setSources([]);
    setSteps([]);
    setError(null);
    setInput("");
  }

  async function consumeStream(response: Response, assistantIndex: number) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Response did not include a stream.");

    const decoder = new TextDecoder();
    let buffer = "";
    let assistantContent = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as StreamEvent;
        if (event.type === "token") {
          assistantContent += event.content;
          setMessages((current) =>
            current.map((message, index) =>
              index === assistantIndex ? { ...message, content: cleanAnswer(assistantContent) } : message
            )
          );
        }
        if (event.type === "source") {
          setSources((current) =>
            current.some((source) => source.url === event.source.url) ? current : [...current, event.source]
          );
        }
        if (event.type === "research_step") setSteps((current) => [...current, event.content]);
        if (event.type === "final") {
          if (event.conversation) {
            setConversationId(event.conversation.id);
            void refreshConversations();
          }
        }
        if (event.type === "error") throw new Error(event.error);
      }
    }
  }

  async function sendMessage(text = input, baseMessages = messages) {
    if (!text.trim() || isStreaming) return;
    setError(null);
    setSources([]);
    setSteps([]);
    setInput("");

    const userMessage: Message = { role: "user", content: text.trim() };
    const nextMessages = [...baseMessages, userMessage, { role: "assistant", content: "" } satisfies Message];
    const assistantIndex = nextMessages.length - 1;
    setMessages(nextMessages);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          messages: [...baseMessages, userMessage],
          model: selectedModel,
          mode,
          enableSearch,
          enableResearch,
          enableDirectoryContext
        })
      });
      if (!response.ok) throw new Error(`Request failed with ${response.status}`);
      await consumeStream(response, assistantIndex);
    } catch (caught) {
      if ((caught as Error).name !== "AbortError") {
        setError(caught instanceof Error ? caught.message : String(caught));
        setMessages((current) =>
          current.map((message, index) =>
            index === assistantIndex && !message.content
              ? { ...message, content: "The request failed. Check Ollama and try again." }
              : message
          )
        );
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }

  function stopStreaming() {
    abortRef.current?.abort();
    setIsStreaming(false);
  }

  async function copyMessage(content: string, index: number) {
    await navigator.clipboard.writeText(content);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 1200);
  }

  function regenerate() {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    const trimmed = messages.slice(0, lastUserIndex);
    setMessages(trimmed);
    void sendMessage(lastUser.content, trimmed);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div>
            <strong>Local Assistant</strong>
            <span>Ollama workspace</span>
          </div>
          <button className="icon-button" onClick={newChat} title="New chat">
            <Play size={17} />
          </button>
        </div>

        <button className="new-chat" onClick={newChat}>
          New chat
        </button>

        <div className="conversation-list">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              className={conversation.id === conversationId ? "conversation active" : "conversation"}
              onClick={() => void openConversation(conversation.id)}
            >
              <span>{conversation.title}</span>
              <small>{new Date(conversation.updatedAt).toLocaleString()}</small>
            </button>
          ))}
        </div>

        <section className="directory-panel">
          <div className="panel-title">
            <FolderOpen size={16} />
            <span>File Context</span>
          </div>
          <input
            className="path-input"
            value={directoryPath}
            onChange={(event) => setDirectoryPath(event.target.value)}
            placeholder="C:\\path\\to\\folder"
          />
          <button className="secondary full-width" onClick={() => void indexDirectory()} disabled={isIndexing}>
            <Database size={15} />
            {isIndexing ? "Indexing..." : "Index folder"}
          </button>
          <button className="secondary full-width" onClick={() => void allowDirectoryRoot()} disabled={!directoryPath.trim()}>
            Allow folder root
          </button>
          <p className="directory-status">
            {directoryStatus.indexed
              ? `${directoryStatus.filesIndexed ?? 0} files, ${directoryStatus.chunks ?? 0} chunks`
              : "No folder indexed"}
          </p>
        </section>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="mode-group" aria-label="Response mode">
            {(["fast", "balanced", "think"] as Mode[]).map((candidate) => (
              <button
                key={candidate}
                className={candidate === mode ? "segmented active" : "segmented"}
                onClick={() => setMode(candidate)}
                title={`${modeLabels[candidate]} mode`}
              >
                {candidate === "fast" && <Zap size={15} />}
                {candidate === "balanced" && <Settings size={15} />}
                {candidate === "think" && <Brain size={15} />}
                {modeLabels[candidate]}
              </button>
            ))}
          </div>

          <div className="toggles">
            <label className="toggle">
              <input
                type="checkbox"
                checked={enableDirectoryContext}
                onChange={(event) => setEnableDirectoryContext(event.target.checked)}
                disabled={!directoryStatus.indexed}
              />
              <FolderOpen size={15} />
              Files
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={enableSearch}
                onChange={(event) => {
                  setEnableSearch(event.target.checked);
                  if (event.target.checked) setEnableResearch(false);
                }}
              />
              <Globe size={15} />
              Search
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={enableResearch}
                onChange={(event) => {
                  setEnableResearch(event.target.checked);
                  if (event.target.checked) setEnableSearch(false);
                }}
              />
              <Microscope size={15} />
              Research
            </label>
          </div>

          <select
            className="model-select"
            value={selectedModel}
            onChange={(event) => setSelectedModel(event.target.value)}
            title="Model"
          >
            <option value={selectedModel}>{selectedModel}</option>
            {models.map((model) => {
              const name = model.name ?? model.model;
              return name ? (
                <option key={name} value={name}>
                  {name}
                </option>
              ) : null;
            })}
          </select>
        </header>

        <section className="messages">
          {activeMessages.length === 0 && (
            <div className="empty-state">
              <h1>Ask locally. Search only when you choose.</h1>
              <p>
                Use Fast for everyday prompts, Think for tougher reasoning, and Research for cited multi-source
                synthesis.
              </p>
            </div>
          )}

          {activeMessages.map((message, index) => (
            <article key={`${index}-${message.role}`} className={`message ${message.role}`}>
              <div className="message-meta">
                <span>{message.role === "user" ? "You" : "Assistant"}</span>
                {message.role === "assistant" && message.content && (
                  <button
                    className="icon-button subtle"
                    onClick={() => void copyMessage(message.content, index)}
                    title="Copy response"
                  >
                    {copiedIndex === index ? <Check size={15} /> : <Copy size={15} />}
                  </button>
                )}
              </div>
              {message.role === "assistant" && message.content ? (
                <div className="message-rendered">
                  <ReactMarkdown
                    rehypePlugins={[rehypeSanitize]}
                    components={{
                      a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noreferrer">
                          {children}
                        </a>
                      )
                    }}
                  >
                    {message.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="message-body">{message.content || "Thinking..."}</div>
              )}
            </article>
          ))}

          {(steps.length > 0 || sources.length > 0) && (
            <aside className="evidence">
              {steps.length > 0 && (
                <div>
                  <h2>Research Progress</h2>
                  {steps.map((step, index) => (
                    <p key={`${step}-${index}`}>{step}</p>
                  ))}
                </div>
              )}
              {sources.length > 0 && (
                <div>
                  <h2>Sources</h2>
                  {sources.map((source) => (
                    source.kind === "file" ? (
                      <div key={source.url + source.title} className="source">
                        <span>[{source.id}] {source.title}</span>
                        <small>{source.url}</small>
                      </div>
                    ) : (
                      <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="source">
                        <span>[{source.id}] {source.title}</span>
                        <small>{source.url}</small>
                      </a>
                    )
                  ))}
                </div>
              )}
            </aside>
          )}

          {error && <div className="error">{error}</div>}
          <div ref={scrollRef} />
        </section>

        <footer className="composer">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder="Ask a question..."
            rows={3}
          />
          <div className="composer-actions">
            <button className="secondary" onClick={regenerate} disabled={isStreaming || messages.length === 0}>
              <RefreshCcw size={16} />
              Regenerate
            </button>
            {isStreaming ? (
              <button className="primary stop" onClick={stopStreaming}>
                <Square size={16} />
                Stop
              </button>
            ) : (
              <button className="primary" onClick={() => void sendMessage()} disabled={!canSend}>
                <Send size={16} />
                Send
              </button>
            )}
          </div>
        </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
