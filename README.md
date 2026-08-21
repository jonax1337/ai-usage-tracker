# Claude Usage Tracker

A local, zero-dependency dashboard for your [Claude Code](https://claude.com/claude-code) token usage, costs, and plan limits — with live updates, pace predictions, and a floating picture-in-picture widget.

![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![No dependencies](https://img.shields.io/badge/dependencies-0-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)

## Features

- **Usage analytics** — daily cost per model as a stacked bar chart, plus breakdowns by project and model, computed from your local Claude Code transcripts
- **Live plan limits** — session (5 h) and weekly limits with progress meters, fetched live from Anthropic's OAuth usage endpoint using the token Claude Code already maintains
- **Pace predictions** — burn rate per limit and an estimate of when it runs out. The session limit uses a short window ("at this pace, exhausted at ~09:50"), weekly limits use a 72-hour average including idle time, since bursts are capped by the session limit anyway
- **Real-time updates** — a file watcher on `~/.claude/projects` pushes changes to the browser via Server-Sent Events; the chart ticks while your sessions run
- **Popout widget** — a compact always-on-top mini window via the Document Picture-in-Picture API (Chromium). Grows responsively: wider windows reveal reset times and stat tiles
- **Light & dark** — follows your system theme, with an accessible, CVD-safe chart palette
- **Zero dependencies** — plain Node.js, plain HTML/CSS/JS. Nothing to install, nothing phoning home

## Quick start

```bash
git clone https://github.com/jonax1337/claude-usage-tracker.git
cd claude-usage-tracker
npm start
```

Open **http://localhost:3789**. That's it — no build step, no config.

Requirements: Node.js ≥ 20 and a machine where Claude Code has been used (transcripts in `~/.claude/projects`).

## How it works

| Data | Source |
|---|---|
| Tokens & costs | `~/.claude/projects/**/*.jsonl` — Claude Code's session transcripts. Each assistant message carries a `usage` block (input, output, cache read/write tokens). Costs are computed at public API list prices, so they are informative even on a subscription plan. |
| Plan limits | `https://api.anthropic.com/api/oauth/usage`, authenticated with the OAuth token Claude Code stores in `~/.claude/.credentials.json`. Falls back to Claude Code's own cache in `~/.claude.json` if the live fetch fails. |
| Pace history | Sampled every 5 minutes and persisted to `pace-history.json` (gitignored) so predictions survive restarts. |

The server parses transcripts with per-file mtime caching and deduplicates streaming entries by message ID, so reloads stay fast even with large histories.

## Popout widget

Click **Popout** in the header to get a floating mini window (Chromium's Document Picture-in-Picture — stays on top of everything). Firefox and others get a small regular window instead. You can also open `http://localhost:3789/?widget=1` directly.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PORT` | `3789` | HTTP port |

Model pricing lives in the `PRICING` table at the top of `server.js` — adjust when Anthropic ships new models.

## Privacy

Everything runs locally. The only outbound request is the limits call to Anthropic's own API, using credentials already on your machine. No telemetry, no third-party services.

## Disclaimer

Cost figures are **computed API list prices**, not what you are billed — on Pro/Max subscriptions they serve as a consumption indicator. Predictions are linear extrapolations and intentionally approximate. This is an unofficial community tool, not affiliated with Anthropic.

## License

[MIT](LICENSE)
