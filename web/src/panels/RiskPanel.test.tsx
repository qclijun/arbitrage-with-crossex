import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RiskPanel } from './RiskPanel';
import { TrackedAddressProvider, useTrackedAddress } from './trackedAddress';
import { STRATEGY_STORAGE_KEY } from './HomeControls';
import { env, server } from '../test/server';
import { contracts, rules, type MetricEvidence, type RiskScope, type RiskBaseline } from '../lib/risk';
import { useBookId } from './bookId';
import { savePrefs } from './assets/assetPrefsStore';
const address = '0x' + '1'.repeat(40), second = '0x' + '2'.repeat(40);
const scope: RiskScope = { address, credentialId: 'account-a', accountId: 0, pool: 'ETH-cross' };
const pool = address + '000002ffffff';
const hiddenHistory = ['hedge.market_identity_match', 'positions.unexpected_change_eth'];
let accountFails = false, margin = '100';
let external: Record<string, MetricEvidence> = {};
let baseline: RiskBaseline | null = null;
const clients: QueryClient[] = [];
const response = (data: unknown) => HttpResponse.json(env(data, { observedAt: Date.now(), credentialId: scope.credentialId, coverageComplete: true }));
const positions = () => ['HYPERLIQUID', 'BINANCE'].map((venue, i) => ({ marketAcc: pool, marketId: 128 + i, venue,
  maturity: Math.floor(Date.now() / 1000) + 20 * 86400, side: i ? 'LONG' : 'SHORT', sizeToken: 3,
  entryApr: i ? .04 : .12, markApr: i ? .04 : .15, mtmUsd: -2, notionalUsd: 9000, settleFeeApr: .001 }));
