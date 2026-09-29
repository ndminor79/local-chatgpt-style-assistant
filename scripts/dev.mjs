import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const processes = [
  {
    name: "api",
    args: [join(root, "node_modules", "tsx", "dist", "cli.mjs"), "watch", "server/index.ts"]
  },
  {
    name: "web",
    args: [join(root, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1"]
  }
];

const children = processes.map(({ name, args }) => {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
    shell: false
  });

  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", (code, signal) => {
    if (code || signal) {
      console.error(`[${name}] exited with ${signal ?? code}`);
      shutdown(code ?? 1);
    }
  });
  child.on("error", (error) => {
    console.error(`[${name}] ${error.message}`);
    shutdown(1);
  });

  return child;
});

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exitCode = code;
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
