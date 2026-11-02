/**
 * The read-only venue surface a funding preview and its acceptance consult
 * (ticket 12). Every method is one fresh read — no cache, no write — and
 * throws on failure; the caller turns a throw into UNKNOWN, never a pass.
 */
import type { CrossexAccount, CrossexInterestRate, Symbol as RuleSymbol } from 'gate-api';
import type { Clients } from '../../core/clients';
import { fetchVenueBookWithDiagnostics, type VenueBookResult } from '../../core/estimate/books';
import type { VenueFeeRow } from '../../core/estimate/fees';
import { getPositionLimits } from '../../core/orders';

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
}

export function gateFundingReads(getClients: () => Clients): FundingReads {
  const crossEx = () => getClients().crossEx;
  return {
    rules: async (symbols) => (await crossEx().listCrossexRuleSymbols({ symbols: symbols.join(',') })).body ?? [],
    // The top tier's leverage; a symbol with no tiers is left out.
    leverageMax: async (symbols) => {
      const out = new Map<string, number>();
      for (const [symbol, limit] of await getPositionLimits(crossEx(), symbols)) if (limit) out.set(symbol, limit.leverage);
      return out;
    },
    leverage: async (symbols) => (await crossEx().getCrossexPositionsLeverage({ symbols: symbols.join(',') })).body ?? {},
    fees: async () => (await crossEx().getCrossexFee()).body as VenueFeeRow[],
    book: fetchVenueBookWithDiagnostics,
    account: async () => (await crossEx().getCrossexAccount()).body,
    interestRates: async () => (await crossEx().getCrossexInterestRate()).body ?? [],
    positions: async () => (await crossEx().listCrossexPositions()).body,
    openOrders: async () => (await crossEx().listCrossexOpenOrders({})).body,
  };
}
