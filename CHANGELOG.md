# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [1.8.0] - 2026-09-02

### Changed

- **Dashboard redesign around the plan limits.** The limits card is now a "gauge board": one row per provider (name, vendor, plan and live badges on the left; that provider's windows on the right), large percentages, a meter with tick marks at the 70 % and 90 % thresholds where the color changes, the reset shown as a countdown ("Resets in 1 h 32 min (11:00 AM)"), and the pace forecast as one plain sentence. Monochrome chrome with color reserved for meaning (amber = approaching a limit, red = critical, green = live); the indigo accent is gone. New type: Bricolage Grotesque for titles and large numbers, IBM Plex Sans for text, IBM Plex Mono for tabular numbers.
- **Summary strip** replaces the four stat tiles: cost in range, today's cost compared with the daily average, tokens with the share served from cache, and sessions. The "Models" count tile was dropped.
- **Copy pass across the whole UI**: no more "27 %" with a space, no "data points" in the header, section titles and subtitles rewritten ("Daily cost, by model, at API list prices", "Projects and sources", "Models"), footer shortened, pace and reset sentences reworded, provider errors translated into plain language ("Rate-limited by the provider. Retrying in a few minutes.", "Sign-in expired. Log in again with the provider's own CLI.").
- **Model labels** no longer mangle non-Claude ids: `gpt-5.6-sol-900k` shows as "GPT-5.6 sol 900k (Codex)" instead of "Gpt 5.6.sol.900k (openai-codex)", `zai/glm-5.3` as "GLM-5.3 (Z.ai)", and an unknown Hermes billing provider is no longer printed as "(unknown)".
- Chart: the current day is labeled "Today", hovering highlights the whole column, and the donut dims the other segments while one is hovered. The donut's center label names the selected range.
- CLI: `aiusage stop`/`status` were listed under the old `ai-usage` name in `--help`; window names now cover every provider's kinds.

### Added

- **Theme toggle** in the header (system, light, dark), remembered in the browser. The selected time range is remembered too.
- **Loading, empty, and error states**: skeleton placeholders while the first payload loads, "No usage recorded in the last 30 days" in the chart and tables, an explanatory empty state when no provider credentials are found, and an error banner with a Retry button when the server is unreachable. A provider that reports no window (a fresh OpenRouter account with no credits) says so instead of rendering an empty row.
- **List prices for non-Claude models.** The LiteLLM price table is no longer filtered to Claude ids: the canonical entries plus the `anthropic/`, `zai/` and `openrouter/` namespaces are cached (cloud-reseller variants like `azure/` and `bedrock/` stay out). Hermes rows that Hermes bills at $0 (subscription providers such as Codex or the GLM Coding Plan) now get a list-price cost like every other row, so "by model" is comparable across providers. Price lookup also strips the `<provider>/` prefix and falls back to the longest matching id (`gpt-5.6-sol-900k` uses `gpt-5.6-sol`).
- **OpenRouter credits are shown as a meter** (share of purchased credits used, with "$x of $y left") instead of a text line.

### Fixed

- **Codex windows are labeled by their length** (`limit_window_seconds`), so a plan with a single weekly window is no longer shown as "Current session (5 h)" resetting five days later.
- **Z.ai pace history was broken by design**: the remaining/used token counts were part of the window's `scope`, which is also the pace-history key, so every refresh started a new key. The counts moved to a display-only `note` field on the window; `scope` is stable again.
- **Last known limits survive a restart.** The on-disk snapshot is trusted for its age instead of being refetched immediately on startup, and a provider whose live call fails (429 after a restart, network blip) keeps showing its previous windows, flagged as unavailable, rather than an empty card.
- **State files are written atomically** (temp file + rename) and the pace history is merged with what is on disk before every write. The dashboard daemon, the CLI widget, and a dev checkout all share `~/.aiusage-tracker/`; with plain `writeFile` a concurrent reader could see a truncated file, parse nothing, and overwrite everyone's pace history with its own single sample. That is exactly what wiped the history on the maintainer's machine while developing this release.
- `docs/screenshot.png` was a screenshot of a cookie banner, not the dashboard.

## [1.7.0] - 2026-08-30

### Renamed

- **claude-usage-tracker → aiusage-tracker** (npm package) and GitHub repo `ai-usage-tracker`, CLI command `claude-usage` → `aiusage`. The tool tracks all detected AI subscriptions now, not just Claude — the old name was a lie. State dir moves `~/.claude-usage-tracker/` → `~/.aiusage-tracker/` (existing data is migrated automatically on first run).

### Added

- **Multi-provider live plan limits**: the dashboard now auto-detects every AI subscription/API credential present on the machine and shows each one's live rate-limit/quota status side by side, not just Anthropic. New `providers.ts` module with one `detect()`+`fetch()` per provider:
  - **Anthropic (Claude Code OAuth)** — unchanged, `api.anthropic.com/api/oauth/usage`
  - **OpenAI Codex (ChatGPT OAuth)** — `chatgpt.com/backend-api/wham/usage`, session + weekly windows, banked reset-credit and pay-as-you-go balance surfaced as details
  - **OpenRouter** — `/v1/credits` balance plus an optional `/v1/key` scoped-key quota window, if the key has one
  - **Z.ai / GLM Coding Plan** — `api.z.ai/api/monitor/usage/quota/limit`, the same endpoint the official ZCode desktop client uses; shows the 5-hour window and the plan billing cycle with remaining/used token counts
  - A provider is only shown once its credentials are detected on disk (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `OPENROUTER_API_KEY`/`GLM_API_KEY` from the environment or Hermes Agent's `.env`). A detected provider whose live call fails still renders as an "unavailable" card with the error — real outages/auth problems stay visible instead of silently vanishing.
  - Pace history and burn-rate predictions are now namespaced per `provider:kind[:scope]`, so e.g. Anthropic's and Codex's "session" windows never share pace data.
- New `GET /api/limits/all` endpoint returning the full multi-provider payload (`{ fetchedAtMs, providers: [...] }`). `GET /api/limits` is kept for backward compatibility and now derives its single-provider shape from the new data (prefers a live Anthropic snapshot, falls back to the first live provider).

### Changed

- The "Plan limits" dashboard card is now grouped by provider (icon + label + plan/freshness header per provider, followed by that provider's own limit tiles), instead of one flat row of tiles.
- `lib.ts`'s limits section was rewritten around `providers.ts`; `readLimits()`/`fetchLiveLimits()`/`limitsFromHistory()` (Anthropic-only) were replaced by `getAllLimits()`/`fetchAllLimits()`. `getLimits()` is kept as a legacy derived view for the CLI widget, which is otherwise unchanged.

## [1.6.0] - 2026-08-30

### Changed

- **Full visual redesign**, dark-mode-first, Linear-inspired: near-black canvas (`#08090a`) as the primary target with light mode as a fully-supported secondary variant (both driven by `prefers-color-scheme`, no manual toggle). Hierarchy now comes from white-opacity luminance steps (`--surface-1/2/3`) rather than flat gray jumps, borders are ultra-thin and semi-transparent, and a single restrained indigo accent (`--accent`) is reserved for genuinely interactive/active elements only.
- **Header restructured into a compact sticky topbar**: icon brand mark + title/live-subtitle on the left, the time-range filter pills and the popout control grouped together on the right as a single toolbar, instead of a separate header row and a separate filter row.
- **The "Float widget" popout control was redesigned from a bright blue pill button into a small ghost icon button** (`.icon-btn`) that matches the rest of the toolbar — it no longer looks like a bolted-on CTA. The underlying Picture-in-Picture / fallback-window launch logic is unchanged, only its trigger's appearance and placement changed.
- Cards, tiles, tables, chart legend/tooltip, and plan-limit meters were all restyled to match the new dark-first language (still hand-drawn SVG charts, same 8-slot CVD-safe `--series-1..8` palette, same `assignSlots()` color-assignment logic — only the surrounding chrome changed).
- No changes to the data layer: `server.ts`, `lib.ts`, `hermes.ts`, `cli.ts`, the `/api/usage` and `/api/limits` response shapes, and the SSE live-update mechanism are all untouched.

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
