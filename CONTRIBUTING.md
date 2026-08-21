# Contributing

Thanks for your interest! This project is deliberately small: one Node server, three static files, zero dependencies. Please keep it that way.

## Ground rules

- **No new runtime dependencies.** The zero-dependency setup is a feature. If something genuinely needs a package, open an issue first.
- **No build step.** Plain ES modules, plain CSS. What's in the repo is what runs.
- **Keep the data local.** The only network call this tool makes is the limits fetch to Anthropic's API with the user's own local token. Don't add anything that sends data elsewhere.

## Development

```bash
npm start        # server on http://localhost:3789
```

There is no test suite yet — verify changes manually:

1. `node --check server.js public/app.js` for syntax
2. Load the dashboard, switch time ranges, hover the chart
3. Check both light and dark mode
4. Open the popout (`?widget=1`) and resize it through the breakpoints

## Pull requests

- One topic per PR, with a short description of what changed and why
- Match the existing code style (no linter is enforced — read the surrounding code)
- Update the README if you change behavior or configuration

## Reporting issues

Include your OS, Node version, and — if it's a parsing issue — an anonymized sample line from the affected `.jsonl` transcript.
