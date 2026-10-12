#!/usr/bin/env python3
"""Read-only four-leg risk monitor. Python standard library only."""
import argparse
import concurrent.futures
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import struct
import time
import urllib.error
import urllib.parse
import urllib.request

from risk_monitor_evidence import CONTRACTS, evidence_error, valid_value

ROOT = Path(__file__).resolve().parents[1]
RULES = ROOT / 'scripts/risk-monitor-rules.json'
DEFAULT_CONFIG = ROOT / 'data/risk-monitor/config.json'
SEVERITY = {'PAUSED': -1, 'OK': 0, 'UNKNOWN': 1, 'WARNING': 2, 'CRITICAL': 3}


class ConfigurationMismatch(ValueError):
    """The monitor must not silently use another terminal's risk settings."""


def canonical_identity(value):
    """Same tagged IEEE-754 encoding as the terminal's canonicalRiskIdentity."""
    def encode(v):
        if isinstance(v, bool):
            return ['boolean', v]
        if isinstance(v, (int, float)):
            return ['number', struct.pack('>d', float(v) if v else 0.0).hex()]
        if isinstance(v, list):
            return ['array', [encode(x) for x in v]]
        if isinstance(v, dict):
            return ['object', [[k, encode(v[k])] for k in sorted(v)]]
        return ['null' if v is None else 'string', v]
    return json.dumps(encode(value), ensure_ascii=False, separators=(',', ':'))


def record_funding_gap(data, config, state, now):
    """Record current verified legs; terminal visits cannot start or extend history."""
    risk = (data.get('farm') or {}).get('risk') or {}
    positions = data.get('positions') or {}
    root = str(config.get('root') or (data.get('agent') or {}).get('root') or '').lower()
    account_id = config.get('account_id', 0)
    if (risk.get('address', '').lower() != root or risk.get('accountId') != account_id
            or account_id != 0 or risk.get('positionsComplete') is not True or risk.get('stale')
            or not isinstance(positions.get('positions'), list) or not isinstance(positions.get('exposure'), list)):
        state.pop('funding_gap', None)
        return
    perps = [p for group in positions['exposure'] if group.get('base') == 'ETH' for p in group.get('legs', [])]
    boros = risk.get('positions', [])
    rows = positions['positions']
    pool = root + f'{account_id:02x}0002ffffff'
    if (not isinstance(boros, list)
            or any(number(p.get('positionQty')) is None or not isinstance(p.get('symbol'), str) for p in rows)
            or sum(number(p['positionQty']) != 0 for p in rows) != sum(len(g.get('legs', [])) for g in positions['exposure'])
            or any(b.get('marketAcc', '').lower() != pool or b.get('venue') not in ('HYPERLIQUID', 'BINANCE')
                   or not isinstance(b.get('marketId'), int) or isinstance(b['marketId'], bool) or b['marketId'] <= 0 for b in boros)):
        state.pop('funding_gap', None)
        return
    quantities = [p.get('qty') for p in perps] + [b.get('sizeToken') for b in boros]
    if (any(not isinstance(q, (int, float)) or isinstance(q, bool) or not math.isfinite(q) or q <= 0 for q in quantities)
            or any(p.get('side') not in ('LONG', 'SHORT') or not re.fullmatch(r'(HYPERLIQUID|BINANCE)_FUTURE_ETH_(USDT|USDC|USD)', p.get('symbol', ''))
                   or p.get('exchange') != p['symbol'].split('_')[0] for p in perps)
            or len({p['symbol'] for p in perps}) != len(perps)
            or any(b.get('side') not in ('LONG', 'SHORT') or not isinstance(b.get('maturity'), (int, float)) or isinstance(b['maturity'], bool)
                   or not math.isfinite(b['maturity']) or b['maturity'] <= 0 for b in boros)):
        state.pop('funding_gap', None)
        return
    fingerprint = canonical_identity({'root': root, 'account_id': account_id, 'perps': sorted([[p['symbol'], p['exchange'], p['side'], p['qty']] for p in perps]),
                                      'boros': sorted([[b['marketId'], b['venue'], b['side'], b['sizeToken'], b['maturity']] for b in boros])})
    quantity = sum(max(0, p['qty'] - sum(b['sizeToken'] for b in boros if b['venue'] == p['exchange'] and b['side'] == p['side'] and b['maturity'] > now)) for p in perps)
    old = state.get('funding_gap') or {}
    continuous = (number(old.get('uncovered_eth')) is not None and old['uncovered_eth'] == quantity and quantity > 0
                  and old.get('fingerprint') == fingerprint and isinstance(old.get('observed_at'), (int, float))
                  and 0 <= now - old['observed_at'] <= 3600 and isinstance(old.get('started_at'), (int, float))
                  and 0 < old['started_at'] <= old['observed_at'])
    state['funding_gap'] = {'fingerprint': fingerprint, 'started_at': old['started_at'] if quantity > 0 and continuous else now,
                            'observed_at': now, 'uncovered_eth': quantity}


def producer_scope(config, data):
    """Approved non-secret identity for read-only terminal evidence consumers."""
    root = config.get('root') or (data.get('agent') or {}).get('root')
    user_id = (data.get('account') or {}).get('userId')
    if (not isinstance(root, str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}', root)
            or not isinstance(user_id, (str, int)) or isinstance(user_id, bool) or not str(user_id).strip()):
        return None
    identity = {'account_id': config.get('account_id', 0), 'base': config.get('base', 'ETH'),
                'collateral_token_id': config.get('collateral_token_id', 2), 'root': root.lower(),
                'terminal_url': config.get('terminal_url', 'http://localhost:6688').rstrip('/'),
                'recovery_margin_fraction': config.get('recovery_margin_fraction', .03), 'thresholds': config.get('thresholds', {})}
    scope = {key: identity[key] for key in ('account_id', 'base', 'collateral_token_id', 'root', 'terminal_url')}
    return {**scope, 'gate_user_id': str(user_id),
            'config_id': hashlib.sha256(canonical_identity(identity).encode()).hexdigest()}


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def rollover_days_to_maturity(data, config, now):
    farm = data.get('farm') or {}
    # The asset view reads Boros subaccount 0. History completeness does not
    # establish that every current position and its market metadata is present.
    if (farm.get('coverage', {}).get('borosPositionsComplete') is not True
            or config.get('account_id', 0) != 0):
        return None
    assets = farm.get('assets', [])
    asset = next((a for a in assets if a.get('base') == config.get('base', 'ETH')), None)
    legs = (asset or {}).get('borosOpen', [])
    maturities = [number(leg.get('maturity')) if not isinstance(leg.get('maturity'), bool) else None
                  for leg in legs]
    if not maturities or any(m is None or m <= 0 for m in maturities):
        return None
    return (min(maturities) - now) / 86400


