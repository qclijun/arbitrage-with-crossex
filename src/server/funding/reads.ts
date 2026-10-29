/**
 * The read-only venue surface a funding preview and its acceptance consult
 * (ticket 12). Every method is one fresh read — no cache, no write — and
 * throws on failure; the caller turns a throw into UNKNOWN, never a pass.
 */
import type { CrossexAccount, CrossexInterestRate, Symbol as RuleSymbol } from 'gate-api';
import type { Clients } from '../../core/clients';
import { fetchVenueBookWithDiagnostics, type VenueBookResult } from '../../core/estimate/books';
import type { VenueFeeRow } from '../../core/estimate/fees';
import { getLeverageMax } from '../../core/orders';

export interface FundingReads {
  rules(symbols: string[]): Promise<RuleSymbol[]>;
  /** Highest settable leverage per symbol. */
  leverageMax(symbols: string[]): Promise<Map<string, number>>;
  /** Current leverage per symbol — a signed read. */
  leverage(symbols: string[]): Promise<Record<string, unknown>>;
  fees(): Promise<VenueFeeRow[]>;
  book(exchange: string, base: string, quote: string): Promise<VenueBookResult>;
  account(): Promise<CrossexAccount>;
  interestRates(): Promise<CrossexInterestRate[]>;
  positions(): Promise<unknown>;
  openOrders(): Promise<unknown>;
  /** Gate spot book top for a pair such as USDC_USDT, with the venue's own
   * time for it (ms); null when the venue gave none. */
  spotTop(pair: string): Promise<{ bid: string; ask: string; at: number | null }>;
}

export function gateFundingReads(getClients: () => Clients): FundingReads {
  const crossEx = () => getClients().crossEx;
  return {
    rules: async (symbols) => (await crossEx().listCrossexRuleSymbols({ symbols: symbols.join(',') })).body ?? [],
    leverageMax: (symbols) => getLeverageMax(crossEx(), symbols),
    leverage: async (symbols) => (await crossEx().getCrossexPositionsLeverage({ symbols: symbols.join(',') })).body ?? {},
    fees: async () => (await crossEx().getCrossexFee()).body as VenueFeeRow[],
    book: fetchVenueBookWithDiagnostics,
    account: async () => (await crossEx().getCrossexAccount()).body,
    interestRates: async () => (await crossEx().getCrossexInterestRate()).body ?? [],
    positions: async () => (await crossEx().listCrossexPositions()).body,
    openOrders: async () => (await crossEx().listCrossexOpenOrders({})).body,
    spotTop: async (pair) => {
      const { body } = await getClients().spot.listOrderBook(pair, { limit: 1 });
      const bid = body.bids?.[0]?.[0];
      const ask = body.asks?.[0]?.[0];
      if (!bid || !ask) throw new Error(`${pair} book is one-sided`);
      const at = Number(body.current);
      return { bid, ask, at: Number.isSafeInteger(at) && at > 0 ? at : null };
    },
  };
}
