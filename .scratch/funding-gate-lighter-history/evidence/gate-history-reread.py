import json, sys, time, urllib.request, hashlib
old = json.load(open(sys.argv[1]))
fresh = {}
start = max(old['readAt'], int(time.time())) - 180*86400 + 60  # inside Gate's 180-day limit now
for c in ['BTC_USDT', 'ETH_USDT']:
    url = f"https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract={c}&from={start}&to={old['readAt']}&limit=1000"
    body = urllib.request.urlopen(url).read()
    rows = json.loads(body)
    a = {r['t']: r['r'] for r in old['data'][c]['rows'] if r['t'] >= start}
    b = {r['t']: r['r'] for r in rows}
    fresh[c] = {'request': 'GET ' + url, 'sha256': hashlib.sha256(body).hexdigest(), 'rows': len(rows),
                'same': a == b, 'changed': sorted(t for t in a if b.get(t) != a[t]), 'missing': sorted(set(a) - set(b)), 'added': sorted(set(b) - set(a))}
json.dump({'readAt': int(time.time()), 'comparedTo': old['readAt'], 'contracts': fresh}, open(sys.argv[2], 'w'), indent=1)
print(json.dumps({c: {k: v for k, v in x.items() if k != 'request'} for c, x in fresh.items()}))
