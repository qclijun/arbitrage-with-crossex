/** Fresh read-only sources, separate from account PnL/history aggregation. */
import type { Clients } from '../core/clients';
import { BOROS_TOKEN_SYMBOLS, fetchBorosCollaterals, fetchBorosMarkets, resolveBorosFetch, type FetchLike } from '../core/boros/client';
import { formatDecimal18, parseDecimal18, rawInteger18ToDecimal } from '../core/boros/decimal18';
import { fx } from '../engine/fx';
import type { ClaimBoros, ClaimEvidence } from '../engine/claim-types';
import { signedPositions } from './livePositions';
import { loggedInRoot } from './borosRebate';

export function claimReader(getClients: () => Clients, now: () => number, borosFetch?: FetchLike, ownerRoot = loggedInRoot) {
  return async (input: { root?: string }): Promise<ClaimEvidence> => {
    const readAt = now();
    const crossEx = getClients().crossEx;
    const [positions, orders, rules] = await Promise.all([
      crossEx.listCrossexPositions().then((r) => r.body),
      crossEx.listCrossexOpenOrders({}).then((r) => r.body),
      crossEx.listCrossexRuleSymbols({}).then((r) => r.body),
    ]);
    if (!Array.isArray(positions) || !Array.isArray(orders) || !Array.isArray(rules)) throw new Error('Incomplete current account evidence.');
    const sides = new Map<string, Set<string>>();
    for (const p of positions) {
      if (!p.symbol || typeof p.positionQty !== 'string' || !['LONG', 'SHORT', 'BOTH', undefined].includes(p.positionSide)) throw new Error('Incomplete position identity or quantity.');
      const q = fx(p.positionQty);
      if (q !== 0n) {
        const s = sides.get(p.symbol) ?? new Set<string>();
        s.add(p.positionSide === 'SHORT' || (p.positionSide !== 'LONG' && q < 0n) ? 'short' : 'long');
        sides.set(p.symbol, s);
        if (s.size > 1) throw new Error('Opposite positions cannot be netted into an ownership proof.');
      }
    }
    if (orders.some((o) => !o.symbol)) throw new Error('Open-order identity missing.');
    const boros: ClaimBoros[] = [];
    if (input.root) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(input.root)) throw new Error('Select an exact Boros root address.');
      if (ownerRoot()?.toLowerCase() !== input.root.toLowerCase()) throw new Error('Boros ownership requires the connected owner root.');
      const accountId = Number(process.env.BOROS_ACCOUNT_ID ?? 0);
      if (!Number.isInteger(accountId) || accountId < 0 || accountId > 255) throw new Error('Invalid Boros account id.');
      const fetcher = resolveBorosFetch(borosFetch);
      const markets = await fetchBorosMarkets(fetcher);
      const zones = await fetchBorosCollaterals(fetcher, input.root, markets, accountId, true);
      for (const zone of zones) for (const group of [zone.cross, ...zone.isolated]) {
        if (!group) continue;
        if (group.positionsComplete !== true) throw new Error('Boros positions incomplete.');
        for (const p of group.marketPositions) {
          const m = markets.find((x) => x.marketId === p.marketId);
          const qty = rawInteger18ToDecimal(p.notionalSize);
          if (!m || !group.marketAcc || qty === null || ![0, 1].includes(p.side) || p.hasRestingOrders || p.ordersComplete !== true) throw new Error('Boros identity, quantity or occupancy unproven.');
          const signed = parseDecimal18(qty);
          if (signed === null) throw new Error('Boros quantity unreadable.');
          if (!signed) continue;
          // A collateral-token notional is a base quantity only for a native
          // book. Never use an unproven FX/mark conversion as exact ownership.
          if (m.tokenId !== zone.tokenId) throw new Error('Boros collateral account and market identity conflict.');
          const unit = BOROS_TOKEN_SYMBOLS[zone.tokenId] === m.base ? 'base' : `collateral:${BOROS_TOKEN_SYMBOLS[zone.tokenId] ?? zone.tokenId}`;
          if ((p.side === 0) !== (signed > 0n)) throw new Error('Boros direction conflicts with size.');
          const side = p.side === 0 ? 'long' : 'short';
          const sources: ClaimBoros['sources'] = m.spreadVenues
            ? [{ venue: m.spreadVenues[0], side }, { venue: m.spreadVenues[1], side: side === 'long' ? 'short' : 'long' }]
            : [{ venue: m.venue, side }];
          const root = input.root.toLowerCase();
          boros.push({ key: `${root}:${accountId}:${group.marketAcc}:${m.marketId}`, root, accountId,
            marketAcc: group.marketAcc, marketId: m.marketId, base: m.base, maturity: m.maturity,
            qty: formatDecimal18(signed < 0n ? -signed : signed), unit, sources });
        }
      }
    }
    return { readAt, positions: Object.fromEntries(signedPositions(positions)),
      contracts: rules.filter((r) => r.state === 'live' && r.businessType === 'FUTURE' && r.symbol).map((r) => r.symbol!),
      openOrders: orders.map((o) => o.symbol!.toUpperCase()), boros: input.root ? boros : null };
  };
}
