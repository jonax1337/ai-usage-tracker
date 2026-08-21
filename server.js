import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const PORT = process.env.PORT || 3789;
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

// USD pro Million Tokens: [substring-match, input, output, cacheWrite5m, cacheRead]
// Reihenfolge zählt — spezifischere Einträge vor generischen.
const PRICING = [
  ["fable", 10, 50, 12.5, 1],
  ["mythos", 10, 50, 12.5, 1],
  ["opus-4-1", 15, 75, 18.75, 1.5],
  ["opus-4-0", 15, 75, 18.75, 1.5],
  ["opus", 5, 25, 6.25, 0.5],
  ["sonnet", 3, 15, 3.75, 0.3],
  ["haiku", 1, 5, 1.25, 0.1],
];

function pricingFor(model) {
  const row = PRICING.find(([m]) => model.includes(m));
  return row ? { input: row[1], output: row[2], cacheWrite: row[3], cacheRead: row[4] } : null;
}

function cost(model, u) {
  const p = pricingFor(model);
  if (!p) return 0;
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheWrite * p.cacheWrite +
      u.cacheRead * p.cacheRead) /
    1e6
  );
}

// Datei-Cache, damit wiederholte Dashboard-Reloads nicht alles neu parsen.
const fileCache = new Map(); // filePath -> { mtimeMs, size, entries }

async function parseTranscript(filePath) {
  const stat = fs.statSync(filePath);
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.entries;
  }

  const entries = new Map(); // dedupe key -> entry (letzter Eintrag gewinnt)
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, "utf8"),
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.includes('"usage"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = obj?.message;
    const usage = msg?.usage;
    // "<synthetic>" sind Claude-Code-Platzhalter (Fehlermeldungen) ohne echte Nutzung
    if (obj?.type !== "assistant" || !usage || !msg.model || msg.model.startsWith("<")) continue;

    // Streaming schreibt dieselbe Message mehrfach — auf id+requestId dedupen.
    const key = msg.id ? `${msg.id}:${obj.requestId ?? ""}` : `line:${lineNo}`;
    entries.set(key, {
      ts: obj.timestamp,
      model: msg.model,
      input: usage.input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
    });
  }

  const result = [...entries.values()];
  fileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, entries: result });
  return result;
}

function localDate(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Ordnernamen wie "E--DEV-LS25-FlowLink" auf das letzte Pfadsegment kürzen.
function projectLabel(dirName) {
  const parts = dirName.split("-").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dirName;
}

async function collectUsage() {
  const rows = new Map(); // date|project|model -> aggregierte Zeile
  const sessionsByDay = new Map(); // date -> Set(sessionId)

  let projectDirs = [];
  try {
    projectDirs = fs
      .readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory());
  } catch {
    return { rows: [], sessions: [] };
  }

  for (const dir of projectDirs) {
    const project = projectLabel(dir.name);
    const dirPath = path.join(PROJECTS_DIR, dir.name);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      const sessionId = file.replace(/\.jsonl$/, "");
      let entries;
      try {
        entries = await parseTranscript(path.join(dirPath, file));
      } catch {
        continue;
      }
      for (const e of entries) {
        const date = localDate(e.ts);
        if (!date) continue;
        const key = `${date}|${project}|${e.model}`;
        let row = rows.get(key);
        if (!row) {
          row = { date, project, model: e.model, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 };
          rows.set(key, row);
        }
        row.input += e.input;
        row.cacheWrite += e.cacheWrite;
        row.cacheRead += e.cacheRead;
        row.output += e.output;
        row.cost += cost(e.model, e);

        if (!sessionsByDay.has(date)) sessionsByDay.set(date, new Set());
        sessionsByDay.get(date).add(sessionId);
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    rows: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)),
    sessions: [...sessionsByDay.entries()]
      .map(([date, set]) => ({ date, count: set.size }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

// Plan-Limits (Session/Weekly): primär live über Anthropics OAuth-Usage-Endpoint,
// mit dem Token, das Claude Code lokal pflegt. Fallback: Claude Codes eigener Cache.
const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");
const CREDENTIALS = path.join(os.homedir(), ".claude", ".credentials.json");

function mapLimits(limits) {
  return limits.map((l) => ({
    kind: l.kind,
    percent: l.percent,
    severity: l.severity,
    resetsAt: l.resets_at,
    scope: l.scope?.model?.display_name ?? null,
  }));
}

function planLabel(tier) {
  return (
    (tier ?? "")
      .replace(/^default_claude_/, "")
      .replace(/_(\d+)x$/, " $1×")
      .replace(/^\w/, (c) => c.toUpperCase()) || null
  );
}

// Pace-Historie: regelmäßige Samples der Limit-Prozente, persistiert über Neustarts
const HISTORY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "pace-history.json");
const HISTORY_MAX_AGE = 8 * 24 * 3600 * 1000;

let paceHistory = [];
try {
  paceHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
} catch {}

// Claude Codes eigener Cache liefert einen älteren Datenpunkt als Start-Seed
(function seedHistory() {
  const cached = readLimits(); // Funktionsdeklaration, gehoisted
  if (!cached?.limits) return;
  if (paceHistory.some((s) => Math.abs(s.t - cached.fetchedAtMs) < 60000)) return;
  const values = {};
  for (const l of cached.limits) values[limitKey(l)] = l.percent;
  paceHistory.push({ t: cached.fetchedAtMs, values });
  paceHistory.sort((a, b) => a.t - b.t);
})();

function limitKey(l) {
  return l.scope ? `${l.kind}:${l.scope}` : l.kind;
}

function recordSample(limits) {
  const now = Date.now();
  const last = paceHistory[paceHistory.length - 1];
  if (last && now - last.t < 2 * 60 * 1000) return;
  const values = {};
  for (const l of limits) values[limitKey(l)] = l.percent;
  paceHistory.push({ t: now, values });
  paceHistory = paceHistory.filter((s) => now - s.t < HISTORY_MAX_AGE);
  fs.writeFile(HISTORY_FILE, JSON.stringify(paceHistory), () => {});
}

// Pace in %/h über ein Zeitfenster; Samples vor einem Limit-Reset
// (Prozentwert fällt deutlich) werden verworfen.
function computePace(key, current, windowMs) {
  const now = Date.now();
  let samples = paceHistory
    .filter((s) => now - s.t < windowMs && s.values[key] != null)
    .map((s) => ({ t: s.t, v: s.values[key] }));
  samples.push({ t: now, v: current });

  let startIdx = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].v < samples[i - 1].v - 2) startIdx = i;
  }
  samples = samples.slice(startIdx);
  if (samples.length < 2) return null;

  const dt = (samples[samples.length - 1].t - samples[0].t) / 3600000;
  if (dt < 0.05) return null;
  return { pace: (samples[samples.length - 1].v - samples[0].v) / dt, spanHours: dt };
}

