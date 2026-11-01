/** Production discovery shares one native/identity snapshot with legOf and history. */
import { mapFundingContracts, type FundingRuleSymbol, type NativeFundingContract } from './contract-identity';
import { createOfficialPublicReader, type PublicRead } from './official-public';
import { OFFICIAL_INSTRUMENT_VENUES, readOfficialInstruments } from './official-instruments';
import type { FundingHistoryLeg, FundingRuleSegment } from './history';

export function createOfficialFundingCatalog(opts: { rules: () => Promise<FundingRuleSymbol[]>; read?: PublicRead }) {
  const read = opts.read ?? createOfficialPublicReader();
  let native: NativeFundingContract[] = [];
  return {
    async contracts() {
      const rules = await opts.rules();
      if (!Array.isArray(rules)) throw new Error('invalid-crossex-rules');
      const venues = [...new Set(rules.filter((r) => r.businessType === 'FUTURE' && r.state === 'live'
        && (r.delistTime === '0' || r.delistTime == null)).map((r) => r.exchangeType))];
      const results = await Promise.allSettled(venues.map((venue) => readOfficialInstruments(venue, read)));
      native = results.flatMap((r) => r.status === 'fulfilled' ? r.value : []);
      const discovery = mapFundingContracts(rules, native);
      for (const rejection of discovery.rejected) {
        const venue = rules.find((r) => r.symbol === rejection.symbol)?.exchangeType;
        const index = venues.indexOf(venue ?? '');
        if (index >= 0 && results[index]?.status === 'rejected') {
          rejection.reason = OFFICIAL_INSTRUMENT_VENUES.includes(venue!) ? 'native-source-failed' : 'native-source-unwired';
        }
      }
      return discovery;
    },
    historyContext(venue: string, contractId: string): { listing: FundingHistoryLeg['listing']; rules: FundingRuleSegment[] } | null {
      const hits = native.filter((n) => n.venue === venue && n.contractId === contractId && n.live);
      if (hits.length !== 1) return null;
      // Current instrument descriptions do not establish historical cadence.
      // The official history source adds separately reviewed policies after
      // this native-contract check; metadata itself is never backdated.
      const rules: FundingRuleSegment[] = [];
      return { listing: hits[0]!.listing, rules };
    },
  };
}
