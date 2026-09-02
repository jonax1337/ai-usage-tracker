import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { collectHermesUsage } from "./hermes.ts";

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
// User-scoped state dir — a globally installed package must not write into itself.
// Renamed with v1.7.0 (was ~/.claude-usage-tracker when this was Claude-only);
// an existing legacy dir keeps being used so pace-history/pricing/limits caches
// survive the rename instead of starting cold.
export const STATE_DIR = (() => {
  const next = path.join(os.homedir(), ".aiusage-tracker");
  const legacy = path.join(os.homedir(), ".claude-usage-tracker");
  try {
    if (!fs.existsSync(next) && fs.existsSync(legacy)) {
      fs.cpSync(legacy, next, { recursive: true });
    }
  } catch {}
  fs.mkdirSync(next, { recursive: true });
  return next;
})();

// Multi-machine usage, the low-effort way: drop a JSON file per machine here
// (Syncthing, a cloud-synced folder, scp, whatever moves bytes between your
// PCs) and it merges straight into the dashboard on next load — no server,
// no auth, no daemon. See README "Multi-machine usage" for the file format
// and a one-liner to produce one from another PC's ~/.claude/projects.
export const EXTERNAL_USAGE_DIR = path.join(STATE_DIR, "external-usage");
fs.mkdirSync(EXTERNAL_USAGE_DIR, { recursive: true });

// State files are shared between the dashboard daemon, the CLI widget, and any
// dev checkout. A plain writeFile is not atomic: a concurrent reader can see a
// truncated file, parse nothing, and later overwrite everyone's data with its
// own empty state. Write to a temp file and rename, which is atomic on every
// platform we run on.
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFile(tmp, JSON.stringify(data), (err) => {
    if (err) return;
    fs.rename(tmp, file, () => {});
  });
}

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface UsageEntry {
  ts: string;
  model: string;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface UsageRow extends Omit<UsageEntry, "ts"> {
  date: string;
  project: string;
  cost: number;
}

export interface LimitInfo {
  kind: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
  scope: string | null;
  note?: string | null;
}

export interface PredictedLimit extends LimitInfo {
  isSession: boolean;
  pacePerHour: number | null;
  exhaustsAtMs: number | null;
  exhaustsBeforeReset: boolean;
  projectedAtReset: number | null;
}

export interface LimitsPayload {
  fetchedAtMs: number;
  source: "live" | "cache";
  plan: string | null;
  limits: LimitInfo[] | PredictedLimit[];
}

// Fallback-Preise, USD pro Million Tokens: [substring-match, input, output, cacheWrite5m, cacheRead]
// Reihenfolge zählt — spezifischere Einträge vor generischen. Primär kommen die
// Preise live aus der LiteLLM-Datenbank (siehe refreshPricing).
const PRICING: Array<[string, number, number, number, number]> = [
  ["fable", 10, 50, 12.5, 1],
  ["mythos", 10, 50, 12.5, 1],
  ["opus-4-1", 15, 75, 18.75, 1.5],
  ["opus-4-0", 15, 75, 18.75, 1.5],
  ["opus", 5, 25, 6.25, 0.5],
  ["sonnet", 3, 15, 3.75, 0.3],
  ["haiku", 1, 5, 1.25, 0.1],
];

// Live-Preise aus der LiteLLM-Preisdatenbank (Community-gepflegt, deckt alle
// Claude-Modelle ab). Auf Disk gecacht, täglich aktualisiert, PRICING als Fallback.
const PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PRICING_CACHE = path.join(STATE_DIR, "pricing-cache.json");

let livePricing: { fetchedAt: number; models: Record<string, ModelPricing> } = {
  fetchedAt: 0,
  models: {},
};
try {
  livePricing = JSON.parse(fs.readFileSync(PRICING_CACHE, "utf8"));
} catch {}

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
}

