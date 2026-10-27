import { currentReversed, decimal, fixed, rankValue, scaled, windows } from './fixtures';
import type { Demo } from './usePrototype';

const rates: Record<string, (string | null)[]> = {
  'ETH:Hyperliquid': ['9.8', '12.2', '11.2', '10', null],
  'ETH:Bybit': ['6.7', '8.1', '6.3', '6.2', '4.2'],
  'BTC:OKX': ['11.2', '10.4', '9', '8', '7.1'],
  'BTC:Bybit': ['6.2', '5.8', '6', null, null],
  'HYPE:Bybit': ['5', '5', '6.2', null, null],
  'SOL:OKX': ['14', '16.2', '13.1', '12', '11'],
  'NEW:Bybit': ['20', null, null, null, null],
  'PEPE:Bybit': ['13', '15', '12', null, null],
};
function mean(c: Demo, side: 'short' | 'long') {
  const value = rates[`${c.selected.asset}:${c.selected[side].venue}`]?.[windows.indexOf(c.days)];
  return value === undefined ? '5' : value;
}
export function scenario(c: Demo) {
  const sr = mean(c, 'short'),
    lr = mean(c, 'long');
  const complete = c.apr !== null && c.knownCost && c.q > 0n && sr !== null && lr !== null;
  const shortIncome = (c.shortN * fixed(sr || '0')) / 36_500_000_000n;
  const longExpense = (c.longN * fixed(lr || '0')) / 36_500_000_000n;
  const borrow = scaled(c.quantity, '0.030000');
  const net = shortIncome - longExpense - borrow;
  const payback = !complete
    ? 'UNKNOWN'
    : net <= 0n
      ? '无有限回本'
      : c.cost <= 0n
        ? '无需回本'
        : `${decimal((c.cost * 1_000_000n) / net)}天`;
  return { complete, sr, lr, shortIncome, longExpense, borrow, net, payback };
}

export function History({ c }: { c: Demo }) {
  const cumulative = (side: 'short' | 'long') => {
    const rate = mean(c, side);
    return c.apr === null || rate === null
      ? 'UNKNOWN'
      : `${decimal((fixed(rate) * BigInt(c.days)) / 365n, 4)}%`;
  };
  return (
    <section className="panel">
      <div className="section-title">
        <h3>历史证据</h3>
        <span className={`tag ${c.stale || c.apr === null ? 'warn' : 'good'}`}>
          {c.stale ? 'STALE' : c.apr === null ? 'UNKNOWN' : '完整 · 演示'}
        </span>
      </div>
      <div className="window-grid">
        {windows.map((w) => (
          <div key={w} className={w === c.days ? 'chosen' : ''}>
            <span>{w}天</span>
            <strong>
              {rankValue(c.selected, w) === null ? 'UNKNOWN' : `${rankValue(c.selected, w)}%`}
            </strong>
          </div>
        ))}
      </div>
      <p>
        方向固定：short {c.selected.short.venue} / long {c.selected.long.venue}。各窗口不自动换向。
      </p>
      <p>
        共同截止 {new Date(c.snapshot.cutoff).toISOString().slice(0, 16)} UTC；验证区间 (start,
        cutoff]，按各场所实际结算/分段周期核验。演示快照 #{c.snapshot.id}。
      </p>
      <small>
        起点 {new Date(c.snapshot.cutoff - c.days * 86_400_000).toISOString().slice(0, 16)}{' '}
        UTC；核验时间 {new Date(c.snapshot.at).toISOString().slice(0, 19)}{' '}
        UTC。来源：各场所结算历史fixture；重复去重、冲突/缺期不补零。
      </small>
      {c.apr === null && (
        <p className="warn-text">
          {c.selected.missing || `${c.days}天覆盖不足；短窗口完整不代表长窗口完整。`}
        </p>
      )}
      <div className="two-col inset">
        <div>
          <span className="short">SHORT</span>
          <b>{c.selected.short.contract}</b>
          <small>
            {c.selected.short.venue} · {c.selected.short.quote} ·{' '}
            {c.selected.unitComparable === false ? '合约乘数不同，仅观察' : '同标的计量'}
          </small>
          <p>
            当期原始费率 <strong>{c.selected.short.current}</strong>
          </p>
          <small>
            {c.days}天历史简单年化：{c.apr === null ? 'UNKNOWN' : `${mean(c, 'short')}%`}
            ；逐期累计：{cumulative('short')}
          </small>
        </div>
        <div>
          <span className="long">LONG</span>
          <b>{c.selected.long.contract}</b>
          <small>
            {c.selected.long.venue} · {c.selected.long.quote} ·{' '}
            {c.selected.unitComparable === false ? '合约乘数不同，仅观察' : '同标的计量'}
          </small>
          <p>
            当期原始费率 <strong>{c.selected.long.current}</strong>
          </p>
          <small>
            {c.days}天历史简单年化：{c.apr === null ? 'UNKNOWN' : `${mean(c, 'long')}%`}
            ；逐期累计：{cumulative('long')}
          </small>
        </div>
      </div>
      {currentReversed(c.selected, c.days) && (
        <p className="notice">当期方向已反转。只作提示，历史候选方向不变，也不自动换向。</p>
      )}
      <small>
        APR = (Σshort真实结算率 − Σlong真实结算率) × 365 /
        窗口天数。历史率不含价格路径、杠杆和所有成本，不是锁定收益。
      </small>
    </section>
  );
}