def settlement_net_24h(ledger, config, now):
    """Sum net ETH settlement events in (now - 24h, now] for this cross pool."""
    root = str(config.get('root', '')).lower()
    if (not isinstance(ledger, dict) or ledger.get('complete') is not True
            or str(ledger.get('root', '')).lower() != root
            or ledger.get('accountId') != config.get('account_id', 0)
            or config.get('collateral_token_id', 2) != 2
            or not re.fullmatch(r'0x[0-9a-f]{40}', root)
            or not isinstance(ledger.get('rows'), list)):
        return None
    pool = root[2:] + f"{config.get('account_id', 0):02x}0002ffffff"
    seen, total = {}, 0
    for row in ledger['rows']:
        if not isinstance(row, dict):
            return None
        handle = str(row.get('marketAcc', '')).lower().removeprefix('0x')
        if not re.fullmatch(r'[0-9a-f]{52}', handle):
            return None
        if handle != pool:
            continue
        stamp = number(row.get('timestamp'))
        event_id = row.get('id')
        amount = row.get('settlement')
        if (stamp is None or stamp <= 0 or isinstance(row.get('timestamp'), bool)
                or not isinstance(event_id, str) or not event_id
                or not isinstance(amount, str) or not re.fullmatch(r'-?\d+', amount)):
            return None
        event = (handle, stamp, row.get('marketId'), amount)
        if event_id in seen:
            if seen[event_id] != event:
                return None
            continue
        seen[event_id] = event
        if now - 86400 < stamp <= now:
            total += int(amount)
    # Settlement is already NET of its fee; never subtract the fee again.
    return number(total / 1e18)


def signed_qty(position):
    qty = number(position.get('positionQty'))
    if qty is None:
        return None
    side = position.get('positionSide', 'NONE')
    return -abs(qty) if side == 'SHORT' else abs(qty) if side == 'LONG' else qty


def load(path, default=None):
    if not Path(path).exists():
        return {} if default is None else default
    return json.loads(Path(path).read_text())


def metric_unit(key):
    return CONTRACTS.get(key, {}).get('unit', 'enum')


def format_metric_value(value, unit):
    """Format human-readable output without rounding stored or evaluated metrics."""
    if value is None:
        return 'UNKNOWN'
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return str(value)
    decimals = {
        'USD': 2, 'USD/ETH': 2, 'USD/day': 2, 'USDT': 2, 'USDC': 2,
        'ETH': 6, 'ETH/24h': 6,
        'ratio': 4, 'ratio lower bound': 4, 'APR fraction': 4,
        'percentage points': 2, 'days': 2, 'hours': 2,
        'seconds': 1, 'unix seconds': 0, 'count': 0,
    }.get(unit, 4)
    if value == 0:
        value = 0  # Do not display negative zero.
    text = f'{value:.{decimals}f}'
    if value != 0 and float(text) == 0:
        return f'{value:.3g}'
    return text


def format_check(check):
    """Show each metric beside its configured warning and critical conditions."""
    operators = {'lt': '<', 'gt': '>', 'eq': '=', 'ne': '!='}
    values = []
    for key, metric in check['metrics'].items():
        conditions = []
        for condition_key, op, threshold, level in check['thresholds']:
            if condition_key != key:
                continue
            comparison = '|value| >' if op == 'abs_gt' else operators.get(op, op)
            conditions.append(f'{level} {comparison} {threshold}')
        shown = 'NA' if metric.get('applicability') == 'NA' else format_metric_value(metric['value'], metric['unit'])
        text = f"{key}={shown} {metric['unit']}"
        if metric.get('details'):
            text += ' [' + '; '.join(f"{d['label']}={format_metric_value(d['value'], d['unit'])} {d['unit']}" for d in metric['details']) + ']'
        if conditions:
            text += ' (' + '; '.join(conditions) + ')'
        values.append(text)
    output = f"{check['status']:8} {check['id']}: " + ', '.join(values)
    if check['reason']:
        output += '\n  ' + check['reason']
    return output


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_suffix(path.suffix + '.tmp')
    with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
    os.replace(temp, path)
    os.chmod(path, 0o600)


def request_json(url, headers=None, payload=None, timeout=15):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers=headers or {})
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    # Local credentials must never be forwarded by an HTTP redirect.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'HTTP {exc.code}') from None
    except Exception as exc:
        # URLs, Telegram tokens and response bodies are intentionally omitted.
        raise RuntimeError(type(exc).__name__) from None


def telegram(env, method, payload):
    token = env.get('MONITOR_TELEGRAM_BOT_TOKEN', '')
    if not re.fullmatch(r'\d+:[A-Za-z0-9_-]+', token):
        raise RuntimeError('Telegram token missing or invalid')
    result = request_json('https://api.telegram.org/bot' + token + '/' + method,
                          payload=payload)
    if not isinstance(result, dict) or result.get('ok') is not True:
        raise RuntimeError('Telegram rejected request')
    delivered = result.get('result')
    if method == 'sendMessage' and (not isinstance(delivered, dict)
            or not isinstance(delivered.get('message_id'), int)
            or isinstance(delivered.get('message_id'), bool) or delivered['message_id'] <= 0):
        raise RuntimeError('Telegram delivery confirmation missing')
    return delivered


def read_env(path):
    result = {}
    if Path(path).exists():
        for line in Path(path).read_text().splitlines():
            if line.startswith('MONITOR_') and '=' in line:
                key, value = line.split('=', 1)
                result[key] = value.strip()
    for key in ('MONITOR_TELEGRAM_BOT_TOKEN', 'MONITOR_TELEGRAM_CHAT_ID'):
        if os.environ.get(key):
            result[key] = os.environ[key]
    return result


