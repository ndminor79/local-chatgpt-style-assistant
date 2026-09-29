import express from "express";
import type { Request, Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage, ChatRequest, Conversation } from "./types";
import { checkOllama, listOllamaModels, streamChat } from "./ollama";
import { buildEvidencePrompt, fetchReadableSource, searchWeb } from "./search";
import { buildDirectoryIndex, getDirectoryIndex, retrieveDirectoryContext } from "./directoryContext";
import { runResearch } from "./research";
import {
  createConversation,
  getConversation,
  getSettings,
  listConversations,
  saveSettings,
  upsertConversation
} from "./storage";
import { initStream, sendEvent } from "./stream";
import { localRequestGuard, untrustedEvidenceHeader } from "./security";

const app = express();
const port = Number(process.env.PORT ?? 8787);
const distDir = join(process.cwd(), "dist");

app.use(localRequestGuard);
app.use(express.json({ limit: "2mb" }));
if (existsSync(distDir)) {
  app.use(express.static(distDir));
}

function lastUserMessage(messages: ChatMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

async function saveTurn(request: ChatRequest, assistantContent: string): Promise<Conversation> {
  const existing = request.conversationId ? await getConversation(request.conversationId) : undefined;
  const conversation = existing ?? createConversation(lastUserMessage(request.messages));
  conversation.messages = [...request.messages, { role: "assistant", content: assistantContent }];
  conversation.updatedAt = new Date().toISOString();
  return upsertConversation(conversation);
}

function responseAbortSignal(res: Response): AbortSignal {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}

app.get("/api/health", async (_req, res) => {
  const settings = await getSettings();
  const ollama = await checkOllama(settings.ollamaBaseUrl);
  res.json({ ok: true, ollama });
});

app.get("/api/models", async (_req, res) => {
  const settings = await getSettings();
  try {
    const models = await listOllamaModels(settings.ollamaBaseUrl);
    res.json({ defaultModel: settings.defaultModel, models });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error), models: [] });
  }
});

app.get("/api/settings", async (_req, res) => {
  res.json(await getSettings());
});

