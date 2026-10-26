#!/usr/bin/env python3
"""One-shot, read-only screen of perp-vs-perp funding spreads (layers 1-3).

Candidates and fees come from the terminal API; settlement history, books and
volume/OI come from each venue's public API. Places nothing. Layers 4-5 (tail
risk, account fit) are not modelled: a PASS here is a candidate, not an order.
Exit 0 on complete evidence, 2 when the terminal's evidence is stale or
incomplete (a failed funding feed, an assumed fee tier), 1 when it cannot run.
"""
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from urllib import error, request
from uuid import uuid4
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import funding_rules as fr  # noqa: E402
import funding_venues as venues  # noqa: E402
from opportunity_screening import NoRedirect, SafeArgumentParser, local_base  # noqa: E402

PATHS = ('/api/funding-spreads', '/api/fees')
MAX_BYTES = 32 * 1024 * 1024
VIP0_TAKER = '0.0005'  # BASE_LADDER[0] in src/core/estimate/crossexFeeTiers.ts, as the route's fallback
VENUE_ERRORS = (OSError, ValueError, KeyError, IndexError, TypeError)  # bad reply shapes too; not NameError etc.
TAIPEI = ZoneInfo('Asia/Taipei')


def fetch_terminal(base, path, token, timeout):
    """The terminal envelope {ok, data, meta} of an allowed GET path on a loopback origin."""
    if path not in PATHS:
        raise ValueError('Request path is not allowed')
    origin = local_base(base)
    opener = request.build_opener(request.ProxyHandler({}), NoRedirect())
    req = request.Request(origin + path, headers={'x-arb-token': token, 'Accept': 'application/json'}, method='GET')
    with opener.open(req, timeout=timeout) as reply:
        raw = reply.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('Response exceeds size limit')
    envelope = json.loads(raw)
    if not isinstance(envelope, dict) or not envelope.get('ok'):
        raise ValueError('terminal returned an error')
    return envelope


def taker_rate(fee_rows, symbol):
    """Taker rate for a CrossEx symbol; per-symbol overrides win, as in fees.ts."""
    venue = symbol.split('_')[0]
    row = next((r for r in fee_rows if str(r.get('exchangeType', '')).upper() == venue), None)
    if row is None:
        return None
    special = next((s for s in row.get('specialFeeList') or [] if s.get('symbol', '').upper() == symbol.upper()), None)
    try:
        return float(special['takerFeeRate'] if special else row['futureTakerFee'])
    except (KeyError, TypeError, ValueError):
        return None


def leg_key(quote):
    """(venue, CrossEx base) of a funding quote: the unit every venue read is keyed by."""
    return quote['venue'], '_'.join(quote['symbol'].split('_')[2:-1])


def run_by_venue(jobs, work, progress=None):
    """Run `work(job)` for jobs keyed (venue, ...): one thread per venue, so each venue's pace holds.
    Returns ({job: result or None}, {job: error class}) — a failed read is UNKNOWN downstream."""
    by_venue = {}
    for job in jobs:
        by_venue.setdefault(job[0], []).append(job)
    results, errors, done = {}, {}, [0]

    def lane(items):
        for job in items:
            try:
                results[job] = work(job)
            except VENUE_ERRORS as exc:
                results[job], errors[job] = None, type(exc).__name__
            done[0] += 1
            if progress and done[0] % 100 == 0:
                progress(f'{done[0]}/{len(jobs)} venue reads')
    with ThreadPoolExecutor(max(1, len(by_venue))) as pool:
        list(pool.map(lane, by_venue.values()))
    return results, errors


def stage(pair):
    """How far a pair got: the run of PASS from layer 1 on (1-3), 0 if layer 1 did not pass."""
    n = 0
    for layer in ('layer1', 'layer2', 'layer3'):
        if pair.get(layer, {}).get('status') != 'PASS':
            break
        n += 1
    return n


def _layer1_pairs(legs, hist, errors, now, rules):
    pairs = {}
    for coin, quotes in legs.items():
        for short in quotes:
            for long in quotes:
                if short is long:
                    continue
                short_hist, long_hist = hist.get(leg_key(short)), hist.get(leg_key(long))
                if short_hist is None or long_hist is None:
                    why = ', '.join(sorted({errors.get(leg_key(q), 'no data') for q in (short, long) if hist.get(leg_key(q)) is None}))
                    res = dict(status='UNKNOWN', reasons=[f'history read failed ({why})'], metrics={})
                else:
                    res = fr.layer1(short_hist, long_hist, short['apr'] - long['apr'], now, rules)
                pairs.setdefault(coin, []).append(dict(short=short, long=long, layer1=res))
    return pairs


