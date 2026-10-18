#!/usr/bin/env python3
"""Daily read-only watch for the 2026-10-30 Boros roll decision.

Implements docs/rollover_watch.md v3. Quotes come from the local terminal and
fee clocks from the public Boros markets API; nothing is written except the JSONL
ledger line. The only mutating-shaped call is POST /api/boros/roll/simulate:
the venue's pricing-only batch preview (no orders, no state change).

Output is the Chinese BOSS report: conclusion first, then the key-number table,
then today's advice. `--json` prints the ledger row instead.
"""
import argparse
import datetime as dt
from decimal import Decimal, ROUND_CEILING, localcontext
import ipaddress
import json
import math
from pathlib import Path
import re
import sys
import time
from urllib import error, parse, request
from zoneinfo import ZoneInfo
from rollover_batch import PROFILE, progress as batch_progress, preview as batch_preview, discover as discover_batches, roll_request

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TOKEN_FILE = ROOT / 'api-token'
DEFAULT_LEDGER = ROOT / 'data/risk-monitor/rollover-watch.jsonl'
DEFAULT_LATEST_JSON = ROOT / 'data/risk-monitor/latest.json'

ADDRESS = PROFILE['address']
TERMINAL = 'http://localhost:6688'

# The old legs (10-30) and the only venue-matched later target (11-27).
OLD_HL = 196      # Hyperliquid ETH 30 Oct 2026, SHORT -> close by buying
OLD_OKX = 198     # OKX ETHUSDT 30 Oct 2026, LONG -> close by selling
NEW_HL = 209      # Hyperliquid ETH 27 Nov 2026, open SHORT
NEW_OKX = 213     # OKX ETHUSDT 27 Nov 2026, open LONG
MARKETS = (OLD_HL, OLD_OKX, NEW_HL, NEW_OKX)

SIZE = PROFILE['totalSize']
SIZE_TOLERANCE = 1e-9
ENTRY_TOLERANCE = 0.0001  # 1bp absolute APR

OLD_MATURITY = PROFILE['oldMaturity']
EXPECTED_NEW_MATURITY = PROFILE['newMaturity']
ENTRY_APR = {p['marketId']: p['entryApr'] for p in PROFILE['legs']}
L = ENTRY_APR[OLD_HL] - ENTRY_APR[OLD_OKX]  # 4.6595%

YR = 31536000
SLIPPAGE_MAX = 0.005     # per leg, |exec - mid|, same units as roll tolerance
EXIT_TOLERANCE = PROFILE['exitTolerance']   # the A route's exit-side tolerance (0.5%)
R_B_RATE = 0.005
VERSION = 3
TERMS_URL = 'https://api-boros.pendle.finance/apis/v1/markets/by-ids?marketIds=196,198,209,213'
GAS_USD_MIN = PROFILE['gasMinimumUsd']
FUNDING_GAP_CRITICAL = 300

DECISION_DATE = dt.date(2026, 10, 25)
END_DATE = dt.date(2026, 10, 29)

# docs/rollover_watch.md, execution gate G: VERIFIED 2026-10-17 (read-only).
GATE_G = 'VERIFIED'

try:
    TZ = ZoneInfo('Asia/Taipei')
except Exception:  # pragma: no cover - the runtime normally ships tzdata
    TZ = dt.timezone(dt.timedelta(hours=8))

ALLOWED_GET = re.compile(r'^/api/(?:asset-view/0x[0-9a-fA-F]{40}|opportunities)$')
ALLOWED_POST = '/api/boros/roll/simulate'
ADDRESS_RE = re.compile(r'^0x[0-9a-fA-F]{40}$')


class WatchError(Exception):
    """A fetch/parse failure that must be reported as UNKNOWN, never guessed."""


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError('Invalid command arguments')


def number(value):
    if type(value) not in (int, float):
        return None
    try:
        return value if math.isfinite(value) else None
    except OverflowError:
        return None


