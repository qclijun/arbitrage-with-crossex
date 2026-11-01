import json, sys, time, urllib.request
SETTLE = int(sys.argv[1]); OUT = sys.argv[2]
get = lambda u: json.load(urllib.request.urlopen(u, timeout=10))
samples = []
while time.time() < SETTLE - 125: time.sleep(5)
while time.time() < SETTLE - 2:
    for c in ['BTC_USDT', 'ETH_USDT']:
        try:
            d = get(f'https://api.gateio.ws/api/v4/futures/usdt/contracts/{c}')
            samples.append({'at': time.time(), 'contract': c, 'funding_rate': d['funding_rate'], 'next': d['funding_next_apply'], 'interval': d['funding_interval']})
        except Exception as e: samples.append({'at': time.time(), 'contract': c, 'error': str(e)})
    time.sleep(8)
reads = []
for wait in (90, 600):
    while time.time() < SETTLE + wait: time.sleep(5)
    for c in ['BTC_USDT', 'ETH_USDT']:
        reads.append({'at': time.time(), 'contract': c, 'rows': get(f'https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract={c}&limit=3')})
after = {c: get(f'https://api.gateio.ws/api/v4/futures/usdt/contracts/{c}') for c in ['BTC_USDT', 'ETH_USDT']}
json.dump({'settle': SETTLE, 'samples': samples, 'reads': reads, 'contractsAfter': {c: {k: v[k] for k in ('funding_rate', 'funding_next_apply', 'funding_interval')} for c, v in after.items()}}, open(OUT, 'w'), indent=1)
for c in ['BTC_USDT', 'ETH_USDT']:
    last = [s for s in samples if s['contract'] == c and 'funding_rate' in s][-1]
    rows = [r for x in reads if x['contract'] == c for r in x['rows'] if SETTLE <= r['t'] < SETTLE + 60]
    print(c, 'last-pre', last['funding_rate'], 'at', round(SETTLE - last['at'], 1), 's before; history', rows)
