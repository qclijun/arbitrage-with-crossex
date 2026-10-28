/**
 * Deal routes — one of the app's two execution surfaces (engine). The other
 * is the rebalance runner (src/server/rebalanceRunner.ts). The route layer
 * never touches venue-mutating endpoints itself: creation writes an intent row
 * the reconcile loop picks up on its next tick; commands are one-row intent
 * edits (levels, not events).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { COIN_NOT_SUPPORTED_TEXT, isSupportedCoin } from '../../core/coins';
import { CoreError } from '../../core/errors';
import { formatRestPrice, parseSymbol } from '../../core/numbers';
import { setLeverage } from '../../core/orders';
import { resolveDeal, type DealRequest } from '../../engine/create';
import { project } from '../../engine/decide';
import { commands } from '../../engine/loop';
import { TUNING, type PairRow } from '../../engine/types';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { DISCLAIMER_NOT_ACCEPTED, isDisclaimerAccepted } from '../disclaimer';
import { classifyDealPurpose } from '../dealPurpose';
import { refuse } from '../errorReply';
import { activeDealsOn, manualGate, type ManualGate } from '../manualConflicts';
import { leverageMaxFor } from './leverage';
import { conflict } from './rebalance';

const TRANSFER_SETTLE_MS = 5_000;
const TRANSFER_SETTLING_TEXT = 'Deals wait until Gate takes the transfer. Try again in a few seconds.';

// deps.engine is non-null here: the deals routes are registered only when the
// engine exists (never in the credential-free public mode — see buildApp).

/** The explainable progress the deal view reports.
 *
 * Every field is DERIVED here from facts the engine already persists — no new
 * column, no parallel state. The loop's own idle reason string is transient
 * (an `idle` action is never written by `perform()`), so a persisted "reason"
 * would be exactly the recovery state AGENTS.md forbids; deriving it from the
 * same durable facts the engine decides on keeps the view and the loop in
 * agreement by construction.
 *
 * `following` is the necessary companion to manual price pinning: a pinned
 * deal carries `pricePolicy === 'fixed'` while its FAMILY (`autoPricePolicy`)
 * stays `'best'`, so the current value alone cannot say whether the deal still
 * chases the book. Reject-class failure budgets are deliberately absent —
 * they are not progress. */
function dealProgress(pair: PairRow, now: number) {
  // A pause is a fact about QUOTING, so it only exists while the deal is still
  // in the maker (OPENING) phase. The loop clears `bookOutageStartedAt` only on
  // a tick that finds the book quotable, and stops clearing it at all once the
  // deal leaves OPENING — so a deal converted mid-outage would otherwise carry
  // the stale marker into the terminal phases. Gating here is what keeps the
  // readout from reporting a pause for a deal that is no longer quoting.
  const quoting = pair.mode === 'OPENING';
  // Book outage WINS over the cap: while the book is unquotable the loop
  // cannot reprice whatever the quota says, and the pause is the actionable
  // fact (it is what the 30 s cancel grading measures).
  const pause = !quoting
    ? null
    : pair.bookOutageStartedAt > 0
      ? { kind: 'book-unavailable', since: pair.bookOutageStartedAt }
      : pair.repriceCount >= TUNING.MAX_REPRICE_CYCLES
        ? { kind: 'reprice-cap' }
        : now < pair.makerNotBefore
          ? { kind: 'maker-backoff', until: pair.makerNotBefore }
          : null;
  return {
    reprice: { used: pair.repriceCount, limit: TUNING.MAX_REPRICE_CYCLES },
    pause,
    autoFollow: { following: pair.pricePolicy !== 'fixed', family: pair.autoPricePolicy },
  };
}

function dealView(deps: AppDeps, pair: PairRow) {
  const orders = deps.engine!.store.listOrders(pair.id);
  return {
    pair,
    orders,
    projection: project(pair, orders),
    progress: dealProgress(pair, deps.engine!.clock.now()),
  };
}

