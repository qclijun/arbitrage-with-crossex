#!/usr/bin/env python3
"""One-shot, read-only Opportunity ranking. Financial values come from the API."""
import argparse
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from datetime import datetime
from urllib import error, parse, request
from uuid import uuid4
from zoneinfo import ZoneInfo

COSTS = ('borosTakerFeeUsd', 'borosSettleFeeUsd', 'perpEntryFeesUsd', 'perpEntrySlippageUsd', 'perpExitFeesUsd', 'perpExitSlippageUsd', 'totalUsd', 'annualizedApr')
CAPITAL = ('borosShortImUsd', 'borosLongImUsd', 'perpShortImUsd', 'perpLongImUsd', 'shortLeverageMax', 'longLeverageMax')
VALUES = ('grossSpreadApr', 'execSpreadApr', 'borosImpactApr', 'capitalUsd', 'netFixedApr', 'netFixedAprOnCapital', 'effectiveLeverage', 'estProfitUsd', 'secondsToMaturity')
LIMITATIONS = ['Maker entry and modeled maker exit assume a fill at mid; resting orders are not guaranteed to fill.', 'Model capital is the return denominator, not account funds or a safe budget.', 'Book ok does not prove four-leg fills; OI is only market-size context.', 'No client rebates added. Gas, borrowing interest and other unmodelled costs are excluded.', 'Boros price impact is already in execution APR and is not deducted again.', 'Roll avoids this period\'s perpetual exit costs; final exit can still cost money and future opportunities are not guaranteed.']


def number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def label(value):
    # Report identifiers are bounded domain labels, never upstream prose/credentials.
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.:+-]{1,48}', value) else None


def book_failures(envelope):
    # Only bounded identifiers and numeric evidence; never persist upstream prose.
    data = envelope.get('data') if isinstance(envelope, dict) else None
    meta = data.get('meta') if isinstance(data, dict) else None
    rows = meta.get('venueBookFailures') if isinstance(meta, dict) else None
    if not isinstance(rows, list):
        return []
    result = []
    for row in rows[:500]:
        if not isinstance(row, dict) or not label(row.get('symbol')):
            continue
        category = row.get('category')
        stage = row.get('stage')
        if category not in ('timeout', 'http', 'network', 'tls', 'invalid-response', 'unsupported', 'unexpected') or stage not in ('setup', 'metadata', 'discovery', 'book'):
            continue
        status, elapsed, observed = row.get('httpStatus'), row.get('elapsedMs'), row.get('observedAt')
        code = row.get('errorCode')
        safe_codes = ('ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_CANCELED')
        result.append(dict(symbol=label(row['symbol']), category=category, stage=stage, httpStatus=status if type(status) is int and 100 <= status <= 599 else None, errorCode=code if code in safe_codes else None, elapsedMs=elapsed if number(elapsed) and elapsed >= 0 else None, observedAtMs=observed if number(observed) and observed >= 0 else None, stale=row.get('stale') if type(row.get('stale')) is bool else None))
    return result


def local_base(value):
    url = parse.urlsplit(value)
    if url.scheme not in ('http', 'https') or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
        raise ValueError('URL must be a loopback origin without authentication, path, query or fragment')
    host = url.hostname
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host == 'localhost'
    if not loopback or url.port == 0:
        raise ValueError('URL must use a loopback address')
    # Pin localhost to an IP: no DNS resolution can send the token off-host.
    if host == 'localhost':
        return parse.urlunsplit((url.scheme, '127.0.0.1' + (':' + str(url.port) if url.port else ''), '', '', ''))
    return value.rstrip('/')


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise error.HTTPError(req.full_url, code, 'redirect refused', headers, fp)


def fetch_json(url, token, timeout):
    parts = parse.urlsplit(url)
    local_base(parse.urlunsplit((parts.scheme, parts.netloc, '', '', '')))
    if parts.path != '/api/opportunities':
        raise ValueError('Request path is not allowed')
    opener = request.build_opener(request.ProxyHandler({}), NoRedirect())
    req = request.Request(url, headers={'x-arb-token': token, 'Accept': 'application/json'}, method='GET')
    with opener.open(req, timeout=timeout) as reply:
        raw = reply.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise ValueError('Response exceeds size limit')
        return json.loads(raw)