def median(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def unique(items):
    seen = set()
    result = []
    for item in items:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


def local_base(value):
    """Require a loopback terminal origin, so the token cannot leave the box."""
    url = parse.urlsplit(value)
    if (url.scheme not in ('http', 'https') or url.username or url.password
            or url.query or url.fragment or url.path not in ('', '/')):
        raise ValueError('terminal URL must be a loopback origin without credentials, path, query or fragment')
    host = url.hostname
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host == 'localhost'
    if not loopback or url.port == 0:
        raise ValueError('terminal URL must use a loopback address')
    if host == 'localhost':
        host = '127.0.0.1'
    if ':' in host and not host.startswith('['):
        host = f'[{host}]'
    port = f':{url.port}' if url.port else ''
    return parse.urlunsplit((url.scheme, host + port, '', '', ''))


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise error.HTTPError(req.full_url, code, 'redirect refused', headers, fp)


def fetch_json(url, token, timeout, data=None):
    """The only network primitive. GET is path-allowlisted; POST is simulate only."""
    parts = parse.urlsplit(url)
    if url == TERMS_URL and data is not None:
        raise WatchError('Public market evidence is GET only')
    public_terms = url == TERMS_URL and data is None
    if not public_terms:
        local_base(parse.urlunsplit((parts.scheme, parts.netloc, '', '', '')))
    if data is None:
        if not public_terms and not ALLOWED_GET.match(parts.path):
            raise WatchError('request path is not allowed')
        method = 'GET'
    else:
        if parts.path != ALLOWED_POST:
            raise WatchError('POST path is not allowed')
        method = 'POST'
    headers = {'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0'}
    if not public_terms:
        headers['x-arb-token'] = token
    if data is not None:
        headers['Content-Type'] = 'application/json'
    req = request.Request(url, data=data, headers=headers, method=method)
    opener = request.build_opener(*([] if public_terms else [request.ProxyHandler({})]), NoRedirect())
    endpoint = '官方市场API' if public_terms else '终端'
    try:
        with opener.open(req, timeout=timeout) as reply:
            raw = reply.read(16 * 1024 * 1024 + 1)
    except error.HTTPError as exc:
        if exc.code in (401, 403):
            raise WatchError(f'{endpoint}拒绝请求（HTTP {exc.code}）') from None
        raise WatchError(f'{endpoint}返回 HTTP {exc.code}') from None
    except (error.URLError, TimeoutError, OSError) as exc:
        raise WatchError(f'{endpoint}不可达：{getattr(exc, "reason", exc)}') from None
    if len(raw) > 16 * 1024 * 1024:
        raise WatchError('终端响应超过大小上限')
    try:
        return json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WatchError(f'终端响应不是 JSON：{exc}') from None


def api_data(payload, what):
    if not isinstance(payload, dict) or not payload.get('ok'):
        detail = payload.get('error') if isinstance(payload, dict) else None
        if isinstance(detail, dict):
            detail = detail.get('message') or detail.get('code')
        raise WatchError(f'{what} 失败：{detail or "响应缺少 ok"}')
    data = payload.get('data')
    return data if isinstance(data, dict) else {}


def read_token(path):
    try:
        token = Path(path).read_text(encoding='utf-8').strip()
    except OSError as exc:
        raise WatchError(f'无法读取 token 文件：{exc}') from None
    if not token or '\n' in token or '\r' in token:
        raise WatchError('token 文件为空或格式错误')
    return token


def iso_local(ts):
    return dt.datetime.fromtimestamp(ts, TZ).strftime('%Y-%m-%d %H:%M %z')


# ---------------------------------------------------------------------------
# Fetching the four inputs
# ---------------------------------------------------------------------------

def fetch_asset_view(fetch, token, terminal, address, timeout):
    payload = fetch(f'{terminal}/api/asset-view/{address}', token, timeout)
    data = api_data(payload, 'asset-view')
    eth = next((a for a in data.get('assets') or []
                if str(a.get('base', '')).upper() == 'ETH'), None)
    if eth is None:
        raise WatchError('asset-view 中没有 ETH 资产组，无法确认 196/198 仓位（不推断为已退出）')
    price = number(eth.get('priceUsd'))
    if price is not None and price <= 0:
        price = None
    risk = data.get('risk') or {}
    observed = number(risk.get('observedAt'))
    if (address != PROFILE['address'] or risk.get('address', '').lower() != address
            or risk.get('accountId') != 0 or risk.get('version') != 2
            or risk.get('positionsComplete') is not True or risk.get('stale') or payload.get('meta', {}).get('stale')
            or observed is None or not isinstance(risk.get('positions'), list)):
        raise WatchError('Incomplete/unscoped current positions; missing legs are not proof of exit')
    positions = risk['positions']
    return price, positions, observed / 1000


def check_old_legs(positions):
    try:
        batch_progress(positions)
        return []
    except (ValueError, TypeError, AttributeError, KeyError) as exc:
        return [f'WARN: {exc}（仓位或数据异常，不给建议）']


def opportunities_url(terminal, notional):
    query = parse.urlencode({
        'borosEntry': 'market',
        'exitMode': 'roll',
        'notionalUsd': int(notional),
    })
    return f'{terminal}/api/opportunities?{query}'


def period_exec(row, side):
    """The exec rate for the ORDER that closes/opens this leg."""
    if not isinstance(row, dict):
        return None
    key = 'execLongApr' if side == 'long' else 'execShortApr'
    return number(row.get(key))


def extract_sample(data):
    """Pull exactly the four legs, their mids/marks/taker rates and the new maturity."""
    groups = [g for g in data.get('groups') or []
              if isinstance(g, dict) and str(g.get('underlying', '')).upper() == 'ETH']
    rows = {}
    for group in groups:
        for row in group.get('markets') or []:
            if not isinstance(row, dict):
                continue
            try:
                rows[int(row.get('marketId'))] = row
            except (TypeError, ValueError):
                continue

    def group_ids(group):
        result = set()
        for market in group.get('markets') or []:
            if not isinstance(market, dict):
                continue
            try:
                result.add(int(market.get('marketId')))
            except (TypeError, ValueError):
                pass
        return result

    new_groups = [g for g in groups if {NEW_HL, NEW_OKX} & group_ids(g)]
    maturities = []
    for group in new_groups:
        value = number(group.get('maturity'))
        if value is not None and value not in maturities:
            maturities.append(value)
    maturity = maturities[0] if len(maturities) == 1 else None

    fee_values = {}
    for group in groups:
        for pair in group.get('pairs') or []:
            if not isinstance(pair, dict):
                continue
            for leg in pair.get('borosLegs') or []:
                if not isinstance(leg, dict):
                    continue
                try:
                    market_id = int(leg.get('marketId'))
                except (TypeError, ValueError):
                    continue
                rate = number(leg.get('takerFeeRate'))
                if rate is not None:
                    fee_values.setdefault(market_id, []).append(rate)

    sides = {OLD_HL: 'long', OLD_OKX: 'short', NEW_HL: 'short', NEW_OKX: 'long'}
    legs = {}
    for market_id, side in sides.items():
        row = rows.get(market_id)
        legs[market_id] = {
            'exec': period_exec(row, side),
            # Ordinary rate markets encode an unavailable midpoint as zero.
            'mid': (number(row.get('midApr')) or None) if row else None,
            'mark': number(row.get('markApr')) if row else None,
            'taker': median(fee_values.get(market_id, [])),
            'venue': row.get('venue') if row else None,
        }

    def spread(a, b):
        if a is None or b is None:
            return None
        return a - b

    sample = {
        'maturity': maturity,
        'legs': legs,
        'E': spread(legs[OLD_HL]['exec'], legs[OLD_OKX]['exec']),
        'S': spread(legs[NEW_HL]['exec'], legs[NEW_OKX]['exec']),
    }
    if len(maturities) > 1:
        sample['warn'] = f'新腿到期在采样内不一致：{maturities}，按 UNKNOWN 处理'
    return sample


def aggregate_samples(samples, expected_count=None):
    result = {
        'maturity': None,
        'exec': {m: None for m in MARKETS},
        'mid': {m: None for m in MARKETS},
        'mark': {m: None for m in MARKETS},
        'taker': {m: None for m in MARKETS},
        'venue': {m: None for m in MARKETS},
        'E': None,
        'S': None,
        'S_min': None,
        'S_max': None,
        'complete': False,
        'warns': [],
    }
    if not samples:
        result['warns'].append('WARN: 三次 /api/opportunities 采样全部失败，四腿执行价缺失')
        return result

    count = len(samples) if expected_count is None else expected_count
    for market_id in MARKETS:
        for field in ('exec', 'mid', 'mark', 'taker'):
            values = [s['legs'][market_id][field] for s in samples
                      if s['legs'][market_id][field] is not None]
            result[field][market_id] = median(values) if len(values) == count else None
            if len(values) < count and field != 'taker':
                result['warns'].append(
                    f'WARN: {market_id}.{field} 在 {count - len(values)}/{count} 次采样中缺失，'
                    '按 UNKNOWN 处理')
        venues = [s['legs'][market_id]['venue'] for s in samples
                  if s['legs'][market_id].get('venue')]
        result['venue'][market_id] = venues[0] if len(venues) == count and len(set(venues)) == 1 else None

    maturities = [s['maturity'] for s in samples if s.get('maturity') is not None]
    unique_maturities = sorted(set(maturities))
    result['maturity'] = unique_maturities[0] if len(unique_maturities) == 1 and len(maturities) == count else None
    if len(unique_maturities) > 1:
        result['warns'].append(f'WARN: 新腿到期在采样间不一致：{unique_maturities}，按 UNKNOWN 处理')
    elif len(maturities) < count:
        result['warns'].append(
            f'WARN: 新腿到期在 {count - len(maturities)}/{count} 次采样中缺失，按 UNKNOWN 处理')

    e_values = [s['E'] for s in samples if s.get('E') is not None]
    s_values = [s['S'] for s in samples if s.get('S') is not None]
    result['E'] = median(e_values) if len(e_values) == count else None
    result['S'] = median(s_values) if len(s_values) == count else None
    if result['S'] is not None:
        result['S_min'] = min(s_values)
        result['S_max'] = max(s_values)
    if not e_values:
        result['warns'].append('WARN: E 缺失（旧腿退出 exec 不完整），不计算 A')
    elif len(e_values) < count:
        result['warns'].append(f'WARN: E 仅有 {len(e_values)}/{count} 次完整采样，按 UNKNOWN 处理，不计算 A')
    if not s_values:
        result['warns'].append('WARN: S 缺失（新腿 exec 不完整），不计算 A')
    elif len(s_values) < count:
        result['warns'].append(f'WARN: S 仅有 {len(s_values)}/{count} 次完整采样，按 UNKNOWN 处理，不计算 A')
    result['complete'] = (len(samples) == count and result['maturity'] is not None
                          and result['E'] is not None and result['S'] is not None
                          and all(result[field][m] is not None
                                  for m in MARKETS for field in ('exec', 'mid', 'venue')))
    for sample in samples:
        if sample.get('warn'):
            result['warns'].append('WARN: ' + sample['warn'])
    result['warns'] = unique(result['warns'])
    return result


def simulate_roll(fetch, token, terminal, address, timeout, size=SIZE):
    payload = fetch(f'{terminal}{ALLOWED_POST}', token, timeout,
                    json.dumps(roll_request(address, size)).encode('utf-8'))
    return api_data(payload, 'roll simulate')


def roll_gate_status(sim, skipped, size=SIZE, now_epoch=None):
    if skipped:
        return None, ['未运行 roll simulate（--skip-simulate），滚门禁 UNKNOWN']
    if sim is None:
        return None, ['roll simulate 失败或无已验证候选，滚门禁 UNKNOWN']
    try:
        state = batch_preview(sim, size, time.time() if now_epoch is None else now_epoch)
    except (ValueError, KeyError, TypeError) as exc:
        return None, [str(exc)]
    reasons = [str(b.get('code', 'blocker')) + ': ' + str(b.get('message', '')) for b in sim['gate']['blockers']]
    if state['ready'] is not True and not reasons:
        reasons.append('四腿足量、容忍内深度、阶段保证金或gas未通过/未确认')
    return state['ready'], reasons


def read_funding_gap(path, address):
    """The risk monitor's live uncovered-funding metric, when it is this account's."""
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    scope = data.get('scope')
    if isinstance(scope, dict) and scope.get('address'):
        if str(scope['address']).lower() != address.lower():
            return None
    for check in data.get('checks') or []:
        if not isinstance(check, dict):
            continue
        metric = (check.get('metrics') or {}).get('rollover.uncovered_funding_seconds')
        if isinstance(metric, dict):
            value = number(metric.get('value'))
            if value is not None:
                return value
    return None


# ---------------------------------------------------------------------------
# Ledger and history
# ---------------------------------------------------------------------------

def load_history(path):
    rows, warns = [], []
    try:
        lines = Path(path).read_text(encoding='utf-8').splitlines()
    except FileNotFoundError:
        return rows, warns
    except OSError as exc:
        return rows, [f'WARN: 无法读取历史账本：{exc}']
    for index, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            warns.append(f'WARN: 历史账本第 {index} 行无法解析，已忽略')
            continue
        if isinstance(row, dict):
            rows.append(row)
        else:
            warns.append(f'WARN: 历史账本第 {index} 行不是对象，已忽略')
    return rows, warns


def row_date(row):
    now_unix = number(row.get('now_unix'))
    if now_unix is not None:
        return dt.datetime.fromtimestamp(now_unix, TZ).date()
    raw = row.get('ts')
    if not isinstance(raw, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(raw)
    except ValueError:
        try:
            parsed = dt.datetime.strptime(raw, '%Y-%m-%dT%H:%M:%S%z')
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=TZ)
    return parsed.astimezone(TZ).date()


def same_quote_size(row, size):
    value = number(row.get('quote_size_eth'))
    return value is not None and abs(value - size) <= 1e-9


def complete_sample_record(row):
    count, expected = number(row.get('sample_count')), number(row.get('sample_expected_count'))
    interval = number(row.get('sample_interval_seconds'))
    return (row.get('sample_complete') is True and count is not None and count >= 3
            and count == int(count) and count == expected and interval is not None and interval >= 60)


def previous_row(rows, today, quote_size=SIZE):
    """Last complete v=3 row before today; otherwise the last complete row."""
    dated = []
    for index, row in enumerate(rows):
        if row.get('v') != VERSION or not same_quote_size(row, quote_size) or not complete_sample_record(row):
            continue
        day = row_date(row)
        if day is not None:
            dated.append((index, day, row))
    before_today = sorted([item for item in dated if item[1] < today],
                          key=lambda item: (item[1], item[0]))
    if before_today:
        row, day = before_today[-1][2], before_today[-1][1]
        return row, '较昨日' if day == today - dt.timedelta(days=1) else '较上次'
    if dated:
        dated.sort(key=lambda item: (item[1], item[0]))
        return dated[-1][2], '较上次'
    return None, None


def consensus_min(rows, today, current, quote_size=SIZE):
    """Min S over complete v=3 records in the last 3 natural days."""
    values = []
    for row in rows:
        if row.get('v') != VERSION or not same_quote_size(row, quote_size) or not complete_sample_record(row):
            continue
        day = row_date(row)
        if day is None or day > today or day < today - dt.timedelta(days=2):
            continue
        value = number(row.get('S'))
        if value is not None:
            values.append(value)
    if current is not None:
        values.append(current)
    return min(values) if values else None


def append_row(path, row):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('a', encoding='utf-8') as handle:
        handle.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + '\n')


