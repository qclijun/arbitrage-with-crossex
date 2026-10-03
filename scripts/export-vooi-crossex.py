import json
from pathlib import Path
from datetime import datetime, timezone, timedelta

d=json.loads(Path('/tmp/vooi-crossex-matched.json').read_text())
rows=d['rows']
def fmt(v):
    return '—' if v is None else f'{v:+.2f}%'
header = '''# VOOI → Gate CrossEx 套利合约匹配快照

抓取时间：2026-10-03 09:20–09:25（Asia/Shanghai）。分页并非同一时刻的原子快照。

来源：VOOI 公开 /arbitrage-scanner 接口（仅筛选 Binance、Bybit、Gate、Hyperliquid、Lighter），Gate CrossEx 公开 /api/v4/crossex/rule/symbols。

扫描 793 个标的分组；匹配 422 个标的分组、1555 个当前正资金费差的跨交易所双腿组合。两边均精确匹配 state=live、business_type=FUTURE 的 CrossEx 合约，并均返回 support_cross=true。

这是合约规则层面的匹配，没有验证个人账户权限、实际下单或成交。并未匹配负资金费差的纯价差机会。VOOI 归一化标的分组及别名沿用其扫描器；不同名称的合约还需核实标的身份及合约乘数。同名合约也应按标的数量、而不是订单张数匹配。

当前毛 APR = fundingSpread1h × 8760 × 100%；24h均值毛 APR = avgFundingSpread24h × 8760 × 100%。均非保证金净收益率。每腿名义金额 $1000；日毛资金费假设费率持续24h，不扣交易费、借款利息、滑点、价差盈亏，也不保证实际结算相同。负开仓价差表示开仓不利，正开仓价差也不是已锁定利润。

| VOOI 标的 | 多头 CrossEx 合约 | 空头 CrossEx 合约 | 当前毛 APR | 24h均值毛 APR | $1000/腿开仓价差 | 估算日毛资金费 | 较小侧24h成交额 | 较小侧OI |
|---|---|---|---:|---:|---:|---:|---:|---:|
'''
lines=[header]
for r in rows:
    lines.append(f"| {r['asset']} | {r['long']} | {r['short']} | {fmt(r['apr'])} | {fmt(r['avg24hApr'])} | {fmt(r['priceSpreadAtSizePct'])} | ${r['grossFunding24hUsd']:.4f} | ${r['minVolume24hUsd']:,.0f} | ${r['minOpenInterestUsd']:,.0f} |\n")
p=Path('/tmp/vooi-crossex-opportunities-20261003.md')
p.write_text(''.join(lines))
print('REPORT',p,'bytes',p.stat().st_size,'rows',len(rows))
print('TOP PER ASSET')
seen=set()
for r in rows:
    if r['asset'] in seen:
        continue
    seen.add(r['asset'])
    print(r['asset'],r['long'],r['short'],fmt(r['apr']),fmt(r['avg24hApr']),fmt(r['priceSpreadAtSizePct']))
    if len(seen)==15:
        break
