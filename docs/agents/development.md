# Development and validation

## Build, Test, and Development Commands

Use Node.js 22.13 or newer and Yarn 1.22.22. The root and `web/` are separate packages; install both with `yarn install --frozen-lockfile` and `yarn --cwd web install --frozen-lockfile`.

- `yarn dev` runs the server and Vite development server together; `yarn start` builds the web app and starts the server; `yarn stop` stops the server (and, under `yarn dev`, the Vite dev server too).
- `yarn typecheck` checks server and shared TypeScript. `yarn test` runs unit and server tests; `yarn test:web` runs UI tests.
- `yarn verify` runs typechecking and offline tests. Run `yarn --cwd web build` to validate the production web bundle, as CI does.

Tests are Vitest projects defined in `vitest.config.ts` (`unit`, `server`, `live`; the web
package is separate). Target one file or one test:

```bash
yarn vitest run --project unit tests/unit/engine-decide.test.ts
yarn vitest run --project unit -t "never over-hedges"
yarn test:web -- -t "unhedged banner"
python3 -m unittest discover -s tests/monitor -v      # risk monitor
python3 -m unittest discover -s tests/screening -v    # opportunity screening
```

There is no formatter or linter script. Match the surrounding style.
## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, single-quoted strings, and semicolons, matching nearby code. Keep modules focused; use kebab-case for most source and test filenames, and PascalCase for React component files. No formatter or linter script is configured, so follow the surrounding style.
## Testing Guidelines

Use Vitest and name tests `*.test.ts` or, for web tests, `*.test.tsx`. Add or update unit/server tests alongside behavior changes; prefer fixtures and stubs for offline coverage. Tests under `tests/live/` require explicit opt-in and can place real exchange orders; do not use them as routine verification.

`tests/server/` is offline: nock blocks real HTTP, and routes are driven through
`app.inject()` — never `listen()`. `tests/live/` needs `LIVE_TRADE_ACK` (exact sentence in
`tests/live/guards.ts`), self-skips otherwise, and must never be part of routine
verification. `yarn live:cleanup` sweeps orphaned `lt<runId>_…` test orders after a crashed
run.
## Commits, Pull Requests, and Sensitive Data

Recent commits use concise `chore: ...` subjects, descriptive feature subjects, and release titles such as `Release 1.7.2: ...`; follow these patterns. PRs should explain the change, list verification commands, include screenshots for visible UI changes, and call out trading or credential implications. Never commit `.env` files, `api-token`, `data/`, SQLite files, or recorded live-account fixtures.