# ---------------------------------------------------------------------------
# The v3 arithmetic
# ---------------------------------------------------------------------------

def empty_row(now_epoch, eth_usd):
    return {
        'v': VERSION,
        'ts': dt.datetime.fromtimestamp(now_epoch, TZ).isoformat(timespec='seconds'),
        'now_unix': int(now_epoch),
        'eth_usd': eth_usd,
        'N_usd': None,
        't_old_yr': None,
        't_new_yr': None,
        't_reopen_yr': None,
        'L': L,
        'profit_scope': 'trade_and_settlement_only; entrance/gas/borrowing/exit costs excluded',
        'E': None,
        'S': None,
        'S_min': None,
        'S_max': None,
        'exec': {str(m): None for m in MARKETS},
        'mid': {str(m): None for m in MARKETS},
        'mark': {str(m): None for m in MARKETS},
        'taker': {str(m): None for m in MARKETS},
        'X_max': None,
        'f_x': None,
        'f_n': None,
        'fee_source': None,
        'fee_A': None,
        'fee_B': None,
        'R_B': None,
        'A_usd': None,
        'S_r_star': None,
        'S_cons': None,
        'M': None,
        'B_minus_A_ref_usd': None,
        'gate_G': GATE_G,
        'warns': [],
    }


def parse_market_terms(payload, now_epoch):
    """Complete, fresh public fee configuration; no account token is sent here."""
    stamp = number((payload.get('syncStatus') or {}).get('timestamp'))
    rows = payload.get('results')
    if (stamp is None or stamp > now_epoch or now_epoch-stamp > 120
            or not isinstance(rows, list) or len(rows) != 4 or payload.get('resumeToken')):
        raise WatchError('Incomplete/stale market fee clocks')
    result = {}
    for row in rows:
        mid = row.get('marketId')
        maturity = OLD_MATURITY if mid in (OLD_HL, OLD_OKX) else EXPECTED_NEW_MATURITY
        expected_venue = 'HYPERLIQUID' if mid in (OLD_HL, NEW_HL) else 'OKX'
        config, ext, data = row.get('config') or {}, row.get('extConfig') or {}, row.get('data') or {}
        seconds, period = number(data.get('timeToMaturity')), number(ext.get('paymentPeriod'))
        raw_rates = [config.get('takerFee'), ext.get('settleFeeRate')]
        if (mid not in MARKETS or mid in result or row.get('tokenId') != 2
                or (row.get('imData') or {}).get('maturity') != maturity
                or str((row.get('platform') or {}).get('platformId', '')).upper() != expected_venue
                or seconds is None or period is None or period <= 0 or seconds <= 0
                or seconds != int(seconds) or period != int(period) or seconds % period != 0
                or not 0 <= stamp-(maturity-seconds) <= period+900
                or any(not isinstance(v, str) or not re.fullmatch(r'\d+', v) for v in raw_rates)
                or any(int(v) > 10**18 for v in raw_rates)):
            raise WatchError('Market identity, fee rate or settlement clock mismatch')
        result[mid] = dict(taker_raw=raw_rates[0], settle_raw=raw_rates[1],
                           fee_seconds=int(seconds), payment_period=int(period), observed_at=stamp)
    return result


def clock_trade_fees(size, terms):
    """Market clock, not wall time; protocol rounds each positive fee up to wei."""
    with localcontext() as context:
        context.prec = 60
        return {str(m): str((Decimal(str(size))*Decimal(t['taker_raw'])*t['fee_seconds']/YR)
                            .to_integral_value(rounding=ROUND_CEILING)/Decimal(10)**18)
                for m, t in terms.items()}


def compute(now_epoch, eth_usd, agg, history, today, quote_size=SIZE, *, terms=None,
            locked_spread=L, risk_premium=R_B_RATE):
    """v3: raw execution APR, actual fee clocks, cash and risk-adjusted comparisons."""
    warns = list(agg['warns'])
    N = quote_size * eth_usd if eth_usd is not None else None
    maturity = agg['maturity']

    t_old = (OLD_MATURITY - now_epoch) / YR if now_epoch < OLD_MATURITY else None
    t_new = (maturity - now_epoch) / YR if maturity is not None and maturity > now_epoch else None
    t_reopen = t_new - t_old if t_old is not None and t_new is not None else None

    if maturity is None:
        warns.append('WARN: 新腿到期缺失，t_new/t_reopen 无法计算')
    elif maturity <= now_epoch:
        warns.append('WARN: 新腿到期已过或等于当前时间，t_new/t_reopen 无法计算')
    elif abs(maturity - EXPECTED_NEW_MATURITY) > 1:
        warns.append(
            f'WARN: 新腿到期 {iso_local(maturity)} 与预期 {iso_local(EXPECTED_NEW_MATURITY)} 不符')
    if t_reopen is not None and t_reopen <= 0:
        warns.append(f'WARN: t_reopen={t_reopen:.6f} 非正，S_r* 无法计算')
        t_reopen = None

    E, S = agg['E'], agg['S']
    f_x = f_n = fee_A = fee_B = settlement_A = settlement_B = R_B = None
    fees = {}
    fee_source = 'UNKNOWN'
    if maturity != EXPECTED_NEW_MATURITY:
        terms = None
    if terms is not None:
        f_x = sum(int(terms[m]['taker_raw'])/1e18 for m in (OLD_HL, OLD_OKX))
        f_n = sum(int(terms[m]['taker_raw'])/1e18 for m in (NEW_HL, NEW_OKX))
        fees = clock_trade_fees(quote_size, terms)
        fee_source = 'market-clock'
        if eth_usd is not None:
            fee_A = float(sum(Decimal(v) for v in fees.values())*Decimal(str(eth_usd)))
        if N is not None and t_reopen is not None and t_old is not None and t_new is not None:
            fee_B = f_n*t_reopen*N  # Future B rates/clock remain a scenario assumption.
            old_settle = sum(int(terms[m]['settle_raw'])/1e18 for m in (OLD_HL, OLD_OKX))
            new_settle = sum(int(terms[m]['settle_raw'])/1e18 for m in (NEW_HL, NEW_OKX))
            settlement_A = new_settle*t_new*N
            settlement_B = (old_settle*t_old+new_settle*t_reopen)*N
    else:
        warns.append('WARN: 费率/结算时钟缺失，不回退猜费；收益和倾向UNKNOWN')
    if N is not None and t_reopen is not None:
        R_B = risk_premium*t_reopen*N

    A = S_r_star = S_r_star_cash = B_cash = B_adjusted = cash_delta = adjusted_delta = None
    if None not in (E, S, N, t_old, t_new, fee_A, settlement_A):
        A = (locked_spread-E)*t_old*N+S*t_new*N-fee_A-settlement_A
    if None not in (A, N, t_old, t_reopen, fee_B, settlement_B) and t_reopen and N:
        S_r_star_cash = (A-locked_spread*t_old*N+fee_B+settlement_B)/(t_reopen*N)
        S_r_star = S_r_star_cash+risk_premium
    if None not in (S, N, t_old, t_reopen, fee_B, settlement_B):
        B_cash = locked_spread*t_old*N+S*t_reopen*N-fee_B-settlement_B
        B_adjusted = B_cash-R_B
    if B_cash is not None and A is not None:
        cash_delta = A-B_cash
        adjusted_delta = A-B_adjusted

    S_cons = consensus_min(history, today, S if agg['complete'] else None, quote_size)
    M = S_cons - S_r_star if S_cons is not None and S_r_star is not None else None

    deviations = {}
    for market_id in MARKETS:
        exec_apr, mid_apr = agg['exec'].get(market_id), agg['mid'].get(market_id)
        deviations[market_id] = abs(exec_apr - mid_apr) if exec_apr is not None and mid_apr is not None else None
    exit_deviations = [deviations[OLD_HL], deviations[OLD_OKX]]
    X_max = max(exit_deviations) if all(v is not None for v in exit_deviations) else None

    return {
        'N': N,
        'maturity': maturity,
        't_old': t_old,
        't_new': t_new,
        't_reopen': t_reopen,
        'E': E,
        'S': S,
        'S_min': agg['S_min'],
        'S_max': agg['S_max'],
        'f_x': f_x,
        'f_n': f_n,
        'fee_source': fee_source,
        'fee_A': fee_A,
        'fee_B': fee_B,
        'R_B': R_B,
        'A': A,
        'S_r_star': S_r_star,
        'S_cons': S_cons,
        'M': M,
        'L': locked_spread,
        'fee_A_eth_by_market': fees,
        'fee_clock_seconds': {str(m): t['fee_seconds'] for m, t in (terms or {}).items()},
        'market_fee_terms': {str(m): t for m, t in (terms or {}).items()},
        'settlement_A': settlement_A,
        'settlement_B': settlement_B,
        'S_r_star_cash': S_r_star_cash,
        'M_cash': S_cons-S_r_star_cash if S_cons is not None and S_r_star_cash is not None else None,
        'B_cash_ref': B_cash,
        'B_risk_adjusted_ref': B_adjusted,
        'A_minus_B_cash_ref': cash_delta,
        'A_minus_B_risk_adjusted_ref': adjusted_delta,
        'risk_premium_apr': risk_premium,
        'B_minus_A_ref': -cash_delta if cash_delta is not None else None,
        'X_max': X_max,
        'deviations': deviations,
        'warns': unique(warns),
    }


