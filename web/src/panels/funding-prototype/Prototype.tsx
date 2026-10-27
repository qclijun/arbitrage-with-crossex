import {
  candidates,
  currentReversed,
  fixed,
  rankValue,
  situations,
  windows,
  type Candidate,
  type WindowDays,
} from './fixtures';
import { Costs, History, Sizing } from './Evidence';
import { Confirmation, Execution, Ownership } from './Confirmation';
import { usePrototype, type Demo } from './usePrototype';

const variants = { A: '排名工作台', B: '研究画布', C: '分步确认' };

function Filters({ c }: { c: Demo }) {
  return (
    <div className="filters panel">
      <div className="segmented" aria-label="历史窗口">
        {windows.map((days) => (
          <button
            aria-pressed={c.days === days}
            className={c.days === days ? 'active' : ''}
            key={days}
            onClick={() => c.changeWindow(days)}
          >
            {days}天
          </button>
        ))}
      </div>
      <label>
        标的
        <select
          aria-label="标的筛选"
          value={c.asset}
          onChange={(e) => {
            c.setAsset(e.target.value);
            c.setPage(0);
          }}
        >
          <option value="ALL">全部标的</option>
          {[...new Set(candidates.map((p) => p.asset))].map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </label>
      <label>
        场所
        <select
          aria-label="场所筛选"
          value={c.venue}
          onChange={(e) => {
            c.setVenue(e.target.value);
            c.setPage(0);
          }}
        >
          <option value="ALL">任一场所</option>
          {[...new Set(candidates.flatMap((p) => [p.short.venue, p.long.venue]))].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={c.positive}
          onChange={(e) => {
            c.setPositive(e.target.checked);
            c.setPage(0);
          }}
        />
        只看正利差
      </label>
    </div>
  );
}

function Rate({ c, p, days }: { c: Demo; p: Candidate; days: WindowDays }) {
  const rate = rankValue(p, days);
  return (
    <span
      className={`rate ${rate === null || c.stale ? 'muted' : fixed(rate) > 0n ? 'good-text' : 'warn-text'}`}
    >
      {rate === null ? 'UNKNOWN' : `${rate}%`}
    </span>
  );
}
function CandidateTable({ c }: { c: Demo }) {
  return (
    <section className="panel table-panel">
      <div className="section-title">
        <h3>{c.stale ? '缓存观察 · 按身份排列' : '所有有向组合'}</h3>
        <small>{c.filtered.length}条演示候选 · 双向保留</small>
      </div>
      <div className="table-scroll">
        <table className="candidate-table">
          <thead>
            <tr>
              <th># / 标的</th>
              <th>SHORT → LONG</th>
              <th>{c.days}天年化</th>
              {c.days !== 7 && <th>7天对照</th>}
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {c.rows.map((p, index) => (
              <tr key={p.id} className={c.selected.id === p.id ? 'selected' : ''}>
                <td>
                  <small>
                    {c.stale || rankValue(p, c.days) === null ? '观察' : c.page * 6 + index + 1}
                  </small>
                  <b>{p.asset}</b>
                </td>
                <td>
                  <button className="row-select" onClick={() => c.choose(p.id)}>
                    <span>
                      <i className="short">S</i> {p.short.venue} <span className="muted">→</span>{' '}
                      <i className="long">L</i> {p.long.venue}
                    </span>
                    <small>
                      {p.short.contract} / {p.long.contract}
                    </small>
                  </button>
                </td>
                <td>
                  <Rate c={c} p={p} days={c.days} />
                </td>
                {c.days !== 7 && (
                  <td>
                    <Rate c={c} p={p} days={7} />
                  </td>
                )}
                <td>
                  <span className={`tag ${rankValue(p, c.days) === null || c.stale ? 'warn' : ''}`}>
                    {c.stale
                      ? 'STALE'
                      : rankValue(p, c.days) === null
                        ? 'UNKNOWN'
                        : p.reason || !p.supported
                          ? '仅观察'
                          : '历史合格'}
                  </span>
                  {currentReversed(p, c.days) && <small className="warn-text">当期反转</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {c.rows.length === 0 && <p className="empty">没有符合筛选的演示候选；未把缺失值当零。</p>}
      <div className="pagination">
        <span>按未舍入有符号值降序，同分按精确身份；历史合格≠可以下单。</span>
        <button disabled={c.page === 0} onClick={() => c.setPage(c.page - 1)}>
          上一页
        </button>
        <span>
          {c.page + 1} / {Math.max(1, Math.ceil(c.filtered.length / 6))}
        </span>
        <button
          disabled={(c.page + 1) * 6 >= c.filtered.length}
          onClick={() => c.setPage(c.page + 1)}
        >
          下一页
        </button>
      </div>
    </section>
  );
}

function PairHeading({ c }: { c: Demo }) {
  return (
    <div className="pair-heading">
      <div>
        <span className="eyebrow">候选方向 · 始终固定</span>
        <h2>
          {c.selected.asset}{' '}
          <small>
            {c.selected.short.venue} → {c.selected.long.venue}
          </small>
        </h2>
        <code>
          {c.selected.id} · snapshot #{c.snapshot.id}
        </code>
        {!c.filtered.some((p) => p.id === c.selected.id) && (
          <small>列表筛选未包含当前候选；详情保持原身份，换腿须重新选择。</small>
        )}
      </div>
      <div>
        <small>{c.days}天历史资金费差年化</small>
        <Rate c={c} p={c.selected} days={c.days} />
      </div>
    </div>
  );
}

function VariantA({ c }: { c: Demo }) {
  return (
    <>
      <Filters c={c} />
      <div className="workbench">
        <div className="workbench-list">
          <CandidateTable c={c} />
          <Ownership c={c} />
        </div>
        <aside className="workbench-detail">
          <PairHeading c={c} />
          <History c={c} />
          <Sizing c={c} />
          <Costs c={c} />
          <Confirmation c={c} />
          <Execution c={c} />
        </aside>
      </div>
    </>
  );
}

function VariantB({ c }: { c: Demo }) {
  return (
    <>
      <Filters c={c} />
      <div className="research">
        <aside className="research-list">
          <h3>候选索引</h3>
          <p>点击一条，展开完整研究画布。</p>
          {c.rows.map((p) => (
            <button
              key={p.id}
              className={`research-pick ${c.selected.id === p.id ? 'selected' : ''}`}
              onClick={() => c.choose(p.id)}
            >
              <b>{p.asset}</b>
              <Rate c={c} p={p} days={c.days} />
              <small>
                S {p.short.venue} → L {p.long.venue}
              </small>
              <small>
                {p.short.contract} / {p.long.contract}
              </small>
            </button>
          ))}
          <div className="pagination">
            <button disabled={c.page === 0} onClick={() => c.setPage(c.page - 1)}>
              上一页
            </button>
            <span>
              {c.page + 1} / {Math.max(1, Math.ceil(c.filtered.length / 6))}
            </span>
            <button
              disabled={(c.page + 1) * 6 >= c.filtered.length}
              onClick={() => c.setPage(c.page + 1)}
            >
              下一页
            </button>
          </div>
        </aside>
        <article className="research-canvas">
          <PairHeading c={c} />
          <History c={c} />
          <div className="two-col aligned">
            <Sizing c={c} />
            <Costs c={c} />
          </div>
          <div className="two-col aligned">
            <Confirmation c={c} />
            <Ownership c={c} />
          </div>
          <Execution c={c} />
        </article>
      </div>
    </>
  );
}

function VariantC({ c }: { c: Demo }) {
  return (
    <>
      <div className="steps">
        {['选择历史候选', '规模 / 成本 / 风险', '预览 / 确认 / 跟踪'].map((label, index) => (
          <button
            key={label}
            aria-pressed={c.step === index + 1}
            className={c.step === index + 1 ? 'active' : ''}
            onClick={() => c.setStep(index + 1)}
          >
            <span>0{index + 1}</span>
            {label}
          </button>
        ))}
      </div>
      {c.step === 1 ? (
        <>
          <Filters c={c} />
          <CandidateTable c={c} />
          <p className="notice">选择后进入步骤02。这里只确定历史方向，尚未产生订单。</p>
        </>
      ) : (
        <div className="guided-canvas">
          <PairHeading c={c} />
          {c.step === 2 ? (
            <>
              <div className="two-col aligned">
                <div>
                  <History c={c} />
                  <Sizing c={c} />
                </div>
                <div>
                  <Costs c={c} />
                  <Ownership c={c} />
                </div>
              </div>
              <button className="primary" onClick={() => c.setStep(3)}>
                查看预览门槛 →
              </button>
            </>
          ) : (
            <>
              <div className="two-col aligned">
                <Confirmation c={c} />
                <div>
                  <History c={c} />
                  <Costs c={c} />
                </div>
              </div>
              <Execution c={c} />
              <button onClick={() => c.setStep(2)}>← 返回编辑（修改即使旧预览失效）</button>
            </>
          )}
        </div>
      )}
    </>
  );
}

export function Prototype() {
  const c = usePrototype();
  return (
    <div className="funding-prototype">
      <div className="prototype-banner">
        <strong>PROTOTYPE 05</strong> 固定演示数据 · 不连接账户或交易API · 刷新重置 · 等待用户验收
      </div>
      <header className="terminal-header">
        <div className="account-strip">
          <strong className="brand">
            ◈ CrossEx <span>TERMINAL</span>
          </strong>
          <span className="tag">演示账户</span>
          <span className="muted">权益 / 余额并非真实账户</span>
          <span className="offline">● OFFLINE FIXTURES</span>
        </div>
        <nav aria-label="终端入口">
          {[
            ['opportunities', 'Opportunities · 四腿/三腿'],
            ['positions', 'Positions'],
            ['funding', '永续两腿机会'],
            ['risk', 'Risk'],
          ].map(([id, label]) => (
            <button key={id} className={c.tab === id ? 'active' : ''} onClick={() => c.setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <span className="eyebrow">FUNDING OPPORTUNITIES / 浮动永续两腿</span>
            <h1>
              {c.tab === 'funding'
                ? '永续两腿机会'
                : c.tab === 'opportunities'
                  ? '四腿 / 三腿机会 · 保留入口'
                  : c.tab === 'positions'
                    ? '策略切片与当前数量'
                    : 'Risk 适用证据'}
            </h1>
            <p>历史资金费差用于发现方向，规模成本与执行资格单独验证。</p>
          </div>
          <label className="scenario-picker">
            演示证据
            <select
              aria-label="演示证据"
              value={c.situation}
              onChange={(e) => c.setSituation(e.target.value as Demo['situation'])}
            >
              {situations.map(([id, label]) => (
                <option value={id} key={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className={`snapshot-banner ${c.stale ? 'is-stale' : ''}`}>
          <div>
            <strong>
              {c.stale ? 'STALE · 暂停排名和下单' : `演示快照 #${c.snapshot.id} · 所选窗口逐腿验证`}
            </strong>
            <small>
              共同截止 {new Date(c.snapshot.cutoff).toISOString().slice(0, 16)} UTC · 15分钟刷新契约
              · 4/6场所成功，1失败 / 1周期未证明（UNKNOWN）
            </small>
            <small>当前显示固定样本，并非全市场扫描结果；失败只影响涉及该场所的组合。</small>
          </div>
          <button onClick={c.refresh}>模拟完整证据刷新</button>
        </div>
        {c.tab === 'funding' ? (
          c.variant === 'B' ? (
            <VariantB c={c} />
          ) : c.variant === 'C' ? (
            <VariantC c={c} />
          ) : (
            <VariantA c={c} />
          )
        ) : c.tab === 'opportunities' ? (
          <section className="panel preserved">
            <h2>四腿 / 三腿入口继续保留</h2>
            <p>这里仅表示导航保留。Boros锁定到期资金费策略与浮动两腿分开，不合并收益口径。</p>
            <button onClick={() => c.setTab('funding')}>返回永续两腿原型</button>
          </section>
        ) : (
          <>
            <Ownership c={c} />
            <Execution c={c} />
            <button onClick={() => c.setTab('funding')}>返回选定候选</button>
          </>
        )}
        <details className="debug panel">
          <summary>原型状态 / 可观察变化</summary>
          <pre>
            {JSON.stringify(
              {
                variant: c.variant,
                tab: c.tab,
                window: c.days,
                direction: c.identity,
                filters: {
                  asset: c.asset,
                  venue: c.venue,
                  positiveOnly: c.positive,
                  page: c.page + 1,
                },
                snapshot: c.snapshot,
                stale: c.stale,
                evidence: c.situation,
                quantity: c.quantity,
                leverage: [c.shortLev, c.longLev],
                maker: c.maker,
                timeout: c.timeout,
                holdingDays: c.holdingDays,
                preview: c.preview,
                consents: {
                  risk: c.riskConsent,
                  conversion: c.convertConsent,
                  nonPositive: c.negativeConsent,
                },
                intent: c.intent,
                confirmedIntent: c.intentMeta,
                execution: c.execution,
                blockers: c.blockers,
              },
              null,
              2,
            )}
          </pre>
        </details>
      </main>
      {import.meta.env.DEV && (
        <div className="prototype-switcher">
          <button
            aria-label="上一个布局"
            onClick={() => c.setVariant(['C', 'A', 'B'][['A', 'B', 'C'].indexOf(c.variant)])}
          >
            ←
          </button>
          <span>
            布局 {c.variant} · {variants[c.variant as keyof typeof variants] || variants.A}
            <small>左右键切换 · URL可分享</small>
          </span>
          <button
            aria-label="下一个布局"
            onClick={() => c.setVariant(['B', 'C', 'A'][['A', 'B', 'C'].indexOf(c.variant)])}
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}