export function Sizing({ c }: { c: Demo }) {
  return (
    <section className="panel">
      <div className="section-title">
        <h3>规模与执行路径</h3>
        <button disabled={!!c.intent || c.selected.unitComparable === false} onClick={c.sample}>
          填入演示规模
        </button>
      </div>
      <fieldset className="form-grid" disabled={!!c.intent || c.selected.unitComparable === false}>
        <label>
          相同标的数量
          <input
            aria-label="相同标的数量"
            inputMode="decimal"
            placeholder="手动填写"
            value={c.quantity}
            onChange={(e) => c.edit('quantity', e.target.value)}
          />
        </label>
        <label>
          持有天数 · 可选
          <input
            aria-label="持有天数"
            inputMode="decimal"
            placeholder="填写后显示情景"
            value={c.holdingDays}
            onChange={(e) => c.edit('holdingDays', e.target.value)}
          />
        </label>
        <label>
          short杠杆
          <input
            aria-label="short杠杆"
            inputMode="numeric"
            placeholder="1–5"
            value={c.shortLev}
            onChange={(e) => c.edit('shortLev', e.target.value)}
          />
        </label>
        <label>
          long杠杆
          <input
            aria-label="long杠杆"
            inputMode="numeric"
            placeholder="1–5"
            value={c.longLev}
            onChange={(e) => c.edit('longLev', e.target.value)}
          />
        </label>
        <label>
          maker腿
          <select
            aria-label="maker腿"
            value={c.maker}
            onChange={(e) => c.edit('maker', e.target.value)}
          >
            <option value="">请选择</option>
            <option value="short">short · {c.selected.short.venue}</option>
            <option value="long">long · {c.selected.long.venue}</option>
          </select>
        </label>
        <label>
          maker等待 · 秒
          <input
            aria-label="maker等待秒数"
            inputMode="numeric"
            value={c.timeout}
            onChange={(e) => c.edit('timeout', e.target.value)}
          />
        </label>
      </fieldset>
      <p>
        {c.selected.unitComparable === false
          ? '执行单位不可比，不生成两腿执行数量；输入值不能隐式换算合约。'
          : `两腿均为 ${c.quantity || '—'} ${c.selected.asset}`}
        ；分别按各腿价格计算名义金额。默认300秒，到期转taker；允许30–3600秒。
      </p>
      <small>
        演示精度、费用和保证金只是固定fixture。真实产品须服务端验证实际规则，不能用本表作为交易依据。
      </small>
    </section>
  );
}