function Controls({ client }: { client: QueryClient }) {
  const wallet = useTrackedAddress();
  const book = useBookId(wallet.address);
  return <><button onClick={() => wallet.followBrowserWallet(second)}>Switch wallet</button><button onClick={() => client.setQueryData(['credentials'], { configured: true, keyMasked: 'other', identity: 'account-b' })}>Switch credentials</button>
    <button onClick={() => savePrefs(book, { sinceByAsset: {}, exclusions: {}, legSince: { 'boros:128': 1800000000 } })}>Change shared window</button></>;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  clients.push(client);
  const rendered = render(<QueryClientProvider client={client}><TrackedAddressProvider><Controls client={client} /><RiskPanel /></TrackedAddressProvider></QueryClientProvider>);
  return { client, ...rendered };
}
const check = (id: string) => Array.from(document.querySelectorAll('details')).find(d => d.querySelector('summary')?.textContent?.includes(id))!;
beforeEach(() => {
  accountFails = false; margin = '100'; external = {}; baseline = null; scope.credentialId = 'account-a';
  localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address, walletUpgraded: true }));
  server.use(
    http.get('/api/credentials', () => response({ configured: true, keyMasked: 'test…1111', identity: scope.credentialId })),
    http.get('/api/account', () => accountFails ? HttpResponse.json({ ok: false, error: { category: 'network', message: 'offline' } }, { status: 502 })
      : response({ marginBalance: margin, initialMargin: '100', maintenanceMargin: '60', assets: [
        { coin: 'USDT', exchangeType: 'BINANCE', liability: '10' }, { coin: 'USDC', exchangeType: 'HYPERLIQUID', liability: '0' }] })),
    http.get('/api/account/interest', () => response({ buckets: [
      { coin: 'USDT', venue: 'BINANCE', borrow: 10, ratePerYear: .1752, interestPerDayUsd: .0048 },
      { coin: 'USDC', venue: 'HYPERLIQUID', borrow: 0, ratePerYear: null, interestPerDayUsd: 0 }], account: { assets: [] } })),
    http.get('/api/positions', () => response({ positions: [], exposure: [] })),
    http.get('/api/orders/open', () => response([])), http.get('/api/deals', () => response([])), http.get('/api/alerts', () => response([])),
    http.get('/api/health', () => response({ status: 'ok' })),
    http.get('/api/risk/evidence', ({ request }) => response({ scope: { ...scope, address: new URL(request.url).searchParams.get('address') }, metrics: external, baseline, fundingGapStartedAt: null })),
    http.get('/api/boros/collateral', ({ request }) => {
      if (new URL(request.url).searchParams.get('address') !== address) return HttpResponse.json({ ok: false, error: { category: 'network', message: 'unavailable' } }, { status: 502 });
      return response({ address, accountId: 0, observedAt: Date.now(), stale: false, tokens: [{ symbol: 'ETH', tokenId: 2, priceUsd: 3000,
        cross: { marketAcc: pool, netBalance: .1, initialMargin: .08, maintenanceMargin: .04, availableInitialMargin: .012,
          activePositions: 2, imCoverage: 1.25, mmCoverage: 2.5 }, isolated: [] }] });
    }),
    http.get('/api/asset-view/:address', () => response({ sinceSec: 0, nowSec: Date.now() / 1000, assets: [], earliestSec: null,
      coverage: { borosPositionsComplete: true, borosTxnsComplete: true, backfilling: false, settlementsFromSec: 0, perpClosedFromSec: 0 }, warnings: [],
      risk: { address, accountId: 0, observedAt: Date.now(), stale: false, positionsComplete: true, positions: positions(),
        settlement: { netEth: -.006, complete: true, fromSec: Date.now() / 1000 - 86400, throughSec: Date.now() / 1000, reason: 'Complete incremental net ETH window; fees included' } } })),
  );
});
afterEach(() => { for (const c of clients.splice(0)) c.clear(); });
describe('rendered Risk / shared API evidence', () => {
  it('shows current hedge checks as OK and omits historical checks without a baseline', async () => {
    server.use(http.get('/api/positions', () => response({
      positions: [{ symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', positionQty: '-3' },
        { symbol: 'BINANCE_FUTURE_ETH_USDT', positionQty: '3' }],
      exposure: [{ base: 'ETH', legs: [
        { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange: 'HYPERLIQUID', side: 'SHORT', qty: 3 },
        { symbol: 'BINANCE_FUTURE_ETH_USDT', exchange: 'BINANCE', side: 'LONG', qty: 3 },
      ] }],
    })));
    mount();
    for (const id of ['hedge.perp_net_eth', 'hedge.hl_size_gap_eth', 'hedge.maturity_match']) {
      await waitFor(() => expect(check(id).querySelector('summary')).toHaveTextContent('OK'));
      expect(check(id)).not.toHaveTextContent('Missing explicit scope-matching baseline');
    }
    expect(check('hedge.maturity_match')).not.toHaveTextContent('hedge.market_identity_match');
    for (const id of hiddenHistory) expect(document.body).not.toHaveTextContent(id);
  });
  it('uses the asset owner’s exact query window after same-tab preference changes', async () => {
    const requests: string[] = [];
    const listener = ({ request }: { request: Request }) => { if (request.url.includes('/asset-view/')) requests.push(request.url); };
    server.events.on('request:start', listener);
    try {
      mount();
      await waitFor(() => expect(requests.length).toBeGreaterThan(0));
      await waitFor(() => expect(check('gate.im_coverage').querySelector('summary')).toHaveTextContent('CRITICAL'));
      fireEvent.click(screen.getByRole('button', { name: 'Change shared window' }));
      await waitFor(() => expect(requests.map(url => new URL(url).searchParams.get('legSince'))).toContain('128:1800000000'));
    } finally { server.events.removeListener('request:start', listener); }
  });
  it('renders visible evidence, excludes disabled and category 8 checks from details and counts, and issues only reads', async () => {
    const now = Date.now() / 1000;
    baseline = { boros: { '128': -3, '129': 3 }, perps: { HYPERLIQUID_FUTURE_ETH_USDC: -3, BINANCE_FUTURE_ETH_USDT: 3 },
      opened_at: now - 1000, observed_at: now - 100, evidence: 'explicit scoped fixture baseline' };
    const ids = new Set(rules.filter(r => r.enabled !== false).flatMap(r => r.metrics));
    for (const id of ids) {
      const contract = contracts[id];
      external[id] = { value: contract.type === 'bool' ? true : contract.type === 'enum' ? contract.values![0] : contract.unit === 'unix seconds' ? now - 30 : 1,
        unit: contract.unit, source: 'synthetic scoped review', evidence: 'fixture', observedAt: now, ttlSeconds: contract.max_age_seconds, scope: { ...scope }, complete: true };
    }
    const methods: string[] = [];
    const listener = ({ request }: { request: Request }) => { methods.push(request.method); };
    server.events.on('request:start', listener);
    try {
      mount();
      await waitFor(() => expect(Array.from(document.querySelectorAll('details')).filter(d => d !== check('basis.mark_spread_usd_per_eth'))
        .every(d => d.querySelector('summary')?.textContent?.includes('Complete applicable evidence'))).toBe(true));
      expect(check('basis.mark_spread_usd_per_eth')).toHaveTextContent('Missing fresh scope-matched ETH positions or four-leg pair');
      const visibleRules = rules.filter(r => r.enabled !== false && r.risk !== 8 && !hiddenHistory.includes(r.id));
      expect(document.querySelectorAll('details')).toHaveLength(visibleRules.length);
      for (const id of new Set(visibleRules.flatMap(r => r.metrics))) expect(screen.getAllByText(id, { exact: false }).length).toBeGreaterThan(0);
      for (const rule of rules.filter(r => r.enabled === false || r.risk === 8 || hiddenHistory.includes(r.id))) {
        expect(document.body).not.toHaveTextContent(rule.id);
        for (const id of rule.metrics) expect(document.body).not.toHaveTextContent(id);
      }
      const total = Array.from(screen.getByLabelText('Risk severity counts').querySelectorAll('p'))
        .reduce((sum, count) => sum + Number(count.textContent), 0);
      expect(total).toBe(visibleRules.length);
      expect(methods.length).toBeGreaterThan(0);
      expect(new Set(methods)).toEqual(new Set(['GET']));
    } finally { server.events.removeListener('request:start', listener); }
  });
  it('shows the visible catalog, same-pool runway, borrowing cost and paused rollover separately', async () => {
    mount();
    await waitFor(() => expect(check('gate.im_coverage').querySelector('summary')).toHaveTextContent('CRITICAL'));
    expect(document.querySelectorAll('details')).toHaveLength(rules.filter(r => r.enabled !== false && r.risk !== 8 && !hiddenHistory.includes(r.id)).length);
    await waitFor(() => expect(check('boros.settlement_net_24h_eth')).toHaveTextContent('2.00 days'));
    expect(check('gate.liability_usdt')).toHaveTextContent('4.80e-3 USD/day');
    expect(check('rollover.next_net_apr').querySelector('summary')).toHaveTextContent('PAUSED');
    expect(check('monitor.heartbeat_age_s').querySelector('summary')).toHaveTextContent('UNKNOWN');
    expect(check('service.http_ok')).toHaveTextContent('Terminal HTTP availability');
    expect(check('boros.im_coverage')).toHaveTextContent('1.2500 ratio');
  });
  it('retains unresolved CRITICAL and historical values after background failure, then requires verified recovery', async () => {
    const { client } = mount();
    await waitFor(() => expect(check('gate.im_coverage').querySelector('summary')).toHaveTextContent('CRITICAL'));
    accountFails = true;
    await client.refetchQueries({ queryKey: ['account'], exact: true });
    await waitFor(() => expect(check('gate.im_coverage')).toHaveTextContent('Historical last success: 1.0000 ratio'));
    expect(check('gate.im_coverage').querySelector('summary')).toHaveTextContent('CRITICAL');
    expect(check('gate.im_coverage')).toHaveTextContent('Previous CRITICAL cannot be verified');
    accountFails = false; margin = '200';
    await client.refetchQueries({ queryKey: ['account'], exact: true });
    await waitFor(() => expect(check('gate.im_coverage').querySelector('summary')).toHaveTextContent('OK'));
  });
  it('clears foreign wallet values and previous severity on wallet and credential transitions', async () => {
    mount();
    await waitFor(() => expect(check('boros.available_eth')).toHaveTextContent('0.012000 ETH'));
    fireEvent.click(screen.getByRole('button', { name: 'Switch wallet' }));
    await waitFor(() => expect(check('boros.available_eth').querySelector('summary')).toHaveTextContent('UNKNOWN'));
    expect(check('boros.available_eth')).not.toHaveTextContent('0.012000');
    fireEvent.click(screen.getByRole('button', { name: 'Switch credentials' }));
    await waitFor(() => expect(check('gate.im_coverage').querySelector('summary')).toHaveTextContent('UNKNOWN'));
    expect(check('gate.im_coverage')).not.toHaveTextContent('Historical last success');
  });
  it('omits category 8 even with depegged quotes and a known custody incident', async () => {
    for (const [id, value, age] of [['stablecoin.usdt_usd', .97, 0], ['stablecoin.usdc_usd', 1, 121], ['custody.incident_status', 'active', 0]] as const) external[id] = {
      value, unit: contracts[id].unit, source: 'independent synthetic evidence', evidence: 'fixture review', observedAt: Date.now() / 1000 - age,
      ttlSeconds: contracts[id].max_age_seconds, scope: { ...scope }, complete: true,
    };
    mount();
    await waitFor(() => expect(check('gate.im_coverage').querySelector('summary')).toHaveTextContent('CRITICAL'));
    for (const rule of rules.filter(r => r.risk === 8)) {
      expect(document.body).not.toHaveTextContent(rule.label);
      for (const id of rule.metrics) expect(document.body).not.toHaveTextContent(id);
    }
  });
  it('separates a fresh heartbeat from expired collection and a failed confirmed-delivery queue', async () => {
    const now = Date.now() / 1000;
    for (const [id, value, age] of [
      ['monitor.heartbeat_age_s', 10, 10], ['monitor.last_complete_run_at', now - 1000, 1000],
      ['service.consecutive_failures', 4, 0], ['service.last_success_age_s', 1000, 0],
      ['notify.last_success_at', now - 86401, 86401], ['notify.pending_count', 2, 0], ['notify.failure_streak', 3, 0],
    ] as const) external[id] = { value, unit: contracts[id].unit, source: 'independent collector fixture', evidence: 'scoped producer result',
      observedAt: now - age, ttlSeconds: contracts[id].max_age_seconds, scope: { ...scope }, complete: true };
    mount();
    await waitFor(() => expect(check('monitor.heartbeat_age_s')).toHaveTextContent('Expired evidence'));
    expect(check('monitor.heartbeat_age_s').querySelector('summary')).toHaveTextContent('UNKNOWN');
    expect(check('monitor.heartbeat_age_s')).toHaveTextContent('Historical last success:');
    expect(check('service.http_ok').querySelector('summary')).toHaveTextContent('CRITICAL');
    expect(check('notify.last_success_at').querySelector('summary')).toHaveTextContent('CRITICAL');
    expect(check('notify.last_success_at')).toHaveTextContent('Incomplete / unknown evidence');
  });
});
