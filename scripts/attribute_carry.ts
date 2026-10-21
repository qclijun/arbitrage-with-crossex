/**
 * Read-only attribution of realized carry income: CrossEx / Hyperliquid funding
 * fees versus Boros settlement, over one or more lookback windows.
 *
 * It answers "is this position actually earning?" without touching state: no
 * orders, no transfers, no ledger writes. Only the two read-only feeds below.
 *
 *   1. CrossEx account book (`listCrossexAccountBook`) — every statement the
 *      CrossEx account posted: FUNDING_FEE, TRADING_FEE, INTEREST_ISOLATED and
 *      TRANSFER_IN/OUT. Transfers are principal moves, never income, so they are
 *      counted separately and excluded from both net figures.
 *   2. The local Boros settlement ledger (`data/boros-ledger-<root>.json`, the
 *      same file risk_monitor.py reads). `settlementToken` is already net of its
 *      fee, so the fee is never subtracted twice.
 *
 * USD conversion: USDT/USDC at the project-wide 1:1 assumption; ETH/BTC at the
 * Gate spot last price observed by this run. That differs slightly from the
 * risk report, which prices collateral from Boros market metadata.
 *
 *   npx tsx scripts/attribute_carry.ts
 *   npx tsx scripts/attribute_carry.ts --hours 24,168 --equity 3813
 *   npx tsx scripts/attribute_carry.ts --json
 *
 * Exit codes: 0 = computed; 2 = computed but a window exceeds what a feed
 * covers (or paging hit its cap), so the totals for that window are partial;
 * 1 = query or config failure, do not read the numbers as a verdict.
 */
import { readFileSync } from 'node:fs';
import { makeClients } from '../src/core/clients';

const PAGE_LIMIT = 100;
const MAX_PAGES = 200;
const STABLE = new Set(['USDT', 'USDC']);
const TOKEN_SYMBOL: Record<string, { base: 'ETH' | 'BTC' | null; label: string }> = {
  '2': { base: 'ETH', label: 'ETH cross' },
  '1': { base: 'BTC', label: 'BTC cross' },
};

interface Row {
  statementType: string;
  exchangeType: string;
  coin: string;
  change: string;
  createTime: string;
}

interface LedgerRow {
  id: string;
  marketAcc: string;
  timeSec: number;
  settlementToken: string;
}

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const asJson = argv.includes('--json');
const windows = [...new Set((flag('--hours') ?? '24,72,168')
  .split(',')
  .map((h) => Number(h.trim()))
  .filter((h) => Number.isFinite(h) && h > 0))].sort((a, b) => a - b);
const equity = Number(flag('--equity'));

