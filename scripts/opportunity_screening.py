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
    return type(value) in (int, float) and math.isfinite(value)


def label(value):
    # Report identifiers are bounded domain labels, never upstream prose/credentials.
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.:+-]{1,48}', value) else None


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


def identity(group, pair):
    short = pair.get('shortLeg') if isinstance(pair.get('shortLeg'), dict) else {}
    long = pair.get('longLeg') if isinstance(pair.get('longLeg'), dict) else {}
    raw = (group.get('underlying'), group.get('collateral'), group.get('tokenId'), group.get('maturity'), short.get('marketId'), long.get('marketId'), short.get('crossexVenue'), short.get('crossexSymbol'), long.get('crossexVenue'), long.get('crossexSymbol'))
    return tuple(v if type(v) in (str, int, float) else None for v in raw)


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
    if not number(observed) or observed > now * 1000 or now * 1000 - observed > args.max_age * 1000:
        reasons.append('observation missing, future or too old')
    if meta.get('stale', False) is not False or data.get('stale', False) is not False or meta.get('coverageComplete', True) is not True:
        reasons.append('stale or incomplete API evidence')
    built = settings.get('asOfSec')
    if not number(built) or built > now or now - built > args.max_age or (number(observed) and built * 1000 + 1000 < observed):
        reasons.append('build time missing, future or inconsistent')
    if not number(settings.get('notionalUsd')) or settings.get('notionalUsd') != args.notional or settings.get('entryMode') != 'maker-hedge' or settings.get('borosEntry') != 'market' or settings.get('exitMode') != mode:
        reasons.append('request assumptions mismatch')
    warnings = data.get('warnings', [])
    if not isinstance(warnings, list) or any(not isinstance(w, str) for w in warnings):
        reasons.append('invalid warning evidence')
    elif warnings:
        reasons.append('assumed fee schedule: reference only' if any('Perp fees assume' in w for w in warnings) else 'API warning: source or fee evidence requires review')
    groups = data.get('groups')
    if not isinstance(groups, list):
        return [], [], reasons + ['groups missing'], observed, meta.get('credentialId')
    seen = set()
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get('pairs'), list) or not isinstance(group.get('markets'), list):
            reasons.append('invalid group evidence')
            continue
        for pair in group['pairs']:
            issues = list(reasons)
            if not isinstance(pair, dict):
                excluded.append(dict(status='UNKNOWN', reasons=['invalid pair evidence']))
                continue
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
            if not isinstance(costs, dict) or any(not number(costs.get(k)) or costs[k] < 0 for k in COSTS):
                issues.append('missing or invalid cost ledger')
            if not isinstance(capital, dict) or any(not number(capital.get(k)) or capital[k] < 0 or (k.endswith('Max') and capital[k] <= 0) for k in CAPITAL):
                issues.append('missing or invalid model capital ledger')
            if any(not number(pair.get(k)) for k in VALUES):
                issues.append('missing or invalid return values')
            if not number(pair.get('capitalUsd')) or pair['capitalUsd'] <= 0 or not number(pair.get('secondsToMaturity')) or pair['secondsToMaturity'] <= 0:
                issues.append('nonpositive model capital or remaining term')
            if pair.get('makerLeg') not in ('short', 'long') or not number(group.get('secondsToMaturity')) or group.get('secondsToMaturity') != pair.get('secondsToMaturity') or (number(group.get('maturity')) and number(built) and abs(group['maturity'] - built - pair.get('secondsToMaturity', 0)) > 1):
                issues.append('invalid direction or maturity evidence')
            if group.get('warnings'):
                issues.append('group warning: evidence requires review')
            if issues:
                excluded.append(dict(status='UNKNOWN', reasons=sorted(set(issues)), reference=dict(values={k: pair[k] if number(pair.get(k)) else None for k in VALUES}, costs={k: costs[k] if isinstance(costs, dict) and number(costs.get(k)) else None for k in COSTS}) if 'assumed fee schedule: reference only' in issues else None))
                continue
            row = dict(identity=list(key), underlying=label(group['underlying']), collateral=label(group['collateral']), maturity=group['maturity'], shortLeg=legs[0], longLeg=legs[1], makerLeg=pair['makerLeg'], costs={k: costs[k] for k in COSTS}, capital={k: capital[k] for k in CAPITAL}, **{k: pair[k] for k in VALUES})
            row['holdingPeriodReturn'] = pair['estProfitUsd'] / pair['capitalUsd']
            row['extraCostToZeroUsd'] = max(0, pair['estProfitUsd'])
            row['oiUsd'] = [m.get('oiUsd') if number(m.get('oiUsd')) and m['oiUsd'] >= 0 else None for m in group['markets'] if isinstance(m, dict) and m.get('marketId') in (legs[0]['marketId'], legs[1]['marketId'])]
            row['reasons'] = ['Ranked by model capital efficiency, then notional return and executable spread.', 'Absolute net profit and total API costs are shown over the remaining term.']
            if pair['estProfitUsd'] <= 0 and mode == 'close':
                excluded.append(dict(status='FILTERED', reasons=['net profit is not positive'], estProfitUsd=pair['estProfitUsd']))
            else:
                rows.append(row)
    return rows, excluded, sorted(set(reasons)), observed, meta.get('credentialId')


