// providers.ts — multi-provider AI usage/limit detection.
//
// Auto-detects which AI subscriptions/API credentials are actually present
// on this machine (Claude Code OAuth, OpenAI Codex/ChatGPT OAuth, OpenRouter
// API key, Z.ai/GLM Coding Plan API key) and fetches live rate-limit/quota
// data from each provider's own usage endpoint — the same ones their
// official clients (Claude Code, Codex CLI, ZCode) use internally.
//
// Adding a new provider = adding one entry to PROVIDERS with a detect() and
// fetch() function. Everything else (pace history, predictions, rendering)
// is generic across providers.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface RawWindow {
  kind: string; // e.g. "session", "weekly_all", "5h", "plan_cycle"
  percent: number; // 0-100
  severity: string; // "normal" | anything else = attention-worthy
  resetsAt: string | null; // ISO timestamp
  scope: string | null; // stable qualifier, e.g. a model display name; part of the pace-history key
  note: string | null; // volatile human-readable extra, e.g. "59,378 of 60,000 left"; never keyed on
}

export interface ProviderSnapshot {
  provider: string; // stable id: "anthropic" | "openai-codex" | "openrouter" | "zai"
  label: string; // display name
  plan: string | null;
  source: "live" | "unavailable";
  fetchedAtMs: number;
  windows: RawWindow[];
  details: string[]; // free-text extras (credits balance, banked resets, ...)
  error?: string;
}

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

function readJson<T = any>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function defaultHermesHome(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "hermes");
  }
  return path.join(os.homedir(), ".hermes");
}

// Env vars for provider API keys can live in the real shell environment, or
// (very commonly on a Hermes Agent box) only in Hermes's own `.env` file,
// which isn't sourced into this process's environment. Check both.
let hermesEnvCache: Record<string, string> | null = null;
function readHermesEnv(): Record<string, string> {
  if (hermesEnvCache) return hermesEnvCache;
  hermesEnvCache = {};
  const candidates = [
    process.env.HERMES_HOME ? path.join(process.env.HERMES_HOME, ".env") : null,
    path.join(defaultHermesHome(), ".env"),
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    try {
      const text = fs.readFileSync(p, "utf8");
      for (const rawLine of text.split("\n")) {
        const line = rawLine.replace(/\r$/, "");
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) hermesEnvCache[m[1]] = m[2].trim();
      }
      break; // first readable file wins
    } catch {}
  }
  return hermesEnvCache;
}

function envVar(name: string): string | null {
  const fromProcess = process.env[name]?.trim();
  if (fromProcess) return fromProcess;
  const fromHermes = readHermesEnv()[name]?.trim();
  return fromHermes || null;
}

// ---------------------------------------------------------------------------
// Anthropic (Claude Code OAuth) — api.anthropic.com/api/oauth/usage
// ---------------------------------------------------------------------------

const CLAUDE_CREDENTIALS = path.join(os.homedir(), ".claude", ".credentials.json");

// Per-provider 429 backoff (ms-timestamp until which live fetches are skipped).
// The usage endpoints rate-limit aggressive pollers hard; without backoff one
// 429 (e.g. while the dashboard and a CLI refresh overlap) poisons every
// subsequent fetch for the rest of the process lifetime.
const providerCooldowns = new Map<string, number>();
const COOLDOWN_429_MS = 5 * 60 * 1000;
const COOLDOWN_ERR_MS = 2 * 60 * 1000;

function inCooldown(provider: string): boolean {
  const until = providerCooldowns.get(provider) ?? 0;
  return Date.now() < until;
}

function setCooldown(provider: string, ms: number): void {
  providerCooldowns.set(provider, Date.now() + ms);
}

// A detected provider that is currently backing off still exists: return an
// "unavailable" snapshot so the dashboard keeps its row (lib.ts fills in the
// last known windows) instead of dropping the provider until the cooldown ends.
function coolingDown(provider: string, label: string): ProviderSnapshot {
  return {
    provider,
    label,
    plan: null,
    source: "unavailable",
    fetchedAtMs: Date.now(),
    windows: [],
    details: [],
    error: "cooldown (rate-limited)",
  };
}