function withPredictions(limits) {
  return limits.map((l) => {
    const isSession = l.kind === "session";
    // Session: kurzes Fenster, lineare Fortschreibung ist hier fair.
    // Weekly: langes Fenster (Ø inkl. Leerlauf) — kurze Bursts sind ohnehin
    // durchs Session-Limit gedeckelt, linear hochrechnen wäre Unsinn.
    const windowMs = isSession ? 3 * 3600 * 1000 : 72 * 3600 * 1000;
    const result = computePace(limitKey(l), l.percent, windowMs);
    // Weekly-Ø braucht genug Historie (inkl. Leerlaufphasen), sonst verzerren Bursts
    const pace = result == null || (!isSession && result.spanHours < 12) ? null : result.pace;
    const resetMs = l.resetsAt ? Date.parse(l.resetsAt) : null;

    let exhaustsAtMs = null;
    let projectedAtReset = null;
    if (pace != null && pace > 0.01 && l.percent < 100) {
      exhaustsAtMs = Date.now() + ((100 - l.percent) / pace) * 3600000;
      if (resetMs != null) {
        projectedAtReset = Math.round(l.percent + pace * ((resetMs - Date.now()) / 3600000));
      }
    }
    return {
      ...l,
      isSession,
      pacePerHour: pace,
      exhaustsAtMs,
      exhaustsBeforeReset:
        isSession && exhaustsAtMs != null && resetMs != null ? exhaustsAtMs < resetMs : false,
      projectedAtReset,
    };
  });
}

let liveLimitsCache = { at: 0, data: null };

async function fetchLiveLimits() {
  if (Date.now() - liveLimitsCache.at < 30_000) return liveLimitsCache.data;
  const oauth = JSON.parse(fs.readFileSync(CREDENTIALS, "utf8")).claudeAiOauth;
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${oauth.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`usage endpoint ${res.status}`);
  const j = await res.json();
  const limits = mapLimits(j.limits ?? []);
  recordSample(limits);
  const data = {
    fetchedAtMs: Date.now(),
    source: "live",
    plan: planLabel(oauth.rateLimitTier),
    limits: withPredictions(limits),
  };
  liveLimitsCache = { at: Date.now(), data };
  return data;
}

// Auch ohne offenes Dashboard weiter sampeln, damit die Pace-Historie dicht bleibt
setInterval(() => fetchLiveLimits().catch(() => {}), 5 * 60 * 1000);
fetchLiveLimits().catch(() => {});

function readLimits() {
  try {
    const j = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8"));
    const u = j.cachedUsageUtilization;
    if (!u?.utilization?.limits) return null;
    const tier = j.oauthAccount?.organizationRateLimitTier ?? "";
    const plan = tier
      .replace(/^default_claude_/, "")
      .replace(/_(\d+)x$/, " $1×")
      .replace(/^\w/, (c) => c.toUpperCase());
    return {
      fetchedAtMs: u.fetchedAtMs,
      source: "cache",
      plan: plan || null,
      limits: mapLimits(u.utilization.limits),
    };
  } catch {
    return null;
  }
}

// Live-Updates: SSE-Clients, die bei Änderungen unter PROJECTS_DIR benachrichtigt werden
const sseClients = new Set();

function notifyClients() {
  for (const res of sseClients) res.write("event: change\ndata: {}\n\n");
}

let watchDebounce = null;
try {
  fs.watch(PROJECTS_DIR, { recursive: true }, (_event, filename) => {
    if (filename && !filename.endsWith(".jsonl")) return;
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(notifyClients, 1500);
  });
} catch (err) {
  console.warn("File-Watcher nicht verfügbar, Live-Updates deaktiviert:", err.message);
}

// ~/.claude.json ändert sich, wenn Claude Code die Limit-Daten neu abruft
try {
  fs.watch(CLAUDE_JSON, () => {
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(notifyClients, 1500);
  });
} catch {}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

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
    let data;
    try {
      data = await fetchLiveLimits();
    } catch {
      data = readLimits();
      if (data) data.limits = withPredictions(data.limits);
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
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

  // Statische Dateien, auf PUBLIC_DIR begrenzt
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
  console.log(`Claude Usage Tracker → http://localhost:${PORT}`);
  console.log(`Datenquelle: ${PROJECTS_DIR}`);
});