def normalize_pair(pair):
    # v1.7.5 separates perpetual legs from Boros markets and their IM values.
    # Preserve this report's two-market model; spread plans need their own model.
    if 'borosLegs' not in pair:
        return pair, []
    boros = pair['borosLegs']
    if (not isinstance(boros, list) or len(boros) != 2 or
            any(not isinstance(leg, dict) or type(leg.get('marketId')) is not int or leg.get('side') not in ('SHORT', 'LONG') or leg.get('spreadVenues') is not None for leg in boros) or
            {leg.get('side') for leg in boros} != {'SHORT', 'LONG'} or
            len({leg['marketId'] for leg in boros}) != 2):
        return pair, ['unsupported or incomplete Boros market plan for two-market screening']
    result = dict(pair)
    selected = {leg['side']: leg for leg in boros}
    for side in ('short', 'long'):
        perp = pair.get(side + 'Leg')
        market = selected[side.upper()]
        if not isinstance(perp, dict) or label(perp.get('venue')) != label(market.get('venue')):
            return pair, ['Boros and perpetual venue mismatch']
        result[side + 'Leg'] = dict(perp, marketId=market['marketId'], execApr=market.get('execApr'))
    capital = pair.get('capital')
    ims = capital.get('borosIms') if isinstance(capital, dict) else None
    if (not isinstance(ims, list) or len(ims) != 2 or
            any(not isinstance(item, dict) or type(item.get('marketId')) is not int for item in ims) or
            {item['marketId'] for item in ims} != {leg['marketId'] for leg in boros}):
        return result, ['missing or mismatched Boros capital evidence']
    by_market = {item['marketId']: item.get('imUsd') for item in ims}
    result['capital'] = dict(capital, borosShortImUsd=by_market[selected['SHORT']['marketId']],
                             borosLongImUsd=by_market[selected['LONG']['marketId']])
    return result, []


def identity(group, pair):
    short = pair.get('shortLeg') if isinstance(pair.get('shortLeg'), dict) else {}
    long = pair.get('longLeg') if isinstance(pair.get('longLeg'), dict) else {}
    raw = (group.get('underlying'), group.get('collateral'), group.get('tokenId'), group.get('maturity'), short.get('marketId'), long.get('marketId'), short.get('crossexVenue'), short.get('crossexSymbol'), long.get('crossexVenue'), long.get('crossexSymbol'))
    return tuple(v if type(v) in (str, int, float) else None for v in raw)


def pair_context(group, pair):
    context = {k: label(group.get(k)) for k in ('underlying', 'collateral')}
    context['maturity'] = group.get('maturity') if number(group.get('maturity')) else None
    for side in ('short', 'long'):
        leg = pair.get(side + 'Leg')
        leg = leg if isinstance(leg, dict) else {}
        context[side + 'Leg'] = {k: label(leg.get(k)) for k in ('venue', 'crossexVenue', 'crossexSymbol')}
        context[side + 'Leg']['marketId'] = leg.get('marketId') if type(leg.get('marketId')) is int and number(leg['marketId']) else None
    return context


def warning_evidence(data):
    warnings = data.get('warnings', [])
    if not isinstance(warnings, list) or any(not isinstance(w, str) for w in warnings):
        return None
    evidence = data.get('warningEvidence', [])
    if not isinstance(evidence, list) or len(evidence) != len(warnings) or any(not isinstance(item, dict) for item in evidence):
        return None
    return evidence


def group_warning_issues(group, pair):
    evidence = warning_evidence(group)
    if evidence is None:
        return ['group warning: missing or invalid machine evidence']
    selected = {leg.get('marketId') for side in ('short', 'long') if isinstance(leg := pair.get(side + 'Leg'), dict) and type(leg.get('marketId')) is int}
    issues = []
    for item in evidence:
        code, market_id = item.get('code'), item.get('marketId')
        market = next((m for m in group['markets'] if isinstance(m, dict) and type(m.get('marketId')) is int and m['marketId'] == market_id), None)
        scoped = (type(market_id) is int and market is not None and
                  ((code == 'unsupported-perp-venue' and not market.get('crossexVenue')) or
                   (code == 'missing-perp-symbol' and market.get('crossexVenue') and not market.get('crossexSymbol'))))
        if not scoped:
            issues.append('group warning: evidence requires review')
        elif market_id in selected:
            issues.append('selected market lacks a confirmed CrossEx perpetual contract')
    return issues