function planLabel(tier: string | null | undefined): string | null {
  return (
    (tier ?? "")
      .replace(/^default_claude_/, "")
      .replace(/_(\d+)x$/, " $1×")
      .replace(/^\w/, (c) => c.toUpperCase()) || null
  );
}

async function fetchAnthropic(): Promise<ProviderSnapshot | null> {
  const creds = readJson<any>(CLAUDE_CREDENTIALS);
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.accessToken) return null; // not detected on this machine
  if (inCooldown("anthropic")) return coolingDown("anthropic", "Claude (Anthropic)");
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      if (res.status === 429) setCooldown("anthropic", COOLDOWN_429_MS);
      throw new Error(`HTTP ${res.status}`);
    }
    const j = (await res.json()) as { limits?: any[] };
    const windows: RawWindow[] = (j.limits ?? []).map((l) => ({
      kind: l.kind,
      percent: l.percent,
      severity: l.severity,
      resetsAt: l.resets_at ?? null,
      scope: l.scope?.model?.display_name ?? null,
      note: null,
    }));
    return {
      provider: "anthropic",
      label: "Claude (Anthropic)",
      plan: planLabel(oauth.rateLimitTier),
      source: "live",
      fetchedAtMs: Date.now(),
      windows,
      details: [],
    };
  } catch (err) {
    return {
      provider: "anthropic",
      label: "Claude (Anthropic)",
      plan: null,
      source: "unavailable",
      fetchedAtMs: Date.now(),
      windows: [],
      details: [],
      error: (err as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// OpenAI Codex (ChatGPT OAuth) — chatgpt.com/backend-api/wham/usage
// ---------------------------------------------------------------------------

const CODEX_AUTH = path.join(os.homedir(), ".codex", "auth.json");

// OpenAI reports plan tiers as lowercase internal ids ("prolite" is the tier
// between Plus and Pro). Map the known ones to their marketing names.
const CODEX_PLANS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  prolite: "Pro Lite",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

function titleCase(s: string | null | undefined): string | null {
  const cleaned = (s ?? "").trim();
  if (!cleaned) return null;
  return CODEX_PLANS[cleaned.toLowerCase()] ?? cleaned.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Codex names its windows "primary"/"secondary" and only the length tells what
// they are: the rolling 5-hour window, the weekly window, or (on some plans)
// something else. Label by duration so a lone weekly window is never shown as
// a session, and keep the well-known kinds stable for pace history.
function codexWindowKind(w: any, fallback: "session" | "weekly"): string {
  const seconds = typeof w?.limit_window_seconds === "number" ? w.limit_window_seconds : null;
  const minutes =
    seconds != null && seconds > 0
      ? seconds / 60
      : typeof w?.window_minutes === "number" && w.window_minutes > 0
        ? w.window_minutes
        : null;
  if (minutes == null) return fallback;
  if (minutes <= 6 * 60) return "session";
  if (minutes >= 6 * 24 * 60 && minutes <= 8 * 24 * 60) return "weekly";
  const hours = Math.round(minutes / 60);
  return hours % 24 === 0 ? `${hours / 24}d_window` : `${hours}h_window`;
}

function unixSecToIso(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return new Date(v * 1000).toISOString();
}

async function fetchCodex(): Promise<ProviderSnapshot | null> {
  const auth = readJson<any>(CODEX_AUTH);
  const accessToken = auth?.tokens?.access_token;
  if (!accessToken) return null;
  const accountId = auth?.tokens?.account_id as string | undefined;
  if (inCooldown("openai-codex")) return coolingDown("openai-codex", "Codex (OpenAI)");
  try {
    const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "codex-cli",
        ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      if (res.status === 429) setCooldown("openai-codex", COOLDOWN_429_MS);
      throw new Error(`HTTP ${res.status}`);
    }
    const j = (await res.json()) as any;
    const rateLimit = j.rate_limit ?? {};
    const windows: RawWindow[] = [];
    for (const [key, fallbackKind] of [
      ["primary_window", "session"],
      ["secondary_window", "weekly"],
    ] as const) {
      const w = rateLimit[key];
      if (w?.used_percent == null) continue;
      windows.push({
        kind: codexWindowKind(w, fallbackKind),
        percent: Number(w.used_percent),
        severity: "normal",
        resetsAt: unixSecToIso(w.reset_at),
        scope: null,
        note: null,
      });
    }
    const details: string[] = [];
    const banked = j.rate_limit_reset_credits?.available_count;
    if (typeof banked === "number" && banked > 0) {
      details.push(`${banked} banked reset${banked === 1 ? "" : "s"}, redeem with /usage reset in the Codex CLI`);
    }
    const credits = j.credits;
    if (credits?.has_credits) {
      if (typeof credits.balance === "number") details.push(`$${credits.balance.toFixed(2)} in credits`);
      else if (credits.unlimited) details.push("Unlimited credits");
    }
    return {
      provider: "openai-codex",
      label: "Codex (OpenAI)",
      plan: titleCase(j.plan_type),
      source: "live",
      fetchedAtMs: Date.now(),
      windows,
      details,
    };
  } catch (err) {
    return {
      provider: "openai-codex",
      label: "Codex (OpenAI)",
      plan: null,
      source: "unavailable",
      fetchedAtMs: Date.now(),
      windows: [],
      details: [],
      error: (err as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// OpenRouter — openrouter.ai/api/v1/credits (+ /key for a scoped-key limit)
// ---------------------------------------------------------------------------

async function fetchOpenRouter(): Promise<ProviderSnapshot | null> {
  const key = envVar("OPENROUTER_API_KEY");
  if (!key) return null;
  if (inCooldown("openrouter")) return coolingDown("openrouter", "OpenRouter");
  try {
    const headers = { Authorization: `Bearer ${key}` };
    const [creditsRes, keyRes] = await Promise.all([
      fetch("https://openrouter.ai/api/v1/credits", { headers, signal: AbortSignal.timeout(8000) }),
      fetch("https://openrouter.ai/api/v1/key", { headers, signal: AbortSignal.timeout(8000) }).catch(() => null),
    ]);
    if (!creditsRes.ok) {
      if (creditsRes.status === 429) setCooldown("openrouter", COOLDOWN_429_MS);
      throw new Error(`HTTP ${creditsRes.status}`);
    }
    const credits = ((await creditsRes.json()) as any)?.data ?? {};
    const total = Number(credits.total_credits) || 0;
    const used = Number(credits.total_usage) || 0;
    const remaining = Math.max(0, total - used);
    const details: string[] = [];
    // Prepaid credits are a quota too: show them as a window so the dashboard
    // renders a meter (share of credits used) instead of a bare text line.
    const windows: RawWindow[] = [];
    if (total > 0) {
      windows.push({
        kind: "credits",
        percent: Math.min(100, Math.round((used / total) * 1000) / 10),
        severity: "normal",
        resetsAt: null,
        scope: null,
        note: `$${remaining.toFixed(2)} of $${total.toFixed(2)} left`,
      });
    } else {
      details.push("No credits purchased yet");
    }
    if (keyRes?.ok) {
      const keyData = ((await keyRes.json()) as any)?.data ?? {};
      const limit = keyData.limit;
      const limitRemaining = keyData.limit_remaining;
      if (typeof limit === "number" && limit > 0 && typeof limitRemaining === "number") {
        const usedPct = ((limit - limitRemaining) / limit) * 100;
        windows.push({
          kind: "api_key_quota",
          percent: Math.round(usedPct),
          severity: "normal",
          resetsAt: keyData.limit_reset ?? null,
          scope: null,
          note: `$${limitRemaining.toFixed(2)} of $${limit.toFixed(2)} left`,
        });
      }
    }
    return {
      provider: "openrouter",
      label: "OpenRouter",
      plan: null,
      source: "live",
      fetchedAtMs: Date.now(),
      windows,
      details,
    };
  } catch (err) {
    return {
      provider: "openrouter",
      label: "OpenRouter",
      plan: null,
      source: "unavailable",
      fetchedAtMs: Date.now(),
      windows: [],
      details: [],
      error: (err as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// Z.ai / GLM Coding Plan — api.z.ai/api/monitor/usage/quota/limit
// (same endpoint the ZCode desktop client uses)
// ---------------------------------------------------------------------------

async function fetchZai(): Promise<ProviderSnapshot | null> {
  const key = envVar("GLM_API_KEY") || envVar("ZAI_API_KEY");
  if (!key) return null;
  if (inCooldown("zai")) return coolingDown("zai", "Z.ai / GLM Coding Plan");
  try {
    const res = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      if (res.status === 429) setCooldown("zai", COOLDOWN_429_MS);
      throw new Error(`HTTP ${res.status}`);
    }
    const j = (await res.json()) as any;
    if (!j?.success || !j?.data) throw new Error("unexpected response shape");
    const limits: any[] = j.data.limits ?? [];
    const sorted = [...limits].sort((a, b) => (a.nextResetTime ?? 0) - (b.nextResetTime ?? 0));
    const windowLabels = ["5h_window", "plan_cycle"];
    const fmtInt = new Intl.NumberFormat("en-US");
    const windows: RawWindow[] = sorted.map((l, i) => ({
      kind: windowLabels[i] ?? `window_${i + 1}`,
      percent: Number(l.percentage) || 0,
      severity: "normal",
      resetsAt: l.nextResetTime ? new Date(l.nextResetTime).toISOString() : null,
      // The remaining/total counts change with every call, so they must not be
      // part of the pace-history key (scope). They go into the display-only note.
      scope: null,
      note:
        typeof l.remaining === "number" && typeof l.usage === "number"
          ? `${fmtInt.format(l.remaining)} of ${fmtInt.format(l.usage)} left`
          : null,
    }));
    return {
      provider: "zai",
      label: "Z.ai / GLM Coding Plan",
      plan: titleCase(j.data.level),
      source: "live",
      fetchedAtMs: Date.now(),
      windows,
      details: [],
    };
  } catch (err) {
    return {
      provider: "zai",
      label: "Z.ai / GLM Coding Plan",
      plan: null,
      source: "unavailable",
      fetchedAtMs: Date.now(),
      windows: [],
      details: [],
      error: (err as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// Registry — add a new provider by adding one entry here.
// ---------------------------------------------------------------------------

const FETCHERS: Array<() => Promise<ProviderSnapshot | null>> = [
  fetchAnthropic,
  fetchCodex,
  fetchOpenRouter,
  fetchZai,
];

// Fetches every provider in parallel. A provider whose credentials aren't
// present on this machine is silently omitted (never detected = never
// shown, no noise). A provider WITH credentials whose live call fails still
// shows up with source: "unavailable" so a real outage/auth problem is
// visible instead of silently vanishing.
export async function fetchAllProviders(): Promise<ProviderSnapshot[]> {
  const results = await Promise.all(FETCHERS.map((fn) => fn().catch(() => null)));
  const snapshots = results.filter((r): r is ProviderSnapshot => r !== null);
  // A provider whose fetch threw outright (not the handled unavailable path)
  // would vanish; keep its last good snapshot visible, flagged as unavailable.
  for (const prev of lastGoodSnapshots.values()) {
    if (!snapshots.some((s) => s.provider === prev.provider)) {
      snapshots.push({ ...prev, source: "unavailable", error: "unreachable" });
    }
  }
  for (const s of snapshots) {
    if (s.source === "live") lastGoodSnapshots.set(s.provider, s);
  }
  return snapshots;
}

const lastGoodSnapshots = new Map<string, ProviderSnapshot>();
