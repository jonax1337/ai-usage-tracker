# Claude Usage Tracker

A local, zero-dependency dashboard for your [Claude Code](https://claude.com/claude-code) (and, optionally, [Hermes Agent](https://github.com/NousResearch/hermes-agent)) token usage, costs, and plan limits — with live updates, pace predictions, and a floating picture-in-picture widget.

![Node.js >= 23.6](https://img.shields.io/badge/node-%3E%3D23.6-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![No runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)

![Dashboard](docs/screenshot.png)

## Features

- **Usage analytics** — daily cost per model as a stacked bar chart, plus breakdowns by project and model, computed from your local Claude Code transcripts
- **Multi-provider live plan limits** — auto-detects every AI subscription/API credential present on the machine (Claude Code/Anthropic, OpenAI Codex/ChatGPT, OpenRouter, Z.ai/GLM Coding Plan) and shows each one's live rate-limit windows with progress meters, side by side — no manual config, a provider only appears once its credentials are found on disk
- **Pace predictions** — burn rate per limit window and an estimate of when it runs out, per provider. Short windows (session, 5h) use a tight recent window ("at this pace, exhausted at ~09:50"), longer windows (weekly, plan cycle) use a 72-hour average including idle time
- **Real-time updates** — a file watcher on `~/.claude/projects` pushes changes to the browser via Server-Sent Events; the chart ticks while your sessions run
- **Popout widget** — a compact always-on-top mini window via the Document Picture-in-Picture API (Chromium). Grows responsively: wider windows reveal reset times and stat tiles
- **CLI mode** — `npm run cli` renders the same limits, pace, and today's cost as a self-refreshing terminal widget
- **Light & dark** — follows your system theme, with an accessible, CVD-safe chart palette
- **Live pricing** — model prices are fetched from the community-maintained [LiteLLM price database](https://github.com/BerriAI/litellm) (daily refresh, disk-cached), with a built-in table as fallback
- **Zero runtime dependencies** — TypeScript, run natively by Node.js (type stripping). No frameworks, no build step for the server, nothing phoning home

## Install

```bash
npm install -g claude-code-usage-tracker
```

That gives you the `claude-usage` command:

```bash
claude-usage            # live terminal widget (limits, pace, today's cost)
claude-usage serve      # web dashboard in the foreground
claude-usage start      # web dashboard as a background daemon
claude-usage stop       # stop the daemon
claude-usage status     # is the daemon running?
```

Open **http://localhost:3789** once the dashboard runs (`PORT` env var to change). State and logs live in `~/.claude-usage-tracker/`.

Requirements: Node.js ≥ 20 and a machine where Claude Code has been used (transcripts in `~/.claude/projects`).

### From source

```bash
git clone https://github.com/jonax1337/claude-usage-tracker.git
cd claude-usage-tracker
npm start               # Node >= 23.6 (runs the .ts natively)
```

## How it works

| Data | Source |
|---|---|
| Tokens & costs (Claude Code CLI) | `~/.claude/projects/**/*.jsonl` — Claude Code's session transcripts. Each assistant message carries a `usage` block (input, output, cache read/write tokens). Costs are computed at public API list prices, so they are informative even on a subscription plan. |
| Tokens & costs (Hermes Agent) | `session_model_usage` in Hermes's own `state.db` (`~/.hermes` or `%LOCALAPPDATA%\hermes`, `HERMES_HOME` env var respected), read-only. Hermes tracks every provider it bills against — Anthropic, zai, OpenAI-Codex, OpenRouter, whatever you've configured. Anthropic models (Claude, Opus, Sonnet, Fable) use the exact same model id Claude Code CLI transcripts use, so usage from both sources merges into one row per model — a Sonnet session run through Hermes and one run through the CLI show up as a single, combined cost/token total. Non-Anthropic providers (which Claude Code CLI can never produce) keep a `<provider>/<model>` prefix for clarity. The *source* (Claude Code CLI vs. Hermes Agent) stays visible in the "By project / source" table regardless. Requires Node ≥ 22.5 (`node:sqlite`); on older Node this source is skipped, everything else keeps working. |
| Tokens & costs (other machines) | Optional JSON files dropped into `~/.claude-usage-tracker/external-usage/*.json` — see "Multi-machine usage" below. |
| Plan limits | `https://api.anthropic.com/api/oauth/usage`, authenticated with the OAuth token Claude Code stores in `~/.claude/.credentials.json`. Falls back to Claude Code's own cache in `~/.claude.json` if the live fetch fails. |
| Pace history | Sampled every 5 minutes and persisted to `pace-history.json` (gitignored) so predictions survive restarts. |
| Model pricing | [LiteLLM price database](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json), refreshed daily and cached to `pricing-cache.json` (gitignored). Falls back to a built-in table when offline. |

The server parses transcripts with per-file mtime caching and deduplicates streaming entries by message ID, so reloads stay fast even with large histories.

## Multi-machine usage

There's no server or sync daemon here on purpose — the tool stays local-first. Instead, each extra machine (a work laptop, a second desktop, whatever) writes its own usage as one JSON file, and you move that file however you already move files between your machines (Syncthing, a cloud-synced folder, `scp`, a USB stick):

```json
{
  "machine": "work-laptop",
  "rows": [
    { "date": "2026-08-29", "project": "some-project", "model": "claude-sonnet-4-6", "input": 1200, "cacheWrite": 0, "cacheRead": 50000, "output": 3400, "cost": 0.42 }
  ]
}
```

Drop it at `~/.claude-usage-tracker/external-usage/<anything>.json` on the machine running the dashboard. Each `model` gets namespaced `<machine>:<model>` on merge, so it never collides with local rows and shows up in the model table/legend tagged with its machine.

To produce one from another machine's local Claude Code transcripts without installing the dashboard there, run this on that machine (Node ≥ 20):

```bash
node -e "
import('./lib.ts').then(async ({ collectUsage }) => {
  const data = await collectUsage();
  console.log(JSON.stringify({ machine: require('os').hostname(), rows: data.rows }));
});
" > usage-export.json
```

(or just `curl http://localhost:3789/api/usage` if the dashboard is already running there) — then copy `usage-export.json` into `external-usage/` on your main machine.

## CLI mode

A live terminal widget that keeps re-rendering in place — plan limits with colored meters, pace predictions, and today's cost:

```bash
claude-usage            # (or npm run cli from a checkout)
```

```
Claude Usage Tracker  Max 5× · ● live 7:33:06 PM

  Session (5 h)      █████████████░░░░░░░░░░░  55%  resets ~10:49 PM
                     34.0 %/h · exhausted ~8:52 PM, before reset
  Week · all         ██████████████░░░░░░░░░░  59%  resets Thu ~12:59 AM
  Week · Fable       █████████████████████░░░  86%  resets Thu ~12:59 AM

  Today  $185.77 list price · 154.7M tokens

  refreshes every 30 s · Ctrl+C to quit
```

Web dashboard and CLI share the same data layer (`lib.ts`), including the pace history — run either or both.

## Popout widget

Click **Popout** in the header to get a floating mini window (Chromium's Document Picture-in-Picture — stays on top of everything). Firefox and others get a small regular window instead. You can also open `http://localhost:3789/?widget=1` directly.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PORT` | `3789` | HTTP port |

## Development

```bash
npm install          # TypeScript tooling (dev-only)
npm run build        # compile src/app.ts → public/app.js
npm run check        # typecheck server + frontend (strict mode)
```

`server.ts` runs natively via Node's type stripping — no bundler, no transpile step. The frontend source lives in `src/app.ts`; the compiled `public/app.js` is committed so a clone runs without building.

## Privacy

Everything runs locally. The only outbound request is the limits call to Anthropic's own API, using credentials already on your machine. No telemetry, no third-party services.

## Disclaimer

Cost figures are **computed API list prices**, not what you are billed — on Pro/Max subscriptions they serve as a consumption indicator. Predictions are linear extrapolations and intentionally approximate. This is an unofficial community tool, not affiliated with Anthropic.

## License

[MIT](LICENSE)