def slippage_status(deviations):
    missing = [m for m in MARKETS if deviations.get(m) is None]
    over = [m for m in MARKETS if deviations.get(m) is not None
            and deviations[m] > (EXIT_TOLERANCE if m in (OLD_HL, OLD_OKX) else PROFILE['entryTolerance']) + 1e-12]
    return not missing and not over, missing, over


def same_platform_status(venues):
    pairs = ((OLD_HL, NEW_HL), (OLD_OKX, NEW_OKX))
    for old, new in pairs:
        if not venues.get(old) or not venues.get(new):
            return None
        if str(venues[old]).lower() != str(venues[new]).lower():
            return False
    return True


def build_row(now_epoch, eth_usd, agg, computed, warns):
    row = empty_row(now_epoch, eth_usd)
    row.update({
        'L': computed['L'],
        'N_usd': computed['N'],
        'fee_A_eth_by_market': computed['fee_A_eth_by_market'],
        'fee_clock_seconds': computed['fee_clock_seconds'],
        'market_fee_terms': computed['market_fee_terms'],
        'settlement_A_usd': computed['settlement_A'],
        'settlement_B_usd': computed['settlement_B'],
        'S_r_star_cash': computed['S_r_star_cash'],
        'M_cash': computed['M_cash'],
        'B_cash_ref_usd': computed['B_cash_ref'],
        'B_risk_adjusted_ref_usd': computed['B_risk_adjusted_ref'],
        'A_minus_B_cash_ref_usd': computed['A_minus_B_cash_ref'],
        'A_minus_B_risk_adjusted_ref_usd': computed['A_minus_B_risk_adjusted_ref'],
        'risk_premium_apr': computed['risk_premium_apr'],
        'profit_scope': 'trade_and_settlement_only; entrance/gas/borrowing/exit costs excluded',
        't_old_yr': computed['t_old'],
        't_new_yr': computed['t_new'],
        't_reopen_yr': computed['t_reopen'],
        'E': computed['E'],
        'S': computed['S'],
        'S_min': computed['S_min'],
        'S_max': computed['S_max'],
        'exec': {str(m): agg['exec'].get(m) for m in MARKETS},
        'mid': {str(m): agg['mid'].get(m) for m in MARKETS},
        'mark': {str(m): agg['mark'].get(m) for m in MARKETS},
        'taker': {str(m): agg['taker'].get(m) for m in MARKETS},
        'X_max': computed['X_max'],
        'f_x': computed['f_x'],
        'f_n': computed['f_n'],
        'fee_source': computed['fee_source'],
        'fee_A': computed['fee_A'],
        'fee_B': computed['fee_B'],
        'R_B': computed['R_B'],
        'A_usd': computed['A'],
        'S_r_star': computed['S_r_star'],
        'S_cons': computed['S_cons'],
        'M': computed['M'],
        'B_minus_A_ref_usd': computed['B_minus_A_ref'],
        'warns': unique(warns + computed['warns']),
    })
    return row


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def pct(value, digits=3):
    return 'UNKNOWN' if value is None else f'{value * 100:.{digits}f}%'


def usd(value):
    if value is None:
        return 'UNKNOWN'
    return f'-${abs(value):,.2f}' if value < 0 else f'${value:,.2f}'


def bp_delta(current, previous):
    if current is None or previous is None:
        return '—'
    return f'{(current - previous) * 10000:+.2f}bp'


def tendency_of(M):
    if M is None:
        return 'UNKNOWN'
    if M >= 0.002:
        return 'B'
    if M < 0:
        return 'roll'
    return 'neutral'


def roll_choice(receipt_success, X_max, full_ready=True):
    if full_ready is True and receipt_success and X_max is not None and X_max <= 0.004:
        return 'A'
    return 'A′'


def roll_is_executable(flags):
    return (flags['slippage_ok'] and flags['roll_gate_ok'] is True
            and flags['same_platform'] is True)


def critical_reasons(flags):
    reasons = []
    gap = flags['funding_gap']
    if gap is not None and gap > FUNDING_GAP_CRITICAL:
        reasons.append(f'资金费空档 {gap:.0f} 秒 > {FUNDING_GAP_CRITICAL} 秒')
    if flags['same_platform'] is False:
        reasons.append('逐腿同平台约束不满足（196/209 或 198/213 不在同一 venue）')
    roll_blocked = not roll_is_executable(flags) or flags.get('execution_admitted') is not True
    if flags['decision_point'] and roll_blocked and not flags['b_approved']:
        reasons.append('二次决策点没有已验证展期候选或实盘准入仍UNKNOWN，且 B 未获批；转人工退出决策')
    return reasons


