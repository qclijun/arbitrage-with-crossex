/** Reviewed default-HyperCore BTC/ETH policy; not a policy for HIP-3 or other assets. */
export interface HyperliquidHourlyPolicy {
  version: string;
  /** Reviewed coverage lower bound, not the rule's original introduction date. */
  from: number;
  archive: { url: string; capturedAt: number; sha256: string; cdxDigest: string };
  current: { url: string; sha256: string };
  listedBy: Partial<Record<'BTC' | 'ETH', { request: string; responseHash: string; raw: Record<string, unknown> }>>;
}

/**
 * Reviewed 2026-10-31. The Jan-2025 official-page payload's SHA-1 matches
 * Wayback's CDX digest. Both that archived policy and the pinned current
 * policy specify asset-independent hourly funding. The reviewed scope starts
 * at the archive observation, never at an invented launch/effective date.
 * A new current-document digest requires review; it never silently passes.
 */
export const HYPERLIQUID_HOURLY_POLICY: HyperliquidHourlyPolicy = {
  version: 'hl-native-btc-eth-hourly-2026-10-31-v1',
  from: Date.UTC(2025, 0, 25, 13, 42, 3),
  archive: {
    url: 'https://web.archive.org/web/20250125134203id_/https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding',
    capturedAt: Date.UTC(2025, 0, 25, 13, 42, 3),
    sha256: '998477d7e90d643ee325f57361a8bff5c3f81232e440c3d94d520b894913c900',
    cdxDigest: '36GMRBVHHWZBCRIC5FDT7AAKQRLW5WXW',
  },
  current: {
    url: 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding.md',
    sha256: '126d1a0489517bad351787542d555a0de25339c69fd544a0d8d283ae172d234c',
  },
  listedBy: {
    BTC: {
      request: 'POST https://api.hyperliquid.xyz/info {"type":"fundingHistory","coin":"BTC","startTime":0,"endTime":1735689600000}',
      responseHash: 'aff6213fba21d02999686abd7f69f427f67233fe856359876c1ff98815db7999',
      raw: { coin: 'BTC', fundingRate: '-0.0006133368', premium: '-0.0009133368', time: 1683849600048 },
    },
    ETH: {
      request: 'POST https://api.hyperliquid.xyz/info {"type":"fundingHistory","coin":"ETH","startTime":0,"endTime":1735689600000}',
      responseHash: 'a90be3d7dd565c3f2a47bca535888d8a5f82f0931eb69ceaf00aab25df19e089',
      raw: { coin: 'ETH', fundingRate: '0.0000863563', premium: '-0.0002136437', time: 1683849600048 },
    },
  },
};