def screen(rows, fee_rows, http, now, notional, min_snapshot_apr, coins=None, progress=None, rules=fr.RULES):
    """Every coin's best fully passing pair, else its furthest-reaching pair, with the funnel.
    `min_snapshot_apr` gates the coin's best snapshot spread and, inside layer 1, each pair's own."""
    rules = dict(rules, min_current_apr=max(rules['min_current_apr'], min_snapshot_apr))
    picked = [r for r in rows if r['spreadApr'] >= min_snapshot_apr and not r.get('priceMismatch')
              and (not coins or r['underlying'] in coins)]
    legs = {r['underlying']: [q for q in r['venues'] if q['venue'] in venues.SUPPORTED] for r in picked}
    unquoted = {r['underlying']: list(r.get('unquotedVenues') or []) for r in picked}
    since = now - (rules['days'] + 1) * fr.DAY_MS
    hist, errors = run_by_venue({leg_key(q) for qs in legs.values() for q in qs},
                                lambda j: venues.history(http, j[0], j[1], since, now), progress)
    pairs = _layer1_pairs(legs, hist, errors, now, rules)
    passing = [p for ps in pairs.values() for p in ps if p['layer1']['status'] == 'PASS']
    books, _ = run_by_venue({leg_key(q) for p in passing for q in (p['short'], p['long'])}, lambda j: venues.book(http, j[0], j[1]))
    mids = {k: fr.book_metrics(b, notional, rules['depth_band']) if b else None for k, b in books.items()}
    market, _ = run_by_venue([k for k, m in mids.items() if m], lambda j: venues.stats(http, j[0], j[1], mids[j]['mid']))
    for p in passing:
        inputs = {side: dict(book=mids.get(leg_key(p[side])), mult=fr.underlying_of(leg_key(p[side])[1])[1], **(market.get(leg_key(p[side])) or {}))
                  for side in ('short', 'long')}
        ts, tl = taker_rate(fee_rows, p['short']['symbol']), taker_rate(fee_rows, p['long']['symbol'])
        fee = None if ts is None or tl is None else 2 * (ts + tl)
        p.update(fr.cost_and_capacity(inputs['short'], inputs['long'], fee, p['layer1']['metrics']['expectedDaily'], notional, rules))
    best = []
    for coin, ps in pairs.items():
        top = max(ps, key=lambda p: (stage(p), p.get('metrics', {}).get('netApr', float('-inf')), p['layer1']['metrics'].get('expectedDaily', float('-inf'))))
        best.append(dict(coin=coin, stage=stage(top), unquotedVenues=unquoted.get(coin, []), **top))
    best.sort(key=lambda b: (-b['stage'], -b.get('metrics', {}).get('netApr', float('-inf'))))
    funnel = dict(snapshotCandidates=len(picked), twoSupportedVenues=len(pairs),
                  layer1=sum(b['stage'] >= 1 for b in best), layer2=sum(b['stage'] >= 2 for b in best),
                  allThree=sum(b['stage'] == 3 for b in best),
                  layer1Unknown=sum(all(p['layer1']['status'] == 'UNKNOWN' for p in ps) for ps in pairs.values()),
                  withUnquotedVenues=sum(bool(b['unquotedVenues']) for b in best))
    return dict(funnel=funnel, coins=best)


def evidence_issues(envelope, fees_assumed):
    """Why the terminal's evidence is not complete; empty when it is (the sibling script's test)."""
    meta, data = envelope.get('meta') or {}, envelope.get('data') or {}
    issues = []
    if meta.get('stale', False) is not False:
        issues.append('stale terminal data')
    if meta.get('coverageComplete', True) is not True:
        down = [f.get('venue') for f in data.get('feeds') or [] if not f.get('ok')]
        issues.append('incomplete funding coverage: ' + (', '.join(map(str, down)) or 'unnamed feed'))
    if data.get('assumedFeeTier'):
        issues.append(f"spread rows priced at assumed fee tier {data['assumedFeeTier']}")
    if fees_assumed:
        issues.append('/api/fees failed: screened at VIP0 taker fees')
    return issues


def row_text(b):
    l1, m = b['layer1']['metrics'], b.get('metrics', {})
    pct = lambda v: '—' if v is None else f'{v:.1%}'  # noqa: E731
    days = lambda v: '—' if v is None else f'{v:.1f}d'  # noqa: E731
    first = next((x['reasons'][0] for x in (b['layer1'], b.get('layer2', {}), b.get('layer3', {})) if x.get('reasons')), '')
    unquoted = f" (unquoted: {', '.join(b['unquotedVenues'])})" if b.get('unquotedVenues') else ''
    return (f"| {b['coin']} | {b['short']['venue']} / {b['long']['venue']} | {pct(l1.get('realisedApr'))} | {l1.get('positiveDays', '—')} | "
            f"{pct(None if l1.get('expectedDaily') is None else l1['expectedDaily'] * 365)} | {pct(m.get('cost'))} | "
            f"{days(m.get('paybackDays'))} | {pct(m.get('netApr'))} | {b['stage']}/3 | {first}{unquoted} |")


