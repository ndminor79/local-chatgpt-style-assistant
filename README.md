# Local ChatGPT-Style LLM Assistant

A local-first ChatGPT-style assistant for Windows using Ollama, Node/TypeScript, and a browser UI.

## Requirements

- Node.js 24+
- Ollama running locally at `http://localhost:11434`
- Recommended model: `qwen3:8b`

```powershell
ollama pull qwen3:8b
npm install
npm run check:setup
npm run dev
```

Open `http://127.0.0.1:5173`.

For a production-style local run:

```powershell
npm run build
npm start
```

Open `http://127.0.0.1:8787`.

## Features

- Streaming local chat through Ollama.
- Fast, Balanced, and Think modes.
- Optional web search with citations.
- Optional deep research loop with progress events.
- Local conversation history in `data/conversations.json`.
- Benchmark script for first-token latency, total latency, and approximate tokens/sec.

## Useful Commands

```powershell
npm run benchmark
npm test
npm run build
```

## Notes

This app is local-first, but the search and research toggles fetch public web pages when enabled.
