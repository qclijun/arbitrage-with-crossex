// PROTOTYPE ONLY. Invented fixtures; no live observations or account data.
export type WindowDays = 7 | 30 | 90 | 180 | 365;
export const windows: WindowDays[] = [7, 30, 90, 180, 365];
export type Leg = {
  venue: string;
  contract: string;
  quote: string;
  current: string;
  price: string;
};
export type Candidate = {
  id: string;
  asset: string;
  short: Leg;
  long: Leg;
  apr: (string | null)[];
  supported: boolean;
  unitComparable?: boolean;
  reason?: string;
  missing?: string;
};

const leg = (
  venue: string,
  contract: string,
  current: string,
  price: string,
  quote = 'USDT',
): Leg => ({ venue, contract, current, price, quote });
const ethHl = leg('Hyperliquid', 'ETH-PERP', '+0.0006% / 1h', '3500');
const ethBn = leg('Binance', 'ETHUSDT', '+0.0080% / 8h', '3495');
const ethBy = leg('Bybit', 'ETHUSDT', '+0.0040% / 8h', '3498');
const btcOk = leg('OKX', 'BTC-USDT-SWAP', '+0.0100% / 8h', '68000');
const btcBn = leg('Binance', 'BTCUSDT', '+0.0040% / 8h', '67950');

function pair(
  id: string,
  asset: string,
  short: Leg,
  long: Leg,
  apr: (string | null)[],
  extra: Partial<Candidate> = {},
): Candidate {
  return {
    id,
    asset,
    short,
    long,
    apr,
    supported: ['ETH', 'BTC', 'HYPE'].includes(asset),
    ...extra,
  };
}
const forwards: Candidate[] = [
  pair('eth-hl-bn', 'ETH', ethHl, ethBn, ['4.8000', '7.2000', '6.2000', '5.0000', null]),
  pair('eth-hl-by', 'ETH', ethHl, ethBy, ['3.1000', '4.1000', '4.9000', '3.8000', null]),
  pair('eth-bn-by', 'ETH', ethBn, ethBy, ['-1.7000', '-3.1000', '-1.3000', '-1.2000', '0.8000']),
  pair('btc-ok-bn', 'BTC', btcOk, btcBn, ['6.2000', '5.4000', '4.0000', '3.0000', '2.1000']),
  pair(
    'hype-by-hl',
    'HYPE',
    leg('Bybit', 'HYPEUSDT', '+0.0100% / 8h', '40'),
    leg('Hyperliquid', 'HYPE-PERP', '+0.0012% / 1h', '39.98'),
    ['0.0000', '0.0000', '1.2000', null, null],
  ),
  pair(
    'sol-ok-bn',
    'SOL',
    leg('OKX', 'SOL-USDT-SWAP', '+0.0200% / 8h', '180'),
    leg('Binance', 'SOLUSDT', '+0.0010% / 8h', '179.9'),
    ['9.0000', '11.2000', '8.1000', '7.0000', '6.0000'],
    { reason: 'SOL不在首版执行白名单，仅观察' },
  ),
  pair(
    'new-by-bn',
    'NEW',
    leg('Bybit', 'NEWUSDT', '+0.0100% / 8h', '2'),
    leg('Binance', 'NEWUSDT', '+0.0020% / 8h', '2'),
    ['15.0000', null, null, null, null],
    { missing: '上线12天；30天及更长窗口不足', reason: 'NEW不在首版执行白名单' },
  ),
  pair(
    'btc-stable',
    'BTC',
    btcOk,
    leg('Bybit', 'BTCUSDC', '+0.0030% / 8h', '67940', 'USDC'),
    ['5.0000', '4.6000', '3.0000', null, null],
    { reason: '历史口径可比；共同计价/可验证换汇证据缺失，金额UNKNOWN' },
  ),
  pair(
    'pepe-scaled',
    'PEPE',
    leg('Bybit', '1000PEPEUSDT', '+0.0100% / 8h', '0.01'),
    leg('Binance', 'PEPEUSDT', '+0.0030% / 8h', '0.00001'),
    ['8.0000', '10.0000', '7.0000', null, null],
    { unitComparable: false, reason: '1000PEPE / PEPE单位不同，仅历史观察；扫描归一化不授权执行' },
  ),
  pair(
    'eth-gate-bn',
    'ETH',
    leg('Gate', 'ETH_USDT', 'UNKNOWN', '3500'),
    ethBn,
    [null, null, null, null, null],
    { missing: 'Gate采集失败；本组合UNKNOWN，其他场所继续排名' },
  ),
  pair(
    'eth-x-bn',
    'ETH',
    leg('Venue X', 'ETH-PERP', 'UNKNOWN', '3500'),
    ethBn,
    [null, null, null, null, null],
    { missing: '该场所未证明历史结算周期，不能补零' },
  ),
];

export const candidates: Candidate[] = forwards.flatMap((p) => [
  p,
  {
    ...p,
    id: `${p.id}-reverse`,
    short: p.long,
    long: p.short,
    apr: p.apr.map((r) => (r === null || fixed(r) === 0n ? r : decimal(-fixed(r), 4))),
  },
]);

export const situations = [
  ['normal', '完整演示证据'],
  ['stale', '历史快照过期'],
  ['fees', '真实账户费率缺失'],
  ['depth', '盘口深度不足'],
  ['ownership', '场外改仓 / 归属差异'],
  ['opposite', '相反旧净仓 / 会先减旧仓'],
  ['conflict', '同合约活动执行冲突'],
] as const;
export type Situation = (typeof situations)[number][0];

// Six-place decimal strings at the boundary; exact integer arithmetic for mock amounts.
export function fixed(value: string): bigint {
  if (!/^-?\d+(\.\d{1,6})?$/.test(value)) return 0n;
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  return (
    (value.startsWith('-') ? -1n : 1n) *
    (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0')))
  );
}
export function decimal(value: bigint, places = 2): string {
  const abs = value < 0n ? -value : value;
  const unit = 10n ** BigInt(6 - places);
  const rounded = ((abs + unit / 2n) / unit) * unit;
  return `${value < 0n && rounded > 0n ? '-' : ''}${rounded / 1_000_000n}.${(rounded % 1_000_000n).toString().padStart(6, '0').slice(0, places)}`;
}
export function scaled(a: string, b: string): bigint {
  return (fixed(a) * fixed(b)) / 1_000_000n;
}
export function rankValue(p: Candidate, days: WindowDays): string | null {
  return p.apr[windows.indexOf(days)];
}
export function identity(p: Candidate): string {
  return `${p.asset}:${p.short.venue}/${p.short.contract}:${p.long.venue}/${p.long.contract}`;
}

export function currentReversed(p: Candidate, days: WindowDays): boolean {
  const rate = rankValue(p, days);
  const parse = (leg: Leg) => leg.current.match(/^([+-]?[\d.]+)% \/ (\d+)h$/);
  const s = parse(p.short),
    l = parse(p.long);
  if (rate === null || !s || !l || fixed(rate) === 0n) return false;
  const difference =
    fixed(s[1].replace('+', '')) * BigInt(l[2]) - fixed(l[1].replace('+', '')) * BigInt(s[2]);
  return difference !== 0n && difference > 0n !== fixed(rate) > 0n;
}
