import type { FundingPreview } from '../../api/fundingIntents';

const micro = 'text-[11px] text-ink-400';

const WARNINGS: Record<string, string> = {
  'maker-expiry-converts-remainder-to-taker': 'At the maker deadline, the unfilled maker remainder converts to taker.',
  'taker-ioc-has-no-price-or-cost-cap': 'Taker orders are MARKET IOC: no price or total-cost cap.',
  'one-leg-exposure-until-hedged': 'One leg is exposed until the other is hedged; a residual can remain.',
  'trading-permission-inferred-from-signed-reads': 'Trading permission is inferred from signed reads; a key without it fails only at the first order.',
  'risk-exempts-only-reconciled-floating-quantity': 'Risk exempts only the reconciled floating quantity from Boros cover; other risks stay.',
  'scenario-not-positive': 'This scenario is not positive: the daily income or the hold result is zero or negative.',
};

export function warningText(code: string): string {
  const lev = /^leverage-change:(.+):(\d+)->(\d+)$/.exec(code);
  if (lev) return `Leverage on ${lev[1]} changes from ${lev[2]}x to ${lev[3]}x before any order.`;
  return WARNINGS[code] ?? code;
}

const money = (v: string | null, currency: string) => (v === null ? 'UNKNOWN' : `${v} ${currency}`);
const paybackText = (v: string) => (/^-?\d/.test(v) ? `${v} d` : v === 'unknown' ? 'UNKNOWN' : v);

/** Everything the user confirms, exactly as the server bound it. */
export function PreviewSummary({ preview }: { preview: FundingPreview }) {
  const c = preview.content;
  return (
    <section aria-label="Preview" className="mt-3 rounded border border-ink-700 p-2">
      <p>
        You typed {c.quantityInput} {c.underlying} · Final quantity {c.quantity ?? 'UNKNOWN'} {c.underlying}
        {c.rounding && <span className={micro}> ({c.rounding})</span>}
      </p>
      <table aria-label="Legs" className="mt-2 w-full">
        <thead className={`text-left ${micro}`}><tr><th>Leg</th><th>Symbol</th><th>Side</th><th>Role</th><th>Leverage</th><th>Fees maker / taker</th></tr></thead>
        <tbody>
          {(['short', 'long'] as const).map((side) => {
            const leg = c.legs[side];
            const fee = c.fees[side];
            return (
              <tr key={side} className="border-t border-ink-800">
                <td>{side}</td><td className="num">{leg.symbol}</td><td>{leg.side}</td><td>{leg.role}</td><td>{leg.leverage}x</td>
                <td className="num">{fee ? `${fee.maker} / ${fee.taker}` : 'UNKNOWN'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2">
        Maker price {c.makerPrice ?? 'UNKNOWN'} · maker waits {c.timeoutSec} s after acceptance, then the unfilled remainder converts to taker.
      </p>
      <p className={micro}>FX {c.fx} · borrow {c.borrow} · amounts in {c.currency}</p>
      <table aria-label="Cost scenarios" className="mt-2 w-full">
        <thead className={`text-left ${micro}`}><tr><th>Scenario</th><th>One-time costs</th><th>Hold {c.holdDays} d result</th><th>Payback</th></tr></thead>
        <tbody>
          <tr className="border-t border-ink-800">
            <td>Maker fills, hedge taker</td><td className="num">{money(c.amounts.normalOneTime, c.currency)}</td>
            <td className="num">{money(c.amounts.normalHold, c.currency)}</td><td className="num">{paybackText(c.payback.normal)}</td>
          </tr>
          <tr className="border-t border-ink-800">
            <td>Maker remainder converts to taker</td><td className="num">{money(c.amounts.conversionOneTime, c.currency)}</td>
            <td className="num">{money(c.amounts.conversionHold, c.currency)}</td><td className="num">{paybackText(c.payback.conversion)}</td>
          </tr>
        </tbody>
      </table>
      <p className={micro}>
        Daily net funding {money(c.amounts.daily, c.currency)}. Scenarios use the current book and fees; they are not a cost cap or a promise.
        The conversion row assumes the whole maker leg converts.
      </p>
      {preview.blockers.length > 0 && (
        <div role="alert" className="mt-2 text-rose-300">
          <p className="font-semibold">Cannot be accepted:</p>
          <ul className="list-disc pl-4">{preview.blockers.map((b) => <li key={b.code}>{b.message}</li>)}</ul>
        </div>
      )}
    </section>
  );
}