def conclusion_line(row, flags):
    if flags['ended']:
        return f'结论：盯盘结束——{flags["ended_reason"]}，不再继续。'
    if flags['critical']:
        notes = ['；'.join(flags['critical']), '请人工决策']
        if row['A_usd'] is None:
            notes.append('关键报价或费用缺失，经济性UNKNOWN')
        if flags['suppressed']:
            notes.append('当日不给建议；仓位、预检或执行证据须核验；pending/unknown交易禁止新批次或重发')
        return '结论：CRITICAL——' + '；'.join(notes) + '。'
    if row['A_usd'] is None:
        suffix = '当日不给建议；证据须先核验，pending/unknown交易禁止新批次或重发。' if flags['suppressed'] else '本轮不动作，留待下轮。'
        return '结论：UNKNOWN——关键报价或费用缺失，' + suffix
    if flags['suppressed']:
        return '结论：WARN——仓位、预检或执行状态未核验，照常记账，当日不给建议；有pending/unknown交易时禁止新批次或重发。'
    M = row['M']
    tendency = flags['tendency']
    if tendency == 'B':
        base = f'风险调整倾向 B（M={pct(M)} ≥ +0.20%）'
    elif tendency == 'roll':
        base = f'风险调整倾向滚（M={pct(M)} < 0）'
    elif tendency == 'neutral':
        base = f'中性（M={pct(M)} 在 [0, +0.20%)）'
    else:
        base = 'UNKNOWN（M 缺失）'
    if flags['decision_point']:
        choice = decision_choice(flags)
        if choice.startswith('两者'):
            return f'结论：CRITICAL——{base}；{choice}。'
        note = '（B 未获批，不可执行）' if not flags['b_approved'] and tendency == 'B' else ''
        return f'结论：{base}；二次决策点选 {choice}{note}。'
    if tendency == 'B' and flags['b_approved']:
        return f'结论：{base}；B 已获批，按 B 准备（仍需收入、保证金与值守准入）。'
    if tendency == 'B' and not flags['b_approved']:
        if roll_is_executable(flags):
            return f'结论：{base}；B 未获批，不可执行；滚有技术预检候选，实盘准入UNKNOWN。'
        return f'结论：{base}；B 未获批，滚亦不可执行；继续盯盘并请人工决策。'
    if tendency == 'roll':
        if flags['slippage_over']:
            if flags['b_approved']:
                return f'结论：{base}；滑点检查未过，本批报价未通过，其他规模须另行预检；B 已获批，可按清单准备；执行前核验仍未完成。'
            return f'结论：{base}；滑点检查未过，本批报价未通过，其他规模须另行预检。'
        if flags['slippage_missing']:
            if flags['b_approved']:
                return f'结论：{base}；滑点字段缺失，A/A′ 无法确认；B 已获批，可按清单准备；执行前核验仍未完成。'
            return f'结论：{base}；滑点字段缺失，A/A′ 无法确认；今日不动作。'
        if not roll_is_executable(flags):
            if flags['same_platform'] is None:
                detail = '同平台约束未确认'
            elif flags['roll_gate_ok'] is not True:
                detail = '滚门禁未过或未确认'
            else:
                detail = '滚不可执行'
            if flags['b_approved']:
                return f'结论：{base}；{detail}，B 已获批，可按清单准备；执行前核验仍未完成。'
            return f'结论：{base}；{detail}，今日不可执行。'
        return f'结论：{base}；选 {flags["roll_choice"]} 预检候选，实盘准入UNKNOWN。'
    return f'结论：{base}；继续盯盘。'


def advice_line(row, flags):
    if flags['ended']:
        return '无（盯盘结束）。'
    if flags['critical']:
        caution = ('当日不给建议；先核验仓位、预检及执行状态；pending/unknown交易禁止新批次或重发。'
                   if flags['suppressed'] else '')
        return ('CRITICAL：' + '；'.join(flags['critical']) + '。' + caution
                + '请人工决策并核对 ROLLOVER-PLAN 的退出分支；脚本不执行退出。')
    if flags['suppressed']:
        return '当日不给建议；先核验仓位、报价及执行证据；pending/unknown交易禁止新批次或重发。'
    if row['A_usd'] is None:
        return '数据不足，不动作；检查终端与报价后重跑，本轮不编造数据。'
    if flags['decision_point']:
        choice = decision_choice(flags)
        if choice.startswith('B'):
            return (f'二次决策点：选 {choice}（持有旧腿到 10-30 结算后重开 209/213）；'
                    '执行前仍需过收入、保证金与值守准入。')
        if choice.startswith('滚'):
            return (f'二次决策点：选 {choice}；先完成滑点、simulate 门禁、保证金与值守准入，'
                    '再执行。')
        return '二次决策点：滚与 B 均未确认可执行 → CRITICAL；请人工决策并转 ROLLOVER-PLAN 的退出方案。'
    tendency = flags['tendency']
    if tendency == 'B':
        if flags['b_approved']:
            return ('按 B 执行清单准备（10-30 到期结算后重开 209/213）；仍需过收入、保证金与值守准入。')
        return ('继续持有至 10-25 二次决策点，同时推进 B 方案审批；B 未获批前不得执行，'
                '若需动作只能滚（A/A′），且须先过滑点与 simulate 门禁。')
    if tendency == 'roll':
        if flags['slippage_over']:
            if flags['b_approved']:
                return '本批报价未通过，其他规模须另行预检（滑点检查未过）；B 已获批，按 B 执行清单准备。'
            return '本批报价未通过，其他规模须另行预检（滑点检查未过）；B 未获批；继续盯盘，等待盘口改善。'
        if flags['slippage_missing']:
            if flags['b_approved']:
                return 'A/A′ 无法确认（滑点字段缺失）；B 已获批，按 B 执行清单准备。'
            return 'A/A′ 无法确认（滑点字段缺失）；补齐数据后重跑，本轮不动作。'
        if not roll_is_executable(flags):
            detail = ('同平台约束未确认' if flags['same_platform'] is None
                      else 'roll simulate 门禁未过或未确认')
            if flags['b_approved']:
                return f'滚今日不可执行（{detail}）；B 已获批，按 B 执行清单准备。'
            return f'滚今日不可执行（{detail}）；B 未获批；继续盯盘。'
        if flags['roll_choice'] == 'A′':
            return ('A′候选：先用最小可验证规模试批，确认 receipt、事件与逐 market 仓位后，'
                    '再执行主批；仍需过收入、保证金与值守准入。')
        return 'A候选：全量预检通过（已有成功 receipt，且 X_max ≤ 0.40%）；仍需过收入、保证金与值守准入。'
    return '中性，继续盯盘，不动作。'


def details_line(row):
    values = (row['t_old_yr'], row['t_new_yr'], row['t_reopen_yr'])
    if all(value is not None for value in values):
        times = (f't_old={row["t_old_yr"]:.5f}y，t_new={row["t_new_yr"]:.5f}y，'
                 f't_reopen={row["t_reopen_yr"]:.5f}y')
    else:
        times = 't_old/t_new/t_reopen=UNKNOWN'
    return (f'参数：L={pct(row["L"], 4)}，N={usd(row["N_usd"])}，{times}，'
            f'fee_source={row["fee_source"] or "UNKNOWN"}')


def decision_choice(flags):
    """The 10-25 二选一, with executability taking priority over economics."""
    if flags['suppressed']:
        return '当日不给建议；仅供经济性参考，须先人工核验'
    if roll_is_executable(flags) and flags.get('execution_admitted') is True:
        if flags['b_approved'] and flags['tendency'] == 'B':
            return 'B'
        return f'滚（{flags["roll_choice"]}）'
    if flags['b_approved']:
        return 'B（已获批，执行前核验仍未完成）'
    return '两者均未确认可执行 → CRITICAL，实盘准入UNKNOWN，请人工决策并核对退出分支'


def decision_lines(row, flags):
    if flags['suppressed']:
        return ['', '二次决策点：当日不给建议；以上数值仅供经济性参考，保留风险告警并先人工核验。']
    days = (OLD_MATURITY - row['now_unix']) / 86400
    choice = decision_choice(flags)

    exit_term = None
    new_term = None
    old_term = None
    reopen_term = None
    if None not in (row['E'], row['N_usd'], row['t_old_yr'], row['S'], row['t_new_yr']):
        exit_term = (row['L'] - row['E']) * row['t_old_yr'] * row['N_usd']
        new_term = row['S'] * row['t_new_yr'] * row['N_usd']
        old_term = row['L'] * row['t_old_yr'] * row['N_usd']
    if None not in (row['S_r_star'], row['N_usd'], row['t_reopen_yr']):
        reopen_term = row['S_r_star'] * row['t_reopen_yr'] * row['N_usd']

    lines = [
        '',
        '二次决策点（≥2026-10-25）：滚 vs B',
        f'- 剩余天数：{days:.2f} 天（旧腿 {iso_local(OLD_MATURITY)} 到期）',
        f'- A 现金流：退出项 {usd(exit_term)} + 新腿项 {usd(new_term)} - fee_A {usd(row["fee_A"])} - 结算费 {usd(row.get("settlement_A_usd"))} = A {usd(row["A_usd"])}',
        f'- B 现金流：旧腿项 {usd(old_term)} + 重开项 {usd(reopen_term)} - fee_B {usd(row["fee_B"])} - 结算费 {usd(row.get("settlement_B_usd"))} - 主观风险折价 R_B {usd(row["R_B"])} = B（按 S_r*）{usd(row["A_usd"])}',
        f'- 风险调整打平价差（非纯现金）：S_r*={pct(row["S_r_star"])}，S_cons={pct(row["S_cons"])}，M={pct(row["M"])}',
        f'- 滑点检查：{flags["slippage_text"]}',
        f'- 逐腿同平台：{flags["platform_text"]}',
        '- 到期日值守：10-30 08:00（+08:00）前须人工到岗确认；脚本无法核实。',
        f'- 资金费空档：>300 秒即 CRITICAL；当前 {flags["funding_gap_text"]}。',
        f'- 可执行性：G {GATE_G}；B {"已获批" if flags["b_approved"] else "未获批 → 不可执行"}；'
        f'滚{"技术门禁通过（仅为候选）" if flags["roll_gate_ok"] is True else "技术门禁未过/未确认"}；实盘准入UNKNOWN。',
        f'- 二选一建议：{choice}。',
    ]
    return lines


