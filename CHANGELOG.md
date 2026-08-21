# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

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
