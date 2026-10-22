/**
 * The Pair ticket's route choice (ADR 0002): a pair whose two single markets
 * a tradable spread covers defaults to the spread, and the trader may put it
 * on the two singles instead. The choice sticks until the pair changes.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { STRATEGY_STORAGE_KEY } from '../panels/HomeControls';
import { SPREAD_OPP_MARKET_ID as SPREAD, SPREAD_OPP_MATURITY as MATURITY } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { BorosPairTicket } from './BorosPairTicket';
import { useTradeFlow, type BorosOpenPrefill } from './TradeFlow';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const HL = 209;
const GATE = 211;

const row = (over: Record<string, unknown>) => ({
  base: 'ETH',
  tokenId: 2,
  collateral: 'ETH',
  maturity: MATURITY,
  midApr: 0.035,
  markApr: 0.035,
  isolatedOnly: false,
  onIsolatedMargin: false,
  isolatedHasPositionOrOrders: false,
  currentSize: 0,
  collateralPriceUsd: 2_500,
  closeOnly: false,
  spreadVenues: null,
  ...over,
});
const singles = (over: Record<string, unknown> = {}) => [
  row({ marketId: HL, name: 'Hyperliquid ETH 27 Nov 2026', venue: 'Hyperliquid', ...over }),
  row({ marketId: GATE, name: 'Gate ETHUSDT 27 Nov 2026', venue: 'Gate', ...over }),
];
const spread = (over: Record<string, unknown> = {}) =>
  row({ marketId: SPREAD, name: 'ETH Spread HL-GATE 27 Nov 2026', venue: 'HL-GATE', spreadVenues: ['HYPERLIQUID', 'GATE'], ...over });

type Leg = { marketId: number; direction: string; size: number; clientOrderId?: string };
type Body = { legs: Leg[]; onlyLeg?: number; intent: string };

const simLeg = (l: Leg) => ({
  marketId: l.marketId,
  marketName: String(l.marketId),
  venue: 'x',
  base: 'ETH',
  direction: l.direction,
  execApr: 0.035,
  worstApr: 0.034,
  estFillSize: l.size,
  shortfallSize: 0,
  bookStatus: 'ok',
  marginRequired: 0.001,
  slippageApr: 0.0005,
  sizing: { currentSize: 0, deltaSize: l.size, resultingSize: l.size, opposing: false, flips: false, clampedToClose: false, orderSide: l.direction },
});

/** Context, a simulation echoing whatever legs were asked for, and execute. */
function handlers(opts: {
  markets?: ReturnType<typeof row>[];
  spreadMarkets?: ReturnType<typeof row>[];
  onSimulate?: (b: Body) => void;
  onExecute?: (b: Body) => void;
  execute?: (b: Body) => Record<string, unknown>;
} = {}) {
  return [
    http.get('/api/boros/agent', () =>
      HttpResponse.json(env({ configured: true, root: ADDRESS, rootMasked: '0x1111…1111', accountId: 0, expiry: null, expired: false, canProvision: true })),
    ),
    http.get('/api/boros/pair/context', () =>
      HttpResponse.json(
        env({
          markets: opts.markets ?? singles(),
          spreadMarkets: opts.spreadMarkets ?? [spread()],
          crossByToken: [{ tokenId: 2, available: 10 }],
          isolatedByMarket: [],
          defaultSlippageApr: 0.0025,
          maxSlippageApr: 0.1,
        }),
      ),
    ),
    http.post('/api/boros/pair/simulate', async ({ request }) => {
      const body = (await request.json()) as Body;
      opts.onSimulate?.(body);
      return HttpResponse.json(
        env({
          simulation: {
            legs: body.legs.map(simLeg),
            receiveLeg: 0,
            estSpreadApr: 0.03,
            worstSpreadApr: 0.028,
            costToCrossSize: 0.00002,
            feeDragApr: 0.001,
            marginRequiredTotal: 0.002,
            hedgedSize: body.legs[0].size,
            unhedgedSize: 0,
            collateral: 'ETH',
            collateralPriceUsd: 2_500,
            secondsToMaturity: 3_000_000,
            reasons: [],
          },
          gate: { blockers: [], warnings: [], requiresAcknowledgement: false, opposingLegs: [] },
          eligibility: { eligible: true, code: null, reason: null },
          simulatedAtMs: Date.now(),
          gasBalanceUsd: null,
        }),
      );
    }),
    http.post('/api/boros/pair/execute', async ({ request }) => {
      const body = (await request.json()) as Body;
      opts.onExecute?.(body);
      return HttpResponse.json(env({ result: opts.execute?.(body) ?? fill(body.legs.map((l) => [l, l.size])), estimate: null, warnings: [] }));
    }),
  ];
}

