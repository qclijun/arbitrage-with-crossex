"""Pages the LLP public pool's position fundings and checks them against /fundings, hour by hour."""
import json, sys, time, urllib.request, hashlib
from decimal import Decimal as D
L = 'https://mainnet.zklighter.elliot.ai/api/v1'; A = 281474976710654
end = int(sys.argv[1]); start = end - 30 * 86400; out = sys.argv[2]
get = lambda u: urllib.request.urlopen(u, timeout=15).read()
pages, recs, cursor = [], [], None
while True:
    url = f'{L}/positionFunding?account_index={A}&limit=100&market_ids=0,1&start_timestamp={start}&end_timestamp={end}' + (f'&cursor={cursor}' if cursor else '')
    body = get(url); d = json.loads(body); pages.append({'request': 'GET ' + url, 'sha256': hashlib.sha256(body).hexdigest(), 'count': len(d['position_fundings'])})
    recs += d['position_fundings']; cursor = d.get('next_cursor')
    if not cursor or not d['position_fundings']: break
    time.sleep(1)
hist = {}
for m in (0, 1):
    url = f'{L}/fundings?market_id={m}&resolution=1h&start_timestamp={start}&end_timestamp={end}&count_back=0'
    body = get(url); pages.append({'request': 'GET ' + url, 'sha256': hashlib.sha256(body).hexdigest()})
    for f in json.loads(body)['fundings']: hist[(m, f['timestamp'])] = f
checks = {'matched': 0, 'rate_mismatch': [], 'change_mismatch': [], 'no_history': [], 'by_direction': {'long': 0, 'short': 0}, 'zero': 0}
for r in recs:
    f = hist.get((r['market_id'], r['timestamp']))
    if not f: checks['no_history'].append(r); continue
    signed = D(f['rate']) / 100 * (1 if f['direction'] == 'long' else -1)  # + = longs pay
    side = 1 if r['position_side'] == 'long' else -1
    if D(r['rate']) != signed: checks['rate_mismatch'].append([r, f])  # the ledger rate is signed
    expected = -side * D(r['position_size']) * D(f['value']) * (1 if f['direction'] == 'long' else -1)
    if abs(expected - D(r['change'])) > D('0.000001') * max(1, abs(expected)) + D('0.000002'): checks['change_mismatch'].append([r, f, str(expected)])
    checks['matched'] += 1; checks['by_direction'][f['direction']] += 1; checks['zero'] += D(f['rate']) == 0
json.dump({'end': end, 'pages': pages, 'records': len(recs), 'checks': checks, 'samples': recs[:4]}, open(out, 'w'), indent=1)
print(json.dumps({k: (v if not isinstance(v, list) else len(v)) for k, v in checks.items()}), 'records', len(recs), 'pages', len(pages))
for k in ('rate_mismatch', 'change_mismatch', 'no_history'):
    for x in checks[k][:3]: print(k, x)
