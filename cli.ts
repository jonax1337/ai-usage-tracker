#!/usr/bin/env node
// claude-usage — CLI entry point.
//
//   claude-usage            live terminal widget (limits, pace, today's cost)
//   claude-usage serve      run the web dashboard in the foreground
//   claude-usage start      run the web dashboard as a background daemon
//   claude-usage stop       stop the background daemon
//   claude-usage status     show whether the daemon is running

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectUsage, getLimits, STATE_DIR, type PredictedLimit } from "./lib.ts";

const REFRESH_MS = 30_000;
const PORT = Number(process.env.PORT) || 3789;
const PID_FILE = path.join(STATE_DIR, "server.pid");
const LOG_FILE = path.join(STATE_DIR, "server.log");

// Works both in dev (cli.ts → server.ts) and packaged (dist/cli.js → dist/server.js)
const OWN_PATH = fileURLToPath(import.meta.url);
const SERVER_ENTRY = path.join(path.dirname(OWN_PATH), `server${path.extname(OWN_PATH)}`);

// ANSI helpers — no dependencies
const ESC = "\x1b[";
const reset = `${ESC}0m`;
const dim = (s: string) => `${ESC}2m${s}${reset}`;
const bold = (s: string) => `${ESC}1m${s}${reset}`;
const fg = (color: number, s: string) => `${ESC}38;5;${color}m${s}${reset}`;

const GREEN = 34;
const YELLOW = 214;
const RED = 160;

const fmtCost = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtTokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

const LIMIT_NAMES: Record<string, string> = {
  session: "Session (5 h)",
  weekly_all: "Week · all",
  weekly_scoped: "Week",
};

// ---------- daemon management ----------

function runningPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    if (!pid) return null;
    process.kill(pid, 0); // throws if the process is gone
    return pid;
  } catch {
    return null;
  }
}

function daemonStart(): void {
  const existing = runningPid();
  if (existing) {
    console.log(`Already running (pid ${existing}) → http://localhost:${PORT}`);
    return;
  }
  const log = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`Dashboard started (pid ${child.pid}) → http://localhost:${PORT}`);
  console.log(`Logs: ${LOG_FILE}`);
}

function daemonStop(): void {
  const pid = runningPid();
  if (!pid) {
    console.log("Not running.");
    return;
  }
  process.kill(pid);
  fs.rmSync(PID_FILE, { force: true });
  console.log(`Stopped (pid ${pid}).`);
}

function daemonStatus(): void {
  const pid = runningPid();
  console.log(pid ? `Running (pid ${pid}) → http://localhost:${PORT}` : "Not running.");
}

// ---------- live terminal widget ----------

function limitColor(l: PredictedLimit): number {
  if (l.severity !== "normal" || l.percent >= 90) return RED;
  if (l.percent >= 70) return YELLOW;
  return GREEN;
}

function bar(percent: number, color: number, width = 24): string {
  const filled = Math.round((Math.min(percent, 100) / 100) * width);
  return fg(color, "█".repeat(filled)) + dim("░".repeat(width - filled));
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `~${fmtTime(ms)}` : `${d.toLocaleDateString("en-US", { weekday: "short" })} ~${fmtTime(ms)}`;
}

function predictionLine(l: PredictedLimit): string {
  if (l.pacePerHour == null) {
    return dim(l.isSession ? "measuring pace …" : "measuring avg pace (needs ~12 h of history)");
  }
  if (l.pacePerHour <= 0.01) return dim("no meaningful usage right now");
  if (l.isSession) {
    const pace = `${l.pacePerHour.toFixed(1)} %/h`;
    return l.exhaustsBeforeReset && l.exhaustsAtMs != null
      ? fg(YELLOW, `${pace} · exhausted ${fmtWhen(l.exhaustsAtMs)}, before reset`)
      : dim(`${pace} · lasts until reset`);
  }
  const pace = `avg ${l.pacePerHour.toFixed(1)} %/h`;
  if (l.projectedAtReset == null) return dim(pace);
  return l.projectedAtReset >= 100 && l.exhaustsAtMs != null
    ? fg(YELLOW, `${pace} · projected to hit limit ${fmtWhen(l.exhaustsAtMs)}`)
    : dim(`${pace} · projected ~${l.projectedAtReset}% at reset`);
}

