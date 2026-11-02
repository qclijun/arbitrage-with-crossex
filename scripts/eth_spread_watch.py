#!/usr/bin/env python3
"""Read-only watch for the ETH funding spread: short Hyperliquid, long Binance.

Standard library only; no orders. Funding history is public; the account's own
CrossEx fee rates come from the local terminal (GET /api/fees). Not part of
risk_monitor.py, which watches the four-leg Boros + CrossEx book.

Both venues use the same formula (premium + clamp(0.01%/8h - premium, +-0.05%)),
so the spread exists only while their premiums differ. In the year to
2026-11-02 Binance ETH settled below its 0.01% baseline 95% of the time, and
those settlements carried all of the spread. Checks, on the last settled data:

  1. 30-day net APR (HL - Binance) against the break-even: one round trip
     (open and close, both legs) at the account's fee rates, spread over
     --hold-days, plus --borrow-apr. --breakeven replaces the computed value.
  2. Net APR of each of the last two 7-day blocks: both negative is a reversal.
  3. Share of 30-day Binance settlements exactly at the 0.01% baseline
     (--baseline-share): Binance back at baseline means the spread is gone.

Status and exit code: OK 0; WARN 1 (any check fails); ALERT 2 (the 30-day net
stayed below break-even at every Binance settlement of the last 7 days);
UNKNOWN 3 (missing or malformed history, or fee rates unavailable).

Schedule, e.g. hourly at :05: 5 * * * * python3 scripts/eth_spread_watch.py --log data/eth-spread-watch/runs.jsonl
"""
import argparse
from decimal import Decimal
import json
from pathlib import Path
import sys
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
HOUR = 3_600_000
DAY = 24 * HOUR
BN_STEP = 8 * HOUR
PERSIST_DAYS = 7
BN_BASELINE = Decimal('0.0001')
HL_BASELINE = Decimal('0.0000125')
LEGS = {'BINANCE': 'BINANCE_FUTURE_ETH_USDT', 'HYPERLIQUID': 'HYPERLIQUID_FUTURE_ETH_USDC'}
STATUS_CODE = {'OK': 0, 'WARN': 1, 'ALERT': 2, 'UNKNOWN': 3}


class DataError(ValueError):
    """History or fees are missing, malformed or not on the expected cadence."""


