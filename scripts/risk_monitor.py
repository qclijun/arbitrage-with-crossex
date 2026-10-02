#!/usr/bin/env python3
"""Read-only four-leg risk monitor. Python standard library only."""
import argparse
import concurrent.futures
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from risk_monitor_evidence import CONTRACTS, evidence_error, valid_value

ROOT = Path(__file__).resolve().parents[1]
RULES = ROOT / 'scripts/risk-monitor-rules.json'
DEFAULT_CONFIG = ROOT / 'data/risk-monitor/config.json'
SEVERITY = {'OK': 0, 'UNKNOWN': 1, 'WARNING': 2, 'CRITICAL': 3}


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


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
        agent = self.get('agent', '/boros/agent?fresh=1')
        root = self.config.get('root') or (agent or {}).get('root')
        paths = {'account': '/account?fresh=1', 'positions': '/positions?fresh=1',
                 'health': '/health', 'deals': '/deals?active=1',
                 'orders': '/orders/open?fresh=1', 'alerts': '/alerts?unacked=1'}
        if root and re.fullmatch(r'0x[0-9a-fA-F]{40}', root):
            paths['farm'] = '/asset-view/' + root + '?fresh=1'
            paths['context'] = '/boros/pair/context?address=' + root + '&fresh=1'
        if self.config.get('scan_rollover', False):
            paths['opportunities'] = '/opportunities?borosEntry=market&exitMode=roll&notionalUsd=' + str(self.config.get('notional_usd', 10000))
        data = {'agent': agent}
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            futures = {pool.submit(self.get, name, path): name for name, path in paths.items()}
            if root and re.fullmatch(r'0x[0-9a-fA-F]{40}', root):
                for name, path in [('boros_raw', 'market-acc-infos-by-root'), ('boros_gas', 'gas-balance')]:
                    futures[pool.submit(self.public_boros, name, path, root)] = name
            for future in concurrent.futures.as_completed(futures):
                data[futures[future]] = future.result()
        return data

    def public_boros(self, name, path, root):
        try:
            # Never send the local terminal token to the public gateway.
            return request_json('https://api-boros.pendle.finance/apis/v1/accounts/' + path + '?root=' + root,
                                {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'},
                                timeout=self.config.get('timeout_seconds', 15))
        except Exception as exc:
            self.errors[name] = str(exc)
            return None


def evaluate(data, config, state, rules, now, errors=None):
    """Pure risk computation; no requests and no automatic trading actions."""
    errors = errors or {}
    metrics = {}

    def put(key, value, source, observed=None, unit='', coverage='measured'):
        metrics[key] = {'value': value, 'unit': unit, 'source': source,
                        'observedAt': now if observed is None else observed,
                        'coverage': coverage}

    account = data.get('account')
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
    if group and price:
        net, im, avail, avail_mm = [number(group.get(k)) for k in ('netBalance', 'initialMargin', 'availableInitialMargin', 'availableMaintMargin')]
        if net is not None and im is not None and im > 0:
            boros_im, boros_equity = im / 1e18 * price, net / 1e18 * price
            available = avail / 1e18 if avail is not None else None
            put('boros.im_coverage', net / im, 'Boros official cross group netBalance / initialMargin', unit='ratio', coverage='derived')
            put('boros.available_eth', available, 'Boros official availableInitialMargin', unit='ETH')
            mm = net - avail_mm if avail_mm is not None else None
            put('boros.mm_health_ratio', net / mm if mm is not None and mm > 0 else None,
                'Boros official netBalance / (netBalance - availableMaintMargin)', unit='ratio', coverage='derived')
    gas = number((data.get('boros_gas') or {}).get('balanceInUSD'))
    put('agent.gas_balance_usd', gas, 'Boros official gas-balance.balanceInUSD', unit='USD')
    if asset is not None and price and boros:
        rates = {b.get('venue'): b for b in boros}
        hl, bn = rates.get('HYPERLIQUID'), rates.get('BINANCE')
        if hl and bn:
            days = (min(hl['maturity'], bn['maturity']) - now) / 86400
            put('rollover.days_to_maturity', days, 'farm.maturity', unit='days')
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
        settlements = sum(b.get('settleUsd', 0) for b in asset.get('borosHistory', [])) / price
        history = [p for p in state.get('samples', []) if p['time'] >= now - 90000]
        earlier = next((p for p in history if now - p['time'] >= 86400 and p.get('root') == config.get('root') and p.get('coverage_complete') is True), None)
        coverage = data['farm'].get('coverage', {})
        covered_from = number(coverage.get('settlementsFromSec'))
        settlement_ok = coverage.get('borosTxnsComplete') is True and covered_from is not None and covered_from <= (baseline.get('opened_at') or now - 86400) and not coverage.get('backfilling') and not data['farm'].get('warnings')
        if earlier and settlement_ok:
            flow = settlements - earlier['settlement_eth']
            put('boros.settlement_net_24h_eth', flow, 'difference of complete cumulative settlement samples', unit='ETH/24h', coverage='derived')
            if available is not None:
                put('boros.buffer_runway_days', available / -flow if flow < 0 else 999999,
                    'available / past-day outflow; not a forecast', unit='days', coverage='derived')
        if settlement_ok:
            history.append({'time': now, 'root': config.get('root'), 'settlement_eth': settlements, 'coverage_complete': True})
            state['samples'] = history

    if account:
        equity, im, mm = [number(account.get(k)) for k in ('marginBalance', 'initialMargin', 'maintenanceMargin')]
        put('gate.im_coverage', equity / im if equity is not None and im and im > 0 else None, 'account.marginBalance / initialMargin', unit='ratio', coverage='derived')
        put('gate.mm_health_ratio', equity / mm if equity is not None and mm and mm > 0 else None, 'account.marginBalance / maintenanceMargin', unit='ratio', coverage='derived')
        for coin in ('USDT', 'USDC'):
            rows = [r for r in account.get('assets', []) if r.get('coin') == coin]
            vals = [number(r.get('liability')) for r in rows]
            put('gate.liability_' + coin.lower(), sum(abs(v) for v in vals) if vals and all(v is not None for v in vals) else None,
                'account.assets.liability', unit=coin)
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
        if key not in CONTRACTS:
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
    if opportunities is not None and boros:
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

    if perps and boros:
        live_venues = {b.get('venue') for b in boros if b['maturity'] > now}
        missing = [p for p in perps if p.get('venue') not in live_venues]
        since = (state.get('uncovered_since') or now) if missing else None
        state['uncovered_since'] = since
        put('rollover.uncovered_funding_seconds', now - since if since else 0, 'perp exists without live corresponding Boros', unit='seconds')
        put('rollover.uncovered_funding_eth', sum(p['qty'] for p in missing), 'uncovered perp quantities', unit='ETH')
    elif perps and asset is not None:
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
        previous = state.get('risk_status', {}).get(rule['id'])
        hits = []
        for condition in conditions:
            key, op, threshold, level = condition
            value = values.get(key, {}).get('value')
            if value is None:
                continue
            boundary = threshold
            if previous and SEVERITY.get(previous, 0) >= SEVERITY[level] and isinstance(threshold, (int, float)) and not isinstance(threshold, bool):
                margin = config.get('recovery_margin_fraction', .03)
                if op == 'lt':
                    boundary = threshold + abs(threshold) * margin
                elif op in ('gt', 'abs_gt'):
                    boundary = threshold - abs(threshold) * margin
            try:
                hit = {'lt': lambda: value < boundary, 'gt': lambda: value > boundary,
                       'abs_gt': lambda: abs(value) > boundary, 'eq': lambda: value == threshold,
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
        unresolved = [key for key in old_hits if values.get(key, {}).get('value') is None]
        if unresolved:
            status = 'CRITICAL'
            reasons.append('previous critical not verifiable: ' + ', '.join(unresolved))
        state.setdefault('critical_metrics', {})[rule['id']] = sorted(set(hits + unresolved))
        state.setdefault('risk_status', {})[rule['id']] = status
        if rule['id'] in ('custody.incident_status', 'protocol.incident_status') and not missing:
            reasons.append('fresh review evidence only; not proof of safety')
        checks.append({'id': rule['id'], 'risk': rule['risk'], 'label': rule['label'],
                       'status': status, 'metrics': values, 'thresholds': conditions,
                       'coverageComplete': not missing, 'reason': '; '.join(reasons) or 'within configured management thresholds',
                       'recommendedAction': rule['action']})
    return {'observedAt': now, 'checks': checks, 'errors': errors,
            'conditionalRollingProfitUsd': profit, 'borosEquityUsd': boros_equity,
            'note': 'Management thresholds, not platform liquidation rules. UNKNOWN is not safe.'}


def notify_report(report, state, config, env, now, sender=None, state_path=None):
    sender = sender or (lambda text: telegram(env, 'sendMessage', {
        'chat_id': env.get('MONITOR_TELEGRAM_CHAT_ID', ''), 'text': text}))
    observed = state.setdefault('observed_status', {})
    notified = state.setdefault('notified_status', {})
    pending = state.setdefault('pending', {})
    counts = state.setdefault('consecutive_status', {})
    reminders = state.setdefault('notified_at', {})
    for check in report['checks']:
        key, status = check['id'], check['status']
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
            sender(text)
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
                data = collector.collect()
                agent = data.get('agent') or {}
                config['root'] = config.get('root') or agent.get('root')
                if args.accept_baseline:
                    asset = next((a for a in (data.get('farm') or {}).get('assets', []) if a.get('base') == config.get('base', 'ETH')), None)
                    if not asset or not asset.get('borosOpen') or not asset.get('perpOpen') or collector.errors:
                        raise RuntimeError('Cannot accept an incomplete baseline')
                    config['baseline'] = {'opened_at': asset['earliestSec'],
                        'boros': {str(b['marketId']): b['sizeToken'] * (-1 if b['side'] == 'SHORT' else 1) for b in asset['borosOpen']},
                        'perps': {p['symbol']: p['qty'] * (-1 if p['side'] == 'SHORT' else 1) for p in asset['perpOpen']}}
                    config['interval_seconds'] = interval
                    save(args.config, config)
                    print('Current baseline accepted explicitly; quantities saved locally.')
                    return 0
                report = evaluate(data, config, state, rules, started, collector.errors)
            except Exception as exc:
                report = evaluate({}, config, state, rules, started, {'collector': type(exc).__name__})
            if args.notify:
                env = read_env(config.get('telegram_env', folder / 'telegram.env'))
                notify_report(report, state, config, env, started, state_path=state_path)
                delivery = next(c for c in report['checks'] if c['id'] == 'notify.last_success_at')
                for key, value in [('notify.last_success_at', state.get('notify_last_success')),
                                   ('notify.pending_count', len(state.get('pending', {}))),
                                   ('notify.failure_streak', state.get('notify_failures', 0))]:
                    delivery['metrics'][key] = {'value': value, 'unit': metric_unit(key), 'source': 'current run Telegram results / persistent queue',
                                                'observedAt': started, 'ageSeconds': 0, 'coverage': 'measured'}
                failed = state.get('notify_failures', 0)
                delivery['status'] = 'CRITICAL' if failed > 2 else 'WARNING' if failed else 'OK' if state.get('notify_last_success') else 'UNKNOWN'
                delivery['coverageComplete'] = bool(state.get('notify_last_success'))
                delivery['reason'] = 'Telegram failed; queued for retry' if failed else 'delivery result updated after notification'
            save(folder / 'latest.json', report)
            save(folder / 'heartbeat.json', {'observedAt': started, 'complete': not report['errors'],
                                                 'lastCompleteAt': state.get('last_complete_run_at')})
            save(state_path, state)
            if args.json:
                print(json.dumps(report, ensure_ascii=False, allow_nan=False), flush=True)
            else:
                print(dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec='seconds'), 'risk checks', flush=True)
                for check in report['checks']:
                    vals = ', '.join(f"{k}={m['value']} {m['unit']}" for k, m in check['metrics'].items())
                    print(f"{check['status']:8} {check['id']}: {vals}\n  {check['reason']}", flush=True)
            if not args.watch:
                return 2 if any(c['status'] != 'OK' for c in report['checks']) else 0
            time.sleep(max(0, interval - (time.time() - started)))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:
        print('Risk monitor failed:', type(exc).__name__, file=sys.stderr)
        sys.exit(1)
