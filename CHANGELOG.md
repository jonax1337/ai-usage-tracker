# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [1.0.0] - 2026-08-21

### Added

- Usage dashboard: daily cost per model (stacked bars), breakdowns by project and model, time-range filter (7/30/90 days/all)
- Transcript parser for `~/.claude/projects` with mtime caching and streaming-entry deduplication
- Live plan limits (session/weekly) via Anthropic's OAuth usage endpoint, with fallback to Claude Code's local cache
- Pace predictions: short-window burn rate for the session limit, 72-hour average with projected-at-reset for weekly limits (requires ≥ 12 h of history)
- Real-time updates via file watcher + Server-Sent Events
- Popout widget (Document Picture-in-Picture, responsive breakpoints) at `/?widget=1`
- Light/dark theme, themed scrollbars, CVD-safe chart palette
