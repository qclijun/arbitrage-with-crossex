# Local engine timing evidence

The optional collector records the original trading path. It does not pool signed
connections, change price-fetch ordering, change decisions, or add venue requests.
It is disabled by default. No live-account orders are needed to test it.

## Enable and locate

Set `ENGINE_OBSERVATION=1` in the environment of the next deliberately started
server process. Use the existing operational procedure for stopping/starting the
terminal; this feature does not restart it or change `.env` automatically.

The collector owns only `<dataDir>/engine-observation/`:

- `details/obs-<UTC-ms>-<run>-<sequence>.jsonl`: structured evidence.
- `reports/obs-<UTC-ms>-<run>-<sequence>.jsonl`: reserved namespace for the next
  reporting ticket. For the separate passive-index/replay report tool, see
  [LATENCY-REPORT.md](LATENCY-REPORT.md); it uses its own output directory.
- `status.json`: latest persisted sequence and cumulative resource/gap counters.

New directories use mode 0700 and files use 0600. The SQLite ledger and existing
logs/history are never candidates for cleanup.

## Meaning of the records

Each record has a version, run, tick, sequence, process monotonic time (`monoMs`),
and an independent UTC anchor (`utcMs`). Wall-clock differences do not replace
monotonic durations. `startedMonoMs` joins the entry and receipt of one operation.

| Stage | Evidence boundary |
| --- | --- |
| `intent`, `intent-changed` | Initial intent and observed mode/policy/price changes |
| `send-entry`, `receipt` | Local Venue/SDK/public-book call entry and completion |
| `fill-confirmed` | Newly merged cumulative order quantity, after ledger commit |
| `projection` | Confirmed ledger fills and reservations, separately for both legs |
| `decision` | Selected action, bounded reason code, and hashed free-form reason |
| `registered` | PENDING reservation has committed; no wire call required yet |
| `cache` | Actual adapter key/hit, local cache-write/receive time and monotonic residence |
| `order-linked` | An accepted SDK create disclosed an order identifier |
| `tick-start`, `tick-end` | Tick boundaries; unsuccessful ticks end with `unknown` |

An outer `create` receipt includes the adapter's follow-up query. Its inner
`sdk-create` and `sdk-confirm` spans separate venue acceptance from confirmation.
An accepted create with failed confirmation remains accepted in the engine; the
confirmation evidence is `unknown`. No observation error converts it to a reject
or causes another create.

`send-entry` is an application boundary, **not** a NIC transmission timestamp.
Socket queueing, connection cold/warm state and exact network-send time remain
UNKNOWN. The original signed client, proxy choice and request timeout are intact.

The current normalized books expose local assembly time, not a verified venue
source timestamp. Therefore `sourceTime`, `sourceTimeUnit` and `clockErrorMs` are
null with UNKNOWN status. No missing source time becomes zero age. Future or
jumping local anchors are not interpreted as precise source age.

Quantities are decimal strings in normalized base units. `aFilled`/`bFilled` are
ledger-confirmed cumulative quantities; `aReserved`/`bReserved` include outstanding
reservations. `unreserved` is the obligation still eligible for another hedge,
not actual economic exposure. Pending/quarantined/unreadable state marks the
projection outcome unknown. Actual economic exposure and native fill identity
remain UNKNOWN. The hashed `fill` key identifies a cumulative confirmation, not
an exchange fill ID. Reservations never count as fills.

Deal/client/order/confirmation/cache/reason identifiers use one private random
salt per run, so joins are consistent within that run. The salt is not persisted;
cross-run joins are UNKNOWN. Raw account IDs, credentials, signatures, headers,
error text, and full requests/responses are not written. Only bounded error
categories and HTTP status are retained, including rate limits.

## Failure and resource contract

The trading thread captures bounded primitive fields, timestamps and salted
identifier hashes. A plain CJS worker performs JSON encoding, retention and file IO. Its
synchronous filesystem calls run exclusively in that thread. It uses
a 7 MiB old-generation, 1 MiB young-generation and 0.5 MiB stack limit; these are
isolate limits, not a claim about whole-process RSS. RSS acceptance includes the
worker in the same process.