def source_issue_details(pair, failures):
    # Use structured diagnostics, never upstream reason templates.
    details = []
    missing_books = {item['symbol'] for item in failures}
    for side in ('short', 'long'):
        leg = pair.get(side + 'Leg')
        if not isinstance(leg, dict):
            continue
        if label(leg.get('crossexSymbol')) in missing_books:
            details.append(side + ': perpetual order book unavailable')
    return details


def freshness_evidence(envelope, args, now):
    data = envelope.get('data') if isinstance(envelope, dict) else None
    settings = data.get('meta') if isinstance(data, dict) else None
    freshness = settings.get('freshness') if isinstance(settings, dict) else None
    result = {}
    for category, title, limit in (('marketData', 'market data', args.max_age), ('staticData', 'static data', args.max_static_age)):
        item = freshness.get(category) if isinstance(freshness, dict) else None
        observed = item.get('observedAt') if isinstance(item, dict) else None
        age = now - observed / 1000 if number(observed) else None
        reasons = []
        if age is None:
            reasons.append(title + ' observation missing')
        elif age < 0:
            reasons.append(title + ' observation is in the future')
        elif age > limit:
            reasons.append(f'{title} observation too old ({age:.1f}s > {limit:g}s)')
        if not isinstance(item, dict) or item.get('stale') is not False:
            reasons.append(title + ' stale or missing stale evidence')
        result[category] = dict(observedAtMs=observed if number(observed) else None, ageSeconds=age, maxAgeSeconds=limit, status='UNKNOWN' if reasons else 'VALID', reasons=reasons)
    return result