def build_report(row, flags):
    lines = [conclusion_line(row, flags), '']
    if flags['ended']:
        lines.append(f'盯盘状态：结束（{flags["ended_reason"]}）')
        lines.append('当日建议：无（盯盘结束）；结束状态不证明旧仓退出、展期完成、receipt成功或风险消除。')
        if row['warns']:
            lines.extend('警告：' + warn for warn in row['warns'])
        return '\n'.join(lines)
    else:
        days = (OLD_MATURITY - row['now_unix']) / 86400
        state = '二次决策点' if flags['decision_point'] else '进行中'
        extra = '；今日为最后一轮' if flags['watch_ending'] else ''
        lines.append(f'盯盘状态：{state}（距 10-30 到期 {days:.2f} 天{extra}）')
    lines.append('')
    change_header = '较昨日' if (flags.get('previous_label') in (None, '较昨日')) else '较上次'
    lines.append(f'| 指标 | 今日 | {change_header} |')
    lines.append('| --- | ---: | ---: |')
    prev = flags['previous']
    label = flags['previous_label'] or '较昨日'
    s_text = pct(row['S'])
    if (row['S_min'] is not None and row['S_max'] is not None
            and row['S_min'] != row['S_max']):
        s_text += f'（min/max {pct(row["S_min"])}–{pct(row["S_max"])}）'
    lines.append(f'| S | {s_text} | {bp_delta(row["S"], prev.get("S") if prev else None)} |')
    lines.append(f'| E | {pct(row["E"])} | {bp_delta(row["E"], prev.get("E") if prev else None)} |')
    lines.append(f'| S_r* | {pct(row["S_r_star"])} | '
                 f'{bp_delta(row["S_r_star"], prev.get("S_r_star") if prev else None)} |')
    lines.append(f'| S_cons | {pct(row["S_cons"])} | '
                 f'{bp_delta(row["S_cons"], prev.get("S_cons") if prev else None)} |')
    lines.append(f'| M | {pct(row["M"])} | {bp_delta(row["M"], prev.get("M") if prev else None)} |')
    lines.append(f'| A_usd | {usd(row["A_usd"])} | — |')
    lines.append(f'| 纯现金打平 S_r* | {pct(row.get("S_r_star_cash"))} | — |')
    lines.append(f'| M_cash | {pct(row.get("M_cash"))} | — |')
    lines.append(f'| A−B 纯现金（假设重开 S_r=S） | {usd(row.get("A_minus_B_cash_ref_usd"))} | — |')
    lines.append(f'| A−B 风险调整（同一假设） | {usd(row.get("A_minus_B_risk_adjusted_ref_usd"))} | — |')
    lines.append(f'| X_max | {pct(row["X_max"])} | — |')
    lines.append(f'| G | {GATE_G} | — |')
    lines.append('')
    lines.append('（变化列：' + (label if flags['previous'] is not None else '无v3同口径历史基线') + '）')
    lines.append('')
    if 'remaining_eth' in row:
        lines.append(f"逐腿进度：旧仓剩余 {row['remaining_eth']} ETH；新仓已滚 {row['rolled_eth']} ETH；本轮报价 {row.get('quote_size_eth', 'UNKNOWN')} ETH。")
        lines.append(f"预检：全量={row.get('full_batch_ready')}；候选小批={row.get('batch_size_eth')} ETH；候选预检={row.get('batch_ready')}。")
        lines.append('小批预检不消耗盘口，不证明后续批次可成交；每批receipt/事件确认和旧+新=原总量对账后重新报价。')
        lines.append(f"人工核验本批额外净成本={usd(row.get('batch_overhead_usd'))}；再扣该成本后A（仍非完整净利润）={usd(row.get('A_after_batch_overhead_usd'))}；累计预算/截止时间/值守准入仍须核验。")
    if flags['suppressed']:
        lines.append('本轮数值与倾向仅供经济性参考，不构成行动建议；先人工核验警告所列证据。')
    lines.append('口径：S/E为裸成交APR；S_r*/M为风险调整口径，纯现金打平另列。未来B报价未知，报价持平情景不是预测。')
    cash_tendency = {'roll': '滚', 'B': 'B', 'neutral': '中性', 'UNKNOWN': 'UNKNOWN'}[tendency_of(row.get('M_cash'))]
    lines.append(f'纯现金倾向：{cash_tendency}（同一M阈值规则）；风险调整倾向见结论。')
    lines.append(f'预计结算费：A={usd(row.get("settlement_A_usd"))}，B={usd(row.get("settlement_B_usd"))}，已从各自收益扣除。')
    lines.append('A_usd仅扣交易/结算费，不是到手净利润；入场费、Gas信用/消耗分账，历史累计结算费不全归本批；完整净收益与实盘准入仍UNKNOWN。')
    lines.append('固定现金流/未来结算费按连续剩余年数估算；实际结算边界及已实现PnL须以事件账本核对，不能把估算覆盖实付。')
    lines.append(details_line(row))
    lines.append(f'交易费预估：fee_A={usd(row["fee_A"])}，fee_B={usd(row["fee_B"])}；R_B={usd(row["R_B"])} 是主观风险折价，不是实付费用')
    lines.append(f'滑点：{flags["slippage_text"]}')
    lines.append(f'逐腿同平台：{flags["platform_text"]}')
    lines.append(f'滚门禁：{flags["roll_gate_text"]}')
    lines.append('')
    lines.append(f'当日建议：{advice_line(row, flags)}')
    if row['warns']:
        lines.append('')
        lines.append('警告：')
        for warn in row['warns']:
            lines.append(f'- {warn}')
    if flags['decision_point'] and not flags['ended'] and row['A_usd'] is not None:
        lines.extend(decision_lines(row, flags))
    if flags['watch_ending'] and not flags['ended']:
        lines.append('')
        lines.append('盯盘结束：今日为最后一轮；10-30 到期后不再继续。')
    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def parse_args(argv):
    parser = SafeArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--terminal', default=TERMINAL)
    parser.add_argument('--address', default=ADDRESS)
    parser.add_argument('--token-file', default=str(DEFAULT_TOKEN_FILE))
    parser.add_argument('--ledger', default=str(DEFAULT_LEDGER))
    parser.add_argument('--latest-json', default=str(DEFAULT_LATEST_JSON))
    parser.add_argument('--samples', type=int, default=3,
                        help='opportunities samples (default: 3)')
    parser.add_argument('--interval-seconds', type=float, default=60.0,
                        help='sleep between samples (default: 60)')
    parser.add_argument('--notional-usd', type=int, default=None,
                        help='override the opportunities quote notional; N still uses size × live ETH price')
    parser.add_argument('--skip-simulate', action='store_true',
                        help='skip the read-only roll simulation (gate becomes UNKNOWN)')
    parser.add_argument('--no-write', action='store_true', help='do not append the ledger row')
    parser.add_argument('--json', action='store_true', help='print the ledger row instead of the report')
    parser.add_argument('--b-approved', action='store_true',
                        help='the B plan is approved (default: not approved)')
    parser.add_argument('--receipt-success', action='store_true',
                        help='a real roll receipt has succeeded on this deployment')
    parser.add_argument('--batch-size', type=float, default=None, help='explicit candidate/trial size; never an execution command')
    parser.add_argument('--b-risk-premium-apr', type=float, default=R_B_RATE, help='subjective B risk discount, not a paid fee (default .005)')
    parser.add_argument('--batch-overhead-usd', type=float, default=None, help='reviewed additional A-only net cost; do not double count entrance credits and covered gas')
    parser.add_argument('--execution-pending', action='store_true', help='an unresolved/pending submission blocks every new batch')
    parser.add_argument('--timeout', type=float, default=60.0)
    args = parser.parse_args(argv)
    if args.samples < 1:
        raise ValueError('--samples must be at least 1')
    if args.interval_seconds < 0:
        raise ValueError('--interval-seconds must be non-negative')
    if args.timeout <= 0:
        raise ValueError('--timeout must be positive')
    if args.notional_usd is not None and not 1000 <= args.notional_usd <= 100_000_000:
        raise ValueError('--notional-usd must be between 1000 and 100000000')
    if args.batch_size is not None and (not math.isfinite(args.batch_size) or args.batch_size <= 0 or args.batch_size > SIZE):
        raise ValueError('--batch-size must be positive and no larger than the approved total')
    if args.batch_overhead_usd is not None and (not math.isfinite(args.batch_overhead_usd) or args.batch_overhead_usd < 0):
        raise ValueError('--batch-overhead-usd must be finite and non-negative')
    if not math.isfinite(args.b_risk_premium_apr) or not 0 <= args.b_risk_premium_apr <= 1:
        raise ValueError('--b-risk-premium-apr must be finite and between 0 and 1')
    return args


