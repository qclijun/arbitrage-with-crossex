/**
 * Read-only check of gate G: does the venue's roll-over builder make every
 * leg FOK? It asks the venue's calldata builders for calldata and decodes it.
 * It never signs and never submits: this file has no key and no /send-txs call.
 *
 * The method needs no ABI. Build the same place-order twice, once with
 * tif=IOC(1) and once with tif=FOK(2). The word that differs is the TIF slot.
 * Every roll-over call has to use the same selector and carry 2 in that slot.
 *
 *   npx tsx scripts/verify_roll_fok.ts
 */
import { readFileSync } from 'node:fs';
import { parseUnits, toHex, type Hex } from 'viem';

const API = 'https://api-boros.pendle.finance/apis/v1';
const ROUTER = '0x8080808080daB95eFED788a9214e400ba552DEf6'; // web/src/lib/borosNetwork.ts
const cfg = JSON.parse(readFileSync('data/risk-monitor/config.json', 'utf8'));
const ROOT = cfg.root as Hex;
const TOKEN_ID = Number(cfg.collateral_token_id); // 2 = ETH
const CROSS_MARKET_ID = 0xffffff;
const SIZE = parseUnits('3.9888313', 18).toString();
// old -> new, same venue and side (src/core/boros/rollover.ts rollPlanFor)
const LEGS = [
  { fromMarketId: 198, toMarketId: 213 }, // OKX long
  { fromMarketId: 196, toMarketId: 209 }, // HL short
];
const TIF_IOC = 1;
const TIF_FOK = 2;

// root (20B) · accountId (1B) · tokenId (2B) · marketId (3B), as packMarketAcc
const marketAcc = toHex((BigInt(ROOT) << 48n) | (0n << 40n) | (BigInt(TOKEN_ID) << 24n) | BigInt(CROSS_MARKET_ID), { size: 26 });

const post = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json as T;
};

const split = (calldata: Hex) => ({
  selector: calldata.slice(0, 10),
  words: (calldata.slice(10).match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`)),
});

const placeOrder = async (tif: number): Promise<Hex> => {
  const { calls } = await post<{ calls: Array<{ calldata: Hex }> }>('/calldata-builder/agent/place-order', {
    marketAcc,
    marketId: 198,
    side: 1, // SHORT: the close of the 198 long
    size: SIZE,
    tif,
    rate: 0.03,
    ammId: 0,
  });
  if (!calls?.[0]?.calldata) throw new Error('place-order builder returned no calldata');
  return calls[0].calldata;
};

const main = async () => {
  console.log(`marketAcc ${marketAcc}  router (signature domain) ${ROUTER}`);

  // 1. Locate the TIF slot.
  const ioc = split(await placeOrder(TIF_IOC));
  const fok = split(await placeOrder(TIF_FOK));
  const diffs = ioc.words.flatMap((w, i) => (w !== fok.words[i] ? [i] : []));
  console.log(`place-order selector ${ioc.selector} / ${fok.selector}, words ${ioc.words.length}, differing slots [${diffs}]`);
  // Other slots may differ per build (e.g. a per-order id); only a slot that
  // reads exactly 1 under IOC and 2 under FOK is the TIF.
  const tifSlots = diffs.filter((i) => ioc.words[i] === BigInt(TIF_IOC) && fok.words[i] === BigInt(TIF_FOK));
  for (const i of diffs) console.log(`  slot ${i}: ioc=${ioc.words[i]} fok=${fok.words[i]}${tifSlots.includes(i) ? '  <- TIF' : ''}`);
  if (ioc.selector !== fok.selector || tifSlots.length !== 1) {
    console.log('VERDICT: UNKNOWN (TIF slot not isolated by the differential)');
    process.exit(2);
  }
  const slot = tifSlots[0];

  // 2. Read the roll-over builder's calls.
  const res = await post<{ calls: Array<{ action: string; marketId: number; size: string; calldata: Hex; resolved?: unknown }> }>(
    '/calldata-builder/agent/roll-over',
    { marketAcc, legs: LEGS.map((l) => ({ ...l, size: SIZE, ammId: 0 })) },
  );
  const calls = res?.calls ?? [];
  const failures: string[] = [];
  if (calls.length !== LEGS.length * 2) failures.push(`expected ${LEGS.length * 2} calls, got ${calls.length}`);
  for (const c of calls) {
    const { selector, words } = split(c.calldata);
    const tif = words[slot];
    console.log(`  ${c.action} m${c.marketId} size=${c.size} selector=${selector} tif=${tif} resolved=${JSON.stringify(c.resolved)}`);
    if (selector !== ioc.selector) failures.push(`m${c.marketId}: selector ${selector} is not place-order ${ioc.selector}`);
    if (tif !== BigInt(TIF_FOK)) failures.push(`m${c.marketId}: tif ${tif} != FOK`);
  }
  const want = (action: string, ids: number[]) =>
    ids.every((id) => calls.some((c) => c.action === action && c.marketId === id)) || failures.push(`missing ${action} on [${ids}]`);
  want('close', LEGS.map((l) => l.fromMarketId));
  want('open', LEGS.map((l) => l.toMarketId));

  console.log(failures.length === 0 ? 'VERDICT: PASS (all 4 roll-over legs are FOK place-orders)' : `VERDICT: FAIL\n  ${failures.join('\n  ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(`VERDICT: UNKNOWN (${(err as Error).message})`);
  process.exit(2);
});
