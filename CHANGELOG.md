# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [1.5.1] - 2026-08-30

### Changed

- **Visual refresh** (Linear/Vercel/Stripe-inspired polish, layout/structure unchanged): cards now use a shadow-as-border technique (`--shadow-card`/`--shadow-card-hover`/`--shadow-raised`/`--shadow-pop` custom properties) instead of a flat 1px border, with a coherent dark-mode counterpart built on Linear-style surface luminance stepping (`--surface-2`, `--ring`, `--ring-strong` step via white-opacity rather than jumping to a flat gray)
- Tightened and evened out spacing rhythm across the page (root padding, tile grid gaps, card margins, table cell padding)
- Table headers now uppercase with tracked letter-spacing; numeric cells (tiles, limit percentages) use `font-variant-numeric: tabular-nums` for aligned digits
- Filter pills, popout button, and table rows got refined hover/active states and consistent 150–200ms transitions
- Limit meter bars: fully rounded ends, smoother animated width transitions on refresh
- Verified visual parity between light and dark mode, and that the popout/PiP widget mode still renders correctly

## [1.5.0] - 2026-08-29

### Added

- **Hermes Agent as a usage source**: reads `session_model_usage` from Hermes's local `state.db` (`~/.hermes` or `%LOCALAPPDATA%\hermes`, `HERMES_HOME` override respected) and merges it into every chart/table alongside the Claude Code CLI transcripts. Anthropic models use identical raw model ids in both sources, so e.g. `claude-sonnet-5` usage from Hermes and from the CLI **combines into one row** in the model table/chart/donut — the source distinction (Claude Code CLI vs. Hermes Agent) stays visible one level up, in "By project / source". Non-Anthropic providers Hermes talks to (zai, OpenAI-Codex, OpenRouter, ...) that the CLI can never produce keep a `<provider>/<model>` prefix. Read-only; requires Node ≥ 22.5 for `node:sqlite`, degrades to Claude-Code-only silently on older Node.
- **Multi-machine usage (low-effort path)**: drop a `{ machine, rows }` JSON file into `~/.claude-usage-tracker/external-usage/` (Syncthing, cloud-synced folder, `scp`, anything) and its rows merge in on next reload, namespaced `<machine>:<model>` so they never collide with local data. No server, no sync daemon, no auth — see README.

### Changed

- "By project" table/heading renamed to "By project / source" now that non-transcript sources (Hermes Agent, external machines) can appear there
- Footer now lists all three usage sources instead of just `~/.claude/projects`

## [1.4.2] - 2026-08-21

### Changed

- Terminal title shows a status emoji per value (session and week each get their own 🟢/🟡/🔴) instead of one combined indicator

## [1.4.1] - 2026-08-21

### Changed

- Terminal title now shows session and overall weekly percentage only; model-scoped limits (e.g. Fable) no longer influence the title or its status emoji

## [1.4.0] - 2026-08-21

### Added

- CLI widget sets the terminal window title on every refresh: status emoji (🟢/🟡/🔴) plus session and week percentages, restored on exit
- npm releases are automated: pushing a `v*` tag publishes via GitHub Actions with OIDC trusted publishing and provenance

## [1.3.0] - 2026-08-21

### Added

- **npm package** `claude-code-usage-tracker`: `npm i -g` provides the `claude-usage` command
- Subcommands: `serve` (foreground dashboard), `start`/`stop`/`status` (background daemon with PID file and log in `~/.claude-usage-tracker/`)
- Compiled `dist/` build (plain ESM JavaScript) so the published package runs on Node ≥ 20

### Changed

- State files (pace history, pricing cache, limits snapshot) moved from the package directory to `~/.claude-usage-tracker/`
- Internal refresh timers no longer keep short-lived CLI commands alive

## [1.2.0] - 2026-08-21

### Added

- **CLI mode** (`npm run cli`): self-refreshing terminal widget showing plan limits with colored meters, pace predictions, and today's cost
- Donut chart next to the bar chart: cost share by model with center total and per-segment tooltips
- Phosphor icons on card headers and the popout button, now styled as the primary action ("Float widget")

### Changed

- UI translated to English (en-US number and date formats)
- Data layer extracted into `lib.ts`, shared between the web server and the CLI
- Limits fallback picks the freshest available source (live snapshot on disk, pace-history reconstruction, or Claude Code's cache)

## [1.1.0] - 2026-08-21

### Added

- Live model pricing from the LiteLLM price database (daily refresh, disk cache, built-in fallback table); pricing source shown in the footer
- Dashboard screenshot in the README

### Changed

- **Migrated to TypeScript** (strict mode): `server.ts` runs natively via Node's type stripping (requires Node ≥ 23.6); frontend source moved to `src/app.ts`, compiled `public/app.js` stays committed for clone-and-run
- Limits fetch now backs off after errors (60 s cache, cooldown on 429) and serves the last good live snapshot instead of stale data

### Fixed

- Y-axis tick labels were clipped on the cost chart

## [1.0.0] - 2026-08-21

### Added

- Usage dashboard: daily cost per model (stacked bars), breakdowns by project and model, time-range filter (7/30/90 days/all)
- Transcript parser for `~/.claude/projects` with mtime caching and streaming-entry deduplication
- Live plan limits (session/weekly) via Anthropic's OAuth usage endpoint, with fallback to Claude Code's local cache
- Pace predictions: short-window burn rate for the session limit, 72-hour average with projected-at-reset for weekly limits (requires ≥ 12 h of history)
- Real-time updates via file watcher + Server-Sent Events
- Popout widget (Document Picture-in-Picture, responsive breakpoints) at `/?widget=1`
- Light/dark theme, themed scrollbars, CVD-safe chart palette