const fmt = (n: number, digits = 4) => (n >= 0 ? '+' : '') + n.toFixed(digits);
const stamp = (sec: number) =>
  new Date(sec * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Taipei', hour12: false });

/** Every statement in (from, to], paging until the feed is exhausted. */
async function fetchBook(c: ReturnType<typeof makeClients>, fromMs: number, toMs: number) {
  const rows: Row[] = [];
  let page = 1;
  let truncated = false;
  for (; page <= MAX_PAGES; page += 1) {
    const res = await c.crossEx.listCrossexAccountBook({ limit: PAGE_LIMIT, page, from: fromMs, to: toMs });
    const batch = (res.body ?? []) as unknown as Row[];
    if (batch.length === 0) break;
    for (const r of batch) {
      const t = Number(r.createTime);
      if (!Number.isFinite(t)) continue;
      if (t > fromMs && t <= toMs) rows.push(r);
    }
    if (batch.length < PAGE_LIMIT) break;
    if (page === MAX_PAGES) truncated = true;
  }
  return { rows, truncated };
}

/** Gate spot last price; the same quote the terminal treats as ~spot. */
async function spotPrices(c: ReturnType<typeof makeClients>) {
  const out: Record<string, number> = {};
  for (const base of ['ETH', 'BTC']) {
    const res = await c.spot.listTickers({ currencyPair: `${base}_USDT` });
    const last = Number((res.body?.[0] as { last?: string } | undefined)?.last);
    if (!Number.isFinite(last) || last <= 0) throw new Error(`no spot price for ${base}_USDT`);
    out[base] = last;
  }
  return out;
}

function loadLedger(root: string) {
  const path = `data/boros-ledger-${root.toLowerCase()}.json`;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { rows?: LedgerRow[] };
  const seen = new Set<string>();
  const rows: LedgerRow[] = [];
  for (const r of raw.rows ?? []) {
    if (!r || typeof r.id !== 'string' || seen.has(r.id)) continue;
    const sec = Number(r.timeSec);
    const amt = Number(r.settlementToken);
    if (!Number.isFinite(sec) || sec <= 0 || !Number.isFinite(amt)) continue;
    seen.add(r.id);
    rows.push(r);
  }
  return rows;
}

async function main() {
  if (windows.length === 0) throw new Error('--hours needs at least one positive number');
  const maxHours = windows[windows.length - 1];
  const nowSec = Math.floor(Date.now() / 1000);
  const maxFromMs = (nowSec - maxHours * 3600) * 1000;
  const cfg = JSON.parse(readFileSync('data/risk-monitor/config.json', 'utf8')) as { root?: string };
  const root = (cfg.root ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(root)) throw new Error('config root is not a 20-byte address');

  const c = makeClients();
  const [book, prices, ledger] = await Promise.all([
    fetchBook(c, maxFromMs, nowSec * 1000),
    spotPrices(c),
    Promise.resolve(loadLedger(root)),
  ]);

  // tokenId is a hex byte in the packed handle; normalise '02' -> '2'.
  const norm = (tokenId: string) => (/^[0-9a-f]{2}$/.test(tokenId) ? String(parseInt(tokenId, 16)) : tokenId);
  const price = (tokenId: string) => (norm(tokenId) === '2' ? prices.ETH : norm(tokenId) === '1' ? prices.BTC : 0);

  const report = windows.map((hours) => {
    const fromSec = nowSec - hours * 3600;
    const fromMs = fromSec * 1000;

    const funding = new Map<string, number>();
    const fees = new Map<string, number>();
    const interest = new Map<string, number>();
    const unsupported = new Set<string>();
    let transfers = 0;
    for (const r of book.rows) {
      const t = Number(r.createTime);
      if (!(t > fromMs && t <= nowSec * 1000)) continue;
      if (r.statementType === 'TRANSFER_IN' || r.statementType === 'TRANSFER_OUT') {
        transfers += 1;
        continue;
      }
      if (!STABLE.has(r.coin)) {
        unsupported.add(r.coin);
        continue;
      }
      const venue = r.exchangeType || 'UNKNOWN';
      const usd = Number(r.change);
      const bucket = r.statementType.startsWith('FUNDING')
        ? funding
        : r.statementType.startsWith('TRADING')
          ? fees
          : r.statementType.startsWith('INTEREST')
            ? interest
            : null;
      if (!bucket) continue;
      bucket.set(venue, (bucket.get(venue) ?? 0) + usd);
    }

    const sums = (m: Map<string, number>) => [...m.entries()].map(([venue, usd]) => ({ venue, usd }));
    const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    const fundingUsd = total(funding);

    const pools = new Map<string, { tokenId: string; native: number; events: number; firstSec: number }>();
    for (const r of ledger) {
      const sec = Number(r.timeSec);
      if (sec <= fromSec || sec > nowSec) continue;
      const acc = String(r.marketAcc ?? '').toLowerCase();
      // 0x · root(40) · accountId(4) · tokenId(2) · marketId(6)
      const tokenId = /^0x[0-9a-f]{40}[0-9a-f]{4}([0-9a-f]{2})[0-9a-f]{6}$/.exec(acc)?.[1] ?? '??';
      const key = `${tokenId}:${acc.slice(-6)}`;
      const p = pools.get(key) ?? { tokenId, native: 0, events: 0, firstSec: sec };
      p.native += Number(r.settlementToken);
      p.events += 1;
      p.firstSec = Math.min(p.firstSec, sec);
      pools.set(key, p);
    }
    const borosPools = [...pools.entries()].map(([key, p]) => {
      const q = price(p.tokenId);
      return {
        pool: TOKEN_SYMBOL[norm(p.tokenId)]?.label ?? `tokenId ${p.tokenId} (${key})`,
        tokenId: p.tokenId,
        native: p.native,
        usd: p.native * q,
        // No quote for this token: the USD total would silently understate.
        unknownPrice: q === 0,
        events: p.events,
        firstEventSec: p.firstSec,
      };
    });
    const borosUsd = borosPools.reduce((a, p) => a + p.usd, 0);

    const ledgerSpanSec = ledger.length > 0 ? Math.min(...ledger.map((r) => Number(r.timeSec))) : null;
    const ledgerPartial = ledgerSpanSec === null || ledgerSpanSec > fromSec;
    const netExclFees = fundingUsd + borosUsd;
    const netInclFees = netExclFees + total(fees) + total(interest);
    const perDay = (netInclFees * 24) / hours;

    return {
      hours,
      fromSec,
      toSec: nowSec,
      funding: { byVenue: sums(funding), usd: fundingUsd },
      tradingFee: { byVenue: sums(fees), usd: total(fees) },
      interest: { byVenue: sums(interest), usd: total(interest) },
      boros: { pools: borosPools, usd: borosUsd, partial: ledgerPartial, firstEventSec: ledgerSpanSec },
      netExclFeesUsd: netExclFees,
      netInclFeesUsd: netInclFees,
      perDayUsd: perDay,
      annualizedOnEquity: Number.isFinite(equity) && equity > 0 ? (perDay * 365) / equity : null,
      excludedTransfers: transfers,
      unsupportedCoins: [...unsupported],
    };
  });

  const partial =
    report.some(
      (r) => r.boros.partial || r.unsupportedCoins.length > 0 || r.boros.pools.some((p) => p.unknownPrice),
    ) || book.truncated;
  if (asJson) {
    console.log(JSON.stringify({ observedAt: nowSec, prices, equityUsd: Number.isFinite(equity) ? equity : null, truncated: book.truncated, partial, windows: report }, null, 2));
  } else {
    console.log(`资金费 vs Boros 结算归因  快照 ${stamp(nowSec)}（台北）`);
    console.log(`价格：ETH ${prices.ETH} / BTC ${prices.BTC}（Gate 现货最新价）· USDT/USDC 按 1:1`);
    for (const w of report) {
      console.log(`\n【${w.hours}h】${stamp(w.fromSec)} → ${stamp(w.toSec)}`);
      for (const f of w.funding.byVenue) console.log(`  ${f.venue.padEnd(12)} 资金费 ${fmt(f.usd)} USD`);
      console.log(`  ${''.padEnd(12)} 小计   ${fmt(w.funding.usd)} USD`);
      for (const p of w.boros.pools) {
        console.log(`  ${p.pool.padEnd(12)} 结算   ${fmt(p.usd)} USD  (${p.native.toPrecision(6)} 原生币, ${p.events} 次)`);
      }
      console.log(`  ${''.padEnd(12)} 小计   ${fmt(w.boros.usd)} USD`);
      console.log(`  ── 毛净收益（资金费+结算）      ${fmt(w.netExclFeesUsd)} USD`);
      console.log(`  ── 交易手续费                  ${fmt(w.tradingFee.usd)} USD`);
      console.log(`  ── 借款利息                    ${fmt(w.interest.usd)} USD`);
      console.log(`  ══ 扣除费用后                  ${fmt(w.netInclFeesUsd)} USD  （日均 ${fmt(w.perDayUsd)}）`);
      if (w.annualizedOnEquity !== null) console.log(`     折权益年化 ${(w.annualizedOnEquity * 100).toFixed(1)}%（权益 ${equity}）`);
      if (w.excludedTransfers > 0) console.log(`     已排除 ${w.excludedTransfers} 笔划转（本金移动，不计收益）`);
      if (w.unsupportedCoins.length > 0) console.log(`     ⚠ 未折算币种：${w.unsupportedCoins.join(', ')}（已跳过，合计偏低）`);
      for (const p of w.boros.pools.filter((x) => x.unknownPrice)) {
        console.log(`     ⚠ ${p.pool} 无可用价：${p.native.toPrecision(6)} 原生币未折算成 USD`);
      }
      if (w.boros.partial) console.log(`     ⚠ Boros 账本覆盖不足：最早记录 ${w.boros.firstEventSec ? stamp(w.boros.firstEventSec) : '缺失'}，本窗口结算可能不完整`);
    }
    console.log(`\n结论：读数为已实现收付，不含未结算浮盈亏；单窗口样本不足以外推年化。${partial ? ' 存在覆盖缺口，见上方 ⚠。' : ''}`);
  }
  // exitCode, not exit(): a piped stdout write must drain before the process ends.
  process.exitCode = partial ? 2 : 0;
}

main().catch((err) => {
  console.error(`归因失败：${(err as Error).message}`);
  process.exit(1);
});
