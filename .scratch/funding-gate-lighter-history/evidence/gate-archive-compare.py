"""Gate funding_applies monthly archive vs REST /futures/usdt/funding_rate, row by row (BTC/ETH)."""
import gzip, hashlib, json, sys, time, urllib.request
from decimal import Decimal
OUT = sys.argv[1]
get = lambda u: urllib.request.urlopen(u, timeout=20).read()
months = ['2025%02d' % m for m in range(9, 13)] + ['2026%02d' % m for m in range(1, 11)]
report = {'readAt': int(time.time()), 'contracts': {}}
skew, rawt = {'BTC_USDT': {}, 'ETH_USDT': {}}, {'BTC_USDT': {}, 'ETH_USDT': {}}
for c in ['BTC_USDT', 'ETH_USDT']:
    files, archive = [], {}
    for m in months:
        u = f'https://download.gatedata.org/futures_usdt/funding_applies/{m}/{c}-{m}.csv.gz'
        raw = get(u); text = gzip.decompress(raw).decode()
        lines = [l for l in text.splitlines() if l]
        for l in lines:
            t, r = l.split(','); raw_t = int(t)
            assert raw_t % 3600 < 60, (u, l)
            t = raw_t - raw_t % 3600
            assert t not in archive, ('dup', u, l)
            archive[t] = r; skew[c][raw_t % 3600] = skew[c].get(raw_t % 3600, 0) + 1; rawt[c][t] = raw_t
        files.append({'url': u, 'sha256': hashlib.sha256(raw).hexdigest(), 'rows': len(lines), 'first': min(int(l.split(',')[0]) for l in lines) // 3600 * 3600, 'last': max(int(l.split(',')[0]) for l in lines) // 3600 * 3600})
        time.sleep(0.2)
    # REST, paged back by `to` only (no `from`), from now to before the archive's first month.
    rest, restraw, pages, to = {}, {}, [], int(time.time())
    while to > files[0]['first']:
        u = f'https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract={c}&to={to}&limit=1000'
        raw = get(u); rows = json.loads(raw)
        pages.append({'request': 'GET ' + u, 'sha256': hashlib.sha256(raw).hexdigest(), 'rows': len(rows)})
        if not rows: break
        for x in rows:
            h = x['t'] - x['t'] % 3600
            assert x['t'] % 3600 < 60 and h not in rest, ('rest', x)
            rest[h] = x['r']; restraw[h] = x['t']
        to = min(x['t'] for x in rows)
        time.sleep(0.3)
    lo, hi = files[0]['first'], files[-1]['last']
    both = sorted(t for t in archive if t in rest)
    report['contracts'][c] = {
        'files': files, 'restPages': pages, 'archiveRows': len(archive), 'restRowsInArchiveSpan': sum(lo <= t <= hi for t in rest),
        'matched': len(both), 'textEqual': sum(archive[t] == rest[t] for t in both),
        'valueMismatch': [[t, archive[t], rest[t]] for t in both if Decimal(archive[t]) != Decimal(rest[t])],
        'textOnlyDiff': [[t, archive[t], rest[t]] for t in both if archive[t] != rest[t] and Decimal(archive[t]) == Decimal(rest[t])][:10],
        'archiveOnly': sorted(t for t in archive if t not in rest), 'restOnly': sorted(t for t in rest if lo <= t <= hi and t not in archive),
        'skew': skew[c], 'rawTimeDiffers': sum(rawt[c][t] != restraw[t] for t in both),
        'gaps': sorted({b - a for a, b in zip(sorted(archive), sorted(archive)[1:])}),
    }
json.dump(report, open(OUT, 'w'), indent=1)
for c, r in report['contracts'].items():
    print(c, {k: (len(v) if isinstance(v, list) else v) for k, v in r.items() if k not in ('files', 'restPages')}, 'gaps', r['gaps'], 'restPages', len(r['restPages']))
