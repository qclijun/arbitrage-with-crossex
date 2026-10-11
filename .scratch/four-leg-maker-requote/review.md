# Final review and repair — four-leg maker requote

Date: 2026-10-11
Branch: `feat/four-leg-maker-requote`
Fixed point: `1ca3a5b96520baec97dc9c075348073e0ba29fb6`
Reviewed implementation HEAD: `ffff5ede0ba315f5a565f7c901d5e74c3202ccde`
Diff: `git diff 1ca3a5b...HEAD`
Spec: [spec.md](spec.md)

The two review axes ran independently, followed by one repair pass and a
read-only review of the resulting working diff. No blocking finding remains.

## Standards

**Documented violation, repaired:** `src/engine/loop.ts` saved cancel provenance
and the reprice counter in separate commits. A process crash between those
writes caused a completed replacement cycle to go uncounted after restart,
contrary to the durable recovery discipline in `AGENTS.md` and
`docs/MAKER-HEDGE.md`. `Store.recordRepriceCancel` now commits both facts in one
transaction, incrementing only on the first marker change. The wire request
starts before that transaction; its outcome is consumed afterward. Tests cover
rollback, reopening a file-backed ledger, unknown outcomes and retries.

**Judgment smell, deferred:** the fresh-schema and CHECK-rebuild migration each
contain a pair-table definition. This possible duplication is a maintenance
concern, not a documented violation. Consolidating schema construction is
outside this repair pass; existing migration verification remains green.

Standards count: one documented violation repaired; one nonblocking judgment
deferred. The worst issue on this axis was quota loss across a crash.

## Spec

1. **Reprice accounting, repaired** — spec line 65 requires one consumed unit
   per initiated cycle, retained across restart. Atomic provenance/counter
   persistence removes the intermediate commit gap and does not charge before
   invoking the cancel. If the request reaches the venue but the transaction
   fails, observation of the unmarked cancellation stops acquisition safely;
   raced fills are reconciled and hedged before honest completion. A file-ledger
   regression proves this case, including no uncounted replacement.
2. **Initial fixed price, repaired** — spec line 83 preserves explicit fixed
   prices. A pinned four-leg ticket now creates `pricePolicy: 'fixed'` while
   retaining the existing `autoPricePolicy: 'best'` fact. This optional creation
   input is accepted only for a fixed, non-reduce-only maker pair. The existing
   no-price re-peg restores best quoting. Such placements retain their timestamp
   so restoration cannot bypass the fifteen-second interval. API, UI and engine
   regressions cover the full path.
3. **Invalid hedge reference, repaired** — spec lines 75–76 require a valid
   two-sided, positive, uncrossed reference book. Four-leg hedge and converting
   sizing now request this predicate, including when the maker is manually
   pinned. A separate cache key prevents ordinary reference values from being
   reused. Ordinary deals retain their existing reference behavior. Adapter and
   full-loop tests prove refusal and recovery.
4. **Hidden ordinary timeout, repaired** — spec line 72 preserves the ordinary
   five-minute default. Switching a mounted ticket from four-leg to ordinary
   resets the selection and submitted value to 300 seconds. Four-leg previews
   now show the same-side best rather than the old spread-offset price. The
   confirmation identity also includes the flow marker, preventing different
   policies from sharing a pending creation ID.

**Additional presentation correction:** spec line 85 requires explainable
progress. Book-outage text now says quoting is paused, without claiming that a
maker exists or remains resting after the thirty-second cancellation threshold.

Spec count: four substantive deviations repaired, plus one presentation
correction. The worst issues on this axis were uncounted replacement cycles and
silently ignored fixed prices. No new blocking issue appeared in the second
review.

## Handoff open items

- Outage state: `tickPair` already resets the marker on a subsequent tick where
  `needBest` is false. A terminal deal may retain a diagnostic marker because
  DONE ticks return immediately; the API gates pause reporting on OPENING, so
  this cannot restart quoting or report a terminal quoting pause.
- Positive initial seed: retained as the existing creation/preview requirement.
  Automatic best quotes still require a valid live book; seed-price fallback is
  not used for best quoting. Omitting the seed is separate work.
- `maker-backoff`: intentionally names the rejection retry backoff, rather than
  the fifteen-second automatic reprice interval.
- `autoPricePolicy`: an actual quote policy to restore after a manual pin, not
  an inferred venue/position origin. The initial-pinning repair reuses this
  already persisted field; no additional persisted field or UI control was added.

## Verification and completion

- Before repair, added regressions failed for initial pinning, crossed reference
  books, quota persistence and the four-leg price display.
- Focused unit/server tests: 7 files, 153 passed.
- Focused UI tests: 3 files, 72 passed.
- `yarn verify`: passed outside the sandbox; both TypeScript checks passed,
  root tests 122 files / 2838 passed / 8 skipped, web tests 100 files / 1469 passed.
  The first sandbox run could not spawn installer/Python subprocesses or listen
  on localhost; the permitted rerun resolved those environment failures.
- `yarn --cwd web build`: passed, with the existing large-bundle advisory.
- `git diff --check`: passed.
- Seven clean, fully merged `ffm-01` through `ffm-07` worktrees removed.
  `.worktrees/t01` and the `opt_monitor` worktree retained.
- No live tests, account mutations, deployment, push or PR creation performed.
  Offline evidence does not establish a future maker fill-rate improvement.

## Completion status recheck — 2026-10-11

All seven tickets have completed implementation and offline acceptance. Their
existing top-level `Status: resolved` values are retained; stale inline
`ready-for-agent` values and the spec status now agree with them. Historical
acceptance lists and Answers are preserved, with per-ticket audit comments.

Implementation checked: `36dbcaf`, including final-review fixes in `9f12669`.
HEAD at completion: `1e42912`; the intervening commit only adds the stop script
and its documentation/package entry, with no changes to this feature.
The newer migration tests also verify preservation of additional legacy
columns, their defaults, indexes, triggers, orders and foreign keys.

Fresh verification:

- Focused unit/server: 12 files / 277 passed.
- Focused web: 4 files / 87 passed.
- `yarn verify`: passed outside the sandbox; root 122 files / 2840 passed /
  8 skipped; web 100 files / 1469 passed; both TypeScript checks passed.
- The initial sandbox run failed due to denied installer/Python subprocesses
  and localhost listening; the permitted rerun passed.
- `yarn --cwd web build`: passed, retaining the existing bundle-size advisory.

Ticket 05's fourth acceptance bullet incorrectly calls the quota-free cancel
an automatic reprice cancel. The spec explicitly makes book-outage cancels
quota-free, while each actual auto-reprice cycle consumes one unit. Completion
is assessed against that spec; the original ticket wording is retained and
qualified in its audit comment. Ticket 02's historical two-commit quota
accounting discussion is superseded by the atomic final-review repair.

No live trading, deployment, service restart or account mutation was performed.
The separate live-validation checklist remains unverified; ticket completion
does not claim improved real-world maker fill rates or completed live acceptance.