def markdown(report):
    def fmt(value, percent=False):
        return 'UNKNOWN' if value is None else (f'{value * 100:.2f}%' if percent else f'{value:,.2f}')
    lines = ['# Opportunity screening', '', f"Run: {report['runId']}", f"Taipei time: {report['timeTaipei']}", f"Data status: {report['status']}", '', '## Assumptions', '', json.dumps(report['assumptions'], ensure_ascii=False), '', '## Top candidates', '']
    if not report['candidates']:
        lines.append('No qualifying candidates. Top list is not padded.')
    for i, row in enumerate(report['candidates'], 1):
        lines += [f"### {i}. {row['underlying']} / {row['collateral']} / markets {row['shortLeg']['marketId']} → {row['longLeg']['marketId']}", '', f"Maturity: {datetime.fromtimestamp(row['maturity'], ZoneInfo('Asia/Taipei')).isoformat()}; remaining days: {row['secondsToMaturity'] / 86400:.2f}", f"Capital net APR: {fmt(row['netFixedAprOnCapital'], True)}; notional net APR: {fmt(row['netFixedApr'], True)}; execution spread: {fmt(row['execSpreadApr'], True)}", f"Net profit: ${fmt(row['estProfitUsd'])}; total costs: ${fmt(row['costs']['totalUsd'])}; model capital: ${fmt(row['capitalUsd'])}; holding return: {fmt(row['holdingPeriodReturn'], True)}", f"Extra cost to erase net profit: ${fmt(row['extraCostToZeroUsd'])}", f"Maker leg: {row['makerLeg']}; short {row['shortLeg']['crossexSymbol']}; long {row['longLeg']['crossexSymbol']}", 'Costs: ' + '; '.join(f"{k}: {fmt(v, k == 'annualizedApr')}" for k, v in row['costs'].items()), 'Capital model: ' + '; '.join(f'{k}: {fmt(v)}' for k, v in row['capital'].items()), 'OI USD (reference): ' + ', '.join(fmt(v) for v in row['oiUsd']), *row['reasons']]
        roll = row['roll']
        lines.append('Roll comparison: ' + ('UNKNOWN (' + ', '.join(roll['reasons']) + ')' if roll['status'] == 'UNKNOWN' else f"net profit ${fmt(roll['estProfitUsd'])}; capital APR {fmt(roll['netFixedAprOnCapital'], True)}; total costs ${fmt(roll['costs']['totalUsd'])}"))
        if roll['status'] == 'VALID':
            lines.append('Roll costs: ' + '; '.join(f"{k}: {fmt(v, k == 'annualizedApr')}" for k, v in roll['costs'].items()))
        lines.append('')
    lines += ['## Exclusions and evidence', '']
    for item in report['excluded']:
        lines.append(f"- {item['status']}: {', '.join(item['reasons'])}")
        if item.get('reference'):
            for section, values in item['reference'].items():
                lines.append('  Reference only ' + section + ': ' + '; '.join(f"{k}: {fmt(v, 'Apr' in k or k == 'annualizedApr')}" for k, v in values.items()))
    lines.extend('- UNKNOWN: ' + reason for reason in report['dataReasons'])
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
    parser.add_argument('--top', type=int, default=5)
    parser.add_argument('--output-dir', default='data/opportunity-screening')
    parser.add_argument('--max-age', type=float, default=180)
    parser.add_argument('--max-skew', type=float, default=120)
    parser.add_argument('--timeout', type=float, default=20)
    try:
        args = parser.parse_args(argv)
        base = local_base(args.url)
        if args.top <= 0 or any(not number(v) or v <= 0 for v in (args.notional, args.max_age, args.max_skew, args.timeout)):
            raise ValueError('Numeric options must be positive and finite')
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
    close, excluded, issues, close_time, close_id = normalize(envelopes.get('close'), 'close', args, stamp)
    rolls, roll_excluded, roll_issues, roll_time, roll_id = normalize(envelopes.get('roll'), 'roll', args, stamp)
    compare = []
    if close_id != roll_id:
        compare.append('credential scope mismatch')
    if not number(close_time) or not number(roll_time) or abs(close_time - roll_time) > args.max_skew * 1000:
        compare.append('observation skew or missing comparison')
    roll_map = {tuple(row['identity']): row for row in rolls}
    for row in close:
        match = roll_map.get(tuple(row['identity']))
        why = compare + roll_issues + ([] if match else ['matching roll comparison unavailable'])
        row['roll'] = dict(status='UNKNOWN', reasons=sorted(set(why))) if why else dict(match, status='VALID')
    close.sort(key=lambda row: (-row['netFixedAprOnCapital'], -row['netFixedApr'], -row['execSpreadApr'], tuple(row['identity'])))
    data_issues = failures + issues + roll_issues + compare
    unknown = bool(data_issues or any(x['status'] == 'UNKNOWN' for x in excluded + roll_excluded) or any(x['roll']['status'] == 'UNKNOWN' for x in close))
    report = dict(runId=datetime.fromtimestamp(stamp, ZoneInfo('Asia/Taipei')).strftime('%Y%m%dT%H%M%S') + '-' + uuid4().hex[:12], timeTaipei=datetime.fromtimestamp(stamp, ZoneInfo('Asia/Taipei')).isoformat(), status='UNKNOWN' if unknown else 'VALID', assumptions=dict(notionalUsd=args.notional, top=args.top, entryMode='maker-hedge', borosEntry='market', primaryExitMode='close', maxAgeSeconds=args.max_age, maxSkewSeconds=args.max_skew, clientRebatesAdded=False, feeEvidence='UNKNOWN' if issues or roll_issues else 'API without assumption warning'), evidence=dict(closeObservedAtMs=close_time if number(close_time) else None, rollObservedAtMs=roll_time if number(roll_time) else None), candidates=close[:args.top], excluded=excluded + [dict(item, comparison='roll') for item in roll_excluded], dataReasons=sorted(set(data_issues)), limitations=LIMITATIONS)
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