def normalize(envelope, mode, args, now):
    reasons, rows, excluded = [], [], []
    if not isinstance(envelope, dict) or envelope.get('ok') is not True or not isinstance(envelope.get('data'), dict):
        return [], [], ['invalid API envelope'], None, None
    data = envelope['data']
    meta = envelope.get('meta', {})
    settings = data.get('meta', {})
    if not isinstance(meta, dict) or not isinstance(settings, dict):
        return [], [], ['invalid metadata'], None, None
    observed = meta.get('observedAt')
    evidence = freshness_evidence(envelope, args, now)
    for item in evidence.values():
        reasons.extend(item['reasons'])
    category_times = [item['observedAtMs'] for item in evidence.values()]
    if not number(observed) or observed > now * 1000:
        reasons.append('aggregate observation missing or future')
    elif all(number(value) for value in category_times) and observed != min(category_times):
        reasons.append('aggregate observation differs from classified input times')
    if meta.get('stale', False) is not False or data.get('stale', False) is not False or meta.get('coverageComplete', True) is not True:
        reasons.append('stale or incomplete API evidence')
    built = settings.get('asOfSec')
    if not number(built) or built > now or now - built > args.max_age or (number(observed) and built * 1000 + 1000 < observed):
        reasons.append('build time missing, future or inconsistent')
    if not number(settings.get('notionalUsd')) or settings.get('notionalUsd') != args.notional or settings.get('entryMode') != 'maker-hedge' or settings.get('borosEntry') != 'market' or settings.get('exitMode') != mode:
        reasons.append('request assumptions mismatch')
    warnings = warning_evidence(data)
    if warnings is None:
        reasons.append('API warning: missing or invalid machine evidence')
    elif warnings:
        reasons.append('assumed fee schedule: reference only' if any(w.get('code') == 'assumed-fee-schedule' for w in warnings) else 'API warning: source or fee evidence requires review')
    failures = book_failures(envelope)
    groups = data.get('groups')
    if not isinstance(groups, list):
        return [], [], reasons + ['groups missing'], evidence['marketData']['observedAtMs'], meta.get('credentialId')
    seen = set()
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get('pairs'), list) or not isinstance(group.get('markets'), list):
            reasons.append('invalid group evidence')
            continue
        for pair in group['pairs']:
            issues = list(reasons)
            if not isinstance(pair, dict):
                excluded.append(dict(status='UNKNOWN', reasons=['invalid pair evidence'], **pair_context(group, {})))
                continue
            pair, contract_issues = normalize_pair(pair)
            issues.extend(contract_issues)
            key = identity(group, pair)
            if not label(group.get('underlying')) or not label(group.get('collateral')) or type(group.get('tokenId')) is not int or not number(group.get('maturity')):
                issues.append('invalid group identity')
            if key in seen:
                issues.append('duplicate combination identity')
            seen.add(key)
            legs = []
            for side in ('short', 'long'):
                leg = pair.get(side + 'Leg')
                if not isinstance(leg, dict):
                    issues.append('missing leg')
                    continue
                market = next((m for m in group['markets'] if isinstance(m, dict) and m.get('marketId') == leg.get('marketId')), {})
                if type(leg.get('marketId')) is not int or not all(label(leg.get(k)) for k in ('venue', 'crossexVenue', 'crossexSymbol', 'base')):
                    issues.append('missing confirmed perpetual contract')
                if market.get('bookStatus') != 'ok':
                    issues.append('Boros target-size book unavailable or insufficient')
                if any(market.get(k) != leg.get(k) for k in ('crossexVenue', 'crossexSymbol')):
                    issues.append('market and perpetual contract mismatch')
                if not number(leg.get('execApr')) or not number(market.get('exec' + side.title() + 'Apr')) or leg.get('execApr') != market.get('exec' + side.title() + 'Apr'):
                    issues.append('missing or mismatched execution rate')
                legs.append({k: leg.get(k) if k == 'marketId' or k == 'execApr' else label(leg.get(k)) for k in ('marketId', 'venue', 'crossexVenue', 'crossexSymbol', 'base', 'execApr')})
            costs, capital = pair.get('costs'), pair.get('capital')
            invalid_fields = []
            invalid_fields.extend('costs.' + k for k in COSTS if not isinstance(costs, dict) or not number(costs.get(k)) or costs[k] < 0)
            invalid_fields.extend('capital.' + k for k in CAPITAL if not isinstance(capital, dict) or not number(capital.get(k)) or capital[k] < 0 or (k.endswith('Max') and capital[k] <= 0))
            invalid_fields.extend(k for k in VALUES if not number(pair.get(k)))
            if not isinstance(costs, dict) or any(not number(costs.get(k)) or costs[k] < 0 for k in COSTS):
                issues.append('missing or invalid cost ledger')
            if not isinstance(capital, dict) or any(not number(capital.get(k)) or capital[k] < 0 or (k.endswith('Max') and capital[k] <= 0) for k in CAPITAL):
                issues.append('missing or invalid model capital ledger')
            if any(not number(pair.get(k)) for k in VALUES):
                issues.append('missing or invalid return values')
            if not number(pair.get('capitalUsd')) or pair['capitalUsd'] <= 0 or not number(pair.get('secondsToMaturity')) or pair['secondsToMaturity'] <= 0:
                issues.append('nonpositive model capital or remaining term')
            if pair.get('makerLeg') not in ('short', 'long'):
                issues.append('maker entry assignment unavailable')
                invalid_fields.append('makerLeg')
            if not number(group.get('secondsToMaturity')) or group.get('secondsToMaturity') != pair.get('secondsToMaturity') or (number(group.get('maturity')) and number(built) and abs(group['maturity'] - built - pair.get('secondsToMaturity', 0)) > 1):
                issues.append('invalid maturity or remaining term evidence')
            issues.extend(group_warning_issues(group, pair))
            if issues:
                issues.extend(source_issue_details(pair, failures))
                excluded.append(dict(status='UNKNOWN', reasons=sorted(set(issues)), invalidFields=sorted(set(invalid_fields)), **pair_context(group, pair), reference=dict(values={k: pair[k] if number(pair.get(k)) else None for k in VALUES}, costs={k: costs[k] if isinstance(costs, dict) and number(costs.get(k)) else None for k in COSTS}) if 'assumed fee schedule: reference only' in issues else None))
                continue
            holding_return = pair['estProfitUsd'] / pair['capitalUsd']
            if not number(holding_return):
                excluded.append(dict(status='UNKNOWN', reasons=['holding-period return exceeds finite numeric range'], **pair_context(group, pair)))
                continue
            admission = {}
            if mode == 'close':
                gross_profit = pair['grossSpreadApr'] * args.notional * (pair['secondsToMaturity'] / (365 * 86400))
                if not number(gross_profit) or (gross_profit == 0 and pair['grossSpreadApr'] > 0):
                    excluded.append(dict(status='UNKNOWN', reasons=['gross profit exceeds finite numeric range'], **pair_context(group, pair)))
                    continue
                friction = costs['totalUsd'] / gross_profit if gross_profit > 0 else None
                if friction is not None and not number(friction):
                    excluded.append(dict(status='UNKNOWN', reasons=['friction exceeds finite numeric range'], **pair_context(group, pair)))
                    continue
                admission = dict(grossProfitUsd=gross_profit, friction=friction)
                filters = []
                if gross_profit <= 0:
                    filters.append('gross profit is not positive; friction is undefined')
                elif friction >= args.max_friction:
                    filters.append('friction is not below the configured maximum')
                if pair['estProfitUsd'] <= args.min_profit_usd:
                    filters.append('net profit is not above the configured minimum')
                if filters:
                    excluded.append(dict(status='FILTERED', reasons=filters, estProfitUsd=pair['estProfitUsd'], **admission, **pair_context(group, pair)))
                    continue
            row = dict(identity=list(key), underlying=label(group['underlying']), collateral=label(group['collateral']), maturity=group['maturity'], shortLeg=legs[0], longLeg=legs[1], makerLeg=pair['makerLeg'], costs={k: costs[k] for k in COSTS}, capital={k: capital[k] for k in CAPITAL}, **{k: pair[k] for k in VALUES})
            row.update(admission)
            row['holdingPeriodReturn'] = holding_return
            row['extraCostToZeroUsd'] = max(0, pair['estProfitUsd'])
            row['oiUsd'] = [m.get('oiUsd') if number(m.get('oiUsd')) and m['oiUsd'] >= 0 else None for m in group['markets'] if isinstance(m, dict) and m.get('marketId') in (legs[0]['marketId'], legs[1]['marketId'])]
            row['reasons'] = ['Ranked by model capital efficiency, then notional return and executable spread.', 'Absolute net profit and total API costs are shown over the remaining term.']
            rows.append(row)
    return rows, excluded, sorted(set(reasons)), evidence['marketData']['observedAtMs'], meta.get('credentialId')