def finish_date_cutoff(args, now_epoch, warns):
    today = dt.datetime.fromtimestamp(now_epoch, TZ).date()
    row = empty_row(now_epoch, None)
    reason = f'日期截止（Asia/Taipei {END_DATE.isoformat()} 起）'
    row.update(watch_status='ENDED_DATE_CUTOFF', ended_reason=reason,
               progress_state='UNKNOWN', warns=unique(warns))
    if not args.no_write:
        append_row(args.ledger, row)
    flags = ended_flags(row, today, reason)
    print(json.dumps(row, ensure_ascii=False, allow_nan=False) if args.json else build_report(row, flags))
    return 0


def run(argv=None, *, fetch=fetch_json, now=time.time, sleep=time.sleep):
    try:
        args = parse_args(argv)
        base = local_base(args.terminal)
        if not ADDRESS_RE.match(args.address):
            raise ValueError('address must be a 20-byte hex address')
    except (ValueError, WatchError) as exc:
        print(f'无法启动：{exc}', file=sys.stderr)
        return 1

    now_epoch = float(now())
    now_dt = dt.datetime.fromtimestamp(now_epoch, TZ)
    today = now_dt.date()
    address = args.address.lower()
    history, history_warns = load_history(args.ledger)
    warns = list(history_warns)
    cutoff_epoch = dt.datetime.combine(END_DATE, dt.time(), TZ).timestamp()

    def at_cutoff():
        return float(now()) >= cutoff_epoch

    class DateCutoff(WatchError):
        pass

    wire_fetch = fetch

    def fetch(*fetch_args, **fetch_kwargs):
        if at_cutoff():
            raise DateCutoff('watch date cutoff reached')
        return wire_fetch(*fetch_args, **fetch_kwargs)

    if at_cutoff():
        return finish_date_cutoff(args, float(now()), warns)

    try:
        token = read_token(args.token_file)
    except WatchError as exc:
        print(f'无法启动：{exc}', file=sys.stderr)
        return 1

    try:
        eth_usd, positions, positions_time = fetch_asset_view(fetch, token, base, address, args.timeout)
        if positions_time > now_epoch or now_epoch - positions_time > 120:
            raise WatchError("Stale/future position observation")
    except DateCutoff:
        return finish_date_cutoff(args, float(now()), warns)
    except Exception as exc:  # terminal/credential failure: do not invent a row
        if at_cutoff():
            return finish_date_cutoff(args, float(now()), warns)
        print('结论：UNKNOWN——终端不可达、鉴权失败或数据异常，本轮不编造数据，留待下轮。')
        print(f'原因：{exc}')
        return 2

    if at_cutoff():
        return finish_date_cutoff(args, float(now()), warns)
    old_warns = check_old_legs(positions)
    warns.extend(old_warns)
    suppressed = bool(old_warns)
    state = batch_progress(positions) if not suppressed else dict(remaining=None, rolled=None, state='UNKNOWN')
    remaining = state['remaining']
    if remaining == 0 or now_epoch >= OLD_MATURITY:
        row = empty_row(now_epoch, eth_usd)
        row.update(remaining_eth=remaining, rolled_eth=state['rolled'], progress_state=state['state'])
        reason = '旧腿已到期' if now_epoch >= OLD_MATURITY else '旧腿 196/198 不在仓：' + state['state']
        row['warns'] = unique(warns)
        row.update(watch_status='ENDED_POSITION', ended_reason=reason)
        if not args.no_write:
            append_row(args.ledger, row)
        flags = ended_flags(row, today, reason)
        print(json.dumps(row, ensure_ascii=False, allow_nan=False) if args.json else build_report(row, flags))
        return 0

    discovery = dict(full=None, full_state=dict(ready=None, depth=None), selected=None, size=None, probes=[])
    if not args.skip_simulate and not suppressed and not args.execution_pending:
        try:
            if args.batch_size is None:
                discovery = discover_batches(lambda q: simulate_roll(fetch, token, base, address, args.timeout, q), remaining, now)
            else:
                full = simulate_roll(fetch, token, base, address, args.timeout, remaining)
                discovery['full'] = full
                discovery['full_state'] = batch_preview(full, remaining, float(now()))
        except DateCutoff:
            return finish_date_cutoff(args, float(now()), warns)
        except Exception as exc:
            warns.append(f'WARN: roll simulate 失败：{exc}')
    if at_cutoff():
        return finish_date_cutoff(args, float(now()), warns)
    if args.batch_size is not None and not args.skip_simulate and not suppressed and not args.execution_pending:
        if args.batch_size > remaining + 1e-9:
            suppressed = True
            warns.append('WARN: --batch-size exceeds current remaining old position')
        else:
            try:
                candidate = simulate_roll(fetch, token, base, address, args.timeout, args.batch_size)
                ready = batch_preview(candidate, args.batch_size, float(now()))['ready']
                discovery['probes'].append(dict(size=args.batch_size, ready=ready))
                discovery['selected'] = candidate if ready is True else None
                discovery['size'] = args.batch_size if ready is True else None
                if ready is not True:
                    warns.append('WARN: 指定小批未通过，不自动替换为其他批量')
            except DateCutoff:
                return finish_date_cutoff(args, float(now()), warns)
            except Exception as exc:
                discovery['selected'] = discovery['size'] = None
                warns.append(f'WARN: 指定小批预检UNKNOWN：{exc}')
    if at_cutoff():
        return finish_date_cutoff(args, float(now()), warns)
    full_ready = discovery['full_state']['ready']
    selected = discovery['selected']
    quote_size = discovery['size'] if selected is not None else remaining if remaining is not None else SIZE
    sim = selected if selected is not None else discovery['full']
    roll_ok, roll_reasons = roll_gate_status(sim, args.skip_simulate, quote_size, float(now()))
    if selected is None and (full_ready is False or args.batch_size is not None):
        roll_ok = None  # A failed whole-position probe does not prove all smaller sizes impossible.
        roll_reasons.append('全量未过，本轮未找到已验证小批；A′状态UNKNOWN，请人工决策，不推断为不可行')
    if args.execution_pending:
        roll_ok = None
        roll_reasons = ['已有pending/unknown交易：先查receipt、事件及逐market仓位，禁止重发或新批次']
    if selected is not None and quote_size < remaining - 1e-9:
        warns.append(f'INFO: 全量{remaining} ETH未过；A′候选{quote_size} ETH整批预检通过，后续批次深度不保证')
    notional = args.notional_usd
    if notional is None and eth_usd is not None:
        notional = int(round(quote_size * eth_usd))
        if not 1000 <= notional <= 100_000_000:
            warns.append(f'WARN: round(N)={notional} 超出 /api/opportunities 允许范围，无法报价')
            notional = None
    if notional is None:
        warns.append('WARN: ETH 美元价缺失，无法按实际名义金额报价')

    samples = []
    if notional is not None:
        for index in range(args.samples):
            try:
                payload = fetch(opportunities_url(base, notional), token, args.timeout)
                samples.append(extract_sample(api_data(payload, 'opportunities')))
            except DateCutoff:
                return finish_date_cutoff(args, float(now()), warns)
            except Exception as exc:
                warns.append(f'WARN: 第 {index + 1}/{args.samples} 次 opportunities 采样失败：{exc}')
            if at_cutoff():
                return finish_date_cutoff(args, float(now()), warns)
            if index < args.samples - 1:
                sleep(min(args.interval_seconds, max(0, cutoff_epoch - float(now()))))
                if at_cutoff():
                    return finish_date_cutoff(args, float(now()), warns)

    agg = aggregate_samples(samples, expected_count=max(3, args.samples))
    agg['complete'] = agg['complete'] and args.interval_seconds >= 60
    warns.extend(agg['warns'])
    if not agg['complete']:
        suppressed = True
        warns.append('WARN: 必要报价三采样不完整或间隔不足60秒，当日不给建议，不作为有效趋势证据')
    terms = None
    try:
        terms = parse_market_terms(fetch(TERMS_URL, '', args.timeout), float(now()))
    except DateCutoff:
        return finish_date_cutoff(args, float(now()), warns)
    except Exception as exc:
        warns.append(f'WARN: market fee evidence UNKNOWN: {exc}')
    if at_cutoff():
        return finish_date_cutoff(args, float(now()), warns)
    locked = {p['marketId']: p.get('entryApr') for p in positions if p.get('marketId') in (OLD_HL, OLD_OKX)}
    locked_spread = locked[OLD_HL]-locked[OLD_OKX] if not old_warns else L
    computed = compute(now_epoch, eth_usd, agg, history, today, quote_size, terms=terms,
                       locked_spread=locked_spread, risk_premium=args.b_risk_premium_apr)
    warns.extend(computed['warns'])

    # Sampling lasts about two minutes. Revalidate positions and both preview
    # sizes afterwards; a pre-sampling success is not current execution evidence.
    sim_time = number((sim or {}).get('simulatedAtMs'))
    if not args.skip_simulate and not suppressed and not args.execution_pending and (sim_time is None or float(now()) - sim_time / 1000 > 60):
        try:
            _, current_positions, current_observed = fetch_asset_view(fetch, token, base, address, args.timeout)
            current_state = batch_progress(current_positions)
            if current_state != state or current_observed > float(now()) or float(now()) - current_observed > 120:
                raise WatchError('采样中仓位/时效变化：重新采集，禁止沿用上一批证据')
            full = simulate_roll(fetch, token, base, address, args.timeout, remaining)
            full_ready = batch_preview(full, remaining, float(now()))['ready']
            sim = full if abs(quote_size - remaining) <= 1e-9 else simulate_roll(fetch, token, base, address, args.timeout, quote_size)
            roll_ok, roll_reasons = roll_gate_status(sim, False, quote_size, float(now()))
            discovery['selected'] = sim if roll_ok is True else None
            discovery['size'] = quote_size if roll_ok is True else None
        except DateCutoff:
            return finish_date_cutoff(args, float(now()), warns)
        except Exception as exc:
            roll_ok = full_ready = None
            discovery['size'] = None
            roll_reasons = [str(exc)]
            suppressed = True
    if at_cutoff():
        return finish_date_cutoff(args, float(now()), warns)
    if args.notional_usd is not None and (eth_usd is None or abs(args.notional_usd - round(quote_size * eth_usd)) > 1):
        suppressed = True
        warns.append('WARN: override notional does not match selected batch size; no actionable economics')
    if roll_ok is not True:
        warns.append('WARN: 滚门禁未确认：' + '；'.join(roll_reasons))
    slippage_ok, slippage_missing, slippage_over = slippage_status(computed['deviations'])
    if slippage_missing:
        warns.append('WARN: 滑点检查缺字段：' + ', '.join(str(m) for m in slippage_missing))
    if slippage_over:
        warns.append('WARN: 超过该腿容忍：' + ', '.join(
            f'{m}={pct(computed["deviations"][m])}' for m in slippage_over))
    same_platform = same_platform_status(agg['venue'])
    if same_platform is False:
        warns.append('CRITICAL: 逐腿同平台约束不满足（196↔209 或 198↔213）')

    funding_gap = read_funding_gap(args.latest_json, address)
    if funding_gap is not None and funding_gap > FUNDING_GAP_CRITICAL:
        warns.append(f'CRITICAL: 资金费空档 {funding_gap:.0f} 秒 > {FUNDING_GAP_CRITICAL} 秒')

    row = build_row(now_epoch, eth_usd, agg, computed, warns)
    row['watch_scope'] = {'address': address, 'account_id': 0, 'size': SIZE, 'terminal': base}
    row['quote_size_eth'] = quote_size
    row['remaining_eth'] = remaining
    row['rolled_eth'] = state['rolled']
    row['progress_state'] = state['state']
    row['full_batch_ready'] = full_ready
    row['batch_ready'] = roll_ok
    row['simulation_observed_at'] = number((sim or {}).get('simulatedAtMs')) / 1000 if number((sim or {}).get('simulatedAtMs')) is not None else None
    row['roll_path'] = 'A_PRIME' if roll_ok is True and quote_size < remaining - 1e-9 else 'FULL_PREVIEW' if roll_ok is True else 'UNKNOWN'
    row['batch_size_eth'] = discovery['size']
    row['batch_probes'] = discovery['probes']
    row['batch_overhead_usd'] = args.batch_overhead_usd
    row['A_after_batch_overhead_usd'] = row['A_usd'] - args.batch_overhead_usd if row['A_usd'] is not None and args.batch_overhead_usd is not None else None
    row['requested_batch_size_eth'] = args.batch_size
    row['execution_pending'] = args.execution_pending
    if args.execution_pending or args.batch_size is not None and selected is None:
        suppressed = True
    row['execution_admission'] = 'UNKNOWN — 逐批成本、累计预算、收入、截止时间、值守和receipt须独立核验'
    row['sample_count'] = len(samples)
    row['sample_expected_count'] = args.samples
    row['sample_complete'] = agg['complete'] and not suppressed
    row['sample_interval_seconds'] = args.interval_seconds
    tendency = tendency_of(row['M'])
    choice = roll_choice(args.receipt_success, row['X_max'], full_ready is True and abs(quote_size - remaining) <= 1e-9)
    flags = {
        'ended': False,
        'ended_reason': None,
        'suppressed': suppressed,
        'slippage_ok': slippage_ok,
        'slippage_missing': slippage_missing,
        'slippage_over': slippage_over,
        'roll_gate_ok': roll_ok,
        'roll_gate_reasons': roll_reasons,
        'same_platform': same_platform,
        'b_approved': args.b_approved,
        'execution_admitted': False,
        'receipt_success': args.receipt_success,
        'decision_point': today >= DECISION_DATE,
        'watch_ending': today >= END_DATE,
        'funding_gap': funding_gap,
        'tendency': tendency,
        'roll_choice': choice,
    }
    flags['critical'] = critical_reasons(flags)
    row['warns'] = unique(row['warns'] + ['CRITICAL: ' + reason for reason in flags['critical']])
    if args.execution_pending:
        flags['suppressed'] = True
        row['warns'].append('WARN: pending/unknown交易未查明，禁止新批次或重发')
    flags['slippage_text'] = slippage_text(row, flags)
    flags['platform_text'] = platform_text(agg['venue'], same_platform)
    flags['roll_gate_text'] = roll_gate_text(flags)
    flags['funding_gap_text'] = ('UNKNOWN' if funding_gap is None else f'{funding_gap:.0f} 秒')
    flags['previous'], flags['previous_label'] = previous_row(history, today, quote_size)

    if not args.no_write:
        append_row(args.ledger, row)
    print(json.dumps(row, ensure_ascii=False, allow_nan=False) if args.json else build_report(row, flags))
    return 0 if row['A_usd'] is not None else 2