export function dealsRoutes(deps: AppDeps) {
  return async function routes(app: FastifyInstance): Promise<void> {
    /* A rebalance moves cash out of CrossEx for minutes, and its amount was
       sized on the margin that was free when it started. A deal that opens
       meanwhile takes that margin. The rebalance start refuses while a deal
       works; this is the same rule the other way. Only a running job blocks:
       a halted one moves nothing until it is resumed, and resume has the
       same check. */
    const rebalanceRunning = (): boolean => deps.rebalance?.jobs.read()?.status === 'running';
    const refuseForRebalance = (reply: FastifyReply, what: string): FastifyReply =>
      refuse(reply, {
        code: 409,
        category: 'validation',
        message: `a rebalance is still running. Wait for it to finish before ${what}.`,
        retryable: true,
      });
    const transferMoving = (): boolean => deps.transfer?.jobs.read()?.status === 'moving';
    const transferSettling = (): boolean => {
      const transfer = deps.transfer?.jobs.read() ?? null;
      if (transfer?.status !== 'moving') return false;
      return transfer.acceptedAt === null || deps.engine!.clock.now() - transfer.acceptedAt < TRANSFER_SETTLE_MS;
    };

    const refuseManual = (reply: FastifyReply, gate: Exclude<ManualGate, { ok: true }>): FastifyReply =>
      refuse(reply, {
        code: gate.label === 'manual-unverifiable' ? 503 : 409,
        category: gate.label === 'manual-unverifiable' ? 'network' : 'validation',
        label: gate.label,
        message: gate.message,
        retryable: gate.label === 'manual-unverifiable',
      });

    app.post('/deals', async (req, reply) => {
      // First-run gate: no real order until the disclaimer is accepted. Tied to
      // the config-backed credentials service (always present in a real install;
      // absent in unit tests, which skip the gate). The UI shows the modal
      // proactively; this 403 is the backstop against a direct API call.
      const envPath = deps.credentials?.envPath;
      if (envPath && !isDisclaimerAccepted(envPath)) return reply.code(403).send(DISCLAIMER_NOT_ACCEPTED);
      const body = req.body as DealRequest & { leverage?: { a?: number; b?: number }; purpose?: unknown; boros?: unknown };
      if (!body?.id) throw new CoreError('deal id is required');
      // Idempotency: the client id is the dedup key — a lost-response retry
      // must never create a second deal.
      if (deps.engine!.store.getPair(body.id)) {
        return reply.code(202).ok({ id: body.id, duplicate: true });
      }
      const legSymbols = [body.a?.symbol, body.b?.symbol].filter((s): s is string => Boolean(s));
      if (legSymbols.some((s) => !isSupportedCoin(parseSymbol(s).base))) {
        return refuse(reply, {
          code: 400,
          category: 'symbol-invalid',
          message: COIN_NOT_SUPPORTED_TEXT,
          retryable: false,
        });
      }
      // What the deal is FOR picks its gate (ticket 19); nothing is read yet.
      const declared = classifyDealPurpose(body);
      if (!declared.ok) {
        return refuse(reply, { code: declared.status, category: 'validation', label: declared.label, message: declared.message, retryable: false });
      }
      if (rebalanceRunning()) return refuseForRebalance(reply, 'starting a deal');
      if (transferSettling()) return conflict(reply, TRANSFER_SETTLING_TEXT);
      const clients = deps.getClients();
      const getAccount = async () =>
        (
          await deps.cache.get('account', TTL.live, async () => (await clients.crossEx.getCrossexAccount()).body, {
            fresh: transferMoving(),
          })
        ).value;
      // Shares the `positions` cache key with GET /positions (the UI polls it every 4s),
      // so the preflight's netting read is normally already warm.
      const getPositions = async () =>
        (await deps.cache.get('positions', TTL.live, async () => (await clients.crossEx.listCrossexPositions()).body)).value ?? [];
      const refPriceA =
        body.execution === 'taker' && body.a?.symbol
          ? await deps.engine!.venue.refPrice(body.a.symbol.toUpperCase()).catch(() => null)
          : null;
      const row = await resolveDeal(clients, body, deps.engine!.clock.now(), {
        preflight: { getAccount, getPositions },
        refPriceA,
      });

      // A stand-alone open adds only where nothing is held or working — checked
      // on fresh reads BEFORE leverage is touched, and again (synchronously)
      // right before the write.
      const gated = declared.purpose === 'manual'
        ? [row.a, row.b].filter((leg): leg is NonNullable<typeof leg> => leg !== null && !leg.reduceOnly).map((leg) => leg.contract)
        : [];
      if (gated.length) {
        const gate = await manualGate(gated, {
          store: deps.engine!.store,
          readPositions: async () => (await clients.crossEx.listCrossexPositions()).body,
          readOpenOrders: async () => (await clients.crossEx.listCrossexOpenOrders({})).body,
        });
        if (!gate.ok) return refuseManual(reply, gate);
      }

      // Leverage phase: applied BEFORE the intent exists — a failure aborts with
      // nothing created and nothing sent (mirrors the abort-pre-send semantics).
      const levs: Array<{ contract: string; lev: unknown }> = [];
      if (body.leverage?.a) levs.push({ contract: row.a.contract, lev: body.leverage.a });
      if (body.leverage?.b && row.b) levs.push({ contract: row.b.contract, lev: body.leverage.b });

      // Validate EVERY leg before touching the venue, with the same rules the
      // sibling PUT /leverage/:symbol enforces. These arrived as raw JSON: with
      // no checks, {a: true} silently set 1x and {a: '50'} set 50x (setLeverage
      // coerces with String(Number(...))), and an over-max value could be
      // CLAMPED by the venue while create.ts's preflight sized initial margin
      // against the number we asked for — under-reserving, which is exactly how
      // a hedge leg gets rejected for margin and leaves the other leg naked.
      for (const { contract, lev } of levs) {
        if (typeof lev !== 'number' || !Number.isFinite(lev)) {
          throw new CoreError(`leverage for ${contract} must be a number`, 'validation');
        }
        const leverageMax = await leverageMaxFor(deps, contract, false);
        if (lev < 1 || lev > leverageMax) {
          throw new CoreError(
            `leverage ${lev}x must be between 1 and ${leverageMax}x for ${contract}`,
            'leverage',
          );
        }
      }

      // Apply, remembering each leg's previous value so a partial application can
      // be undone. Without this, leg A's leverage stayed changed after leg B's
      // call failed and the request returned "nothing was created": a user with
      // an existing position would have had its liquidation price moved without
      // ever seeing it, on a deal that was never created.
      const applied: Array<{ contract: string; prev: number }> = [];
      const readLeverage = async (contract: string): Promise<number> => {
        const { body: cur } = await clients.crossEx.getCrossexPositionsLeverage({ symbols: contract });
        return Number((cur as Record<string, unknown> | undefined)?.[contract] ?? 0);
      };
      const restoreLeverage = async () => {
        for (const { contract, prev } of applied.reverse()) {
          if (!Number.isFinite(prev) || prev < 1) continue; // nothing trustworthy to restore
          try {
            await setLeverage(clients.crossEx, contract, prev);
          } catch {
            /* best-effort: the refusal below is the one the user must see */
          }
        }
      };
      try {
        for (const { contract, lev } of levs) {
          let prev = 0;
          try {
            prev = await readLeverage(contract);
          } catch {
            /* can't read it → can't restore it; recorded as 0 and skipped below */
          }
          const set = await setLeverage(clients.crossEx, contract, lev as number);
          applied.push({ contract, prev });
          const replied = Number(set?.leverage);
          const confirmed = replied > 0 ? replied : await readLeverage(contract);
          if (!(confirmed >= (lev as number))) {
            throw new CoreError(`CrossEx set ${contract} to ${confirmed}x, not the ${lev}x asked`, 'leverage');
          }
        }
      } catch (err) {
        await restoreLeverage();
        throw new CoreError(
          `aborted before creating the deal: leverage set failed — ${(err as Error).message}`,
        );
      }

      // Again, with no await between here and the write: the checks above ran
      // before several reads, and a rebalance can have started during them.
      // A refusal here is the same outcome as a failed set — nothing created —
      // so the leverage just applied is put back the same way.
      if (rebalanceRunning()) {
        await restoreLeverage();
        return refuseForRebalance(reply, 'starting a deal');
      }
      if (transferSettling()) {
        await restoreLeverage();
        return conflict(reply, TRANSFER_SETTLING_TEXT);
      }
      const startedMeanwhile = activeDealsOn(deps.engine!.store, gated);
      if (startedMeanwhile.length) {
        await restoreLeverage();
        return refuseManual(reply, {
          ok: false,
          label: 'manual-conflict',
          message: `an unfinished deal started on ${gated.join(', ')} meanwhile (${startedMeanwhile.join(', ')}); nothing was created.`,
        });
      }
      deps.engine!.store.createPair({
        ...row,
        purpose: declared.purpose,
        purposeContext: declared.context ? JSON.stringify(declared.context) : null,
      });
      deps.cache.bust('account');
      deps.engine!.wake?.(); // first placement happens now, not after the tick sleep
      return reply.code(202).ok({ id: row.id });
    });

    app.get('/deals', async (req, reply) => {
      const q = req.query as { active?: string; limit?: string };
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
      const all = deps.engine!.store.listPairs(q.active === '1' ? { activeOnly: true } : undefined);
      const rows = all.slice(-limit).reverse();
      return reply.ok(rows.map((p) => dealView(deps, p)), { observedAt: Date.now(), coverageComplete: rows.length === all.length });
    });

    app.get('/deals/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const pair = deps.engine!.store.getPair(id);
      if (!pair) throw new CoreError(`unknown deal ${id}`);
      return reply.ok(dealView(deps, pair));
    });

    const requireDeal = (id: string): PairRow => {
      const pair = deps.engine!.store.getPair(id);
      if (!pair) throw new CoreError(`unknown deal ${id}`);
      return pair;
    };

    app.post('/deals/:id/convert', async (req, reply) => {
      const pair = requireDeal((req.params as { id: string }).id);
      if (pair.mode !== 'OPENING') {
        throw new CoreError(`deal ${pair.id} is not awaiting a maker fill (mode: ${pair.mode})`);
      }
      commands.convertNow(deps.engine!.store, pair.id);
      deps.engine!.wake?.();
      return reply.ok({ id: pair.id, mode: 'CONVERTING' });
    });

    app.post('/deals/:id/repeg', async (req, reply) => {
      const pair = requireDeal((req.params as { id: string }).id);
      if (pair.mode !== 'OPENING') {
        throw new CoreError(`deal ${pair.id} is not awaiting a maker fill (mode: ${pair.mode})`);
      }
      const body = (req.body ?? {}) as { price?: unknown };
      // The ONLY input this route takes is `price`. Extra body keys are ignored,
      // so there is no new user-adjustable entry point for policy, family or an
      // auto-follow flag — button, parameter and route count stay exactly as
      // they were.
      // An explicit price PINS the deal (pricePolicy 'fixed'). Without that, the
      // deal re-derives its price from the live book on the next placement, so
      // this route used to return 200 echoing the user's number while the engine
      // re-placed at whatever the market had moved to. The UI's own two buttons
      // say exactly this: "at YOUR price" vs "at the fresh same-side best".
      const explicit = body.price !== undefined && body.price !== null && String(body.price).trim() !== '';
      let price: string | null;
      if (explicit) {
        const n = Number(body.price);
        if (!Number.isFinite(n) || n <= 0) {
          throw new CoreError(`re-peg price "${String(body.price)}" is not a positive number`, 'validation');
        }
        // Snap to the venue tick, away from crossing — this price is going to REST.
        price = formatRestPrice(n, pair.a.side, pair.a.contract, pair.a.tick);
        if (!(Number(price) > 0)) {
          throw new CoreError(`re-peg price ${n} is below one tick (${pair.a.tick})`, 'validation');
        }
      } else {
        // Restore auto-follow. The price comes from the deal's OWN auto-follow
        // source, not a hardcoded quote fetch: a 'best' deal quotes at the bare
        // same-side best, an ordinary one one spread behind (the historical
        // 'touch'). Restoring a four-leg deal as 'touch' would silently swap its
        // quoting semantics for the old ones — the family policy is what says
        // which, and it is the only legitimate source (never venue/symbol/
        // position, and never an origin field).
        price =
          pair.autoPricePolicy === 'best'
            ? await deps.engine!.venue.bestQuote(pair.a.contract, pair.a.side, pair.a.tick)
            : await deps.engine!.venue.touch(pair.a.contract, pair.a.side, pair.a.tick);
      }
      // No fresh quote → FAIL, and say so. Writing the policy anyway would
      // silently turn auto-follow OFF (the deal would keep the retained price
      // and never follow again) — the opposite of what the user asked for. The
      // pre-existing "no fresh price, no execution" rule is preserved.
      if (!price) {
        throw new CoreError(
          'no fresh quote available — re-peg aborted (book unavailable). Auto-follow is unchanged.',
        );
      }
      commands.repeg(deps.engine!.store, pair.id, price, explicit ? 'fixed' : pair.autoPricePolicy);
      deps.engine!.wake?.();
      return reply.ok({ id: pair.id, price });
    });

    app.post('/deals/:id/stop', async (req, reply) => {
      const pair = requireDeal((req.params as { id: string }).id);
      if (pair.mode === 'DONE') throw new CoreError(`deal ${pair.id} is already done`);
      commands.stop(deps.engine!.store, pair.id);
      deps.engine!.wake?.();
      return reply.ok({ id: pair.id, mode: 'STOPPING' });
    });

    app.post('/deals/:id/resume', async (req, reply) => {
      const pair = requireDeal((req.params as { id: string }).id);
      if (pair.mode !== 'HALTED') throw new CoreError(`deal ${pair.id} is not halted (mode: ${pair.mode})`);
      if (rebalanceRunning()) return refuseForRebalance(reply, 'resuming a deal');
      commands.resumeAfterHalt(deps.engine!.store, pair.id);
      deps.engine!.wake?.();
      return reply.ok({ id: pair.id, mode: 'STOPPING' });
    });

    app.get('/alerts', async (req, reply) => {
      const q = req.query as { unacked?: string };
      return reply.ok(deps.engine!.store.listAlerts(q.unacked === '1' ? { unackedOnly: true } : undefined));
    });

    app.post('/alerts/:id/ack', async (req, reply) => {
      deps.engine!.store.ackAlert(Number((req.params as { id: string }).id));
      return reply.ok({ acked: true });
    });
  };
}