def markdown(report):
    def fmt(value, percent=False):
        return 'UNKNOWN' if value is None else (f'{value * 100:.2f}%' if percent else f'{value:,.2f}')
    def taipei_time(value):
        try:
            return datetime.fromtimestamp(value, ZoneInfo('Asia/Taipei')).isoformat()
        except (TypeError, ValueError, OverflowError, OSError):
            return 'UNKNOWN'
    lines = ['# Opportunity screening', '', f"Run: {report['runId']}", f"Taipei time: {report['timeTaipei']}", f"Data status: {report['status']}", '', '## Assumptions', '', json.dumps(report['assumptions'], ensure_ascii=False), '']
    freshness_lines = ['## Freshness evidence', '']
    for mode in ('close', 'roll'):
        for category, title in (('marketData', 'Market data'), ('staticData', 'Static data')):
            item = report.get('evidence', {}).get(mode, {}).get(category)
            if item:
                freshness_lines.append(f"- {mode} {title}: {item['status']}; observed {taipei_time(item['observedAtMs'] / 1000 if item['observedAtMs'] is not None else None)}; age {fmt(item['ageSeconds'])} seconds; limit {fmt(item['maxAgeSeconds'])} seconds" + ('; ' + ', '.join(item['reasons']) if item['reasons'] else ''))
    if len(freshness_lines) > 2:
        lines += freshness_lines + ['']
    if 'maxFriction' in report['assumptions']:
        lines += ['## Close admission thresholds', '', f"Friction < {fmt(report['assumptions']['maxFriction'], True)}; minimum net profit ${fmt(report['assumptions']['minProfitUsd'])} (must be strictly exceeded; {fmt(report['assumptions']['minProfitRatio'], True)} of per-leg notional).", '']
    lines += ['## Top candidates', '']
    if not report['candidates']:
        lines.append('No qualifying candidates. Top list is not padded.')
    for i, row in enumerate(report['candidates'], 1):
        lines += [f"### {i}. {row['underlying']} / {row['collateral']} / markets {row['shortLeg']['marketId']} → {row['longLeg']['marketId']}", '', f"Maturity: {datetime.fromtimestamp(row['maturity'], ZoneInfo('Asia/Taipei')).isoformat()}; remaining days: {row['secondsToMaturity'] / 86400:.2f}", f"Capital net APR: {fmt(row['netFixedAprOnCapital'], True)}; notional net APR: {fmt(row['netFixedApr'], True)}; execution spread: {fmt(row['execSpreadApr'], True)}", f"Net profit: ${fmt(row['estProfitUsd'])}; total costs: ${fmt(row['costs']['totalUsd'])}; model capital: ${fmt(row['capitalUsd'])}; holding return: {fmt(row['holdingPeriodReturn'], True)}", f"Extra cost to erase net profit: ${fmt(row['extraCostToZeroUsd'])}", f"Maker leg: {row['makerLeg']}; short {row['shortLeg']['crossexSymbol']}; long {row['longLeg']['crossexSymbol']}", 'Costs: ' + '; '.join(f"{k}: {fmt(v, k == 'annualizedApr')}" for k, v in row['costs'].items()), 'Capital model: ' + '; '.join(f'{k}: {fmt(v)}' for k, v in row['capital'].items()), 'OI USD (reference): ' + ', '.join(fmt(v) for v in row['oiUsd']), *row['reasons']]
        if 'friction' in row:
            lines.append(f"Friction: {fmt(row['friction'], True)}; gross profit ${fmt(row['grossProfitUsd'])} (mid-rate spread before Boros impact and model costs).")
        roll = row['roll']
        lines.append('Roll comparison: ' + ('UNKNOWN (' + ', '.join(roll['reasons']) + ')' if roll['status'] == 'UNKNOWN' else f"net profit ${fmt(roll['estProfitUsd'])}; capital APR {fmt(roll['netFixedAprOnCapital'], True)}; total costs ${fmt(roll['costs']['totalUsd'])}"))
        if roll['status'] == 'VALID':
            lines.append('Roll costs: ' + '; '.join(f"{k}: {fmt(v, k == 'annualizedApr')}" for k, v in roll['costs'].items()))
        lines.append('')
    if report.get('comparisonIssues'):
        lines += ['## Roll comparison issues', '', 'These issues affect the overall data status, including candidates outside the Top list.', '']
        for item in report['comparisonIssues']:
            short, long = item['shortLeg'], item['longLeg']
            context = f"{item['underlying']} / {item['collateral']} / maturity {taipei_time(item['maturity'])} / markets {short['marketId']} → {long['marketId']} / short {short['crossexSymbol']} / long {long['crossexSymbol']}"
            lines.append(f"- [roll; rank {item['rank']}; {'in Top list' if item['inTop'] else 'outside Top list'}] {context} — UNKNOWN: {', '.join(item['reasons'])}")
        lines.append('')
    lines += ['## Exclusions and evidence', '']
    exclusions = {}
    for item in report['excluded']:
        content = {k: v for k, v in item.items() if k != 'comparison'}
        key = json.dumps(content, sort_keys=True)
        exclusions.setdefault(key, (content, []))[1].append(item.get('comparison', 'close'))
    for item, modes in exclusions.values():
        short, long = item.get('shortLeg', {}), item.get('longLeg', {})
        context = f"{item.get('underlying') or 'UNKNOWN'} / {item.get('collateral') or 'UNKNOWN'} / maturity {taipei_time(item.get('maturity'))} / markets {short.get('marketId')} → {long.get('marketId')} / short {short.get('crossexSymbol') or 'UNKNOWN'} / long {long.get('crossexSymbol') or 'UNKNOWN'}"
        lines.append(f"- [{', '.join(modes)}] {context} — {item['status']}: {', '.join(item['reasons'])}")
        if 'friction' in item:
            lines.append(f"  Friction: {fmt(item['friction'], True)}; gross profit ${fmt(item['grossProfitUsd'])}; net profit ${fmt(item['estProfitUsd'])}")
        if item.get('invalidFields'):
            lines.append('  Missing or invalid fields: ' + ', '.join(item['invalidFields']))
        if item.get('reference'):
            for section, values in item['reference'].items():
                lines.append('  Reference only ' + section + ': ' + '; '.join(f"{k}: {fmt(v, 'Apr' in k or k == 'annualizedApr')}" for k, v in values.items()))
    lines.extend('- UNKNOWN: ' + reason for reason in report['dataReasons'])
    diagnostics = []
    for mode in ('close', 'roll'):
        for item in report.get('evidence', {}).get(mode, {}).get('venueBookFailures', []):
            status = item['httpStatus'] if item['httpStatus'] is not None else 'unavailable (no HTTP status recorded)'
            diagnostics.append(f"- [{mode}] {item['symbol']}: category={item['category']}; stage={item['stage']}; HTTP={status}; errorCode={item['errorCode'] or 'unavailable'}; elapsed={fmt(item['elapsedMs'])} ms; observed={taipei_time(item['observedAtMs'] / 1000 if item['observedAtMs'] is not None else None)}; stale={item['stale']}")
    if diagnostics:
        lines += ['', '## Perpetual book failure diagnostics', '', 'Elapsed time covers the complete collection attempt, including metadata and connection waits.', ''] + diagnostics
    lines += ['', '## Limits', ''] + ['- ' + item for item in LIMITATIONS]
    return '\n'.join(lines) + '\n'