Pending/in-flight evidence and the identifier cache share a conservative 1 MiB
reservation budget. At most 64 KiB is reserved for the bounded identifier cache;
repeated identifiers reuse their salted hash without repeated allocations.
Frame objects are pooled within that bound and cleared after IPC cloning. Only
one batch is in flight. The trading loop never awaits a write or a worker reply.
A batch has a five-second observation deadline; worker failure or timeout disables
that run's writer, drops pending evidence, and releases reservations. Individual
write errors drop their batch and retain bounded best-effort collection. Trading
continues under its existing rules. No automatic worker or trading-request retry
is added. Service close drains bounded observation work and terminates the worker.

Queue exhaustion, worker failure, write failure and rotation failure increment
counters and emit a stable warning through the existing engine alert store
(throttled to once per minute and using its existing deduplication). Missing
samples are UNKNOWN. `COMPLETE` means no collector gap has been detected; it does
not certify source freshness, real exposure or every possible crash tail.

Read the run/sequence range and cumulative counters together. An unfinished tick,
a missing sequence, failed storage, truncated JSONL tail, absent status or a
counter increase makes the affected evidence interval UNKNOWN. An earlier gap
must not be silently removed to make a whole run pass.

Owned detail segments are at most 1 MiB. Detail retention is seven days/100 MiB;
report retention is thirty days/10 MiB. Cleanup uses the first age/capacity bound,
runs at segment rollover and periodically while idle, and touches only the owned
filename pattern. Segment capacity is reserved before append, so rollover may
remove the oldest segment slightly before the byte cap is fully occupied.
An oversized batch is dropped before any write. Unrelated files are preserved.

## Offline verification

Use the project's supported Node runtime (>=22.13) and Yarn:

```sh
yarn vitest run --project unit tests/unit/engine-observation.test.ts
yarn verify
node --import tsx tests/bench/engine-observation.ts <pre-change-commit>
```

For the RSS gate, run the benchmark with
`NODE_OPTIONS=--max-semi-space-size=1` so both child configurations share a fixed
V8 new-space size. With default flags, V8's new-space high-water mark makes both
configurations step by ~140 MiB at random points, and the joint-stability check
measures that instead of the collector. See the
[2026-10-23 RSS rerun](validation/engine-observation-rss-2026-10-23.md).

The performance command freezes original/observed source snapshots under `/tmp`,
uses FakeVenue plus file-backed SQLite, initializes observation storage, warms
200 ticks and measures 1000 ticks per configuration in each of three alternating
pairs. Each tenth tick confirms another 0.001 base units and triggers a hedge.
Timing includes an event-loop yield so asynchronous writer/alert work can compete.
Both variants must produce identical final ledger facts. All groups and the
pooled p95 must satisfy the agreed budget. Normal-GC steady RSS is measured in
160 further rounds of 200 fixed-ledger ticks while observation remains active.
Predeclared checkpoints at 80, 120 and 160 windows require the last ten windows
in both configurations to have a range <=4 MiB and an OLS positive slope
<=0.25 MiB/window. Use only the first jointly stable checkpoint, independently
of its RSS increment. If none is stable, the increment remains unverified and
the gate fails. The <=32 MiB increment compares maxima of those same windows.
Every subsequent predefined checkpoint must also pass observed RSS stability; later growth vetoes the result.
Five additional post-GC windows are diagnostic only. No GC is forced during timing
or the normal stability probe. Timed RSS maxima are sampled every 100 ticks and
are not true process peaks. RSS includes all threads. A gap fails the evidence
gate. Run this command alone, after other test processes finish. Finite sampling
cannot prove the absence of future growth: the shared queue/cache byte bound and
repeated-batch regression provide additional structural evidence.

These checks establish finite-run offline evidence, not a live latency or
unhedged-exposure improvement. Live baselines, reporting, transport pooling and
removing unrelated quote waits remain separate tickets.

## Hedge dependency diagnostics

Ticket 09 adds bounded `hedge-wait` events with waitState/waitMs, actualUnhedged and
unreserved quantities kept separate. Source time and exact economic exposure stay UNKNOWN.
See [HEDGE-DEPENDENCY.md](HEDGE-DEPENDENCY.md) for default-off dependency selection,
reconfirmation, alert throttling, diagnostic capacity and recovery semantics.
