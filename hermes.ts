// Hermes Agent usage source — reads session_model_usage from Hermes's local
// state.db (read-only) and maps it into the same UsageRow shape the Claude
// Code transcript reader produces, so both sources render on one dashboard.
//
// Hermes tracks usage per (session, model, billing_provider, task) across
// EVERY provider it talks to (Anthropic, zai, openai-codex, openrouter, ...),
// not just Claude Code. Anthropic models use the exact same raw model id as
// Claude Code CLI transcripts, so we pass those through unprefixed and let
// them merge into one row at the model level (cost/tokens for e.g.
// "claude-sonnet-5" add up regardless of which of the two produced them).
// The source distinction still lives at the project/row level ("Hermes
// Agent" vs. a real project name), just not baked into the model id anymore.
// Non-Anthropic providers can never collide with a Claude Code model id, so
// they keep a "<provider>/<model>" prefix for clarity in the model table.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { UsageRow } from "./lib.ts";

function defaultHermesHome(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "hermes");
  }
  return path.join(os.homedir(), ".hermes");
}

export const HERMES_HOME = (process.env.HERMES_HOME || "").trim() || defaultHermesHome();
const STATE_DB = path.join(HERMES_HOME, "state.db");

export function hermesAvailable(): boolean {
  return fs.existsSync(STATE_DB);
}

interface UsageRowDb {
  date: string; // YYYY-MM-DD, local time, derived from first_seen
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost: number;
}

function localDate(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Lazily import node:sqlite — only Node >= 22.5 (experimental) / >= 23 (stable)
// has it. Older runtimes simply get no Hermes rows instead of a crash.
async function openDb(): Promise<any | null> {
  try {
    const sqlite = await import("node:sqlite");
    return new sqlite.DatabaseSync(STATE_DB, { readOnly: true });
  } catch (err) {
    console.warn("Hermes usage unavailable (node:sqlite):", (err as Error).message);
    return null;
  }
}

// Per-file mtime cache, mirroring the transcript reader's approach — a busy
// state.db (Hermes writes on every turn) shouldn't mean re-scanning on every
// dashboard poll.
let cache: { mtimeMs: number; size: number; rows: UsageRow[] } | null = null;

export async function collectHermesUsage(): Promise<UsageRow[]> {
  if (!hermesAvailable()) return [];
  let stat: fs.Stats;
  try {
    stat = fs.statSync(STATE_DB);
  } catch {
    return [];
  }
  if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.rows;
  }

  const db = await openDb();
  if (!db) return [];
  try {
    const raw = db
      .prepare(
        `SELECT model, billing_provider, task, api_call_count,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                estimated_cost_usd, actual_cost_usd, first_seen
         FROM session_model_usage
         WHERE model NOT LIKE '<%'`,
      )
      .all() as UsageRowDb extends never ? any[] : any[];

    // Aggregate by day+provider+model, same grain as the Claude Code side —
    // "project" doubles as a source/provider label here since Hermes has no
    // per-project transcript concept.
    const byKey = new Map<string, UsageRow>();
    for (const r of raw) {
      if (!r.first_seen) continue;
      const date = localDate(r.first_seen);
      const provider = String(r.billing_provider || "unknown");
      const model = String(r.model);
      // Anthropic models are verified to use identical raw model ids between
      // Hermes and the Claude Code CLI transcripts — pass through unprefixed
      // so they merge into one row. Other providers keep a prefix since
      // Claude Code never produces those model ids (no collision risk either
      // way, but the prefix keeps e.g. zai/glm-5.3 legible in the model table).
      const modelKey = provider.toLowerCase() === "anthropic" ? model : `${provider}/${model}`;
      const key = `${date}|${modelKey}`;
      let row = byKey.get(key);
      if (!row) {
        row = {
          date,
          project: "Hermes Agent",
          model: modelKey,
          input: 0,
          cacheWrite: 0,
          cacheRead: 0,
          output: 0,
          cost: 0,
        };
        byKey.set(key, row);
      }
      row.input += Number(r.input_tokens) || 0;
      row.cacheWrite += Number(r.cache_write_tokens) || 0;
      row.cacheRead += Number(r.cache_read_tokens) || 0;
      row.output += Number(r.output_tokens) || 0;
      // actual_cost_usd wins when the provider reports real billed cost;
      // Hermes falls back to its own estimate otherwise (mirrors billing_usage.py).
      row.cost += Number(r.actual_cost_usd) || Number(r.estimated_cost_usd) || 0;
    }

    const rows = [...byKey.values()];
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, rows };
    return rows;
  } catch (err) {
    console.warn("Failed to read Hermes state.db:", (err as Error).message);
    return [];
  } finally {
    db.close();
  }
}