app.post("/api/settings", async (req, res) => {
  try {
    res.json(await saveSettings(req.body));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/conversations", async (_req, res) => {
  res.json(await listConversations());
});

app.get("/api/conversations/:id", async (req, res) => {
  const conversation = await getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.json(conversation);
});

app.get("/api/context/directory", async (_req, res) => {
  const index = await getDirectoryIndex();
  if (!index) {
    res.json({ indexed: false });
    return;
  }
  res.json({
    indexed: true,
    rootPath: index.rootPath,
    indexedAt: index.indexedAt,
    filesIndexed: index.filesIndexed,
    chunks: index.chunks.length,
    skipped: index.skipped.slice(0, 20)
  });
});

app.post("/api/context/directory", async (req, res) => {
  const settings = await getSettings();
  try {
    const index = await buildDirectoryIndex(String(req.body?.path ?? ""), settings);
    res.json({
      indexed: true,
      rootPath: index.rootPath,
      indexedAt: index.indexedAt,
      filesIndexed: index.filesIndexed,
      chunks: index.chunks.length,
      skipped: index.skipped.slice(0, 20)
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

async function handlePlainChat(req: Request, res: Response, request: ChatRequest): Promise<void> {
  const settings = await getSettings();
  const mode = request.mode ?? "balanced";
  const userQuestion = lastUserMessage(request.messages);
  let content = "";
  initStream(res);

  try {
    const directoryContext = request.enableDirectoryContext
      ? await retrieveDirectoryContext(userQuestion, settings)
      : { prompt: "", sources: [] };
    for (const source of directoryContext.sources) sendEvent(res, { type: "source", source });

    const messages = directoryContext.prompt
      ? [
          ...request.messages.slice(0, -1),
          {
            role: "user" as const,
            content: [
              directoryContext.prompt,
              "",
              "User question:",
              userQuestion,
              "",
              "Format the answer clearly with short headings, bullets, code blocks, or formulas when useful."
            ].join("\n")
          }
        ]
      : request.messages;

    content = await streamChat({
      baseUrl: settings.ollamaBaseUrl,
      model: request.model ?? settings.defaultModel,
      mode,
      messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: responseAbortSignal(res),
      onToken: (token) => sendEvent(res, { type: "token", content: token })
    });
    const conversation = await saveTurn(request, content);
    sendEvent(res, { type: "final", content, conversation });
  } catch (error) {
    sendEvent(res, { type: "error", error: error instanceof Error ? error.message : String(error) });
  } finally {
    res.end();
  }
}

async function handleSearchChat(req: Request, res: Response, request: ChatRequest): Promise<void> {
  const settings = await getSettings();
  const userQuestion = lastUserMessage(request.messages);
  let content = "";
  initStream(res);

  try {
    const searchResults = await searchWeb(userQuestion, settings.searchResultCount, settings.searchTimeoutMs);
    const sources = await Promise.all(
      searchResults.map(async (source, index) => ({
        ...(await fetchReadableSource(source, settings.searchTimeoutMs)),
        id: index + 1
      }))
    );

    for (const source of sources) sendEvent(res, { type: "source", source });
    const directoryContext = request.enableDirectoryContext
      ? await retrieveDirectoryContext(userQuestion, settings)
      : { prompt: "", sources: [] };
    for (const source of directoryContext.sources) sendEvent(res, { type: "source", source });

    const promptParts = [
      untrustedEvidenceHeader("mixed"),
      buildEvidencePrompt(userQuestion, sources),
      directoryContext.prompt,
      "Format the answer clearly with short headings, bullets, code blocks, or formulas when useful."
    ].filter(Boolean);

    const messages: ChatMessage[] = [
      ...request.messages.slice(0, -1),
      { role: "user", content: promptParts.join("\n\n") }
    ];

    content = await streamChat({
      baseUrl: settings.ollamaBaseUrl,
      model: request.model ?? settings.defaultModel,
      mode: request.mode ?? "balanced",
      messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: responseAbortSignal(res),
      onToken: (token) => sendEvent(res, { type: "token", content: token })
    });
    const conversation = await saveTurn(request, content);
    sendEvent(res, { type: "final", content, conversation, sources });
  } catch (error) {
    sendEvent(res, { type: "error", error: error instanceof Error ? error.message : String(error) });
  } finally {
    res.end();
  }
}

app.post("/api/chat", async (req, res) => {
  const request = req.body as ChatRequest;
  if (request.enableResearch) {
    await handleResearchChat(req, res, request);
    return;
  }
  if (request.enableSearch) {
    await handleSearchChat(req, res, request);
    return;
  }
  await handlePlainChat(req, res, request);
});

app.post("/api/search-chat", async (req, res) => {
  await handleSearchChat(req, res, req.body as ChatRequest);
});

async function handleResearchChat(_req: Request, res: Response, request: ChatRequest): Promise<void> {
  const settings = await getSettings();
  const question = lastUserMessage(request.messages);
  let content = "";
  initStream(res);

  try {
    const result = await runResearch({
      baseUrl: settings.ollamaBaseUrl,
      model: request.model ?? settings.defaultModel,
      question,
      maxSteps: settings.researchMaxSteps,
      timeoutMs: settings.researchTimeoutMs,
      searchResultCount: settings.searchResultCount,
      onStep: (step) => sendEvent(res, { type: "research_step", content: step }),
      onSource: (source) => sendEvent(res, { type: "source", source }),
      onToken: (token) => {
        content += token;
        sendEvent(res, { type: "token", content: token });
      }
    });
    content = result.answer;
    const conversation = await saveTurn(request, content);
    sendEvent(res, { type: "final", content, conversation, sources: result.sources });
  } catch (error) {
    sendEvent(res, { type: "error", error: error instanceof Error ? error.message : String(error) });
  } finally {
    res.end();
  }
}

app.post("/api/research", async (req, res) => {
  await handleResearchChat(req, res, req.body as ChatRequest);
});

app.get(/.*/, (_req, res, next) => {
  const indexFile = join(distDir, "index.html");
  if (!existsSync(indexFile)) {
    next();
    return;
  }
  res.sendFile(indexFile);
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Local LLM Assistant API listening on http://127.0.0.1:${port}`);
});