function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function frame(): Promise<string> {
  const [limits, usage] = await Promise.all([getLimits(), collectUsage()]);
  const lines: string[] = [];
  const now = new Date().toLocaleTimeString("en-US");

  const status = limits?.source === "live" ? fg(GREEN, "● live") : fg(YELLOW, "● cached");
  lines.push(`${bold("Claude Usage Tracker")}  ${limits?.plan ? dim(limits.plan + " · ") : ""}${status} ${dim(now)}`);
  lines.push("");

  if (limits) {
    for (const l of limits.limits as PredictedLimit[]) {
      const name = (LIMIT_NAMES[l.kind] ?? l.kind) + (l.scope ? ` · ${l.scope}` : "");
      const pct = `${String(l.percent).padStart(3)}%`;
      const resetsAt = l.resetsAt ? dim(`resets ${fmtWhen(Date.parse(l.resetsAt))}`) : "";
      lines.push(`  ${name.padEnd(18)} ${bar(l.percent, limitColor(l))} ${bold(pct)}  ${resetsAt}`);
      lines.push(`  ${" ".repeat(18)} ${predictionLine(l)}`);
    }
  } else {
    lines.push(dim("  no limit data available"));
  }

  const today = localToday();
  const rows = usage.rows.filter((r) => r.date === today);
  const cost = rows.reduce((a, r) => a + r.cost, 0);
  const tokens = rows.reduce((a, r) => a + r.input + r.output + r.cacheRead + r.cacheWrite, 0);
  lines.push("");
  lines.push(`  ${dim("Today")}  ${bold(fmtCost.format(cost))} ${dim("list price")} · ${bold(fmtTokens.format(tokens))} ${dim("tokens")}`);
  lines.push("");
  lines.push(dim(`  refreshes every ${REFRESH_MS / 1000} s · Ctrl+C to quit`));
  return lines.join("\n");
}

async function widget(): Promise<void> {
  let lastHeight = 0;

  const tick = async (): Promise<void> => {
    let out: string;
    try {
      out = await frame();
    } catch (err) {
      out = fg(RED, `Error: ${(err as Error).message}`);
    }
    // Redraw in place: move cursor up over the previous frame, clear below
    if (lastHeight > 0) process.stdout.write(`${ESC}${lastHeight}A`);
    process.stdout.write(`${ESC}0J` + out + "\n");
    lastHeight = out.split("\n").length + 1;
  };

  process.stdout.write(`${ESC}?25l`); // hide cursor
  const restore = () => {
    process.stdout.write(`${ESC}?25h`); // show cursor
    process.exit(0);
  };
  process.on("SIGINT", restore);
  process.on("SIGTERM", restore);

  await tick();
  setInterval(tick, REFRESH_MS);
}

// ---------- dispatch ----------

const HELP = `claude-usage — local Claude Code usage tracker

Usage:
  claude-usage            live terminal widget (limits, pace, today's cost)
  claude-usage serve      run the web dashboard in the foreground
  claude-usage start      run the web dashboard as a background daemon
  claude-usage stop       stop the background daemon
  claude-usage status     show whether the daemon is running

Dashboard: http://localhost:${PORT}  (PORT env var to change)
State dir: ${STATE_DIR}`;

const command = process.argv[2] ?? "";
switch (command) {
  case "":
  case "widget":
    await widget();
    break;
  case "serve":
    await import("./server.ts");
    break;
  case "start":
    daemonStart();
    break;
  case "stop":
    daemonStop();
    break;
  case "status":
    daemonStatus();
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP);
    process.exitCode = 1;
}