/** An execution result: each leg filled the given size. */
const fill = (legs: [Leg, number][]) => {
  const short = legs.map(([l, f]) => l.size - f);
  return {
    legs: legs.map(([l, f], i) => ({
      marketId: l.marketId,
      direction: l.direction,
      filledSize: f,
      shortfallSize: short[i],
      execApr: 0.035,
      feeSize: 0.00001,
      failure: short[i] > 0 ? { code: 'insufficient-depth', message: 'thin' } : null,
    })),
    hedgedSize: Math.min(...legs.map(([, f]) => f)),
    unhedgedSize: Math.max(...legs.map(([, f]) => f)) - Math.min(...legs.map(([, f]) => f)),
    unhedgedLeg: legs.length < 2 || legs[0][1] === legs[1][1] ? null : legs[0][1] > legs[1][1] ? 0 : 1,
    realisedSpreadApr: null,
    partial: short.some((s) => s > 0),
    filledNothing: false,
    allLegsSubmitted: true,
  };
};

function Harness({ prefill, guided }: { prefill: Omit<BorosOpenPrefill, 'nonce'>; guided?: boolean }) {
  const flow = useTradeFlow();
  return (
    <>
      <button type="button" onClick={() => flow.prefillBorosOpen(prefill)}>
        fire
      </button>
      <BorosPairTicket guided={guided} />
    </>
  );
}

const routeGroup = () => screen.queryByRole('radiogroup', { name: 'Trade on' });
const lastLegs = (bodies: Body[]) => bodies[bodies.length - 1]?.legs.map((l) => [l.marketId, l.direction]);

/** The free ticket with Hyperliquid in slot A and Gate in slot B, sized. */
async function pickHlGate(user: ReturnType<typeof userEvent.setup>) {
  renderWithClient(<BorosPairTicket />);
  await waitFor(() => expect((screen.getByLabelText('Leg A') as HTMLSelectElement).options.length).toBeGreaterThan(1));
  await user.selectOptions(screen.getByLabelText('Leg A'), String(HL));
  await user.selectOptions(screen.getByLabelText('Leg B'), String(GATE));
  await user.type(screen.getByLabelText(/^Size/), '0.5');
}

beforeEach(() => {
  window.localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ADDRESS }));
});

