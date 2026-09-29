import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Conversation, Settings } from "./types";
import { defaultSettings } from "./config";
import { validateSettingsPatch } from "./security";

const dataDir = join(process.cwd(), "data");
const conversationsFile = join(dataDir, "conversations.json");
const settingsFile = join(dataDir, "settings.json");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function getSettings(): Promise<Settings> {
  const stored = await readJson<Partial<Settings>>(settingsFile, {});
  return validateSettingsPatch(stored, defaultSettings);
}

export async function saveSettings(settings: Partial<Settings>): Promise<Settings> {
  const merged = validateSettingsPatch(settings, await getSettings());
  await writeJson(settingsFile, merged);
  return merged;
}

export async function listConversations(): Promise<Conversation[]> {
  const conversations = await readJson<Conversation[]>(conversationsFile, []);
  return conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  return (await listConversations()).find((conversation) => conversation.id === id);
}

export async function upsertConversation(conversation: Conversation): Promise<Conversation> {
  const conversations = await listConversations();
  const next = [
    conversation,
    ...conversations.filter((candidate) => candidate.id !== conversation.id)
  ];
  await writeJson(conversationsFile, next);
  return conversation;
}

export function createConversation(title: string): Conversation {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: title.trim().slice(0, 80) || "New chat",
    createdAt: now,
    updatedAt: now,
    messages: []
  };
}
