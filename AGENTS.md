# Repository Guidelines

## Project Structure & Module Organization

- `src/core/` contains exchange and domain logic; `src/engine/` owns the reconcile loop and SQLite state; `src/server/` contains the Fastify API and routes.
- `web/src/` is the React/Vite interface. `tests/unit/`, `tests/server/`, and `tests/live/` hold unit, API, and live-account tests; shared fixtures and helpers live under `tests/fixtures/` and `tests/helpers/`.
- `docs/` contains user and design documentation. Read `docs/MAKER-HEDGE.md` before changing trade execution or recovery behavior.

## Build, Test, and Development Commands

Use Node.js 22.13 or newer and Yarn 1.22.22. The root and `web/` are separate packages; install both with `yarn install --frozen-lockfile` and `yarn --cwd web install --frozen-lockfile`.

- `yarn dev` runs the server and Vite development server together; `yarn start` builds the web app and starts the server.
- `yarn typecheck` checks server and shared TypeScript. `yarn test` runs unit and server tests; `yarn test:web` runs UI tests.
- `yarn verify` runs typechecking and offline tests. Run `yarn --cwd web build` to validate the production web bundle, as CI does.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, single-quoted strings, and semicolons, matching nearby code. Keep modules focused; use kebab-case for most source and test filenames, and PascalCase for React component files. No formatter or linter script is configured, so follow the surrounding style.

## Testing Guidelines

Use Vitest and name tests `*.test.ts` or, for web tests, `*.test.tsx`. Add or update unit/server tests alongside behavior changes; prefer fixtures and stubs for offline coverage. Tests under `tests/live/` require explicit opt-in and can place real exchange orders; do not use them as routine verification.

## Commits, Pull Requests, and Sensitive Data

Recent commits use concise `chore: ...` subjects, descriptive feature subjects, and release titles such as `Release 1.7.2: ...`; follow these patterns. PRs should explain the change, list verification commands, include screenshots for visible UI changes, and call out trading or credential implications. Never commit `.env` files, `api-token`, `data/`, SQLite files, or recorded live-account fixtures.
