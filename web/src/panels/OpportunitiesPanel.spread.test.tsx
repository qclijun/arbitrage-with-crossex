import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  makeOpportunitiesResult,
  makeOpportunityBorosLeg,
  makeOpportunityGroup,
  makeOpportunityLeg,
  makeOpportunityPair,
  makeSpreadOpportunityPair,
  opportunitiesHandler,
  SPREAD_OPP_MATURITY,
  SPREAD_OPP_NOW,
} from '../test/fixtures';
import { server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { useTradeFlow } from '../trade/TradeFlow';
import { OpportunitiesPanel } from './OpportunitiesPanel';

const toggles = () => screen.getAllByRole('button', { name: /^(Show|Hide) details for/ });

const spreadResult = (...pairs: ReturnType<typeof makeSpreadOpportunityPair>[]) =>
  makeOpportunitiesResult({
    groups: [
      makeOpportunityGroup({
        tokenId: 2,
        collateral: 'ETH',
        collateralPriceUsd: 1900,
        maturity: SPREAD_OPP_MATURITY,
        secondsToMaturity: SPREAD_OPP_MATURITY - SPREAD_OPP_NOW,
        pairs: pairs.length ? pairs : [makeSpreadOpportunityPair()],
      }),
    ],
  });

describe('OpportunitiesPanel — spread market', () => {
  it('spread details', async () => {
    server.use(opportunitiesHandler(spreadResult()));
    renderWithClient(<OpportunitiesPanel />);
    await waitFor(() => expect(toggles()).toHaveLength(1));
    await userEvent.click(toggles()[0]);

    expect(screen.getByText(/2 perps \+ 1 spread position ·/)).toBeInTheDocument();
    expect(screen.queryByText(/2 perps \+ 2 Boros positions ·/)).not.toBeInTheDocument();

    const borosLinks = screen.getAllByRole('link', { name: /funding on Boros/ });
    expect(borosLinks).toHaveLength(1);
    expect(borosLinks[0]).toHaveAccessibleName('Short ETH Spread HL-GATE funding on Boros');
    expect(borosLinks[0]).toHaveAttribute(
      'href',
      'https://boros.pendle.finance/markets/59?form=market&direction=short',
    );

    const legLabels = ['Long ETH', 'Short ETH', 'Short ETH Spread HL-GATE'].map((label) => screen.getByText(label));
    expect(legLabels[0].compareDocumentPosition(legLabels[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(legLabels[1].compareDocumentPosition(legLabels[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('ETH Spread HL-GATE')).toBeInTheDocument();
    expect(screen.getAllByText(/ fixed$/)).toHaveLength(1);

    expect(screen.getByText('Boros spread margin')).toBeInTheDocument();
    expect(screen.queryByText('Boros Short margin')).not.toBeInTheDocument();
    expect(screen.queryByText('Boros Long margin')).not.toBeInTheDocument();
  });

  it.each([
    ['SHORT', 0.0348, 0.0343],
    ['LONG', -0.0348, -0.0343],
  ] as const)('shows a %s spread the trader receives as green and unsigned', async (side, midApr, execApr) => {
    const base = makeSpreadOpportunityPair();
    const pair = {
      ...base,
      borosLegs: [{ ...makeOpportunityBorosLeg({ ...base.borosLegs[0], side, midApr, execApr }) }],
    };
    server.use(opportunitiesHandler(spreadResult(pair)));
    renderWithClient(<OpportunitiesPanel />);
    await waitFor(() => expect(toggles()).toHaveLength(1));
    await userEvent.click(toggles()[0]);

    const chip = screen.getByText(/ fixed$/);
    expect(chip).toHaveTextContent(/^3\.4% fixed$/);
    expect(chip.className).toContain('text-grass');
    expect(screen.getAllByTitle(/^Modeled minimum capital .+ across the 2 perps and the spread position$/)).toHaveLength(2);
    expect(screen.getByTitle('The minimum capital this trade posts across the 2 perps and the spread position.')).toBeInTheDocument();
  });

  it('keeps one capital bar per Boros market for two single markets', async () => {
    server.use(opportunitiesHandler(makeOpportunitiesResult()));
    renderWithClient(<OpportunitiesPanel />);
    await waitFor(() => expect(toggles()).toHaveLength(1));
    await userEvent.click(toggles()[0]);

    expect(screen.getByText(/2 perps \+ 2 Boros positions ·/)).toBeInTheDocument();
    expect(screen.getByText('Boros Short margin')).toBeInTheDocument();
    expect(screen.getByText('Boros Long margin')).toBeInTheDocument();
    expect(screen.queryByText('Boros spread margin')).not.toBeInTheDocument();
    expect(screen.getAllByText(/ fixed$/)).toHaveLength(2);
    expect(screen.getAllByTitle(/^Modeled minimum capital .+ across the 2 perps and the 2 Boros positions$/)).toHaveLength(2);
    expect(screen.getByTitle('The minimum capital this trade posts across the 2 perps and the 2 Boros positions.')).toBeInTheDocument();
  });
});

/** The same HL/GATE ETH cohort on its two single markets — the four-leg route
 * ADR 0002 lists beside the spread. Its capital APR sits above the spread's. */
const singlesPair = () => {
  const spread = makeSpreadOpportunityPair();
  const base = makeOpportunityPair();
  return makeOpportunityPair({
    longLeg: makeOpportunityLeg({ venue: 'GATE', crossexVenue: 'GATE', crossexSymbol: 'GATE_FUTURE_ETH_USDT' }),
    borosLegs: [
      { ...base.borosLegs[0], marketId: 51 },
      { ...base.borosLegs[1], marketId: 60, venue: 'GATE' },
    ],
    secondsToMaturity: spread.secondsToMaturity,
    netFixedAprOnCapital: (spread.netFixedAprOnCapital as number) + 0.01,
  });
};

const wizardSeen: Array<Record<string, unknown>> = [];
function WizardProbe() {
  const w = useTradeFlow().wizard as unknown as Record<string, unknown> | null;
  if (w && wizardSeen.at(-1) !== w) wizardSeen.push(w);
  return null;
}

const cards = () => screen.getAllByRole('button', { name: /^Open this strategy — / });

describe('OpportunitiesPanel — spread and singles side by side', () => {
  it('lists both routes as their own cards, ranked on capital and labelled by route', async () => {
    server.use(opportunitiesHandler(spreadResult(makeSpreadOpportunityPair(), singlesPair())));
    renderWithClient(<OpportunitiesPanel />);
    await waitFor(() => expect(cards()).toHaveLength(2));

    // The four-leg route out-earns the spread here, so it leads.
    expect(cards()[0]).toHaveAccessibleName(/Two singles/);
    expect(cards()[1]).toHaveAccessibleName(/Spread/);
    expect(screen.getByText('Two singles')).toBeInTheDocument();
    expect(screen.getByText('Spread')).toBeInTheDocument();

    await userEvent.click(toggles()[0]);
    await userEvent.click(toggles()[1]);
    expect(screen.getByText(/2 perps \+ 2 Boros positions ·/)).toBeInTheDocument();
    expect(screen.getByText(/2 perps \+ 1 spread position ·/)).toBeInTheDocument();
  });

  it.each([
    [0, 'singles'],
    [1, 'spread'],
  ] as const)('card %i opens the wizard on its own route (%s)', async (index, route) => {
    server.use(opportunitiesHandler(spreadResult(makeSpreadOpportunityPair(), singlesPair())));
    wizardSeen.length = 0;
    renderWithClient(
      <>
        <OpportunitiesPanel />
        <WizardProbe />
      </>,
    );
    await waitFor(() => expect(cards()).toHaveLength(2));
    await userEvent.click(cards()[index]);

    await waitFor(() => expect(wizardSeen).toHaveLength(1));
    expect(wizardSeen[0]).toMatchObject({
      borosRoute: route,
      borosShortVenue: 'HYPERLIQUID',
      borosLongVenue: 'GATE',
      maturity: SPREAD_OPP_MATURITY,
    });
  });
});
