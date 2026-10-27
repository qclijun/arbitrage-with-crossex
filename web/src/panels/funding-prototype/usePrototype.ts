import { useEffect, useRef, useState } from 'react';
import {
  candidates,
  decimal,
  fixed,
  identity,
  rankValue,
  scaled,
  type Situation,
  type WindowDays,
} from './fixtures';

export function usePrototype() {
  const requestedVariant = new URLSearchParams(location.search).get('variant') || 'A';
  const [variant, setVariantState] = useState(
    ['A', 'B', 'C'].includes(requestedVariant) ? requestedVariant : 'A',
  );
  const [days, setDays] = useState<WindowDays>(30);
  const [asset, setAsset] = useState('ALL');
  const [venue, setVenue] = useState('ALL');
  const [positive, setPositive] = useState(false);
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState('eth-hl-bn');
  const [situation, setSituationState] = useState<Situation>('normal');
  const [quantity, setQuantity] = useState('');
  const [shortLev, setShortLev] = useState('');
  const [longLev, setLongLev] = useState('');
  const [maker, setMaker] = useState('');
  const [timeout, setTimeoutValue] = useState('300');
  const [holdingDays, setHoldingDays] = useState('');
  const [preview, setPreview] = useState<{
    id: number;
    expires: number;
    makerLimit: string;
  } | null>(null);
  const [riskConsent, setRiskConsent] = useState(false);
  const [convertConsent, setConvertConsent] = useState(false);
  const [negativeConsent, setNegativeConsent] = useState(false);
  const [holding, setHolding] = useState(false);
  const [changeAtSubmit, setChangeAtSubmit] = useState(false);
  const [quoteRevision, setQuoteRevision] = useState(0);
  const [intent, setIntent] = useState<string | null>(null);
  const [intentMeta, setIntentMeta] = useState<{
    snapshotId: number;
    days: WindowDays;
    quantity: string;
    maker: string;
    makerLimit: string;
    identity: string;
  } | null>(null);
  const [execution, setExecution] = useState('');
  const [tab, setTab] = useState('funding');
  const [step, setStep] = useState(1);
  const [note, setNote] = useState('选择一条有向组合，检查逐腿证据。');
  const [snapshot, setSnapshot] = useState({
    id: 1,
    at: Date.now(),
    cutoff: Math.floor(Date.now() / 3_600_000) * 3_600_000,
  });
  const [clock, setClock] = useState(Date.now());
  const holdTimer = useRef<ReturnType<typeof setTimeout>>();
  const previewCounter = useRef(0);
  const intentCounter = useRef(0);
  const submitted = useRef(false);
  const admission = useRef(false);
  const selected = candidates.find((p) => p.id === selectedId)!;
  const stale =
    situation === 'stale' ||
    clock - snapshot.at > 900_000 ||
    snapshot.cutoff < Math.floor(clock / 3_600_000) * 3_600_000;
  const apr = rankValue(selected, days);
  const q = fixed(quantity);
  const shortN = scaled(quantity, selected.short.price);
  const longN = scaled(quantity, selected.long.price);
  const knownCost =
    situation !== 'fees' &&
    situation !== 'depth' &&
    selected.short.quote === selected.long.quote &&
    selected.unitComparable !== false;
  const cost =
    (shortN * (maker === 'short' ? 2n : 5n)) / 10_000n +
    (longN * (maker === 'long' ? 2n : 5n)) / 10_000n +
    ((shortN + longN) * 5n) / 10_000n +
    scaled(quantity, '0.600000') +
    BigInt(quoteRevision) * 350_000n;
  const conversionCost =
    ((shortN + longN) * 10n) / 10_000n +
    scaled(quantity, '0.750000') +
    BigInt(quoteRevision) * 350_000n;
  const minQty = selected.asset === 'HYPE' ? 100_000n : 1_000n;
  const maxQty =
    selected.asset === 'BTC' ? 200_000n : selected.asset === 'HYPE' ? 1_000_000_000n : 5_000_000n;
  const lot = minQty;
  const validLev = (v: string) => /^[1-5]$/.test(v);
  const margin =
    validLev(shortLev) && validLev(longLev)
      ? shortN / BigInt(shortLev) + longN / BigInt(longLev)
      : 0n;
  const blockers = [
    ...(stale ? ['历史 stale：仅观察，暂停排名和下单'] : []),
    ...(apr === null ? [selected.missing || `${days}天证据不完整`] : []),
    ...(!selected.supported ? [selected.reason || '不在执行白名单 / 单位不支持'] : []),
    ...(selected.unitComparable === false ? ['执行单位不可比，不能自动换算合约数量'] : []),
    ...(selected.short.quote !== selected.long.quote ? [selected.reason!] : []),
    ...(situation === 'fees' ? ['真实账户费率UNKNOWN；VIP0仅参考，不准入'] : []),
    ...(situation === 'depth' ? ['当前盘口不足；滑点/全成本UNKNOWN'] : []),
    ...(situation === 'ownership'
      ? ['归属差异UNKNOWN，阻止相关新增风险；正常对冲/减风险仍保留']
      : []),
    ...(situation === 'opposite' ? ['会先减反向旧净仓，阻止新开；先处理旧仓并重新预览'] : []),
    ...(situation === 'conflict'
      ? ['同合约已有活动执行，阻止新意图；查询既有执行，不盲目重建']
      : []),
    ...(!/^\d+(\.\d{1,6})?$/.test(quantity) || q < minQty || q % lot !== 0n
      ? [`输入同标的数量；演示lot ${decimal(lot, 3)}`]
      : []),
    ...(q > maxQty ? ['演示盘口深度不足，不能静默改量'] : []),
    ...(q > 0n && (shortN < 10_000_000n || longN < 10_000_000n)
      ? ['两腿名义金额须各满足演示最小10 USDT']
      : []),
    ...(!validLev(shortLev) || !validLev(longLev) ? ['分别填写两腿杠杆（演示范围1–5倍整数）'] : []),
    ...(margin > 20_000_000_000n ? ['演示可用保证金不足（20,000 USDT）'] : []),
    ...(!maker ? ['请选择maker腿'] : []),
    ...(!/^\d+$/.test(timeout) || fixed(timeout) < 30_000_000n || fixed(timeout) > 3_600_000_000n
      ? ['maker等待须为30–3600秒，不自动夹值']
      : []),
    ...(intent ? ['已有同合约执行意图；先查询处理，不再新建'] : []),
  ];
  const nonPositive = apr !== null && fixed(apr) <= 0n;
  const seconds = preview ? Math.max(0, Math.ceil((preview.expires - clock) / 1000)) : 0;
  const canSubmit =
    preview !== null &&
    clock < preview.expires &&
    blockers.length === 0 &&
    riskConsent &&
    convertConsent &&
    (!nonPositive || negativeConsent);
  admission.current = canSubmit;

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => () => clearTimeout(holdTimer.current), []);
  function cancelHold() {
    clearTimeout(holdTimer.current);
    setHolding(false);
  }
  function invalidate() {
    cancelHold();
    setPreview(null);
    setRiskConsent(false);
    setConvertConsent(false);
    setNegativeConsent(false);
    setNote('参数或证据已改变，旧预览失效；请重新预览。');
  }
  function edit(key: string, value: string) {
    if (intent) {
      setNote('当前执行参数已绑定，不能通过编辑改变同一意图。');
      return;
    }
    invalidate();
    if (key === 'quantity') setQuantity(value);
    if (key === 'shortLev') setShortLev(value);
    if (key === 'longLev') setLongLev(value);
    if (key === 'maker') setMaker(value);
    if (key === 'timeout') setTimeoutValue(value);
    if (key === 'holdingDays') setHoldingDays(value);
  }
  function choose(id: string) {
    if (intent) {
      setNote(
        '本原型单轮演示保留原执行视图；产品仅阻止相关合约冲突。刷新原型可演示另一轮，不代表结束真实执行。',
      );
      return;
    }
    invalidate();
    if (id !== selectedId) {
      setQuantity('');
      setShortLev('');
      setLongLev('');
      setMaker('');
      setQuoteRevision(0);
      setChangeAtSubmit(false);
    }
    setSelectedId(id);
    setStep(2);
  }
  function changeWindow(value: WindowDays) {
    if (intent) {
      setNote('当前执行保留原历史身份；演示查询结束后刷新原型可开始另一轮。');
      return;
    }
    invalidate();
    setDays(value);
    setPage(0);
  }
  function setSituation(value: Situation) {
    invalidate();
    setSituationState(value);
    if (value === 'stale') {
      setSnapshot((s) => ({
        ...s,
        at: Date.now() - 16 * 60_000,
        cutoff: Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000,
      }));
    }
  }
  function sample() {
    if (intent) return;
    invalidate();
    setQuantity(selected.asset === 'BTC' ? '0.01' : selected.asset === 'HYPE' ? '10' : '1');
    setShortLev('2');
    setLongLev('2');
    setMaker('short');
    setHoldingDays('7');
    setTimeoutValue('300');
  }
  function makePreview() {
    if (blockers.length) {
      setNote(blockers[0]);
      return;
    }
    setPreview({
      id: ++previewCounter.current,
      expires: Date.now() + 10_000,
      makerLimit: (maker === 'short' ? selected.short : selected.long).price,
    });
    setRiskConsent(false);
    setConvertConsent(false);
    setNegativeConsent(false);
    setStep(3);
    setNote('演示服务端已重验完整证据；预览10秒有效。');
  }
  function startHold() {
    if (!canSubmit || holding || submitted.current) return;
    setHolding(true);
    holdTimer.current = setTimeout(() => {
      setHolding(false);
      if (submitted.current) return;
      if (!preview || Date.now() >= preview.expires) {
        setNote('预览已过期，拒绝模拟提交。');
        return;
      }
      if (
        !admission.current ||
        Date.now() - snapshot.at > 900_000 ||
        snapshot.cutoff < Math.floor(Date.now() / 3_600_000) * 3_600_000
      ) {
        setNote('最终演示重验未通过，证据/确认已失效；没有创建意图。');
        return;
      }
      if (changeAtSubmit) {
        setQuoteRevision((v) => v + 1);
        setChangeAtSubmit(false);
        setPreview({
          id: ++previewCounter.current,
          expires: Date.now() + 10_000,
          makerLimit: (maker === 'short' ? selected.short : selected.long).price,
        });
        setRiskConsent(false);
        setConvertConsent(false);
        setNegativeConsent(false);
        setNote('最终只读重验发现成本变化+0.35 USDT：返回新预览，须重新确认；尚未创建意图。');
        return;
      }
      submitted.current = true;
      setIntentMeta({
        snapshotId: snapshot.id,
        days,
        quantity,
        maker,
        makerLimit: preview.makerLimit,
        identity: identity(selected),
      });
      setIntent(`DEMO-INTENT-${(++intentCounter.current).toString().padStart(3, '0')}`);
      setExecution('MAKER_WORKING');
      setNote('仅模拟接受意图。不是两腿原子成交，不自动补单或回滚。');
    }, 800);
  }
  function refresh() {
    invalidate();
    setSituationState('normal');
    setSnapshot((s) => ({
      id: s.id + 1,
      at: Date.now(),
      cutoff: Math.floor(Date.now() / 3_600_000) * 3_600_000,
    }));
    setNote('模拟重新核验结算证据、当前规则和归属，生成新快照；不是只续observedAt。');
  }
  function setVariant(value: string) {
    const v = ['A', 'B', 'C'].includes(value) ? value : 'A';
    setVariantState(v);
    const url = new URL(location.href);
    url.searchParams.set('variant', v);
    history.replaceState(null, '', url);
  }
  useEffect(() => {
    const cycle = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.closest('input,textarea,select,[contenteditable],button') ||
        !['ArrowLeft', 'ArrowRight'].includes(event.key)
      )
        return;
      event.preventDefault();
      const index = ['A', 'B', 'C'].indexOf(variant);
      setVariant(['A', 'B', 'C'][(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3]);
    };
    window.addEventListener('keydown', cycle);
    return () => window.removeEventListener('keydown', cycle);
  }, [variant]);
  const filtered = candidates.filter(
    (p) =>
      (asset === 'ALL' || p.asset === asset) &&
      (venue === 'ALL' || [p.short.venue, p.long.venue].includes(venue)) &&
      (!positive || (rankValue(p, days) !== null && fixed(rankValue(p, days)!) > 0n)),
  );
  filtered.sort((a, b) => {
    if (stale) return identity(a).localeCompare(identity(b));
    const av = rankValue(a, days),
      bv = rankValue(b, days);
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    const delta = fixed(bv || '0') - fixed(av || '0');
    return delta > 0n ? 1 : delta < 0n ? -1 : identity(a).localeCompare(identity(b));
  });
  const rows = filtered.slice(page * 6, page * 6 + 6);
  return {
    variant,
    setVariant,
    days,
    changeWindow,
    asset,
    setAsset,
    venue,
    setVenue,
    positive,
    setPositive,
    page,
    setPage,
    selected,
    choose,
    situation,
    setSituation,
    quantity,
    shortLev,
    longLev,
    maker,
    timeout,
    holdingDays,
    edit,
    sample,
    preview,
    makePreview,
    riskConsent,
    setRiskConsent,
    convertConsent,
    setConvertConsent,
    negativeConsent,
    setNegativeConsent,
    holding,
    startHold,
    cancelHold,
    changeAtSubmit,
    setChangeAtSubmit,
    intent,
    intentMeta,
    execution,
    setExecution,
    tab,
    setTab,
    step,
    setStep,
    note,
    setNote,
    snapshot,
    refresh,
    stale,
    apr,
    q,
    shortN,
    longN,
    knownCost,
    cost,
    conversionCost,
    margin,
    blockers,
    nonPositive,
    seconds,
    canSubmit,
    rows,
    filtered,
    clock,
    quoteRevision,
    identity: identity(selected),
  };
}
export type Demo = ReturnType<typeof usePrototype>;
