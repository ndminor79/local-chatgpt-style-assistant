import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { DirectoryChunk, DirectoryIndex, Settings, Source } from "./types";
import { assertDirectoryAllowed, isSecretLikePath, untrustedEvidenceHeader } from "./security";

const indexFile = join(process.cwd(), "data", "directory-context.json");
const ignoredDirs = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vite",
  "benchmark-results",
  "build",
  "coverage",
  "data",
  "dist",
  "node_modules",
  "target"
]);

const textExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".log",
  ".md",
  ".mdx",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml"
]);

const ignoredFiles = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".env"]);

function normalizePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Directory path is required.");
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(process.cwd(), trimmed);
}

function isProbablyText(path: string): boolean {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return textExtensions.has(extname(path).toLowerCase()) && !ignoredFiles.has(name) && !isSecretLikePath(path);
}

function chunkText(filePath: string, rootPath: string, text: string): DirectoryChunk[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const chunks: DirectoryChunk[] = [];
  const chunkLines = 80;
  const overlap = 12;
  for (let start = 0; start < lines.length; start += chunkLines - overlap) {
    const selected = lines.slice(start, start + chunkLines);
    const body = selected.join("\n").trim();
    if (!body) continue;
    const endLine = Math.min(lines.length, start + selected.length);
    chunks.push({
      id: `${relative(rootPath, filePath)}:${start + 1}-${endLine}`,
      filePath,
      relativePath: relative(rootPath, filePath),
      text: body.slice(0, 6000),
      startLine: start + 1,
      endLine
    });
  }
  return chunks;
}

async function walkDirectory(rootPath: string, settings: Settings): Promise<{ files: string[]; skipped: string[] }> {
  const files: string[] = [];
  const skipped: string[] = [];

  async function visit(directory: string): Promise<void> {
    if (files.length >= settings.contextMaxFiles) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      skipped.push(`${directory} (${error instanceof Error ? error.message : "unreadable"})`);
      return;
    }

    for (const entry of entries) {
      if (files.length >= settings.contextMaxFiles) break;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) await visit(fullPath);
        continue;
      }
      if (entry.isFile() && isProbablyText(fullPath)) files.push(fullPath);
    }
  }

  await visit(rootPath);
  return { files, skipped };
}

export async function buildDirectoryIndex(pathInput: string, settings: Settings): Promise<DirectoryIndex> {
  const rootPath = normalizePath(pathInput);
  assertDirectoryAllowed(rootPath, settings);
  const rootStats = await stat(rootPath);
  if (!rootStats.isDirectory()) throw new Error("The supplied path is not a directory.");

  const { files, skipped } = await walkDirectory(rootPath, settings);
  const chunks: DirectoryChunk[] = [];

  for (const file of files) {
    const fileStats = await stat(file);
    if (fileStats.size > settings.contextMaxFileBytes) {
      skipped.push(`${relative(rootPath, file)} (too large)`);
      continue;
    }
    try {
      const text = await readFile(file, "utf8");
      if (text.includes("\u0000")) {
        skipped.push(`${relative(rootPath, file)} (binary-looking text)`);
        continue;
      }
      chunks.push(...chunkText(file, rootPath, text));
    } catch (error) {
      skipped.push(`${relative(rootPath, file)} (${error instanceof Error ? error.message : "unreadable"})`);
    }
  }

  const index: DirectoryIndex = {
    rootPath,
    indexedAt: new Date().toISOString(),
    filesIndexed: files.length,
    chunks,
    skipped
  };
  await saveDirectoryIndex(index);
  return index;
}

export async function saveDirectoryIndex(index: DirectoryIndex): Promise<void> {
  await mkdir(dirname(indexFile), { recursive: true });
  await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

export async function getDirectoryIndex(): Promise<DirectoryIndex | undefined> {
  try {
    return JSON.parse(await readFile(indexFile, "utf8")) as DirectoryIndex;
  } catch {
    return undefined;
  }
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((token) => token.length > 2);
}

function scoreChunk(questionTokens: Set<string>, chunk: DirectoryChunk): number {
  const text = `${chunk.relativePath}\n${chunk.text}`.toLowerCase();
  let score = 0;
  for (const token of questionTokens) {
    if (text.includes(token)) score += token.includes(".") || token.includes("/") ? 3 : 1;
  }
  return score;
}

export async function retrieveDirectoryContext(
  question: string,
  settings: Settings
): Promise<{ prompt: string; sources: Source[] }> {
  const index = await getDirectoryIndex();
  if (!index || index.chunks.length === 0) return { prompt: "", sources: [] };

  const questionTokens = new Set(tokenize(question));
  const ranked = index.chunks
    .map((chunk) => ({ chunk, score: scoreChunk(questionTokens, chunk) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const selected = ranked.some((item) => item.score > 0)
    ? ranked.filter((item) => item.score > 0).slice(0, 6)
    : ranked.slice(0, 4);

  const sources: Source[] = selected.map(({ chunk }, index) => ({
    id: index + 1,
    title: `${chunk.relativePath}:${chunk.startLine}-${chunk.endLine}`,
    url: chunk.filePath,
    snippet: chunk.text.slice(0, 700),
    kind: "file"
  }));

  let usedChars = 0;
  const blocks: string[] = [];
  for (const { chunk } of selected) {
    const block = `[${blocks.length + 1}] ${chunk.relativePath}:${chunk.startLine}-${chunk.endLine}\n${chunk.text}`;
    if (usedChars + block.length > settings.contextMaxPromptChars) break;
    usedChars += block.length;
    blocks.push(block);
  }

  if (blocks.length === 0) return { prompt: "", sources };

  return {
    prompt: [
      untrustedEvidenceHeader("file"),
      "If the files do not contain enough information, say what is missing instead of guessing.",
      "",
      `Indexed root: ${index.rootPath}`,
      "",
      blocks.join("\n\n")
    ].join("\n"),
    sources
  };
}