def markdown(report, top):
    f = report['funnel']
    lines = [f"# Funding screen {report['timeTaipei']}", '', f"Leg size ${report['notionalUsd']:,.0f}; snapshot spread ≥ {report['minSnapshotApr']:.0%}; rules: `scripts/funding_rules.py`.", '']
    if report['evidenceIssues']:
        lines += ['**Evidence incomplete — results are UNKNOWN-tainted:** ' + '; '.join(report['evidenceIssues']), '']
    lines += [f"Funnel: {f['snapshotCandidates']} snapshot candidates → {f['twoSupportedVenues']} with two supported venues → layer 1 {f['layer1']} → layer 2 {f['layer2']} → all three {f['allThree']} ({f['layer1Unknown']} coins UNKNOWN at layer 1; {f['withUnquotedVenues']} with unquoted venues, whose best pair may be missing).", '',
              '| Coin | Short / Long | 14d APR | +days | E APR | Cost | Payback | Net APR | Stage | First failure |', '|---|---|---|---|---|---|---|---|---|---|']
    lines += [row_text(b) for b in report['coins'][:top]]
    lines += ['', 'Not modelled: layer 4 (tail risk) and layer 5 (account fit). A PASS is a candidate, not an order.']
    return '\n'.join(lines) + '\n'


def _arguments(argv):
    parser = SafeArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:6688')
    parser.add_argument('--token-file', default='api-token')
    parser.add_argument('--notional', type=float, default=1000, help='USD per leg (default 1000).')
    parser.add_argument('--min-snapshot-apr', type=float, default=.05, help='Skip coins, and fail pairs, whose current spread is below this (default 0.05 = the exit line, a third of the 15%% bar).')
    parser.add_argument('--coins', default='', help='Comma-separated coins to restrict the screen to.')
    parser.add_argument('--proxy', default=os.environ.get('GATE_PROXY') or os.environ.get('HTTPS_PROXY'), help='HTTP proxy for venue reads (default: $GATE_PROXY, then $HTTPS_PROXY), as the terminal reaches these venues.')
    parser.add_argument('--top', type=int, default=30)
    parser.add_argument('--output-dir', default='data/funding-screening')
    parser.add_argument('--timeout', type=float, default=15)
    args = parser.parse_args(argv)
    args.base = local_base(args.url)
    if args.notional <= 0 or args.min_snapshot_apr < 0 or args.top <= 0 or args.timeout <= 0:
        raise ValueError('Numeric options out of range')
    args.token = Path(args.token_file).read_text().strip()
    if not args.token or '\n' in args.token or '\r' in args.token:
        raise ValueError('Invalid token file')
    return args


def run(argv=None, *, fetch=fetch_terminal, http=None, now=time.time):
    try:
        args = _arguments(argv)
    except (ValueError, OSError):
        print('Unable to start: invalid parameters or token file.', file=sys.stderr)
        return 1
    except SystemExit as exc:  # --help
        return 0 if exc.code == 0 else 1
    try:
        spreads = fetch(args.base, '/api/funding-spreads', args.token, args.timeout)
    except (error.URLError, ValueError, OSError):
        print('Unable to read the terminal API.', file=sys.stderr)
        return 1
    rows = (spreads.get('data') or {}).get('rows')
    try:
        fee_rows, fees_assumed = fetch(args.base, '/api/fees', args.token, args.timeout)['data'], False
    except (error.URLError, ValueError, OSError, KeyError):
        venue_names = sorted({q['venue'] for r in rows or [] for q in r.get('venues') or []})
        fee_rows, fees_assumed = [dict(exchangeType=v, futureTakerFee=VIP0_TAKER) for v in venue_names], True
    stamp = now()
    coins = {c.strip().upper() for c in args.coins.split(',') if c.strip()}
    try:
        result = screen(rows, fee_rows, http or venues.Http(args.proxy, args.timeout), int(stamp * 1000), args.notional,
                        args.min_snapshot_apr, coins, lambda msg: print(msg, file=sys.stderr))
    except (KeyError, TypeError, AttributeError):
        print('Unable to read the terminal API: unexpected funding-spreads shape.', file=sys.stderr)
        return 1
    issues = evidence_issues(spreads, fees_assumed)
    when = datetime.fromtimestamp(stamp, TAIPEI)
    report = dict(runId=when.strftime('%Y%m%dT%H%M%S') + '-' + uuid4().hex[:12], timeTaipei=when.isoformat(timespec='seconds'),
                  status='UNKNOWN' if issues else 'VALID', evidenceIssues=issues, notionalUsd=args.notional,
                  minSnapshotApr=args.min_snapshot_apr, rules=fr.RULES, feeds=(spreads.get('data') or {}).get('feeds'), **result)
    directory = Path(args.output_dir) / report['runId']
    try:
        directory.mkdir(parents=True, mode=0o700)
        for name, content in (('report.json', json.dumps(report, indent=2, allow_nan=False) + '\n'), ('report.md', markdown(report, args.top))):
            with open(directory / name, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as out:
                out.write(content)
    except (OSError, ValueError):
        print('Report write failed.', file=sys.stderr)
        return 1
    print(markdown(report, args.top))
    print(f'Reports: {directory}')
    return 2 if issues else 0


if __name__ == '__main__':
    sys.exit(run())
