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

    expect(screen.getByText(/three legs ·/)).toBeInTheDocument();
    expect(screen.queryByText(/four legs ·/)).not.toBeInTheDocument();

    const borosLinks = screen.getAllByRole('link', { name: /funding on Boros/ });
    expect(borosLinks).toHaveLength(1);
    expect(borosLinks[0]).toHaveAccessibleName('Short ETH Spread HL-GATE funding on Boros');
    expect(borosLinks[0]).toHaveAttribute(
      'href',
      'https://boros.pendle.finance/markets/59?form=market&direction=short',
    );

    const legLabels = ['Short ETH', 'Long ETH', 'Short ETH Spread HL-GATE'].map((label) => screen.getByText(label));
    expect(legLabels[0].compareDocumentPosition(legLabels[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(legLabels[1].compareDocumentPosition(legLabels[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('ETH Spread HL-GATE')).toBeInTheDocument();
    expect(screen.getAllByText(/ Fixed$/)).toHaveLength(1);

    expect(screen.getByText('Boros spread IM')).toBeInTheDocument();
    expect(screen.queryByText('Boros short IM')).not.toBeInTheDocument();
    expect(screen.queryByText('Boros long IM')).not.toBeInTheDocument();
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

    const chip = screen.getByText(/ Fixed$/);
    expect(chip).toHaveTextContent(/^3\.4% Fixed$/);
    expect(chip.className).toContain('text-grass');
    expect(screen.getAllByTitle(/^Modelled minimum capital .+ across the three legs$/)).toHaveLength(2);
    expect(screen.getByTitle('The minimum capital this trade posts across the three legs.')).toBeInTheDocument();
  });

  it('keeps one capital bar per Boros market for two single markets', async () => {
    server.use(opportunitiesHandler(makeOpportunitiesResult()));
    renderWithClient(<OpportunitiesPanel />);
    await waitFor(() => expect(toggles()).toHaveLength(1));
    await userEvent.click(toggles()[0]);

    expect(screen.getByText(/four legs ·/)).toBeInTheDocument();
    expect(screen.getByText('Boros short IM')).toBeInTheDocument();
    expect(screen.getByText('Boros long IM')).toBeInTheDocument();
    expect(screen.queryByText('Boros spread IM')).not.toBeInTheDocument();
    expect(screen.getAllByText(/ Fixed$/)).toHaveLength(2);
    expect(screen.getAllByTitle(/^Modelled minimum capital .+ across the four legs$/)).toHaveLength(2);
    expect(screen.getByTitle('The minimum capital this trade posts across the four legs.')).toBeInTheDocument();
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
  it('lists both routes as their own cards, ranked on capital and labelled by leg count', async () => {
    server.use(opportunitiesHandler(spreadResult(makeSpreadOpportunityPair(), singlesPair())));
    renderWithClient(<OpportunitiesPanel />);
    await waitFor(() => expect(cards()).toHaveLength(2));

    // The four-leg route out-earns the spread here, so it leads.
    expect(cards()[0]).toHaveAccessibleName(/4 legs/);
    expect(cards()[1]).toHaveAccessibleName(/3 legs/);
    const [four, three] = screen.getAllByText(/^[34] legs$/);
    expect(four).toHaveTextContent('4 legs');
    expect(three).toHaveTextContent('3 legs');

    await userEvent.click(toggles()[0]);
    await userEvent.click(toggles()[1]);
    expect(screen.getByText(/four legs ·/)).toBeInTheDocument();
    expect(screen.getByText(/three legs ·/)).toBeInTheDocument();
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