def redact(value, secrets):
    if isinstance(value, str):
        for secret in secrets:
            if isinstance(secret, str) and secret:
                value = value.replace(secret, '[redacted]')
        return value
    if isinstance(value, list):
        return [redact(item, secrets) for item in value]
    if isinstance(value, dict):
        return {key: redact(item, secrets) for key, item in value.items()}
    return value


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError('Invalid command arguments')


def run(argv=None, *, fetch=fetch_json, now=time.time):
    parser = SafeArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:6688')
    parser.add_argument('--token-file', default='api-token')
    parser.add_argument('--notional', type=float, default=10000)
    parser.add_argument('--top', type=int, default=10)
    parser.add_argument('--output-dir', default='data/opportunity-screening')
    parser.add_argument('--max-age', '--max-market-age', dest='max_age', type=float, default=180)
    parser.add_argument('--max-static-age', type=float, default=600)
    parser.add_argument('--max-skew', type=float, default=120)
    parser.add_argument('--timeout', type=float, default=20)
    parser.add_argument('--max-friction', type=float, default=.4, help='Close admission requires total cost / gross profit below this ratio (default: 0.4).')
    parser.add_argument('--min-profit-ratio', type=float, default=.001, help='Close net profit must exceed per-leg notional times this ratio (default: 0.001 = 0.1%%).')
    try:
        args = parser.parse_args(argv)
        base = local_base(args.url)
        if args.top <= 0 or any(not number(v) or v <= 0 for v in (args.notional, args.max_age, args.max_static_age, args.max_skew, args.timeout)):
            raise ValueError('Numeric options must be positive and finite')
        if not number(args.max_friction) or args.max_friction <= 0 or not number(args.min_profit_ratio) or args.min_profit_ratio < 0:
            raise ValueError('Invalid admission thresholds')
        args.min_profit_usd = args.notional * args.min_profit_ratio
        if not number(args.min_profit_usd) or (args.min_profit_ratio > 0 and args.min_profit_usd == 0):
            raise ValueError('Minimum profit exceeds finite numeric range')
        token = Path(args.token_file).read_text().strip()
        if not token or '\n' in token or '\r' in token:
            raise ValueError('Invalid token file')
    except (ValueError, OSError):
        print('Unable to start: invalid parameters or token file.', file=sys.stderr)
        return 1
    except SystemExit as exc:
        return 0 if exc.code == 0 else 1
    envelopes, failures = {}, []
    for mode in ('close', 'roll'):
        query = parse.urlencode(dict(notionalUsd=args.notional, entryMode='maker-hedge', borosEntry='market', exitMode=mode))
        try:
            envelopes[mode] = fetch(base + '/api/opportunities?' + query, token, args.timeout)
        except error.HTTPError as exc:
            if exc.code in (401, 403):
                print('Authentication failed.', file=sys.stderr)
                return 1
            failures.append(mode + ' request failed')
        except Exception:
            failures.append(mode + ' request failed')
    if not envelopes:
        print('Unable to collect Opportunity data.', file=sys.stderr)
        return 1
    stamp = now()
    close, excluded, issues, close_market_time, close_id = normalize(envelopes.get('close'), 'close', args, stamp)
    rolls, roll_excluded, roll_issues, roll_market_time, roll_id = normalize(envelopes.get('roll'), 'roll', args, stamp)
    compare = []
    if close_id != roll_id:
        compare.append('credential scope mismatch')
    if not number(close_market_time) or not number(roll_market_time) or abs(close_market_time - roll_market_time) > args.max_skew * 1000:
        compare.append('observation skew or missing comparison')
    roll_map = {tuple(row['identity']): row for row in rolls}
    for row in close:
        match = roll_map.get(tuple(row['identity']))
        why = compare + roll_issues + ([] if match else ['matching roll comparison unavailable'])
        if match and match['makerLeg'] != row['makerLeg']:
            why.append('maker leg mismatch')
        row['roll'] = dict(status='UNKNOWN', reasons=sorted(set(why))) if why else dict(match, status='VALID')
    close.sort(key=lambda row: (-row['netFixedAprOnCapital'], -row['netFixedApr'], -row['execSpreadApr'], tuple(row['identity'])))
    comparison_issues = [dict(status='UNKNOWN', comparison='roll', rank=rank, inTop=rank <= args.top, reasons=row['roll']['reasons'], **pair_context(row, row)) for rank, row in enumerate(close, 1) if row['roll']['status'] == 'UNKNOWN']
    data_issues = failures + issues + roll_issues + compare
    unknown = bool(data_issues or any(x['status'] == 'UNKNOWN' for x in excluded + roll_excluded) or comparison_issues)
    report = dict(runId=datetime.fromtimestamp(stamp, ZoneInfo('Asia/Taipei')).strftime('%Y%m%dT%H%M%S') + '-' + uuid4().hex[:12], timeTaipei=datetime.fromtimestamp(stamp, ZoneInfo('Asia/Taipei')).isoformat(), status='UNKNOWN' if unknown else 'VALID', assumptions=dict(notionalUsd=args.notional, top=args.top, entryMode='maker-hedge', borosEntry='market', primaryExitMode='close', maxAgeSeconds=args.max_age, maxSkewSeconds=args.max_skew, clientRebatesAdded=False, feeEvidence='UNKNOWN' if issues or roll_issues else 'API without assumption warning'), evidence=dict(closeMarketObservedAtMs=close_market_time if number(close_market_time) else None, rollMarketObservedAtMs=roll_market_time if number(roll_market_time) else None), candidates=close[:args.top], excluded=excluded + [dict(item, comparison='roll') for item in roll_excluded], dataReasons=sorted(set(data_issues)), limitations=LIMITATIONS)
    report['comparisonIssues'] = comparison_issues
    report['assumptions'].update(maxMarketAgeSeconds=args.max_age, maxStaticAgeSeconds=args.max_static_age, skewBasis='marketData')
    report['assumptions'].update(maxFriction=args.max_friction, minProfitRatio=args.min_profit_ratio, minProfitUsd=args.min_profit_usd)
    report['evidence'].update(close=freshness_evidence(envelopes.get('close'), args, stamp), roll=freshness_evidence(envelopes.get('roll'), args, stamp))
    for mode in ('close', 'roll'):
        report['evidence'][mode]['venueBookFailures'] = book_failures(envelopes.get(mode))
    for mode in ('close', 'roll'):
        envelope = envelopes.get(mode)
        meta = envelope.get('meta') if isinstance(envelope, dict) else None
        aggregate = meta.get('observedAt') if isinstance(meta, dict) else None
        report['evidence'][mode + 'ObservedAtMs'] = aggregate if number(aggregate) else None
    report = redact(report, [token, close_id, roll_id])
    try:
        directory = Path(args.output_dir) / report['runId']
        directory.mkdir(parents=True, mode=0o700)
        for name, content in [('report.json', json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n'), ('report.md', markdown(report))]:
            with open(directory / name, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
                output.write(content)
    except (OSError, ValueError, OverflowError):
        print('Report write failed; dual-format output is incomplete.', file=sys.stderr)
        return 1
    print(f"{report['status']}: {len(report['candidates'])} candidates; reports: {directory}")
    return 2 if unknown else 0


if __name__ == '__main__':
    sys.exit(run())
