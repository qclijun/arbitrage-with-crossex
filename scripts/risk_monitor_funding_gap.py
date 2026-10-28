"""Continuous ETH funding-gap history for the risk monitor (standard library
only, read-only). The gap identity is the terminal's fundingGapFingerprint
(src/core/risk.ts); proven floating two-leg quantity from a version-2 Risk
report (ticket 16) is used as given, never recomputed or widened."""
import json
import math
import re
import struct


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


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
            or any(b.get('marketAcc', '').lower() != pool or b.get('venue') not in ('HYPERLIQUID', 'BINANCE', 'OKX')
                   or not isinstance(b.get('marketId'), int) or isinstance(b['marketId'], bool) or b['marketId'] <= 0 for b in boros)):
        state.pop('funding_gap', None)
        return
    quantities = [p.get('qty') for p in perps] + [b.get('sizeToken') for b in boros]
    if (any(not isinstance(q, (int, float)) or isinstance(q, bool) or not math.isfinite(q) or q <= 0 for q in quantities)
            or any(p.get('side') not in ('LONG', 'SHORT') or not re.fullmatch(r'(HYPERLIQUID|BINANCE|OKX)_FUTURE_ETH_(USDT|USDC|USD)', p.get('symbol', ''))
                   or p.get('exchange') != p['symbol'].split('_')[0] for p in perps)
            or len({p['symbol'] for p in perps}) != len(perps)
            or any(b.get('side') not in ('LONG', 'SHORT') or not isinstance(b.get('maturity'), (int, float)) or isinstance(b['maturity'], bool)
                   or not math.isfinite(b['maturity']) or b['maturity'] <= 0 for b in boros)):
        state.pop('funding_gap', None)
        return
    floating = floating_exemptions(data.get('fundingApplicability'), perps)
    if floating is None:
        state.pop('funding_gap', None)
        return
    identity = {'root': root, 'account_id': account_id, 'perps': sorted([[p['symbol'], p['exchange'], p['side'], p['qty']] for p in perps]),
                'boros': sorted([[b['marketId'], b['venue'], b['side'], b['sizeToken'], b['maturity']] for b in boros])}
    base_fingerprint = canonical_identity(identity)
    # Same identity as the terminal's fundingGapFingerprint: proven floating
    # quantity (ticket 16) joins it only when there is some.
    fingerprint = canonical_identity({**identity, 'floating': sorted([[s, side, q] for (s, side), q in floating.items()])}) if floating else base_fingerprint
    quantity = sum(max(0, p['qty'] - floating.get((p['symbol'], p['side']), 0)
                       - sum(b['sizeToken'] for b in boros if b['venue'] == p['exchange'] and b['side'] == p['side'] and b['maturity'] > now)) for p in perps)
    old = state.get('funding_gap') or {}
    recent = (isinstance(old.get('observed_at'), (int, float)) and 0 <= now - old['observed_at'] <= 3600
              and isinstance(old.get('started_at'), (int, float)) and 0 < old['started_at'] <= old['observed_at']
              and number(old.get('uncovered_eth')) is not None and quantity > 0)
    same = recent and old['uncovered_eth'] == quantity and old.get('fingerprint') == fingerprint
    # A changed exemption that leaves part of the same gap open keeps its clock:
    # proving some quantity floats must never restart the timer on the rest.
    narrowed = (recent and old.get('base_fingerprint', old.get('fingerprint')) == base_fingerprint
                and old.get('fingerprint') != fingerprint and quantity <= old['uncovered_eth'])
    state['funding_gap'] = {'fingerprint': fingerprint, 'base_fingerprint': base_fingerprint,
                            'started_at': old['started_at'] if same or narrowed else now,
                            'observed_at': now, 'uncovered_eth': quantity}


def floating_exemptions(raw, perps):
    """ETH floating quantities the report proved, by (symbol, side); {} when
    there are none (a version-1 report), None when the list is malformed or
    claims more than a held leg."""
    if raw is None:
        return {}
    if not isinstance(raw, list):
        return None
    result = {}
    for entry in raw:
        if (not isinstance(entry, dict) or not isinstance(entry.get('symbol'), str) or entry.get('side') not in ('LONG', 'SHORT')
                or not isinstance(entry.get('qty'), str) or not re.fullmatch(r'\d+(\.\d+)?', entry['qty'])
                or not isinstance(entry.get('sliceIds'), list) or not all(isinstance(i, str) for i in entry['sliceIds'])):
            return None
        qty = float(entry['qty'])
        if '_FUTURE_ETH_' not in entry['symbol']:
            continue  # other bases have their own report coverage
        held = next((p for p in perps if p['symbol'] == entry['symbol'] and p['side'] == entry['side']), None)
        key = (entry['symbol'], entry['side'])
        if held is None or qty <= 0 or result.get(key, 0) + qty > held['qty']:
            return None
        result[key] = result.get(key, 0) + qty
    return result
