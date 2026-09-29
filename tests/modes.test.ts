import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareMessages } from "../server/ollama";
import { buildEvidencePrompt } from "../server/search";
import { buildDirectoryIndex, retrieveDirectoryContext } from "../server/directoryContext";
import { defaultSettings } from "../server/config";
import { assertSafeFetchUrl, isPublicIpAddress, validateSettingsPatch } from "../server/security";

test("prepareMessages appends mode suffix to last user message", () => {
  const messages = prepareMessages([{ role: "user", content: "Hello" }], "think");
  assert.equal(messages[0].content, "Hello\n\n/think");
});

test("prepareMessages appends no-think suffix for fast mode", () => {
  const messages = prepareMessages([{ role: "user", content: "Hello" }], "fast");
  assert.equal(messages[0].content, "Hello\n\n/no_think");
});

test("prepareMessages preserves explicit thinking directive", () => {
  const messages = prepareMessages([{ role: "user", content: "Hello /no_think" }], "think");
  assert.equal(messages[0].content, "Hello /no_think");
});

test("buildEvidencePrompt includes citation identifiers and URLs", () => {
  const prompt = buildEvidencePrompt("What happened?", [
    { id: 1, title: "Example", url: "https://example.com", snippet: "Evidence text" }
  ]);

  assert.match(prompt, /\[1\] Example/);
  assert.match(prompt, /https:\/\/example\.com/);
  assert.match(prompt, /User question: What happened\?/);
});

test("directory context indexes and retrieves relevant local file chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-llm-context-"));
  const indexPath = join(process.cwd(), "data", "directory-context.json");
  let existingIndex: string | undefined;
  try {
    try {
      existingIndex = await readFile(indexPath, "utf8");
    } catch {
      existingIndex = undefined;
    }
    await writeFile(join(directory, "notes.md"), "Sphere surface area is 4*pi*r^2.\nUse radius r.", "utf8");
    const settings = { ...defaultSettings, allowedDirectoryRoots: [directory] };
    const index = await buildDirectoryIndex(directory, settings);
    assert.equal(index.filesIndexed, 1);
    assert.ok(index.chunks.length >= 1);

    const context = await retrieveDirectoryContext("surface area sphere", settings);
    assert.match(context.prompt, /Sphere surface area/);
    assert.equal(context.sources[0].kind, "file");
  } finally {
    if (existingIndex !== undefined) {
      await mkdir(join(process.cwd(), "data"), { recursive: true });
      await writeFile(indexPath, existingIndex, "utf8");
    } else {
      await unlink(indexPath).catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("directory context rejects paths outside allowed roots", async () => {
  const allowed = await mkdtemp(join(tmpdir(), "local-llm-allowed-"));
  const blocked = await mkdtemp(join(tmpdir(), "local-llm-blocked-"));
  try {
    await assert.rejects(
      buildDirectoryIndex(blocked, { ...defaultSettings, allowedDirectoryRoots: [allowed] }),
      /outside allowed roots/
    );
  } finally {
    await rm(allowed, { recursive: true, force: true });
    await rm(blocked, { recursive: true, force: true });
  }
});

test("directory context skips secret-like files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-llm-secrets-"));
  try {
    await writeFile(join(directory, "notes.md"), "public note", "utf8");
    await writeFile(join(directory, "credentials.txt"), "password=secret", "utf8");
    const index = await buildDirectoryIndex(directory, { ...defaultSettings, allowedDirectoryRoots: [directory] });
    assert.equal(index.chunks.some((chunk) => chunk.relativePath.includes("credentials")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("settings validation blocks remote Ollama by default", () => {
  assert.throws(
    () => validateSettingsPatch({ ollamaBaseUrl: "https://example.com" }, defaultSettings),
    /Remote Ollama URLs are disabled/
  );
});

test("safe fetch validation blocks localhost and private network URLs", () => {
  assert.throws(() => assertSafeFetchUrl("http://127.0.0.1:11434/api/tags"), /Localhost URLs are blocked/);
  assert.throws(() => assertSafeFetchUrl("http://192.168.1.10/"), /Private or reserved network URLs are blocked/);
  assert.throws(() => assertSafeFetchUrl("http://printer.local/"), /Localhost URLs are blocked/);
  assert.throws(() => assertSafeFetchUrl("http://example.com:8080/"), /Nonstandard ports are blocked/);
});

test("safe fetch validation rejects reserved, mapped, and private IP ranges", () => {
  for (const address of [
    "0.1.2.3",
    "100.64.0.1",
    "169.254.10.10",
    "192.0.2.1",
    "198.18.0.1",
    "203.0.113.10",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1"
  ]) {
    assert.equal(isPublicIpAddress(address), false, `${address} should not be public`);
  }
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("2001:4860:4860::8888"), true);
  assert.equal(isPublicIpAddress("::ffff:8.8.8.8"), true);
});
