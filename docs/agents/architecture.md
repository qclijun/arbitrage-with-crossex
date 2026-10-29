# Architecture reference

## Project Structure & Module Organization

- `src/core/` contains exchange and domain logic; `src/engine/` owns the reconcile loop and SQLite state; `src/server/` contains the Fastify API and routes.
- `web/src/` is the React/Vite interface. `tests/unit/`, `tests/server/`, and `tests/live/` hold unit, API, and live-account tests; shared fixtures and helpers live under `tests/fixtures/` and `tests/helpers/`.
- `docs/` contains user and design documentation. Read `docs/MAKER-HEDGE.md` before changing trade execution or recovery behavior.
- `scripts/` holds standalone Python tools (standard library only, read-only): `risk_monitor*.py` and `opportunity_screening.py`. They are independent of the Node app and are not covered by `yarn verify`. `scripts/stop.sh` stops the running server (`yarn stop`). `scripts/ledger-restore.ts` (`yarn ledger:restore`) is the one script that writes data: it restores a ledger upgrade's backup, and refuses once the upgraded ledger was written (`src/engine/ledger/`).
- `install.sh` / `install.ps1` are the user-facing installers. They download a private Node runtime and register a LaunchAgent / Scheduled Task; user data lives outside the app dir because updates wipe it.
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
  `engine.wake()`; they never place or cancel orders themselves. The strategy slice
  ledger (`engine/slices.ts`) follows the same split: fill-derived quantities are
  booked only by the engine after each tick, while user commands — slice creation,
  attaching a deal, a claim, an evidenced recovery of an unexplained position — are
  validated and written atomically by the route like any other intent. That
  recovery is ledger reconciliation, not crash recovery state.
- Leverage a deal owns (`PairRow.leverage`, `engine/leverage.ts`) is set by the engine,
  one leg per tick, before anything is placed; a refusal or an unconfirmed outcome
  ends the deal with nothing placed. The funding-opportunity admission
  (`server/funding/`, `/api/funding/*`) relies on this: its preview and acceptance
  only read, and acceptance writes intent, slice and deal in one admission
  transaction. The older `POST /deals` still sets leverage itself — a known exception.
  The read-only opportunities page (`GET /api/funding/opportunities`,
  `server/funding/board.ts`) ranks from memory only: the published history cache
  and `core/funding/market.ts`, both filled by background pollers
  (`server/funding/services.ts`), so a browser request never reaches a venue.

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