class Collector:
    def __init__(self, config):
        self.config = config
        self.base = config.get('terminal_url', 'http://localhost:6688').rstrip('/')
        parsed = urllib.parse.urlsplit(self.base)
        if parsed.scheme != 'http' or parsed.hostname not in ('localhost', '127.0.0.1', '::1'):
            raise ValueError('terminal_url must be a loopback HTTP URL')
        self.headers = {'x-arb-token': Path(config.get('token_file', ROOT / 'api-token')).read_text().strip()}
        self.errors = {}
        self.responses = {}

    def get(self, name, path):
        try:
            obj = request_json(self.base + '/api' + path, self.headers,
                               timeout=self.config.get('timeout_seconds', 15))
            if obj.get('ok') is not True:
                raise RuntimeError('API rejected request')
            if obj.get('meta', {}).get('stale'):
                raise RuntimeError('API cache marked stale')
            self.responses[name] = obj
            return obj.get('data')
        except Exception as exc:
            self.errors[name] = str(exc)
            return None

    def collect(self):
        """Legacy collection used only for explicit baseline acceptance."""
        agent = self.get('agent', '/boros/agent?fresh=1')
        root = self.config.get('root') or (agent or {}).get('root')
        paths = {'interest': '/account/interest?fresh=1', 'positions': '/positions?fresh=1',
                 'liquidation': '/account/liquidation?fresh=1',
                 'health': '/health', 'deals': '/deals?active=1',
                 'orders': '/orders/open?fresh=1', 'alerts': '/alerts?unacked=1'}
        if root and re.fullmatch(r'0x[0-9a-fA-F]{40}', root):
            paths['farm'] = '/asset-view/' + root + '?fresh=1'
            paths['context'] = '/boros/pair/context?address=' + root + '&fresh=1'
        data = {'agent': agent}
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            futures = {pool.submit(self.get, name, path): name for name, path in paths.items()}
            if root and re.fullmatch(r'0x[0-9a-fA-F]{40}', root):
                for name, path in [('boros_raw', 'market-acc-infos-by-root'), ('boros_gas', 'gas-balance')]:
                    futures[pool.submit(self.public_boros, name, path, root)] = name
                futures[pool.submit(self.public_settlements, root)] = 'boros_settlements'
            for future in concurrent.futures.as_completed(futures):
                data[futures[future]] = future.result()
        days = rollover_days_to_maturity(data, self.config, time.time())
        if self.config.get('scan_rollover', False) and days is not None and days < 14:
            data['opportunities'] = self.get('opportunities', '/opportunities?borosEntry=market&exitMode=roll&notionalUsd=' + str(self.config.get('notional_usd', 10000)))
        data['account'] = (data.get('interest') or {}).get('account')
        return data

    def collect_report(self, state):
        """Use the terminal's Risk page calculations; never fall back to Python formulas."""
        previous = {'scope': state.get('shared_scope'), 'producerScope': state.get('producer_scope'),
                    'state': state.get('shared_risk_state') or {
                        key: {'status': status, 'criticalMetrics': state.get('critical_metrics', {}).get(key, [])}
                        for key, status in state.get('risk_status', {}).items()}}
        query = {'fresh': '1', 'previous': json.dumps(previous, separators=(',', ':'))}
        root = self.config.get('root')
        if root:
            if not isinstance(root, str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}', root):
                raise ValueError('Invalid Risk wallet')
            root = root.lower()
            query['address'] = root
        # A composed cold read may take several upstream request timeouts.
        obj = request_json(self.base + '/api/risk/report?' + urllib.parse.urlencode(query), self.headers,
                           timeout=max(60, self.config.get('timeout_seconds', 15)))
        report = obj.get('data')
        if obj.get('ok') is not True or obj.get('meta', {}).get('stale') or not isinstance(report, dict):
            raise RuntimeError('Risk report unavailable')
        scope = report.get('scope') or {}
        if (report.get('version') != 1 or not scope.get('credentialId')
                or obj.get('meta', {}).get('credentialId') != scope.get('credentialId')
                or not isinstance(scope.get('address'), str) or not re.fullmatch(r'0x[0-9a-f]{40}', scope['address'])
                or scope.get('address') != (root or scope.get('address'))
                or scope.get('accountId') != self.config.get('account_id', 0)
                or scope.get('pool') not in ('ETH-cross', 'account') or self.config.get('base', 'ETH') != 'ETH'
                or self.config.get('collateral_token_id', 2) != 2
                or not isinstance(report.get('checks'), list) or not isinstance(report.get('state'), dict)
                or not isinstance(report.get('collection'), dict) or not isinstance(report.get('complete'), bool)):
            raise RuntimeError('Risk report scope or contract mismatch')
        stamp = number(report.get('observedAt'))
        if stamp is None or not 0 <= time.time() - stamp <= 120:
            raise RuntimeError('Risk report expired')
        configuration = report.get('configuration')
        if not isinstance(configuration, dict) or not all(isinstance(configuration.get(k), str) and configuration[k]
                                                        for k in ('configId', 'stateDir', 'observationsFile')):
            raise RuntimeError('Risk configuration evidence unavailable')
        expected = producer_scope({**self.config, 'root': scope['address']}, {'account': {'userId': 'configuration-check'}})
        if (configuration['configId'] != expected['config_id']
                or Path(configuration['stateDir']).resolve() != Path(self.config.get('state_dir', ROOT / 'data/risk-monitor')).resolve()
                or Path(configuration['observationsFile']).resolve() != Path(self.config.get('observations_file', ROOT / 'data/risk-monitor/observations.json')).resolve()):
            raise ConfigurationMismatch('Monitor configuration differs from terminal Risk settings or evidence directories; '
                                        'use the terminal configuration and matching state_dir/observations_file')
        old_scope = state.get('shared_scope') or {}
        old_user = (state.get('producer_scope') or {}).get('gate_user_id')
        raw_user = (report['collection'].get('account') or {}).get('userId')
        current_user = str(raw_user).strip() if isinstance(raw_user, (str, int)) and not isinstance(raw_user, bool) else None
        compatible_pool = old_scope.get('pool') in ('ETH-cross', 'account') and scope.get('pool') in ('ETH-cross', 'account')
        changed_subject = old_scope and (any(old_scope.get(key) != scope.get(key) for key in ('address', 'accountId'))
                                         or old_scope.get('pool') != scope.get('pool') and not compatible_pool
                                         or old_user and current_user and old_user != current_user)
        if changed_subject:
            for key in ('pending', 'observed_status', 'notified_status', 'consecutive_status', 'notified_at',
                        'risk_status', 'critical_metrics', 'funding_gap', 'producer_scope'):
                state.pop(key, None)
        state['shared_scope'] = scope
        state['shared_risk_state'] = report['state']
        state['risk_status'] = {key: value['status'] for key, value in report['state'].items()}
        state['critical_metrics'] = {key: value['criticalMetrics'] for key, value in report['state'].items()}
        return report

    def public_boros(self, name, path, root):
        try:
            # Never send the local terminal token to the public gateway.
            return request_json('https://api-boros.pendle.finance/apis/v1/accounts/' + path + '?root=' + root,
                                {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'},
                                timeout=self.config.get('timeout_seconds', 15))
        except Exception as exc:
            self.errors[name] = str(exc)
            return None

    def public_settlements(self, root):
        """Read every page; a cap, bad page or pagination cycle is incomplete."""
        account_id = self.config.get('account_id', 0)
        rows, token, tokens = [], None, set()
        try:
            for _ in range(50):
                query = {'root': root, 'accountId': account_id, 'limit': 200}
                if token:
                    query['resumeToken'] = token
                page = request_json('https://api-boros.pendle.finance/apis/v1/accounts/settlement-events?'
                                    + urllib.parse.urlencode(query),
                                    {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'},
                                    timeout=self.config.get('timeout_seconds', 15))
                if not isinstance(page, dict) or not isinstance(page.get('results'), list):
                    raise ValueError('invalid settlement page')
                rows.extend(page['results'])
                token = page.get('resumeToken')
                if token is None or token == '':
                    return {'root': root, 'accountId': account_id, 'complete': True, 'rows': rows}
                if not isinstance(token, str) or token in tokens or not page['results']:
                    raise ValueError('invalid settlement pagination')
                tokens.add(token)
            raise ValueError('settlement page cap reached')
        except Exception as exc:
            self.errors['boros_settlements'] = str(exc)
            return None


def evaluate(data, config, state, rules, now, errors=None):
    """Legacy offline evaluator retained for historical fixtures; not used by the service."""
    errors = errors or {}
    days = rollover_days_to_maturity(data, config, now)
    # Only a verified distant maturity can suppress risk checks. Missing data
    # must retain UNKNOWN and any previously unverifiable critical state.
    outside_rollover_window = days is not None and days >= 14
    disabled = {rule['id'] for rule in rules if rule.get('enabled', True) is False}
    inactive_rollover = {rule['id'] for rule in rules
                         if outside_rollover_window and rule['id'].startswith('rollover.')
                         and rule['id'] != 'rollover.days_to_maturity'}
    disabled.update(inactive_rollover)
    for key in ('pending', 'observed_status', 'notified_status', 'consecutive_status',
                'notified_at', 'risk_status', 'critical_metrics'):
        for check_id in disabled:
            state.get(key, {}).pop(check_id, None)
    rules = [rule for rule in rules if rule['id'] not in disabled]
    active_metrics = {key for rule in rules for key in rule['metrics']}
    metrics = {}

    def put(key, value, source, observed=None, unit='', coverage='measured'):
        metrics[key] = {'value': value, 'unit': unit, 'source': source,
                        'observedAt': now if observed is None else observed,
                        'coverage': coverage}

    put('rollover.days_to_maturity', days, 'farm.maturity', unit='days')
    account = data.get('account')
    liquidation = data.get('liquidation')
    if isinstance(liquidation, dict):
        distance = number(liquidation.get('distance'))
        put('gate.liquidation_distance_pct', distance if distance is not None and distance >= 0 else None,
            '/account/liquidation: nearest absolute modeled move across coins; ' + str(liquidation.get('assumptions', '')),
            unit='ratio', coverage='derived')
    positions = (data.get('positions') or {}).get('positions')
    assets = (data.get('farm') or {}).get('assets', [])
    asset = next((a for a in assets if a.get('base') == config.get('base', 'ETH')), None)
    price = number((asset or {}).get('priceUsd'))
    boros = (asset or {}).get('borosOpen', [])
    perps = (asset or {}).get('perpOpen', [])
    baseline = config.get('baseline', {})
    expected = baseline.get('boros', {})
    expected_perps = baseline.get('perps', {})
    profit = None
    boros_equity = None
    boros_im = None
    available = None
    groups = (data.get('boros_raw') or {}).get('results', [])
    group = None
    for candidate in groups:
        handle = candidate.get('marketAcc', '').removeprefix('0x').lower()
        if len(handle) >= 52 and handle[:40] == str(config.get('root', '')).removeprefix('0x').lower():
            if (int(handle[40:42], 16) == config.get('account_id', 0)
                    and int(handle[42:46], 16) == config.get('collateral_token_id', 2)
                    and handle[46:52] == 'ffffff'):
                group = candidate
                break
    if group:
        avail = number(group.get('availableInitialMargin'))
        available = avail / 1e18 if avail is not None else None
        put('boros.available_eth', available, 'Boros official availableInitialMargin', unit='ETH')
    if group and price:
        net, im, avail_mm = [number(group.get(k)) for k in ('netBalance', 'initialMargin', 'availableMaintMargin')]
        if net is not None and im is not None and im > 0:
            boros_im, boros_equity = im / 1e18 * price, net / 1e18 * price
            put('boros.im_coverage', net / im, 'Boros official cross group netBalance / initialMargin', unit='ratio', coverage='derived')
            mm = net - avail_mm if avail_mm is not None else None
            put('boros.mm_health_ratio', net / mm if mm is not None and mm > 0 else None,
                'Boros official netBalance / (netBalance - availableMaintMargin)', unit='ratio', coverage='derived')
    gas = number((data.get('boros_gas') or {}).get('balanceInUSD'))
    put('agent.gas_balance_usd', gas, 'Boros official gas-balance.balanceInUSD', unit='USD')
    if asset is not None and price and boros:
        rates = {b.get('venue'): b for b in boros}
        hl, bn = rates.get('HYPERLIQUID'), rates.get('BINANCE')
        if hl and bn:
            put('hedge.maturity_match', hl['maturity'] == bn['maturity'], 'farm.maturity', unit='bool')
            put('boros.adverse_spread_pp', ((hl['markApr'] - bn['markApr']) - (hl['entryApr'] - bn['entryApr'])) * 100,
                'farm.markApr / entryApr', unit='percentage points', coverage='derived')
            put('boros.rate_mtm_usd', sum(b['mtmUsd'] for b in boros), 'farm.mtmUsd', unit='USD')
            if boros_equity and boros_equity > 0:
                put('boros.mtm_loss_equity_ratio', max(0, -sum(b['mtmUsd'] for b in boros)) / boros_equity,
                    'Boros negative MTM / net equity', unit='ratio', coverage='derived')
            initial = (baseline.get('opened_at') or now)
            duration = max(0, (min(hl['maturity'], bn['maturity']) - initial) / 31536000)
            history = (asset or {}).get('borosHistory', [])
            coverage = data['farm'].get('coverage', {})
            covered_from = number(coverage.get('settlementsFromSec'))
            ledger_ok = coverage.get('borosTxnsComplete') and not coverage.get('backfilling') and not data['farm'].get('warnings')
            profit_legs_ok = (hl['maturity'] == bn['maturity'] and hl.get('side') == 'SHORT'
                              and bn.get('side') == 'LONG' and hl['sizeToken'] == bn['sizeToken'])
            if profit_legs_ok and baseline.get('opened_at') and history and perps and ledger_ok and covered_from is not None and covered_from <= initial:
                live_ids = {b['marketId'] for b in boros}
                fees = (sum(p.get('feesUsd', 0) for p in perps) if config.get('include_perp_entry_cost', True) else 0)
                fees += sum(b.get('tradeFeeUsd', 0) for b in history if b.get('marketId') in live_ids)
                profit = hl['sizeToken'] * price * (hl['entryApr'] - bn['entryApr'] - hl['settleFeeApr'] - bn['settleFeeApr']) * duration - fees
        boros_directions = {b.get('venue'): b.get('side') for b in boros}
        put('hedge.direction_match', boros_directions.get('HYPERLIQUID') == 'SHORT' and boros_directions.get('BINANCE') == 'LONG', 'farm.side', unit='bool')
        market_ids = {str(b['marketId']) for b in boros}
        put('hedge.market_identity_match', market_ids == set(expected) if expected else None, 'confirmed baseline vs farm markets', unit='bool')
        by_venue = {p.get('venue'): p for p in perps}
        for venue, key in [('HYPERLIQUID', 'hl'), ('BINANCE', 'binance')]:
            b = next((b for b in boros if b.get('venue') == venue), None)
            p = by_venue.get(venue)
            put('hedge.' + key + '_size_gap_eth', abs(b['sizeToken'] - p['qty']) if b and p else None,
                'farm Boros / perp quantity', unit='ETH', coverage='derived')
        boros_snapshot = {str(b['marketId']): b['sizeToken'] * (-1 if b['side'] == 'SHORT' else 1) for b in boros}
        if expected:
            gap = sum(abs(boros_snapshot.get(k, 0) - v) for k, v in expected.items())
            gap += sum(abs(v) for k, v in boros_snapshot.items() if k not in expected)
            put('positions.unexpected_change_eth', gap, 'confirmed Boros baseline; ADL cause not inferred', unit='ETH', coverage='derived')

    flow = settlement_net_24h(data.get('boros_settlements'), config, now)
    put('boros.settlement_net_24h_eth', flow,
        'Boros settlement-events: net ETH events in (now-24h, now], complete pagination, configured cross pool',
        unit='ETH/24h', coverage='derived' if flow is not None else 'unknown')
    if flow is not None and available is not None:
        put('boros.buffer_runway_days', available / -flow if flow < 0 else 999999,
            'available / past-day net outflow; not a forecast', unit='days', coverage='derived')

    if account:
        equity, im, mm = [number(account.get(k)) for k in ('marginBalance', 'initialMargin', 'maintenanceMargin')]
        put('gate.im_coverage', equity / im if equity is not None and im and im > 0 else None, 'account.marginBalance / initialMargin', unit='ratio', coverage='derived')
        put('gate.mm_health_ratio', equity / mm if equity is not None and mm and mm > 0 else None, 'account.marginBalance / maintenanceMargin', unit='ratio', coverage='derived')
        for coin in ('USDT', 'USDC'):
            rows = [r for r in account.get('assets', []) if r.get('coin') == coin]
            vals = [number(r.get('liability')) for r in rows]
            put('gate.liability_' + coin.lower(), sum(abs(v) for v in vals) if vals and all(v is not None for v in vals) else None,
                'account.assets.liability', unit=coin)
        buckets = (data.get('interest') or {}).get('buckets')
        daily = 0.0
        rows = account.get('assets')
        known = isinstance(rows, list) and isinstance(buckets, list)
        seen = set()
        for row in rows if known else []:
            borrow = number(row.get('liability'))
            key = (row.get('coin'), row.get('exchangeType'))
            if borrow is None or borrow < 0 or key in seen:
                known = False
                break
            seen.add(key)
            if borrow == 0:
                continue
            matches = [b for b in buckets or [] if (b.get('coin'), b.get('venue')) == key]
            if key[0] not in ('USDT', 'USDC') or len(matches) != 1:
                known = False
                break
            bucket = matches[0]
            rate = number(bucket.get('ratePerYear'))
            cost = number(bucket.get('interestPerDayUsd'))
            if (number(bucket.get('borrow')) != borrow or rate is None or rate < 0
                    or cost is None or cost < 0):
                known = False
                break
            daily += cost
        put('gate.interest_daily_usd', daily if known and math.isfinite(daily) else None,
            '/account/interest buckets.interestPerDayUsd; current borrow/rate estimate, HL USDC free allowance; USDT/USDC valued at $1',
            unit='USD/day', coverage='derived')
    if data.get('farm') is not None and data['farm'].get('coverage', {}).get('borosTxnsComplete') and expected:
        live_boros = {str(b['marketId']): b['sizeToken'] * (-1 if b['side'] == 'SHORT' else 1) for b in boros}
        gap = sum(abs(live_boros.get(k, 0) - v) for k, v in expected.items())
        gap += sum(abs(v) for k, v in live_boros.items() if k not in expected)
        put('positions.unexpected_change_eth', gap, 'complete live Boros result vs confirmed baseline', unit='ETH', coverage='derived')
        if not boros:
            put('hedge.direction_match', False, 'complete live fetch: expected Boros legs absent', unit='bool')
    if positions is not None:
        wanted = [p for p in positions if p.get('symbol') in expected_perps]
        if expected_perps:
            quantities = [signed_qty(p) for p in wanted]
            known = all(q is not None for q in quantities)
            put('hedge.perp_net_eth', sum(quantities) if known else None, 'positions.qty normalized by positionSide', unit='ETH')
            actual = {symbol: sum(signed_qty(p) for p in wanted if p.get('symbol') == symbol)
                      for symbol in expected_perps} if known else None
            gap = sum(abs(actual[symbol] - qty) for symbol, qty in expected_perps.items()) if actual is not None else None
            old_gap = metrics.get('positions.unexpected_change_eth', {}).get('value')
            put('positions.unexpected_change_eth', gap + old_gap if gap is not None and old_gap is not None else None,
                'confirmed four-leg baseline', unit='ETH', coverage='derived')
            perp_directions = all(actual[symbol] * qty > 0 for symbol, qty in expected_perps.items()) if actual is not None else None
            old_direction = metrics.get('hedge.direction_match', {}).get('value')
            direction = False if perp_directions is False or old_direction is False else None if perp_directions is None or old_direction is None else True
            put('hedge.direction_match', direction, 'actual signed perp and Boros directions', unit='bool')
        hp = next((p for p in positions if 'HYPERLIQUID' in p.get('symbol', '') and 'ETH' in p.get('symbol', '')), None)
        bp = next((p for p in positions if 'BINANCE' in p.get('symbol', '') and 'ETH' in p.get('symbol', '')), None)
        if hp and bp:
            marks = [number(p.get('markPrice')) for p in (hp, bp)]
            spread = marks[0] - marks[1] if all(v is not None for v in marks) else None
            put('basis.mark_spread_usd_per_eth', spread, 'positions.markPrice', unit='USD/ETH')
            profits = [number(p.get('upnl')) for p in (hp, bp)]
            pnl = sum(profits) if all(v is not None for v in profits) else None
            put('basis.pnl_usd', pnl, 'positions.upnl', unit='USD')
            if profit is not None and profit > 0 and pnl is not None:
                put('basis.loss_profit_ratio', max(0, -pnl) / profit, 'basis loss / conditional strategy profit', unit='ratio', coverage='derived')
        times = [number(p.get('updateTime')) for p in wanted]
        if times and all(t is not None for t in times):
            put('data.age_seconds', max(0, now - min(times) / 1000), 'positions.updateTime (venue time, not response meta.ts)', unit='seconds')
        stale = [p.get('markStaleSinceMs') or p.get('markHeldSinceMs') for p in wanted]
        put('data.stale', bool(errors) or any(stale), 'API failure / upstream mark stale fields', unit='bool')
    farm = data.get('farm')
    if farm:
        cov = farm.get('coverage', {})
        start = baseline.get('opened_at') or now
        floors = [number(cov.get(k)) for k in ('settlementsFromSec', 'perpClosedFromSec')]
        put('data.coverage_complete', cov.get('borosTxnsComplete') is True and all(v is not None and v <= start for v in floors) and not cov.get('backfilling') and not farm.get('warnings'),
            'farm.coverage and warnings', unit='bool')
    deals, orders, alerts = data.get('deals'), data.get('orders'), data.get('alerts')
    if isinstance(deals, list):
        put('execution.halted_count', sum((d.get('pair') or {}).get('mode') == 'HALTED' for d in deals), 'deals.pair.mode', unit='count')
        # No active deals is authoritative zero; active deals need explicit reports.
        reports = [d.get('projection') for d in deals]
        if not deals or all(isinstance(r, dict) and 'unhedged' in r for r in reports):
            quantities = [number(r['unhedged']) for r in reports]
            put('execution.unhedged_eth', sum(abs(q) for q in quantities) if all(q is not None for q in quantities) else None,
                'deals explicit execution reports', unit='ETH')
        if deals and all(isinstance(r, dict) and 'anyPending' in r and 'anyQuarantined' in r for r in reports):
            pending = [o for d in deals for o in d.get('orders', []) if o.get('state') == 'PENDING' or o.get('quarantinedStatus')]
            ages = [now - o['createdAt'] / 1000 for o in pending if number(o.get('createdAt')) is not None]
            if not any(r['anyPending'] or r['anyQuarantined'] for r in reports):
                put('execution.pending_age_s', 0, 'deals.projection pending/quarantine', unit='seconds')
            elif len(ages) == len(pending) and ages:
                put('execution.pending_age_s', max(ages), 'deals pending/quarantine order creation times', unit='seconds')
        if orders == [] and not deals:
            put('execution.pending_age_s', 0, 'no active deals or open orders', unit='seconds')
    agent = data.get('agent')
    if agent:
        put('agent.approval', agent.get('approval') if agent.get('approval') != 'unknown' else None, 'agent live approval', unit='enum')
        expiry = number(agent.get('expiry'))
        put('agent.expiry_days', (expiry - now) / 86400 if expiry else None, 'agent.expiry', unit='days')
    ok = data.get('health', {}).get('status') == 'ok' if data.get('health') else False
    put('service.http_ok', ok, '/health only; upstream monitored separately', unit='bool')
    failures = state.get('service_failures', 0) + 1 if errors else 0
    state['service_failures'] = failures
    put('service.consecutive_failures', failures, 'all mandatory collector endpoints', unit='count')
    if not errors:
        state['last_complete_run_at'] = now
    put('service.last_success_age_s', now - state['last_complete_run_at'] if state.get('last_complete_run_at') else None,
        'successful mandatory endpoint collection', unit='seconds')
    put('monitor.last_complete_run_at', state.get('last_complete_run_at'), 'local persisted successful collection', unit='unix seconds')
    put('notify.pending_count', len(state.get('pending', {})), 'local persistent notification queue', unit='count')
    put('notify.failure_streak', state.get('notify_failures', 0), 'confirmed Telegram results', unit='count')
    put('notify.last_success_at', state.get('notify_last_success'), 'confirmed Telegram delivery', unit='unix seconds')

    # External observations require independent evidence, timestamp and expiry.
    try:
        observations = load(config.get('observations_file', ROOT / 'data/risk-monitor/observations.json')).get('metrics', {})
        if not isinstance(observations, dict):
            observations = {}
    except (ValueError, OSError, AttributeError):
        observations = {}
    for key, obs in observations.items():
        if key not in active_metrics:
            continue
        # Runtime state cannot be vouched for by a manual record.
        if key.startswith(('notify.', 'service.')) or key == 'monitor.last_complete_run_at':
            continue
        if key in metrics and metrics[key]['value'] is not None:
            continue
        invalid = evidence_error(key, obs, now)
        if invalid:
            put(key, None, CONTRACTS[key]['source'], unit=metric_unit(key), coverage='unknown')
            metrics[key]['validationError'] = invalid
        else:
            put(key, obs['value'], obs['source'], obs['observed_at'], metric_unit(key), 'external / human evidence')
            metrics[key]['evidence'] = obs['evidence']
            metrics[key]['expiresAt'] = obs['observed_at'] + min(obs['ttl_seconds'], CONTRACTS[key]['max_age_seconds'])

    exposure = metrics.get('collateral.eth_net')
    if exposure and price and valid_value(exposure['value'], CONTRACTS['collateral.eth_net']):
        delta = exposure['value'] * price
        loss = max(0, delta) * config.get('eth_stress_drop', .2)
        for key, value in [('collateral.eth_delta_usd', delta), ('collateral.stress_loss_usd', loss)]:
            put(key, value, 'verified total ETH exposure * current ETH/USD downside scenario', exposure['observedAt'], metric_unit(key), 'scenario')
        if profit is not None and profit > 0:
            put('collateral.stress_loss_profit_ratio', loss / profit, 'total exposure stress loss / conditional current-period profit',
                exposure['observedAt'], 'ratio', 'scenario')

    for coin in ('usdt', 'usdc'):
        quote = metrics.get('stablecoin.' + coin + '_usd')
        if quote and number(quote['value']) is not None:
            put('stablecoin.' + coin + '_deviation', abs(number(quote['value']) - 1), quote['source'], quote['observedAt'], 'ratio', 'derived')
    quotes = [metrics.get('stablecoin.' + coin + '_usd') for coin in ('usdt', 'usdc')]
    if all(quotes):
        put('stablecoin.source_age_s', max(now - q['observedAt'] for q in quotes), 'independent USD quote timestamps', unit='seconds', coverage='derived')
    for group in ('custody', 'protocol'):
        obs = metrics.get(group + '.incident_status')
        if obs:
            put(group + '.review_age_h', (now - obs['observedAt']) / 3600, obs['source'], unit='hours', coverage='derived')

    opportunities = data.get('opportunities')
    if days is not None and not outside_rollover_window and opportunities is not None and boros:
        current_maturity = max(b['maturity'] for b in boros)
        candidates = [(p, g) for g in opportunities.get('groups', []) for p in g.get('pairs', [])
                      if p.get('base') == config.get('base', 'ETH')
                      and p.get('shortLeg', {}).get('venue', '').upper() == 'HYPERLIQUID'
                      and p.get('longLeg', {}).get('venue', '').upper() == 'BINANCE'
                      and g.get('maturity', 0) > current_maturity
                      and number(p.get('netFixedApr')) is not None]
        if candidates:
            candidate, group = max(candidates, key=lambda pair: pair[0]['netFixedApr'])
            put('rollover.next_net_apr', candidate['netFixedApr'], 'opportunities.netFixedApr on NOTIONAL at configured size, not capital APR', unit='APR fraction')
            statuses = {m['marketId']: m.get('bookStatus') for m in group.get('markets', [])}
            put('rollover.depth_coverage_ratio', 1 if all(statuses.get(candidate[l]['marketId']) == 'ok' for l in ('shortLeg', 'longLeg')) else 0,
                'opportunities book status at configured notional', unit='ratio lower bound')

    if outside_rollover_window:
        state.pop('uncovered_since', None)
    elif days is not None and perps and boros:
        live_venues = {b.get('venue') for b in boros if b['maturity'] > now}
        missing = [p for p in perps if p.get('venue') not in live_venues]
        since = (state.get('uncovered_since') or now) if missing else None
        state['uncovered_since'] = since
        put('rollover.uncovered_funding_seconds', now - since if since else 0, 'perp exists without live corresponding Boros', unit='seconds')
        put('rollover.uncovered_funding_eth', sum(p['qty'] for p in missing), 'uncovered perp quantities', unit='ETH')
    elif (perps and asset is not None and not boros
          and (data.get('farm') or {}).get('coverage', {}).get('borosPositionsComplete') is True
          and config.get('account_id', 0) == 0):
        since = state.get('uncovered_since') or now
        state['uncovered_since'] = since
        put('rollover.uncovered_funding_seconds', now - since, 'perps present but no Boros hedge', unit='seconds')
        put('rollover.uncovered_funding_eth', sum(p['qty'] for p in perps), 'uncovered perp quantities', unit='ETH')

    checks = []
    overrides = config.get('thresholds', {})
    for rule in rules:
        values = {key: metrics.get(key, {'value': None, 'unit': metric_unit(key), 'source': rule['sourcePlan'], 'observedAt': None, 'coverage': 'unknown'}) for key in rule['metrics']}
        for key, metric in values.items():
            if metric['value'] is not None and not valid_value(metric['value'], CONTRACTS[key]):
                metric['value'] = None
                metric['coverage'] = 'unknown'
                metric['validationError'] = 'invalid metric value or type'
            metric['unit'] = metric_unit(key)
            metric['ageSeconds'] = now - metric['observedAt'] if metric['observedAt'] is not None else None
        missing = [k for k, m in values.items() if m['value'] is None]
        status = 'UNKNOWN' if missing else 'OK'
        reasons = ['missing/expired: ' + ', '.join(missing)] if missing else []
        conditions = overrides.get(rule['id'], rule.get('conditions', []))
        hits = []
        for condition in conditions:
            key, op, threshold, level = condition
            value = values.get(key, {}).get('value')
            if value is None:
                continue
            try:
                hit = {'lt': lambda: value < threshold, 'gt': lambda: value > threshold,
                       'abs_gt': lambda: abs(value) > threshold, 'eq': lambda: value == threshold,
                       'ne': lambda: value != threshold}[op]()
            except (TypeError, KeyError):
                status = max((status, 'UNKNOWN'), key=SEVERITY.get)
                reasons.append('invalid value / rule: ' + key)
                continue
            if hit:
                status = max((status, level), key=SEVERITY.get)
                reasons.append(f'{key} {op} {threshold}')
                if level == 'CRITICAL':
                    hits.append(key)
        old_hits = state.get('critical_metrics', {}).get(rule['id'], [])
        unresolved = [key for key in old_hits if key in values and values[key]['value'] is None]
        if unresolved:
            status = 'CRITICAL'
            reasons.append('previous critical not verifiable: ' + ', '.join(unresolved))
        state.setdefault('critical_metrics', {})[rule['id']] = sorted(set(hits + unresolved))
        state.setdefault('risk_status', {})[rule['id']] = status
        if rule['id'] in ('custody.incident_status', 'protocol.incident_status') and not missing:
            reasons.append('fresh review evidence only; not proof of safety')
        checks.append({'id': rule['id'], 'risk': rule['risk'], 'label': rule['label'],
                       'status': status, 'metrics': values, 'thresholds': conditions,
                       'coverageComplete': not missing, 'reason': '; '.join(reasons),
                       'recommendedAction': rule['action']})
    return {'observedAt': now, 'checks': checks, 'errors': errors,
            'inactiveRolloverChecks': sorted(inactive_rollover),
            'conditionalRollingProfitUsd': profit, 'borosEquityUsd': boros_equity,
            'note': 'Management thresholds, not platform liquidation rules. UNKNOWN is not safe.'}


def unavailable_report(state, rules, now, error):
    """Fail closed when the shared evaluator cannot be read, preserving unresolved danger."""
    checks = []
    for rule in rules:
        if (state.get('shared_scope') or {}).get('pool') == 'account' and rule.get('account'):
            rule = {**rule, **rule['account']}
        if (rule.get('enabled', True) is False or rule['risk'] == 8
                or rule['id'] in ('hedge.market_identity_match', 'positions.unexpected_change_eth')):
            continue
        critical = state.get('critical_metrics', {}).get(rule['id'], [])
        old = state.get('risk_status', {}).get(rule['id'])
        status = 'CRITICAL' if critical or old == 'CRITICAL' else 'UNKNOWN'
        checks.append({'id': rule['id'], 'risk': rule['risk'], 'label': rule['label'], 'status': status,
                       'metrics': {key: {'value': None, 'unit': metric_unit(key), 'source': '/api/risk/report',
                                         'observedAt': None, 'complete': False} for key in rule['metrics']},
                       'thresholds': rule.get('conditions', []), 'coverageComplete': False,
                       'reason': 'Shared Risk report unavailable; previous critical cannot be verified' if status == 'CRITICAL'
                                 else 'Shared Risk report unavailable; current evidence is UNKNOWN',
                       'recommendedAction': rule['action']})
    return {'observedAt': now, 'checks': checks, 'errors': {'report': error}, 'complete': False,
            'note': 'Shared Risk report unavailable. No legacy calculation fallback.'}


def notify_report(report, state, config, env, now, sender=None, state_path=None):
    sender = sender or (lambda text: telegram(env, 'sendMessage', {
        'chat_id': env.get('MONITOR_TELEGRAM_CHAT_ID', ''), 'text': text}))
    observed = state.setdefault('observed_status', {})
    notified = state.setdefault('notified_status', {})
    pending = state.setdefault('pending', {})
    counts = state.setdefault('consecutive_status', {})
    reminders = state.setdefault('notified_at', {})
    active = {check['id'] for check in report['checks'] if check['status'] != 'PAUSED'}
    for mapping in (observed, notified, pending, counts, reminders):
        for key in set(mapping) - active:
            mapping.pop(key, None)
    for check in report['checks']:
        key, status = check['id'], check['status']
        if status == 'PAUSED':
            continue
        counts[key] = counts.get(key, 0) + 1 if observed.get(key) == status else 1
        observed[key] = status
        old = notified.get(key)
        due = now - reminders.get(key, 0) >= config.get('reminder_seconds', 21600)
        immediate = status == 'CRITICAL' or (status != 'OK' and key in ('hedge.direction_match', 'positions.unexpected_change_eth', 'rollover.uncovered_funding_seconds'))
        debounce = 1 if immediate else config.get('debounce_runs', 2)
        if (status != old or (status != 'OK' and due)) and counts[key] >= debounce:
            if status != 'OK' or old not in (None, 'OK'):
                pending[key] = {'id': key, 'status': status, 'label': check['label'], 'reason': check['reason'], 'action': check['recommendedAction']}
            else:
                notified[key] = 'OK'
        # A pending alert is updated to the newest state, including recovery.
        if key in pending and pending[key]['status'] != status and counts[key] >= debounce:
            pending[key] = {'id': key, 'status': status, 'label': check['label'], 'reason': check['reason'], 'action': check['recommendedAction']}
    if state_path is not None:
        save(state_path, state)
    entries = [entry for key, entry in pending.items() if entry['status'] == observed.get(key)]
    if not entries:
        return
    # One short line per item; split conservatively below Telegram's 4096 limit.
    chunk, keys = '四腿风险监控\n', []
    batches = []
    for entry in entries:
        line = f"[{entry['status']}] {entry['label']} ({entry['id']})\n{entry['reason'][:180]}\n应对：{entry['action'][:160]}\n"
        # External evidence can contain wallet addresses or credential-bearing URLs.
        line = re.sub(r'0x[0-9a-fA-F]{40}', '[wallet]', line)
        line = re.sub(r'\d+:[A-Za-z0-9_-]{20,}', '[token]', line)
        for secret in env.values():
            if secret:
                line = line.replace(secret, '[redacted]')
        if len(chunk + line) > 3000:
            batches.append((chunk, keys))
            chunk, keys = '四腿风险监控（续）\n', []
        chunk += line
        keys.append(entry['id'])
    batches.append((chunk, keys))
    for text, keys in batches:
        try:
            delivered = sender(text)
        except Exception:
            state['notify_failures'] = state.get('notify_failures', 0) + 1
            if state_path is not None:
                save(state_path, state)
            print('Telegram send failed; undelivered alerts retained locally.', file=sys.stderr)
            return
        for key in keys:
            notified[key] = pending[key]['status']
            reminders[key] = now
            del pending[key]
        state['notify_last_success'] = now
        if isinstance(delivered, dict) and isinstance(delivered.get('message_id'), int) and not isinstance(delivered['message_id'], bool) and delivered['message_id'] > 0:
            state['notify_last_message_id'] = delivered['message_id']
        else:
            state.pop('notify_last_message_id', None)
        if state_path is not None:
            save(state_path, state)
    state['notify_failures'] = 0
    if state_path is not None:
        save(state_path, state)


def heartbeat_check(path, now, interval):
    """Check a mirrored file on a separate host; never contact the terminal."""
    limit = 2 * interval + 60
    age, completed_age = None, None
    status, reason = 'CRITICAL', 'heartbeat missing or invalid'
    try:
        beat = load(path)
        observed = beat.get('observedAt')
        complete = beat.get('complete')
        completed = beat.get('lastCompleteAt')
        if (isinstance(observed, (int, float)) and not isinstance(observed, bool)
                and math.isfinite(observed) and isinstance(complete, bool)):
            age = now - observed
            if isinstance(completed, (int, float)) and not isinstance(completed, bool) and math.isfinite(completed):
                completed_age = now - completed
            elif complete:
                completed_age = age
            if 0 <= age <= limit:
                status = 'OK' if complete else 'WARNING'
                reason = 'heartbeat fresh' if complete else 'monitor alive; collection incomplete'
                if completed_age is None or not 0 <= completed_age <= limit:
                    status, reason = 'CRITICAL', 'no recent complete collection'
            else:
                reason = 'heartbeat stale or future-dated'
    except (ValueError, OSError, AttributeError, TypeError):
        pass
    return {'id': 'monitor.heartbeat_age_s', 'label': '独立监控心跳',
            'status': status, 'ageSeconds': age, 'lastCompleteAgeSeconds': completed_age,
            'reason': reason, 'recommendedAction': '检查主机、网络和监控进程'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=str(DEFAULT_CONFIG))
    parser.add_argument('--interval-seconds', type=int)
    parser.add_argument('--watch', action='store_true')
    parser.add_argument('--notify', action='store_true')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--accept-baseline', action='store_true', help='Explicitly accept currently observed quantities as the expected four-leg baseline')
    parser.add_argument('--heartbeat', help='External machine: read a mirrored heartbeat JSON file')
    parser.add_argument('--record', help='Record a timestamped external metric observation')
    parser.add_argument('--value', help='Observation value encoded as JSON')
    parser.add_argument('--source')
    parser.add_argument('--evidence')
    parser.add_argument('--ttl-seconds', type=int, default=3600)
    args = parser.parse_args()
    config = load(ROOT / 'scripts/risk-monitor-config.example.json')
    config.update(load(args.config))
    interval = args.interval_seconds if args.interval_seconds is not None else config.get('interval_seconds', 300)
    if interval < 10:
        parser.error('interval must be at least 10 seconds')
    if args.record:
        ids = {m for r in load(RULES, []) for m in r['metrics']}
        if args.record not in ids or args.value is None or not args.source or not args.evidence or args.ttl_seconds <= 0:
            parser.error('record needs a known metric id, JSON value, source, evidence and positive TTL')
        try:
            value = json.loads(args.value)
        except ValueError:
            parser.error('value must be valid JSON')
        entry = {'value': value, 'unit': metric_unit(args.record), 'observed_at': time.time(),
                 'ttl_seconds': args.ttl_seconds, 'source': args.source, 'evidence': args.evidence}
        invalid = evidence_error(args.record, entry, entry['observed_at'])
        if invalid or args.ttl_seconds > CONTRACTS[args.record]['max_age_seconds']:
            parser.error(invalid or 'TTL exceeds metric maximum age')
        if args.record.startswith(('notify.', 'service.')) or args.record == 'monitor.last_complete_run_at':
            parser.error('runtime metrics cannot be recorded manually')
        path = config.get('observations_file', ROOT / 'data/risk-monitor/observations.json')
        # Reuse recent independent identity without performing a new collection.
        # Legacy/unverified observations remain usable by the CLI, UNKNOWN in Risk.
        try:
            producer = load(Path(config.get('state_dir', ROOT / 'data/risk-monitor')) / 'state.json')
        except (OSError, ValueError):
            producer = {}
        if not isinstance(producer, dict):
            producer = {}
        scope = producer.get('producer_scope') or {}
        if not isinstance(scope, dict):
            scope = {}
        expected = producer_scope(config, {'account': {'userId': scope.get('gate_user_id')}, 'agent': {'root': scope.get('root')}})
        stamp = producer.get('observed_at')
        if (expected and scope == expected and isinstance(stamp, (int, float)) and not isinstance(stamp, bool)
                and 0 <= entry['observed_at'] - stamp <= 3600):
            entry.update({'scope': scope, 'coverage_complete': True})
        observed = load(path)
        observed.setdefault('metrics', {})[args.record] = entry
        save(path, observed)
        print('Timestamped observation saved locally; expires after', args.ttl_seconds, 'seconds.')
        return 0
    if args.heartbeat:
        checked_at = time.time()
        check = heartbeat_check(args.heartbeat, checked_at, interval)
        print(json.dumps(check, ensure_ascii=False, allow_nan=False))
        if args.notify:
            env = read_env(config.get('telegram_env', ROOT / 'data/risk-monitor/telegram.env'))
            path = Path(config.get('state_dir', ROOT / 'data/risk-monitor')) / 'external-heartbeat-state.json'
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with open(path.parent / 'external-heartbeat.lock', 'a') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    print('Another heartbeat check is already running.', file=sys.stderr)
                    return 1
                external_state = load(path)
                notify_report({'checks': [check]}, external_state, config, env, checked_at, state_path=path)
                if external_state.get('notify_failures'):
                    return 1
        return 0 if check['status'] == 'OK' else 2
    folder = Path(config.get('state_dir', ROOT / 'data/risk-monitor'))
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(folder / 'monitor.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another risk monitor is already running.', file=sys.stderr)
            return 1
        state_path = folder / 'state.json'
        state = load(state_path)
        rules = load(RULES, [])
        while True:
            started = time.time()
            try:
                collector = Collector(config)
                if args.accept_baseline:
                    data = collector.collect()
                else:
                    report = collector.collect_report(state)
                    data = report.pop('collection')
                agent = data.get('agent') or {}
                config['root'] = config.get('root') or agent.get('root')
                if args.accept_baseline:
                    asset = next((a for a in (data.get('farm') or {}).get('assets', []) if a.get('base') == config.get('base', 'ETH')), None)
                    if not asset or not asset.get('borosOpen') or not asset.get('perpOpen') or collector.errors:
                        raise RuntimeError('Cannot accept an incomplete baseline')
                    config['baseline'] = {'opened_at': asset['earliestSec'],
                        'boros': {str(b['marketId']): b['sizeToken'] * (-1 if b['side'] == 'SHORT' else 1) for b in asset['borosOpen']},
                        'perps': {p['symbol']: p['qty'] * (-1 if p['side'] == 'SHORT' else 1) for p in asset['perpOpen']}}
                    config['baseline'].update({'scope': producer_scope(config, data), 'observed_at': started,
                                               'evidence': 'explicit --accept-baseline'})
                    config['interval_seconds'] = interval
                    save(args.config, config)
                    print('Current baseline accepted explicitly; quantities saved locally.')
                    return 0
                state['service_failures'] = 0 if report['complete'] else state.get('service_failures', 0) + 1
                if report['complete']:
                    state['last_complete_run_at'] = report['observedAt']
                # No incomplete or stale snapshot can extend funding-gap history.
                if report['complete']:
                    record_funding_gap(data, config, state, report['observedAt'])
                else:
                    state.pop('funding_gap', None)
                verified_scope = producer_scope(config, data)
                if verified_scope:
                    state['producer_scope'] = verified_scope
                state['observed_at'] = report['observedAt']
            except ConfigurationMismatch as exc:
                print(str(exc), file=sys.stderr)
                return 1
            except Exception as exc:
                state.pop('funding_gap', None)
                state['service_failures'] = state.get('service_failures', 0) + 1
                state['observed_at'] = started
                report = unavailable_report(state, rules, started, type(exc).__name__)
            if args.notify:
                env = read_env(config.get('telegram_env', folder / 'telegram.env'))
                notify_report(report, state, config, env, started, state_path=state_path)
                # Keep this report's shared snapshot unchanged. Confirmed delivery is
                # persisted separately and becomes evidence on the next Risk read.
            save(folder / 'latest.json', report)
            save(folder / 'heartbeat.json', {'observedAt': time.time(), 'complete': report.get('complete', False),
                                                 'lastCompleteAt': state.get('last_complete_run_at'),
                                                 'producer_scope': state.get('producer_scope')})
            save(state_path, state)
            if args.json:
                print(json.dumps(report, ensure_ascii=False, allow_nan=False), flush=True)
            else:
                print(dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec='seconds'), 'risk checks', flush=True)
                for check in report['checks']:
                    print(format_check(check), flush=True)
            if not args.watch:
                return 2 if any(c['status'] not in ('OK', 'PAUSED') for c in report['checks']) else 0
            time.sleep(max(0, interval - (time.time() - started)))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:
        print('Risk monitor failed:', type(exc).__name__, file=sys.stderr)
        sys.exit(1)
