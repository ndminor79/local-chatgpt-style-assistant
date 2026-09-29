import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultSettings } from "../server/config";

const execFileAsync = promisify(execFile);

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("powershell", ["-NoProfile", "-Command", `Get-Command ${command} -ErrorAction Stop`]);
    return true;
  } catch {
    return false;
  }
}

async function checkOllamaApi(): Promise<string> {
  try {
    const response = await fetch(`${defaultSettings.ollamaBaseUrl}/api/tags`);
    if (!response.ok) return `Ollama API responded with ${response.status}`;
    const data = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    const models = data.models?.map((model) => model.name ?? model.model).filter(Boolean) ?? [];
    return models.length > 0 ? `Ollama API ok. Models: ${models.join(", ")}` : "Ollama API ok. No models installed.";
  } catch (error) {
    return `Ollama API unavailable at ${defaultSettings.ollamaBaseUrl}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

console.log("Local LLM Assistant setup check");
console.log(`Node.js: ${process.version}`);
console.log(`Ollama CLI: ${(await commandExists("ollama")) ? "found" : "not found"}`);
console.log(await checkOllamaApi());
console.log("");
console.log("Expected setup:");
console.log("1. Install Ollama for Windows from https://ollama.com/download");
console.log("2. Run: ollama pull qwen3:8b");
console.log("3. Run: npm run dev");