export function Costs({ c }: { c: Demo }) {
  const s = scenario(c);
  const hasDays = /^\d+(\.\d{1,6})?$/.test(c.holdingDays) && fixed(c.holdingDays) > 0n;
  const makerN = c.maker === 'short' ? c.shortN : c.longN;
  const hedgeN = c.maker === 'short' ? c.longN : c.shortN;
  const amounts = c.q > 0n && !!c.maker && c.selected.unitComparable !== false;
  return (
    <section className="panel">
      <div className="section-title">
        <h3>费用证据与持有情景</h3>
        <span className={`tag ${c.knownCost ? '' : 'warn'}`}>
          {c.knownCost ? '当前账户fixture' : '真实成本 UNKNOWN'}
        </span>
      </div>
      <p>
        两腿名义金额：
        {c.q > 0n && c.selected.unitComparable !== false
          ? `${decimal(c.shortN)} ${c.selected.short.quote} / ${decimal(c.longN)} ${c.selected.long.quote}`
          : 'UNKNOWN · 未填有效规模或执行单位不可比'}
        。
      </p>
      {!c.knownCost && (
        <p className="notice">
          {c.situation === 'fees'
            ? 'VIP0假设参考：maker 0.02%、taker 0.05%；真实费率及全成本仍UNKNOWN，禁止下单。'
            : '深度或共同计价/换汇证据不足，金额成本UNKNOWN；不能按零计算。'}
        </p>
      )}
      <table className="cost-table">
        <thead>
          <tr>
            <th>一次性往返成本</th>
            <th>正常路径</th>
            <th>到期转换情景</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>开仓费用 · maker / hedge</td>
            <td>
              {c.knownCost && amounts
                ? `${decimal((makerN * 2n) / 10_000n)} + ${decimal((hedgeN * 5n) / 10_000n)}`
                : 'UNKNOWN'}
            </td>
            <td>
              {c.knownCost && amounts ? decimal(((c.shortN + c.longN) * 5n) / 10_000n) : 'UNKNOWN'}
            </td>
          </tr>
          <tr>
            <td>平仓费用 · 双taker</td>
            <td colSpan={2}>
              {c.knownCost && amounts ? decimal(((c.shortN + c.longN) * 5n) / 10_000n) : 'UNKNOWN'}
            </td>
          </tr>
          <tr>
            <td>当前盘口冲击 · 开仓</td>
            <td>{c.knownCost && amounts ? decimal(scaled(c.quantity, '0.25')) : 'UNKNOWN'}</td>
            <td>{c.knownCost && amounts ? decimal(scaled(c.quantity, '0.40')) : 'UNKNOWN'}</td>
          </tr>
          <tr>
            <td>当前盘口冲击 · 平仓双taker</td>
            <td colSpan={2}>
              {c.knownCost && amounts ? decimal(scaled(c.quantity, '0.35')) : 'UNKNOWN'}
            </td>
          </tr>
          {c.quoteRevision > 0 && (
            <tr>
              <td>重报价新增盘口成本</td>
              <td colSpan={2}>{decimal(BigInt(c.quoteRevision) * 350_000n)} USDT</td>
            </tr>
          )}
          <tr>
            <td>往返合计 C · USDT</td>
            <td>{c.knownCost && amounts ? decimal(c.cost) : 'UNKNOWN'}</td>
            <td>{c.knownCost && amounts ? decimal(c.conversionCost) : 'UNKNOWN'}</td>
          </tr>
        </tbody>
      </table>
      <small>
        费率：maker 0.02%、taker 0.05%（
        {c.situation === 'fees'
          ? 'VIP0假设参考，当前实际账户费率UNKNOWN'
          : '两场所当前演示账户证据'}
        ）。演示盘口可成交深度：ETH 5 / BTC 0.2 / HYPE 1000；证据时间{' '}
        {new Date(c.preview ? c.preview.expires - 10_000 : c.snapshot.at)
          .toISOString()
          .slice(11, 19)}{' '}
        UTC。平仓使用双taker＋当前盘口；转换以整条A腿taker参考，未知剩余量，不是价格或成本上限。
      </small>
      <p>
        借款持续成本：{c.knownCost && amounts ? `${decimal(s.borrow, 4)} USDT/日` : 'UNKNOWN'}；
        {c.selected.short.quote === c.selected.long.quote
          ? '同计价，无换汇需求（演示已核验）'
          : 'USDT/USDC换汇证据UNKNOWN，不假定1:1'}
        。
      </p>
      {!hasDays || !amounts ? (
        <p className="muted">
          填写数量、maker腿和可选持有天数后显示金额情景；持有天数不是额外开仓门槛。
        </p>
      ) : !s.complete ? (
        <p className="warn-text">
          金额情景、净日收入及回本 UNKNOWN，缺失证据不能用假设冒充真实成本。
        </p>
      ) : (
        <>
          <div className="scenario-stats">
            <div>
              <small>净日收入 D · USDT</small>
              <strong className={s.net > 0n ? 'good-text' : 'warn-text'}>
                {decimal(s.net, 4)}
              </strong>
            </div>
            <div>
              <small>回本 C / D</small>
              <strong>{s.payback}</strong>
            </div>
            <div>
              <small>{c.holdingDays}天正常路径 H×D−C</small>
              <strong
                className={
                  scaled(c.holdingDays, decimal(s.net, 6)) - c.cost <= 0n ? 'warn-text' : ''
                }
              >
                {decimal(scaled(c.holdingDays, decimal(s.net, 6)) - c.cost)} USDT
              </strong>
            </div>
          </div>
          <p>
            G = {decimal(c.shortN)} × {s.sr}% ÷ 365 − {decimal(c.longN)} × {s.lr}% ÷ 365 ={' '}
            {decimal(s.shortIncome - s.longExpense, 4)} USDT/日；D = G − {decimal(s.borrow, 4)}
            。两腿按相同标的量、各自名义金额计算。
          </p>
        </>
      )}
      {hasDays &&
        amounts &&
        s.complete &&
        scaled(c.holdingDays, decimal(s.net, 6)) - c.cost <= 0n && (
          <p className="notice">
            持有期情景非正。仍可人工预览，但须明确承担浮动利差与成本风险；盈利不是自动准入阈值。
          </p>
        )}
      <p className="notice">
        假设所选历史平均费差持续。未来盘口、基差、汇率及费用变化未保证；情景不是实际净利润或权益年化，杠杆不乘主排名。
      </p>
      <details>
        <summary>回本边界说明</summary>
        <p>
          必要成本未知 → UNKNOWN；净日收入≤0 → 无有限回本；净日收入&gt;0且一次性成本≤0 →
          无需回本；否则 C÷D。金额情景不改变费率排名。
        </p>
      </details>
    </section>
  );
}