def slippage_text(row, flags):
    parts = []
    for market_id in MARKETS:
        exec_apr = number(row['exec'].get(str(market_id)))
        mid_apr = number(row['mid'].get(str(market_id)))
        value = abs(exec_apr - mid_apr) if exec_apr is not None and mid_apr is not None else None
        parts.append(f'{market_id}={pct(value)}')
    verdict = '退出≤0.50%，新开≤0.25%' if flags['slippage_ok'] else (
        '超过该腿容忍：' + ', '.join(str(m) for m in flags['slippage_over'])
        if flags['slippage_over'] else '字段缺失，无法确认')
    return f'{"，".join(parts)} → {verdict}'


def platform_text(venues, status):
    old_hl, new_hl = venues.get(OLD_HL), venues.get(NEW_HL)
    old_okx, new_okx = venues.get(OLD_OKX), venues.get(NEW_OKX)
    text = f'{OLD_HL} {old_hl or "UNKNOWN"} ↔ {NEW_HL} {new_hl or "UNKNOWN"}；' \
           f'{OLD_OKX} {old_okx or "UNKNOWN"} ↔ {NEW_OKX} {new_okx or "UNKNOWN"}'
    if status is True:
        return text + ' → OK'
    if status is False:
        return text + ' → 不满足'
    return text + ' → UNKNOWN'


def roll_gate_text(flags):
    if flags['roll_gate_ok'] is True:
        return '技术预检通过（仅为候选；depth/margin/gas；实盘准入UNKNOWN，值守需人工确认）'
    if flags['roll_gate_ok'] is False:
        return '未过：' + '；'.join(flags['roll_gate_reasons'])
    return 'UNKNOWN：' + ('；'.join(flags['roll_gate_reasons']) or '未确认')


def ended_flags(row, today, reason):
    flags = {
        'ended': True,
        'ended_reason': reason,
        'suppressed': False,
        'slippage_ok': False,
        'slippage_missing': [],
        'slippage_over': [],
        'roll_gate_ok': None,
        'roll_gate_reasons': [],
        'same_platform': None,
        'b_approved': False,
        'execution_admitted': False,
        'receipt_success': False,
        'decision_point': today >= DECISION_DATE,
        'watch_ending': True,
        'funding_gap': None,
        'tendency': 'UNKNOWN',
        'roll_choice': 'A′',
        'critical': [],
        'slippage_text': 'UNKNOWN',
        'platform_text': 'UNKNOWN',
        'roll_gate_text': 'UNKNOWN',
        'funding_gap_text': 'UNKNOWN',
        'previous': None,
        'previous_label': None,
    }
    return flags


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except (AttributeError, OSError):
        pass
    return run()


if __name__ == '__main__':
    sys.exit(main())
