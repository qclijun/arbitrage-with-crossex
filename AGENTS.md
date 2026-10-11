# Repository Guidelines

Guidance for agents working in this repository. `CLAUDE.md` is a pointer to
this file — keep everything here so there is one place to update.

## Project Structure & Module Organization

- `src/core/` contains exchange and domain logic; `src/engine/` owns the reconcile loop and SQLite state; `src/server/` contains the Fastify API and routes.
- `web/src/` is the React/Vite interface. `tests/unit/`, `tests/server/`, and `tests/live/` hold unit, API, and live-account tests; shared fixtures and helpers live under `tests/fixtures/` and `tests/helpers/`.
- `docs/` contains user and design documentation. Read `docs/MAKER-HEDGE.md` before changing trade execution or recovery behavior.
- `scripts/` holds standalone Python tools (standard library only, read-only): `risk_monitor*.py` and `opportunity_screening.py`. They are independent of the Node app and are not covered by `yarn verify`. `scripts/stop.sh` stops the running server (`yarn stop`).
- `install.sh` / `install.ps1` are the user-facing installers. They download a private Node runtime and register a LaunchAgent / Scheduled Task; user data lives outside the app dir because updates wipe it.

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

## Architecture

TypeScript monorepo, no framework in the core: `src/core` is a pure domain library, the
server wraps it in Fastify, and `web/` is a React SPA that only ever talks to the server's
`/api`. Everything runs on the user's machine against their own keys; the server binds to
`127.0.0.1` and must never be reachable off-box.

### The deal engine (`src/engine/`) is the point of the system

Every trade — maker+hedge pair, both-market pair, single open, reduce-only close — is a
**deal**: one intent row, converged by **one single-writer reconcile loop** that is the only
code allowed to mutate state or call venue-mutating endpoints.

- The SQLite file (`engine/db.ts`) **is** the system of record. Its `EXCLUSIVE` lock doubles
  as the single-instance guard, so a second process fails before touching the venue.
- A tick is OBSERVE → PROJECT → DECIDE → ACT, with **at most one wire mutation per tick**.
- `engine/decide.ts` is pure — `(intent, projection, now, prices) → the single next action`.
  No IO, no clock, no randomness. `engine/loop.ts` performs the IO. Keep it that way: that
  purity is the entire correctness review surface, and `tests/unit/engine-sim.ts` exercises
  it deterministically against a fake venue.
- Orders are registered **write-ahead**: the row is committed before the wire call, with a
  deterministic client id. Wire outcomes are **three-way** (`ok` / `reject` / `unknown`);
  `unknown` is anything that is not a definitively parsed business label from an allowlist —
  including any 5xx — and resolves by probing, never by guessing. Persisted quantities merge
  **monotonically**; a shrink is corruption → alert + quarantine.
- Recovery is not a module, an adopt-window, or a repeg protocol: it *is* the loop. The
  first tick after a crash is indistinguishable from any other tick, because no decision
  depends on witnessing an event. Do not add recovery state.
- Routes are thin intent writers. They write a command level / intent row and call
  `engine.wake()`; they never place or cancel orders themselves.

### Layers

- `src/core/` — domain library shared by server, live tests, and tests. `clients.ts` holds
  the Gate SDK wiring (`makeClients` hard-throws without keys; `makeClientsIfConfigured`
  returns null so the server boots into the first-run setup UI) plus `publicCrossEx()`, the
  memoized unsigned client for the endpoints Gate serves publicly. `numbers.ts` / `estimate/`
  own tick snapping, Hyperliquid's 5-sig-fig cap, and VWAP fill estimation.
- `src/core/boros/` — the fixed-rate side: pricing every Boros↔CrossEx pair net of costs
  (`opportunities.ts`), two-leg quoting and atomic pair execution (`pair.ts`, `orders.ts`),
  rollover. This is where the *signal* comes from; CrossEx exposes no per-venue funding feed.
- `src/server/` — Fastify. `app.ts` is the factory (no `listen`; tests inject) and owns the
  localhost Host/Origin guard, the per-install `x-arb-token` gate scoped to `/api` (health
  stays open for the installers), the `{ok,data,meta}` / `{ok,error}` envelope, and the
  error-category → status mapping. `buildApp` throws if `authToken` is missing — that
  fail-closed check is deliberate; don't make auth optional. `cache.ts` is a TTL cache with
  request coalescing and stale-serve on 429.
- `web/src/` — React 18 + Vite + Tailwind + react-query. `panels/` are dashboards, `trade/`
  is the gated trading UI, `api/` wraps the server. Tailwind and Vite configs are `.cjs`.

### Conventions worth knowing before editing

- Money and quantities are **decimal strings** end to end (`engine/fx.ts`), never floats.
- Credentials live only in `.env` (`DOTENV_CONFIG_PATH`) and are re-tightened to owner-only
  on every boot. The `hardenConfigDir` flag exists precisely so a source checkout does not
  get its own repo root chmod'd — keep it.
- Order-state strings from Gate are undocumented open-world values. Unknown states render
  verbatim and are quarantined, never guessed terminal or non-terminal.
- Run with real funds and no venue-side backstop: Gate CrossEx has no dead-man's switch, so
  a machine that sleeps mid-deal leaves a leg unhedged. Restarting the server resumes the
  loop; there is nothing to repair by hand.

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

## Release workflow

Bundle changes. Do not ship one feature per release.

1. Branch off `dev`. Merge every change and fix back into `dev`.
2. Let work collect on `dev`. Never push a feature straight to `main`.
3. Once or twice a week, release the whole collected set as one version.

Why: users must not update the app often. A bundled release also gives a
feature launch more effect than a drip of small ones.

### To cut a release

1. Read the bundle: `git log main..dev --oneline`.
2. Write the `CHANGELOG.md` entry from that list.
3. Bump `version.json` and write its `highlights`. Users read `highlights`
   in the in-app update modal, so write them for a trader, not for a
   developer.
4. Land it on `main`: cut `release/<version>` from `main`, cherry-pick the
   bundle's commits from `dev`, and open that PR into `main`. Check the tree
   matches `dev` (`git diff dev release/<version>` is empty).
5. After the release PR merges, reset `dev` to `main`:
   `git push --force-with-lease origin origin/main:dev`.

Why: releases are squash-merged, so `dev` and `main` histories diverge and a
`dev` → `main` PR conflicts. Resetting `dev` after each release keeps the
next bundle a clean diff on top of `main`.

`main` is what `install.sh` and the in-app update check read. The merge to
`main` is the moment every user sees the update.

There is no changeset tool, and the repo does not need one. The bundle is
what `dev` has on top of `main` (`git diff main dev`, since `dev` is reset to
`main` after every release). `version.json` highlights stay hand-written.

## Agent skills

### Issue tracker

创建、读取或更新工单与规格时，使用本地 Markdown；见 `docs/agents/issue-tracker.md`。

### Triage labels

分诊工单时，使用默认五种标签；见 `docs/agents/triage-labels.md`。

### Domain docs

探索领域术语或架构决策时，使用 single-context 布局；见 `docs/agents/domain.md`。
