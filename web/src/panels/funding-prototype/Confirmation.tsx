import { decimal, fixed } from './fixtures';
import type { Demo } from './usePrototype';

export function Confirmation({ c }: { c: Demo }) {
  function consent(kind: 'risk' | 'convert' | 'negative', value: boolean) {
    c.cancelHold();
    if (kind === 'risk') c.setRiskConsent(value);
    if (kind === 'convert') c.setConvertConsent(value);
    if (kind === 'negative') c.setNegativeConsent(value);
  }
  return (
    <section className="panel confirm-panel">
      <div className="section-title">
        <h3>预览与人工确认</h3>
        <span className="tag">全程模拟</span>
      </div>
      <ul className="blockers">
        {c.blockers.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
      <button className="primary wide" disabled={c.blockers.length > 0} onClick={c.makePreview}>
        {c.preview ? '重新核验并生成预览' : '只读重验 · 生成预览'}
      </button>
      {c.preview && (
        <div className="preview-box">
          <div className="section-title">
            <strong>
              DEMO-P{c.preview.id} · snapshot #{c.snapshot.id}
            </strong>
            <span className={`countdown ${c.seconds ? '' : 'warn-text'}`}>
              {c.seconds ? `${c.seconds}s 有效` : '已过期'}
            </span>
          </div>
          <p>
            {c.days}天 · short {c.selected.short.venue}/{c.selected.short.contract} / long{' '}
            {c.selected.long.venue}/{c.selected.long.contract}
          </p>
          <p>
            数量各 {c.quantity} {c.selected.asset}；杠杆 {c.shortLev}× / {c.longLev}×；maker{' '}
            {c.maker}腿；到期 {c.timeout}s 转taker。
          </p>
          <p>
            当前参考价 {c.selected.short.price} {c.selected.short.quote} / {c.selected.long.price}{' '}
            {c.selected.long.quote}；当前规则/费用/深度、可用保证金及归属证据均为fixture。
          </p>
          <p>
            本次maker委托限价（fixture）：{c.preview.makerLimit}{' '}
            {(c.maker === 'short' ? c.selected.short : c.selected.long).quote}
            ；绑定本次预览与模拟意图。hedge为MARKET IOC，参考价不是hedge价格上限。
          </p>
          <p>
            往返情景：正常 {decimal(c.cost)} / 全A转taker {decimal(c.conversionCost)}{' '}
            USDT。演示保证金需求 {decimal(c.margin)} USDT，可用20,000 USDT。
          </p>
          <p className="notice">
            hedge = MARKET
            IOC，无用户滑点或总成本硬上限。盘口预览不保证成交价，可能短暂单腿敞口、部分成交和残余；两腿不是原子成交。
          </p>
          {c.nonPositive && (
            <p className="notice">
              所选历史差≤0：允许人工决策，不保证盈利，不自动换向；费用可能加剧损失。
            </p>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={c.riskConsent}
              onChange={(e) => consent('risk', e.target.checked)}
            />
            我承担浮动利差、非正持有情景、费用、基差/汇率、IOC价格及单腿残余风险。
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={c.convertConsent}
              onChange={(e) => consent('convert', e.target.checked)}
            />
            初次明确授权：maker到期后同一deal转taker补余量；已看转换费用情景，非费用硬上限。
          </label>
          {c.nonPositive && (
            <label className="check">
              <input
                type="checkbox"
                checked={c.negativeConsent}
                onChange={(e) => consent('negative', e.target.checked)}
              />
              我仍选择此零/负历史方向，接受浮动与成本风险。
            </label>
          )}
          <label className="check muted">
            <input
              type="checkbox"
              checked={c.changeAtSubmit}
              onChange={(e) => {
                c.cancelHold();
                c.setChangeAtSubmit(e.target.checked);
              }}
            />
            演示分支：提交时盘口成本变化，返回新预览重确认
          </label>
          <button
            className={`hold-button ${c.holding ? 'holding' : ''}`}
            disabled={!c.canSubmit}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              c.startHold();
            }}
            onPointerUp={c.cancelHold}
            onPointerCancel={c.cancelHold}
            onLostPointerCapture={c.cancelHold}
            onKeyDown={(e) => {
              if ([' ', 'Enter'].includes(e.key) && !e.repeat) {
                e.preventDefault();
                c.startHold();
              }
            }}
            onKeyUp={c.cancelHold}
            onBlur={c.cancelHold}
          >
            {c.holding ? '持续长按…' : '长按 0.8 秒 · 模拟提交'}
          </button>
          <small>
            松开即取消；最多10秒，过期/参数/证据变化须重新确认。真实产品最终由服务端只读重验，本页按钮只是演示。
          </small>
        </div>
      )}
      <p role="status" className="status-note">
        {c.note}
      </p>
    </section>
  );
}

export function Execution({ c }: { c: Demo }) {
  if (!c.intent || !c.intentMeta) return null;
  const q = fixed(c.intentMeta.quantity);
  const partial = ['PARTIAL', 'UNKNOWN', 'STOPPED', 'CONVERTING'].includes(c.execution);
  const a = partial ? (q * 4n) / 10n : q;
  const b =
    c.execution === 'UNKNOWN'
      ? null
      : partial
        ? q / 10n
        : c.execution === 'DONE_WITH_DUST'
          ? (q * 999n) / 1000n
          : q;
  return (
    <section className="panel execution-panel">
      <div className="section-title">
        <h3>执行追踪 · 模拟</h3>
        <span className="tag warn">{c.execution}</span>
      </div>
      <code>{c.intent} → DEMO-DEAL-001</code>
      <p>已授权maker限价（fixture）：{c.intentMeta.makerLimit}，不随后续缓存变化改写。</p>
      <p>
        身份固定：{c.intentMeta.identity}；{c.intentMeta.days}天 / snapshot #
        {c.intentMeta.snapshotId}；A = {c.intentMeta.maker} maker腿，B = 另一条hedge腿；目标数量各{' '}
        {c.intentMeta.quantity}，不等于实际持仓。
      </p>
      {c.execution === 'MAKER_WORKING' ? (
        <p>maker委托已登记，尚无成交；A实际0，B实际0。B预留量不记成持仓。</p>
      ) : (
        <p>
          A实际累计 {decimal(a, 6)}；B实际累计{' '}
          {b === null ? `UNKNOWN（已知至少${decimal(q / 10n, 6)}）` : decimal(b, 6)}{' '}
          {c.selected.asset}。未对冲/残余：{b === null ? 'UNKNOWN，须探测' : decimal(a - b, 6)}。
        </p>
      )}
      <p>两腿非原子。超时先查原意图；页面不补第二笔、不自动回滚。STOPPED/DONE不代表全量零残余。</p>
      <div className="button-row">
        {[
          ['PARTIAL', '模拟部分成交'],
          ['UNKNOWN', '模拟请求超时 / UNKNOWN'],
          ['CONVERTING', '模拟maker到期转taker'],
          ['DONE_WITH_DUST', '模拟DONE仍有dust'],
          ['STOPPED', '模拟停止 / 残余'],
        ].map(([value, label]) => (
          <button
            key={value}
            disabled={
              ['DONE_WITH_DUST', 'STOPPED'].includes(c.execution) ||
              (value === 'PARTIAL' && !['MAKER_WORKING', 'UNKNOWN'].includes(c.execution))
            }
            onClick={() => c.setExecution(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <button
        onClick={() =>
          c.setNote(`模拟刷新/超时恢复：查询 ${c.intent}，仍为同一DEMO-DEAL-001；不新建或重发。`)
        }
      >
        模拟刷新 / 查询原意图
      </button>
      <small>
        原型仅内存状态，真正刷新浏览器会重置；按钮只演示恢复交互，产品持久化由14/15实施。
      </small>
    </section>
  );
}

export function Ownership({ c }: { c: Demo }) {
  const mismatch = c.situation === 'ownership';
  return (
    <section className="panel">
      <div className="section-title">
        <h3>持仓归属与 Risk 反馈</h3>
        <span className={`tag ${mismatch ? 'warn' : ''}`}>
          {mismatch ? '归属 UNKNOWN' : '当前时点证据 · 模拟'}
        </span>
      </div>
      <p>示例：ETH账户同向净仓4.03，两份长期切片；deal是执行记录，不等于策略仓位。</p>
      <div className="ownership-bar">
        <span>0.36 · Boros策略</span>
        <span>3.67 · {mismatch ? '归属差异' : '已证浮动两腿'}</span>
      </div>
      <div className="two-col">
        <div>
          <h4>应覆盖 0.36</h4>
          <p>按实际Boros市场/方向/到期核验；三腿Spread的资金费来源展开，不重复计持仓/抵押品。</p>
        </div>
        <div>
          <h4>{mismatch ? '未能证明 3.67' : '已证浮动 3.67'}</h4>
          <p>
            {mismatch
              ? '保留原风险/UNKNOWN，阻相关新开/加仓；正常对冲及明确减风险仍可处理。'
              : '只对此数量解除“本应有Boros却缺失”，仍显示浮动资金费暴露。'}
          </p>
        </div>
      </div>
      <p>
        价格净敞口、保证金/清算、单腿缺口和执行unknown均继续检查；HYPE等producer未支持分支保留UNKNOWN，不假装已覆盖。
      </p>
      <dl className="facts">
        <dt>账户/合约资金费汇总</dt>
        <dd>12.34 USDT · 演示</dd>
        <dt>各切片实际收益/手续费</dt>
        <dd>UNKNOWN · 缺逐切片时间/金额证据</dd>
      </dl>
      <details>
        <summary>旧仓如何从当前时点认领？</summary>
        <p>
          完整核验当前仓位、腿/方向、必要Boros及全部相关数量后，用户明确选定未归属数量，保存当前时点和来源；不回填过去收益，不抹历史差异。这里仅展示凭证要求，不自动改账。
        </p>
      </details>
      <div className="button-row">
        <button onClick={() => c.setTab('positions')}>查看策略切片 / 实际数量</button>
        <button onClick={() => c.setTab('risk')}>查看Risk适用证据</button>
      </div>
    </section>
  );
}
