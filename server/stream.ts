import type { Response } from "express";
import type { StreamEvent } from "./types";

export function initStream(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
}

export function sendEvent(res: Response, event: StreamEvent): void {
  res.write(`${JSON.stringify(event)}\n`);
}
