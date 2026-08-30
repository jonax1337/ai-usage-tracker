import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { collectUsage, getLimits, getAllLimits } from "./lib.ts";

const PORT = Number(process.env.PORT) || 3789;
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");
// Dev layout: ./public next to server.ts — packaged layout: dist/server.js with ../public
const OWN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = [path.join(OWN_DIR, "public"), path.join(OWN_DIR, "..", "public")]
  .map((p) => path.resolve(p))
  .find((p) => fs.existsSync(p)) ?? path.join(OWN_DIR, "public");

// Live updates: SSE clients notified on changes under PROJECTS_DIR
const sseClients = new Set<http.ServerResponse>();

function notifyClients(): void {
  for (const res of sseClients) res.write("event: change\ndata: {}\n\n");
}

let watchDebounce: NodeJS.Timeout | undefined;
try {
  fs.watch(PROJECTS_DIR, { recursive: true }, (_event, filename) => {
    if (filename && !filename.endsWith(".jsonl")) return;
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(notifyClients, 1500);
  });
} catch (err) {
  console.warn("File watcher unavailable, live updates disabled:", (err as Error).message);
}

// ~/.claude.json changes whenever Claude Code refreshes its limit data
try {
  fs.watch(CLAUDE_JSON, () => {
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(notifyClients, 1500);
  });
} catch {}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    sseClients.add(res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 30000);
    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  if (url.pathname === "/api/limits") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(await getLimits()));
    return;
  }

  // New multi-provider payload — every detected AI subscription/API
  // credential with its own live rate-limit windows. /api/limits stays for
  // back-compat (single-provider shape, Anthropic-first).
  if (url.pathname === "/api/limits/all") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(await getAllLimits()));
    return;
  }

  if (url.pathname === "/api/usage") {
    try {
      const data = await collectUsage();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // Static files, confined to PUBLIC_DIR
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`AI Usage Tracker → http://localhost:${PORT}`);
  console.log(`Data source: ${PROJECTS_DIR}`);
});
