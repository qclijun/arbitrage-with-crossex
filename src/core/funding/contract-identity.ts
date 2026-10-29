/** CrossEx/native corroboration and separately evidenced economic identity. No aliases. */
import { parseSymbol } from '../numbers';
import { nativeFundingId, reviewedContractEvidence } from './contract-evidence';
import type { FundingContractListing } from './market';
import type { FundingHistoryLeg } from './history';

export interface FundingRuleSymbol {
  symbol: string; exchangeType: string; businessType: string; state: string; delistTime?: string | null;
}
export interface NativeFundingContract {
  venue: string; contractId: string; base: string; quote: string; linear: boolean; live: boolean;
  listing: FundingHistoryLeg['listing']; evidence: string;
}
export interface FundingMappingRejection { symbol: string; reason: string; }
export interface FundingContractDiscovery { listings: FundingContractListing[]; rejected: FundingMappingRejection[]; }
const GATE_SPEC = 'https://www.gate.com/docs/developers/apiv4/en/crossex/#query-symbol-information';

export function mapFundingContracts(rules: FundingRuleSymbol[], native: NativeFundingContract[]): FundingContractDiscovery {
  const listings: FundingContractListing[] = [];
  const rejected: FundingMappingRejection[] = [];
  for (const rule of rules) {
    if (rule.businessType !== 'FUTURE' || rule.state !== 'live' || (rule.delistTime !== '0' && rule.delistTime != null)) continue;
    if (rules.filter((r) => r.symbol === rule.symbol).length !== 1) {
      rejected.push({ symbol: rule.symbol, reason: 'crossex-symbol-ambiguous' });
      continue;
    }
    const p = parseSymbol(rule.symbol);
    const expectedId = nativeFundingId(p.exchange, p.base, p.quote);
    const hits = native.filter((n) => n.venue === p.exchange && n.base === p.base && n.quote === p.quote && n.contractId === expectedId && n.live && n.linear && n.evidence);
    if (p.business !== 'FUTURE' || p.exchange !== rule.exchangeType || hits.length !== 1) {
      rejected.push({ symbol: rule.symbol, reason: hits.length > 1 ? 'native-contract-ambiguous' : 'native-contract-unverified' });
      continue;
    }
    const n = hits[0]!;
    listings.push({ venue: n.venue, contractId: n.contractId, symbol: rule.symbol, mappingEvidence: `${GATE_SPEC}; ${n.evidence}`,
      ...reviewedContractEvidence(n.venue, n.contractId, n.base, `${GATE_SPEC}; ${n.evidence}`) });
  }
  return { listings, rejected };
}