async function refreshPricing(): Promise<void> {
  const res = await fetch(PRICING_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`pricing fetch ${res.status}`);
  const raw = (await res.json()) as Record<string, LiteLLMEntry>;
  const models: Record<string, ModelPricing> = {};
  for (const [key, e] of Object.entries(raw)) {
    if (typeof e?.input_cost_per_token !== "number") continue;
    // Keep the canonical (unprefixed) entries plus the namespaces our sources
    // actually produce: Anthropic, Z.ai and OpenRouter ids. The hundreds of
    // cloud-reseller variants (azure/, bedrock/, vertex_ai/, ...) stay out.
    if (key.includes("/") && !/^(anthropic|zai|openrouter)\//.test(key)) continue;
    models[key.replace(/^anthropic\//, "")] = {
      input: e.input_cost_per_token * 1e6,
      output: (e.output_cost_per_token ?? 0) * 1e6,
      cacheWrite: (e.cache_creation_input_token_cost ?? e.input_cost_per_token * 1.25) * 1e6,
      cacheRead: (e.cache_read_input_token_cost ?? e.input_cost_per_token * 0.1) * 1e6,
    };
  }
  if (Object.keys(models).length === 0) throw new Error("pricing data empty");
  livePricing = { fetchedAt: Date.now(), models };
  writeJsonAtomic(PRICING_CACHE, livePricing);
  if (process.env.CLAUDE_USAGE_VERBOSE) {
    console.log(`Pricing refreshed: ${Object.keys(models).length} models (LiteLLM)`);
  }
}

refreshPricing().catch((err) =>
  console.warn("Live pricing unavailable, using fallback:", (err as Error).message),
);
setInterval(() => refreshPricing().catch(() => {}), 24 * 3600 * 1000).unref();

function pricingFor(model: string): ModelPricing | null {
  // Normalise transcript ids: drop the date suffix and context markers like "[1m]"
  const id = model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
  // Hermes rows carry a "<provider>/<model>" prefix; LiteLLM keys the same
  // model either bare ("gpt-5.5") or under its own namespace ("zai/glm-5.3").
  const bare = id.replace(/^[a-z0-9][\w.-]*\//i, "");
  const candidates = [model, id, bare, `zai/${bare}`, `openrouter/${bare}`];
  for (const c of candidates) {
    const live = livePricing.models[c];
    if (live) return live;
  }
  // Variant suffixes ("gpt-5.6-sol-900k" vs LiteLLM's "gpt-5.6-sol"): take the
  // longest known key the id starts with, provided it is specific enough.
  let best: string | null = null;
  for (const key of Object.keys(livePricing.models)) {
    if (key.length >= 6 && bare.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  if (best) return livePricing.models[best];
  const row = PRICING.find(([m]) => bare.includes(m));
  return row ? { input: row[1], output: row[2], cacheWrite: row[3], cacheRead: row[4] } : null;
}

function cost(model: string, u: Pick<UsageEntry, "input" | "output" | "cacheWrite" | "cacheRead">): number {
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
const fileCache = new Map<string, { mtimeMs: number; size: number; entries: UsageEntry[] }>();

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

async function parseTranscript(filePath: string): Promise<UsageEntry[]> {
  const stat = fs.statSync(filePath);
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.entries;
  }

  const entries = new Map<string, UsageEntry>(); // dedupe key -> entry (letzter Eintrag gewinnt)
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, "utf8"),
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.includes('"usage"')) continue;
    let obj: TranscriptLine;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = obj?.message;
    const usage = msg?.usage;
    // "<synthetic>" sind Claude-Code-Platzhalter (Fehlermeldungen) ohne echte Nutzung
    if (obj?.type !== "assistant" || !usage || !msg?.model || msg.model.startsWith("<")) continue;

    // Streaming schreibt dieselbe Message mehrfach — auf id+requestId dedupen.
    const key = msg.id ? `${msg.id}:${obj.requestId ?? ""}` : `line:${lineNo}`;
    entries.set(key, {
      ts: obj.timestamp ?? "",
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

function localDate(ts: string): string | null {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Ordnernamen wie "E--DEV-LS25-FlowLink" auf das letzte Pfadsegment kürzen.
function projectLabel(dirName: string): string {
  const parts = dirName.split("-").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dirName;
}

interface ExternalUsageFile {
  machine?: string;
  rows: UsageRow[];
}

// Reads every *.json dropped into external-usage/. Each file is expected to
// contain { machine: "work-laptop", rows: UsageRow[] } — the same shape
// `collectUsage()` produces, so any other checkout of this project (or a
// small export script) can just write its own `rows` array verbatim. The
// model id gets namespaced with the source machine so it never collides
// with local rows and stays attributable in the model table/legend.
function collectExternalUsage(): UsageRow[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(EXTERNAL_USAGE_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: UsageRow[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(EXTERNAL_USAGE_DIR, file), "utf8")) as ExternalUsageFile;
      const machine = (parsed.machine || file.replace(/\.json$/, "")).trim() || "remote";
      for (const r of parsed.rows ?? []) {
        if (!r?.date || !r?.model) continue;
        out.push({ ...r, project: r.project || machine, model: `${machine}:${r.model}` });
      }
    } catch (err) {
      console.warn(`Skipping malformed external usage file ${file}:`, (err as Error).message);
    }
  }
  return out;
}

export async function collectUsage() {
  const rows = new Map<string, UsageRow>();
  const sessionsByDay = new Map<string, Set<string>>();

  let projectDirs: fs.Dirent[] = [];
  try {
    projectDirs = fs
      .readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory());
  } catch {
    projectDirs = [];
  }

  for (const dir of projectDirs) {
    const project = projectLabel(dir.name);
    const dirPath = path.join(PROJECTS_DIR, dir.name);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      const sessionId = file.replace(/\.jsonl$/, "");
      let entries: UsageEntry[];
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
        sessionsByDay.get(date)!.add(sessionId);
      }
    }
  }

  // Hermes Agent — a second, independent usage source (its own state.db,
  // its own providers). Rows arrive pre-aggregated per day/provider/model;
  // fold them straight into the same map under a "Hermes Agent" project so
  // every chart/table that already groups by project or model picks them up
  // for free.
  for (const r of await collectHermesUsage()) {
    // Hermes reports $0 for subscription-billed providers (Codex, GLM Coding
    // Plan). Every other row on the dashboard is "list price", so fill those
    // in from the price table too; a real billed amount from Hermes always wins.
    if (r.cost === 0 && r.input + r.output + r.cacheRead + r.cacheWrite > 0) {
      r.cost = cost(r.model, r);
    }
    const key = `${r.date}|${r.project}|${r.model}`;
    rows.set(key, r);
  }

  // Other machines' usage, dropped as JSON files into external-usage/ (see
  // README) — the low-effort multi-PC path: no server, no sync daemon, just
  // sync/copy a file however you like (Syncthing, cloud drive, scp) and the
  // dashboard picks it up on next reload.
  for (const r of collectExternalUsage()) {
    const key = `${r.date}|${r.project}|${r.model}`;
    rows.set(key, r);
  }

  return {
    generatedAt: new Date().toISOString(),
    pricing: {
      source: livePricing.fetchedAt ? "live" : "static",
      fetchedAt: livePricing.fetchedAt || null,
    },
    rows: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)),
    sessions: [...sessionsByDay.entries()]
      .map(([date, set]) => ({ date, count: set.size }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// Plan-Limits (Session/Weekly/Plan-Cycle): jetzt multi-provider — siehe
// providers.ts. Jeder erkannte Provider (Anthropic, Codex, OpenRouter, Z.ai)
// liefert seine eigenen Fenster; Pace-Historie und Predictions bleiben pro
// Provider+Fenster getrennt (Namespace über den Pace-Key).
import { fetchAllProviders, type ProviderSnapshot, type RawWindow } from "./providers.ts";

export interface ProviderLimitsPayload {
  provider: string;
  label: string;
  plan: string | null;
  source: "live" | "unavailable";
  fetchedAtMs: number;
  limits: PredictedLimit[];
  details: string[];
  error?: string;
}

export interface AllProvidersPayload {
  fetchedAtMs: number;
  providers: ProviderLimitsPayload[];
}


// Pace-Historie: regelmäßige Samples der Limit-Prozente, persistiert über Neustarts.
// Keys sind jetzt providerscoped ("anthropic:session", "zai:5h_window", ...),
// damit unterschiedliche Provider mit gleichem `kind` (z. B. beide "session")
// sich nicht die Pace-Historie teilen.
const HISTORY_FILE = path.join(STATE_DIR, "pace-history.json");
const HISTORY_MAX_AGE = 8 * 24 * 3600 * 1000;

interface PaceSample {
  t: number;
  values: Record<string, number>;
}

let paceHistory: PaceSample[] = [];
try {
  paceHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
} catch {}

function limitKey(provider: string, l: RawWindow): string {
  const base = l.scope ? `${l.kind}:${l.scope}` : l.kind;
  return `${provider}:${base}`;
}

// The dashboard daemon, the CLI widget, and a dev checkout can all run at once
// and share this file. Merge what is on disk before writing so no process
// clobbers the samples another one recorded; samples are keyed by timestamp.
function mergeHistoryFromDisk(): void {
  let onDisk: PaceSample[];
  try {
    onDisk = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(onDisk)) return;
  const byTime = new Map<number, PaceSample>(paceHistory.map((s) => [s.t, s]));
  for (const s of onDisk) {
    if (typeof s?.t !== "number" || typeof s?.values !== "object") continue;
    const mine = byTime.get(s.t);
    if (mine) mine.values = { ...s.values, ...mine.values };
    else byTime.set(s.t, s);
  }
  paceHistory = [...byTime.values()].sort((a, b) => a.t - b.t);
}

function recordSample(provider: string, windows: RawWindow[]): void {
  const now = Date.now();
  mergeHistoryFromDisk();
  const last = paceHistory[paceHistory.length - 1];
  const values: Record<string, number> = last && now - last.t < 2 * 60 * 1000 ? { ...last.values } : {};
  for (const l of windows) values[limitKey(provider, l)] = l.percent;
  if (last && now - last.t < 2 * 60 * 1000) {
    last.values = values;
  } else {
    paceHistory.push({ t: now, values });
  }
  paceHistory = paceHistory.filter((s) => now - s.t < HISTORY_MAX_AGE);
  writeJsonAtomic(HISTORY_FILE, paceHistory);
}

// Pace in %/h über ein Zeitfenster; Samples vor einem Limit-Reset
// (Prozentwert fällt deutlich) werden verworfen.
function computePace(
  key: string,
  current: number,
  windowMs: number,
): { pace: number; spanHours: number } | null {
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

// "session"-artige Fenster (kurzer Reset-Zyklus) bekommen die lineare
// Kurzfrist-Fortschreibung; alles andere (weekly/plan-cycle) den 72h-Ø.
const SHORT_WINDOW_KINDS = new Set(["session", "5h_window"]);

function withPredictions(provider: string, windows: RawWindow[]): PredictedLimit[] {
  return windows.map((l) => {
    const isSession = SHORT_WINDOW_KINDS.has(l.kind);
    const windowMs = isSession ? 3 * 3600 * 1000 : 72 * 3600 * 1000;
    const key = limitKey(provider, l);
    const result = computePace(key, l.percent, windowMs);
    const pace = result == null || (!isSession && result.spanHours < 12) ? null : result.pace;
    const resetMs = l.resetsAt ? Date.parse(l.resetsAt) : null;

    let exhaustsAtMs: number | null = null;
    let projectedAtReset: number | null = null;
    if (pace != null && pace > 0.01 && l.percent < 100) {
      exhaustsAtMs = Date.now() + ((100 - l.percent) / pace) * 3600000;
      if (resetMs != null) {
        projectedAtReset = Math.round(l.percent + pace * ((resetMs - Date.now()) / 3600000));
      }
    }
    const limitInfo: LimitInfo = {
      kind: l.kind,
      percent: l.percent,
      severity: l.severity,
      resetsAt: l.resetsAt,
      scope: l.scope,
      note: l.note ?? null,
    };
    return {
      ...limitInfo,
      isSession,
      pacePerHour: pace,
      exhaustsAtMs,
      exhaustsBeforeReset:
        isSession && exhaustsAtMs != null && resetMs != null ? exhaustsAtMs < resetMs : false,
      projectedAtReset,
    };
  });
}

// Letzter guter Multi-Provider-Stand, auf Disk persistiert — überlebt
// Server-Neustarts, damit ein Cooldown/Fehler nicht auf uralte Daten zurückwirft.
const LIMITS_CACHE = path.join(STATE_DIR, "limits-cache.json");

let liveLimitsCache: { at: number; data: AllProvidersPayload | null } = { at: 0, data: null };

try {
  const saved = JSON.parse(fs.readFileSync(LIMITS_CACHE, "utf8")) as AllProvidersPayload;
  // Trust a fresh on-disk snapshot: a restart (or the CLI and the dashboard
  // starting together) must not hammer the provider endpoints again.
  liveLimitsCache = { at: saved.fetchedAtMs ?? 0, data: saved };
} catch {}

function rawWindows(p: ProviderLimitsPayload): RawWindow[] {
  return p.limits.map((l) => ({
    kind: l.kind,
    percent: l.percent,
    severity: l.severity,
    resetsAt: l.resetsAt,
    scope: l.scope,
    note: l.note ?? null,
  }));
}

async function fetchAllLimits(): Promise<AllProvidersPayload> {
  const snapshots = await fetchAllProviders();
  const previous = liveLimitsCache.data?.providers ?? [];
  const providers: ProviderLimitsPayload[] = snapshots.map((s) => {
    if (s.source === "live") recordSample(s.provider, s.windows);
    // A provider that failed right now (429 after a restart, a flaky network)
    // keeps showing its last known windows from the previous snapshot rather
    // than an empty card. The unavailable flag and error still say it is stale.
    const last = s.source !== "live" && s.windows.length === 0
      ? previous.find((p) => p.provider === s.provider && p.limits.length > 0)
      : undefined;
    const windows = last ? rawWindows(last) : s.windows;
    return {
      provider: s.provider,
      label: s.label,
      plan: s.plan ?? last?.plan ?? null,
      source: s.source,
      fetchedAtMs: last ? last.fetchedAtMs : s.fetchedAtMs,
      limits: withPredictions(s.provider, windows),
      details: s.details.length ? s.details : last?.details ?? [],
      error: s.error,
    };
  });
  const data: AllProvidersPayload = { fetchedAtMs: Date.now(), providers };
  liveLimitsCache = { at: Date.now(), data };
  writeJsonAtomic(LIMITS_CACHE, data);
  return data;
}

// Keep sampling without an open dashboard so the pace history stays dense.
// Skip the startup fetch when the on-disk snapshot is younger than a minute.
setInterval(() => fetchAllLimits().catch(() => {}), 5 * 60 * 1000).unref();
if (Date.now() - liveLimitsCache.at >= 60_000) fetchAllLimits().catch(() => {});

// Aktuellster verfügbarer Multi-Provider-Stand: live (max. alle 60s neu
// abgefragt), sonst der letzte gute Cache-Snapshot mit frisch berechneten
// Predictions (Pace-Historie kann sich seither weiterentwickelt haben).
export async function getAllLimits(): Promise<AllProvidersPayload> {
  if (Date.now() - liveLimitsCache.at < 60_000 && liveLimitsCache.data) {
    return liveLimitsCache.data;
  }
  try {
    return await fetchAllLimits();
  } catch {
    if (liveLimitsCache.data) {
      return {
        ...liveLimitsCache.data,
        providers: liveLimitsCache.data.providers.map((p) => ({
          ...p,
          limits: withPredictions(p.provider, rawWindows(p)),
        })),
      };
    }
    return { fetchedAtMs: Date.now(), providers: [] };
  }
}

// Legacy single-provider shape, kept for the CLI widget / anything still on
// the old contract — derived from getAllLimits() so there's one source of
// truth. Prefers Anthropic (the original default) if present, else the
// first live provider.
export async function getLimits(): Promise<LimitsPayload | null> {
  const all = await getAllLimits();
  if (!all.providers.length) return null;
  const preferred =
    all.providers.find((p) => p.provider === "anthropic" && p.source === "live") ??
    all.providers.find((p) => p.source === "live") ??
    all.providers[0];
  if (!preferred || !preferred.limits.length) return null;
  return {
    fetchedAtMs: preferred.fetchedAtMs,
    source: preferred.source === "live" ? "live" : "cache",
    plan: preferred.plan,
    limits: preferred.limits,
  };
}