describe('BorosPairTicket — Spread or two single markets', () => {
  it('defaults to the spread, and choosing the singles sends two single-market orders', async () => {
    const bodies: Body[] = [];
    server.use(...handlers({ onSimulate: (b) => bodies.push(b) }));
    const user = userEvent.setup();
    await pickHlGate(user);

    await waitFor(() => expect(routeGroup()).toBeInTheDocument());
    expect(within(routeGroup()!).getByRole('radio', { name: /ETH Spread HL-GATE/ })).toBeChecked();
    await waitFor(() => expect(lastLegs(bodies)).toEqual([[SPREAD, 'short']]));

    await user.click(within(routeGroup()!).getByRole('radio', { name: '2 single markets' }));
    expect(screen.getByLabelText('Leg A')).toHaveValue(String(HL));
    expect(screen.getByLabelText('Leg B')).toHaveValue(String(GATE));
    await waitFor(() => expect(lastLegs(bodies)).toEqual([[HL, 'short'], [GATE, 'long']]));
    expect(await screen.findByRole('button', { name: /Confirm · 2 Boros market orders/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Size per leg/)).toHaveValue('0.5');
  });

  it('stays on the singles through a side swap and a new size, and drops the choice with the pair', async () => {
    const bodies: Body[] = [];
    const binance = row({ marketId: 213, name: 'Binance ETHUSDT 27 Nov 2026', venue: 'Binance' });
    server.use(...handlers({ markets: [...singles(), binance], onSimulate: (b) => bodies.push(b) }));
    const user = userEvent.setup();
    await pickHlGate(user);
    await waitFor(() => expect(routeGroup()).toBeInTheDocument());
    await user.click(within(routeGroup()!).getByRole('radio', { name: '2 single markets' }));

    await user.click(screen.getByRole('button', { name: 'Swap markets' }));
    await user.clear(screen.getByLabelText(/^Size per leg/));
    await user.type(screen.getByLabelText(/^Size per leg/), '0.7');
    await waitFor(() => expect(lastLegs(bodies)).toEqual([[GATE, 'short'], [HL, 'long']]));
    expect(bodies[bodies.length - 1].legs[0].size).toBe(0.7);
    expect(within(routeGroup()!).getByRole('radio', { name: '2 single markets' })).toBeChecked();

    // A pair no spread covers: no choice to show, and none left behind.
    await user.selectOptions(screen.getByLabelText('Leg B'), '213');
    expect(routeGroup()).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Leg B'), String(HL));
    await waitFor(() => expect(within(routeGroup()!).getByRole('radio', { name: /ETH Spread HL-GATE/ })).toBeChecked());
    await waitFor(() => expect(lastLegs(bodies)).toEqual([[SPREAD, 'long']]));

    // And back again by choice.
    await user.click(within(routeGroup()!).getByRole('radio', { name: '2 single markets' }));
    await waitFor(() => expect(lastLegs(bodies)).toEqual([[GATE, 'short'], [HL, 'long']]));
    await user.click(within(routeGroup()!).getByRole('radio', { name: /ETH Spread HL-GATE/ }));
    await waitFor(() => expect(lastLegs(bodies)).toEqual([[SPREAD, 'long']]));
  });

  it('a prefill naming the singles route arms the two singles, and the wizard form offers no choice', async () => {
    const bodies: Body[] = [];
    server.use(...handlers({ onSimulate: (b) => bodies.push(b) }));
    const user = userEvent.setup();
    renderWithClient(
      <Harness
        guided
        prefill={{ base: 'ETH', longVenue: 'Gate', shortVenue: 'Hyperliquid', maturity: MATURITY, size: 1_250, sizeBase: 0.5, route: 'singles' }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'fire' }));
    expect(await screen.findByRole('button', { name: /Confirm · 2 Boros market orders/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Leg A')).toHaveValue(String(GATE));
    expect(screen.getByLabelText('Leg B')).toHaveValue(String(HL));
    expect(screen.queryByText('ETH Spread HL-GATE')).not.toBeInTheDocument();
    expect(routeGroup()).not.toBeInTheDocument();
    await waitFor(() => expect(lastLegs(bodies)).toEqual([[GATE, 'long'], [HL, 'short']]));
  });

  it('a close keeps the spread rule: it goes to a spread that holds the position, with nothing to choose', async () => {
    const bodies: Body[] = [];
    server.use(...handlers({ spreadMarkets: [spread({ currentSize: -0.5 })], onSimulate: (b) => bodies.push(b) }));
    const user = userEvent.setup();
    await pickHlGate(user);
    await waitFor(() => expect(routeGroup()).toBeInTheDocument());
    await user.click(within(routeGroup()!).getByRole('radio', { name: '2 single markets' }));
    await user.click(screen.getByRole('checkbox', { name: 'Reduce-only' }));
    await waitFor(() => expect(lastLegs(bodies)).toEqual([[SPREAD, 'short']]));
    expect(screen.getByText('ETH Spread HL-GATE')).toBeInTheDocument();
    expect(routeGroup()).not.toBeInTheDocument();
  });

  it.each([
    ['paused', { closeOnly: true, paused: true }],
    ['close-only', { closeOnly: true, paused: false }],
  ])('a %s spread leaves the pair on its singles and offers no choice', async (_label, over) => {
    const bodies: Body[] = [];
    server.use(...handlers({ spreadMarkets: [spread(over)], onSimulate: (b) => bodies.push(b) }));
    const user = userEvent.setup();
    await pickHlGate(user);
    await waitFor(() => expect(lastLegs(bodies)).toEqual([[HL, 'short'], [GATE, 'long']]));
    expect(routeGroup()).not.toBeInTheDocument();
    expect(screen.queryByText('ETH Spread HL-GATE')).not.toBeInTheDocument();
  });

  it('a half-filled singles pair retries and completes on the same two singles, never the spread', async () => {
    const sent: Body[] = [];
    const bodies: Body[] = [];
    // First fill: leg A 0.25 and leg B 0.375 of 0.5. Then everything fills.
    const fills = [(b: Body) => fill([[b.legs[0], 0.25], [b.legs[1], 0.375]]), (b: Body) => fill(b.legs.map((l) => [l, l.size]))];
    server.use(
      ...handlers({
        onSimulate: (b) => bodies.push(b),
        onExecute: (b) => sent.push(b),
        execute: (b) => fills[Math.min(sent.length - 1, 1)](b),
      }),
    );
    const user = userEvent.setup();
    await pickHlGate(user);
    await waitFor(() => expect(routeGroup()).toBeInTheDocument());
    await user.click(within(routeGroup()!).getByRole('radio', { name: '2 single markets' }));

    const confirm = await screen.findByRole('button', { name: /Confirm · 2 Boros market orders/ });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    await user.pointer({ keys: '[MouseLeft>]', target: confirm });
    const report = within(await screen.findByRole('status', {}, { timeout: 3_000 }));
    await user.click(report.getByRole('button', { name: 'Retry' }));

    // Both fell short: both re-arm at the smaller shortfall, on the singles.
    expect(screen.getByLabelText(/^Size per leg/)).toHaveValue('0.125');
    await waitFor(() => expect(lastLegs(bodies)).toEqual([[HL, 'short'], [GATE, 'long']]));
    const retry = await screen.findByRole('button', { name: /Confirm · 2 Boros market orders/ });
    await waitFor(() => expect(retry).not.toBeDisabled());
    await user.pointer({ keys: '[MouseLeft>]', target: retry });
    await waitFor(() => expect(sent).toHaveLength(2), { timeout: 3_000 });
    expect(sent.map((b) => b.legs.map((l) => l.marketId))).toEqual([[HL, GATE], [HL, GATE]]);
    expect(sent[1].legs.map((l) => l.size)).toEqual([0.125, 0.125]);
  });

  it('completing the short leg of a singles pair sends that single alone', async () => {
    const bodies: Body[] = [];
    server.use(
      ...handlers({ onSimulate: (b) => bodies.push(b), execute: (b) => fill([[b.legs[0], 0.25], [b.legs[1], 0.5]]) }),
    );
    const user = userEvent.setup();
    await pickHlGate(user);
    await waitFor(() => expect(routeGroup()).toBeInTheDocument());
    await user.click(within(routeGroup()!).getByRole('radio', { name: '2 single markets' }));
    const confirm = await screen.findByRole('button', { name: /Confirm · 2 Boros market orders/ });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    await user.pointer({ keys: '[MouseLeft>]', target: confirm });
    const report = within(await screen.findByRole('status', {}, { timeout: 3_000 }));
    await user.click(report.getByRole('button', { name: 'Complete now at market' }));

    expect(screen.getByText(/Completing leg A only/i)).toBeInTheDocument();
    await waitFor(() => {
      const last = bodies[bodies.length - 1];
      expect(last.onlyLeg).toBe(0);
      expect(last.legs.map((l) => [l.marketId, l.size])).toEqual([[HL, 0.25], [GATE, 0.25]]);
    });
    // Leaving the completion keeps the singles too.
    await user.click(screen.getByRole('button', { name: 'Trade both legs instead' }));
    await waitFor(() => expect(bodies[bodies.length - 1].onlyLeg).toBeUndefined());
    expect(lastLegs(bodies)).toEqual([[HL, 'short'], [GATE, 'long']]);
  });

  it('keeps the singles through Pair → Single → Pair and through a Reduce-only round trip', async () => {
    const bodies: Body[] = [];
    // The spread holds a position, so a close goes to it (the unchanged close rule).
    server.use(...handlers({ spreadMarkets: [spread({ currentSize: -0.5 })], onSimulate: (b) => bodies.push(b) }));
    const user = userEvent.setup();
    await pickHlGate(user);
    await waitFor(() => expect(routeGroup()).toBeInTheDocument());
    await user.click(within(routeGroup()!).getByRole('radio', { name: '2 single markets' }));

    await user.click(screen.getByRole('radio', { name: 'Single' }));
    await user.click(screen.getByRole('radio', { name: 'Pair' }));
    await waitFor(() => expect(lastLegs(bodies)).toEqual([[HL, 'short'], [GATE, 'long']]));
    expect(within(routeGroup()!).getByRole('radio', { name: '2 single markets' })).toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: 'Reduce-only' }));
    await waitFor(() => expect(lastLegs(bodies)).toEqual([[SPREAD, 'short']]));
    await user.click(screen.getByRole('checkbox', { name: 'Reduce-only' }));
    await waitFor(() => expect(lastLegs(bodies)).toEqual([[HL, 'short'], [GATE, 'long']]));
    expect(within(routeGroup()!).getByRole('radio', { name: '2 single markets' })).toBeChecked();
  });
});