def http_get(url, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json', **(headers or {})})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def rate(value):
    if not isinstance(value, str):
        raise DataError('rate-not-string')
    try:
        return Decimal(value)
    except ArithmeticError as exc:
        raise DataError('rate-invalid') from exc


def hour_of(ms):
    if not isinstance(ms, int) or ms <= 0:
        raise DataError('time-invalid')
    return ms // HOUR * HOUR


def fetch_binance(get, start):
    rows = get(f'https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&startTime={start}&limit=1000')
    if not isinstance(rows, list) or len(rows) >= 1000 or any(r.get('symbol') != 'ETHUSDT' for r in rows):
        raise DataError('binance-page-invalid')
    return [(hour_of(r.get('fundingTime')), rate(r.get('fundingRate'))) for r in rows]


def fetch_hyperliquid(get, start, now):
    out = []
    while start <= now:
        rows = get('https://api.hyperliquid.xyz/info', {'type': 'fundingHistory', 'coin': 'ETH', 'startTime': start})
        if not isinstance(rows, list) or any(r.get('coin') != 'ETH' for r in rows):
            raise DataError('hyperliquid-page-invalid')
        out += [(hour_of(r.get('time')), rate(r.get('fundingRate'))) for r in rows]
        if len(rows) < 500:
            break
        start = rows[-1]['time'] + 1
    return out


def fetch_fees(get, terminal_url, token_file):
    """Per-leg (maker, taker) CrossEx futures rates; an exact-symbol special rate wins."""
    if urllib.parse.urlsplit(terminal_url).hostname not in ('localhost', '127.0.0.1', '::1'):
        raise DataError('terminal-url-not-loopback')
    body = get(f"{terminal_url.rstrip('/')}/api/fees", None, {'x-arb-token': Path(token_file).read_text().strip()})
    rows = {r.get('exchangeType'): r for r in (body or {}).get('data') or [] if isinstance(r, dict)}
    fees = {}
    for venue, symbol in LEGS.items():
        row = rows.get(venue)
        if row is None:
            raise DataError(f'fees-missing-{venue.lower()}')
        special = next((s for s in row.get('specialFeeList') or [] if s.get('symbol') == symbol), None)
        fees[venue] = ((rate(special.get('makerFeeRate')), rate(special.get('takerFeeRate'))) if special
                       else (rate(row.get('futureMakerFee')), rate(row.get('futureTakerFee'))))
    return fees


def breakeven_from(fees, hold_days, borrow_apr, execution='taker'):
    """Open and close both legs once, spread over the hold, plus borrow interest."""
    (bn_maker, bn_taker), (hl_maker, hl_taker) = fees['BINANCE'], fees['HYPERLIQUID']
    one_way = (bn_taker + hl_taker if execution == 'taker'
               else min(bn_maker + hl_taker, hl_maker + bn_taker))  # limit + hedge: maker on one leg
    return 2 * one_way * Decimal(365) / Decimal(hold_days) + borrow_apr


def window(rows, start, end):
    return [r for t, r in rows if start < t <= end]


def evaluate(binance, hyperliquid, breakeven, days=30, baseline_share=Decimal('0.5')):
    """Pure check over settled rows (hour ms, Decimal), aligned on Binance's last settlement."""
    for name, rows in (('binance', binance), ('hyperliquid', hyperliquid)):
        times = [t for t, _ in rows]
        if times != sorted(set(times)):
            raise DataError(f'{name}-duplicate-or-unordered')
    if not binance:
        raise DataError('binance-empty')
    end = binance[-1][0]
    first = end - (days + PERSIST_DAYS) * DAY
    if [t for t, _ in binance if first < t <= end] != list(range(first + BN_STEP, end + 1, BN_STEP)):
        raise DataError('binance-not-8h-or-gapped')
    if [t for t, _ in hyperliquid if first < t <= end] != list(range(first + HOUR, end + 1, HOUR)):
        raise DataError('hyperliquid-gapped')

    def net(lo, hi):
        hl, bn = sum(window(hyperliquid, lo, hi), Decimal(0)), sum(window(binance, lo, hi), Decimal(0))
        scale = Decimal(365 * DAY) / Decimal(hi - lo)
        return {'net': (hl - bn) * scale, 'hyperliquid': hl * scale, 'binance': bn * scale}

    start = end - days * DAY
    month, last, previous = net(start, end), net(end - 7 * DAY, end), net(end - 14 * DAY, end - 7 * DAY)
    # The 30-day net as each Binance settlement of the last 7 days saw it.
    trailing = [net(c - days * DAY, c)['net'] for c in range(end - PERSIST_DAYS * DAY, end + 1, BN_STEP)]
    bn_month, hl_month = window(binance, start, end), window(hyperliquid, start, end)
    share = Decimal(sum(r == BN_BASELINE for r in bn_month)) / len(bn_month)
    checks = {
        'net_30d_below_breakeven': month['net'] < breakeven,
        'net_7d_negative_twice': last['net'] < 0 and previous['net'] < 0,
        'binance_back_at_baseline': share >= baseline_share,
    }
    failed = [k for k, v in checks.items() if v]
    persisted = all(n < breakeven for n in trailing)
    return {'status': 'ALERT' if persisted else 'WARN' if failed else 'OK', 'failed': failed,
            'below_breakeven_7d': persisted, 'cutoff': end, 'days': days, 'breakeven': breakeven,
            'month': month, 'last_7d': last, 'previous_7d': previous,
            'binance_baseline_share': share, 'binance_baseline_share_limit': baseline_share,
            'hyperliquid_baseline_share': Decimal(sum(r == HL_BASELINE for r in hl_month)) / len(hl_month)}


def pct(value):
    return f'{value * 100:.2f}%'


def render(result):
    if result['status'] == 'UNKNOWN':
        return f"UNKNOWN  {result['reason']}"
    cutoff = time.strftime('%Y-%m-%d %H:%MZ', time.gmtime(result['cutoff'] / 1000))
    lines = [f"{result['status']}  ETH 空 Hyperliquid / 多 Binance  截至 {cutoff}"]
    for label, key in ((f"{result['days']} 天", 'month'), ('近 7 天', 'last_7d'), ('前 7 天', 'previous_7d')):
        w = result[key]
        lines.append(f"  {label}: 净 {pct(w['net'])}  (HL {pct(w['hyperliquid'])} / Binance {pct(w['binance'])})")
    source = result.get('breakeven_source', '')
    lines.append(f"  回本线 {pct(result['breakeven'])}{'  ' + source if source else ''}")
    lines.append(f"  Binance 在 0.01% 基准的比例 {pct(result['binance_baseline_share'])}"
                 f" (门槛 {pct(result['binance_baseline_share_limit'])})；HL {pct(result['hyperliquid_baseline_share'])}")
    if result['failed']:
        lines.append('  触发: ' + ', '.join(result['failed'])
                     + ('（30 天净值已连续 7 天低于回本线）' if result['below_breakeven_7d'] else ''))
    return '\n'.join(lines)


def run(args, get=http_get, now=None):
    now = int(time.time() * 1000) if now is None else now
    # Two extra 8h steps: the window aligns on Binance's last settlement, up to 8h before now.
    start = now - (args.days + PERSIST_DAYS) * DAY - 2 * BN_STEP
    try:
        if args.breakeven is not None:
            breakeven, source = args.breakeven, '手动指定'
        else:
            fees = fetch_fees(get, args.terminal_url, args.token_file)
            breakeven = breakeven_from(fees, args.hold_days, args.borrow_apr, args.execution)
            taker = {v: f'{fees[v][1] * 100:f}'.rstrip('0') + '%' for v in fees}
            source = (f"按 {args.execution} 成交，taker 费率 Binance {taker['BINANCE']} / HL {taker['HYPERLIQUID']}，"
                      f"持有 {args.hold_days} 天，借款 {pct(args.borrow_apr)}")
        result = evaluate(fetch_binance(get, start), fetch_hyperliquid(get, start, now), breakeven,
                          args.days, args.baseline_share)
        return {**result, 'breakeven_source': source}
    except (DataError, OSError, ValueError, KeyError, AttributeError, TypeError) as exc:
        return {'status': 'UNKNOWN', 'reason': f'{type(exc).__name__}: {exc}'}


def main(argv=None, get=http_get, now=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--days', type=int, default=30, choices=[14, 30, 60, 90])
    parser.add_argument('--hold-days', type=int, default=90, help='expected holding period the round trip is spread over')
    parser.add_argument('--execution', choices=['taker', 'limit-hedge'], default='taker')
    parser.add_argument('--borrow-apr', type=Decimal, default=Decimal(0), help='borrow interest as APR on notional')
    parser.add_argument('--breakeven', type=Decimal, help='fixed annual break-even, 0.015 = 1.5%%; skips the fee read')
    parser.add_argument('--baseline-share', type=Decimal, default=Decimal('0.5'))
    parser.add_argument('--terminal-url', default='http://localhost:6688')
    parser.add_argument('--token-file', type=Path, default=ROOT / 'api-token')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--log', type=Path, help='append each run as one JSON line')
    args = parser.parse_args(argv)
    if args.hold_days <= 0:
        parser.error('--hold-days must be positive')
    result = run(args, get, now)
    encoded = json.dumps(result, default=str, ensure_ascii=False, sort_keys=True)
    if args.log:
        args.log.parent.mkdir(parents=True, exist_ok=True)
        with args.log.open('a', encoding='utf-8') as log:
            log.write(encoded + '\n')
    print(encoded if args.json else render(result))
    return STATUS_CODE[result['status']]


if __name__ == '__main__':
    sys.exit(main())
