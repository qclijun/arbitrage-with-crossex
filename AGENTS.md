# Repository Guidelines

`CLAUDE.md` points here. Keep shared agent guidance in this file and its linked references.

## Safety and architecture

- Bind the server to `127.0.0.1`; preserve Host/Origin checks and mandatory `/api` token authentication. `buildApp` must fail without `authToken`.
- The deal engine is the sole writer of state and venue mutations. Routes write intents and call `engine.wake()`; each tick makes at most one wire mutation.
- SQLite is the system of record and its `EXCLUSIVE` lock is the single-instance guard. Keep `decide.ts` pure; IO belongs in `loop.ts`.
- Register orders before wire calls with deterministic client IDs. Resolve `unknown` outcomes (including 5xx) by probing; shrinking persisted quantities require alert and quarantine.
- Recovery is the normal reconcile loop; do not add separate recovery state. Unknown venue order states render verbatim and are quarantined.
- Money and quantities remain decimal strings. Credentials stay in `.env`; preserve owner-only permissions and `hardenConfigDir` behavior.
- Live tests require explicit opt-in and can trade real funds; exclude them from routine verification. Never commit credentials, `api-token`, `data/`, SQLite files, or live-account fixtures.
- Branch from and merge changes into `dev`; bundle releases through `release/<version>` into `main`.

## Validation

- Use Node.js >=22.13 and Yarn 1.22.22; install root and `web/` dependencies separately with `--frozen-lockfile`.
- Match surrounding strict TypeScript style: two spaces, single quotes, semicolons. Add offline unit/server tests for behavior changes.
- Run `yarn verify` for TypeScript/offline checks and `yarn --cwd web build` for the production UI bundle.
- Python tools under `scripts/` are standard-library-only and read-only; `yarn verify` does not cover them. Run the relevant `tests/monitor` or `tests/screening` unittest suite.
- Server tests use `app.inject()` with real HTTP blocked; never `listen()`.

## Read when relevant

- Before changing execution or recovery: read [MAKER-HEDGE](docs/MAKER-HEDGE.md).
- When locating modules or changing engine, venue clients, API security, credentials, installers, or UI boundaries: read [architecture](docs/agents/architecture.md).
- Before development setup, selecting tests, or preparing commits/PRs: read [development](docs/agents/development.md).
- Before preparing or publishing a release: read [release workflow](docs/agents/release.md).
- 创建、读取或更新工单与规格：[issue tracker](docs/agents/issue-tracker.md)。
- 分诊工单：[triage labels](docs/agents/triage-labels.md)。
- 探索领域术语或架构决策：[domain docs](docs/agents/domain.md)。
