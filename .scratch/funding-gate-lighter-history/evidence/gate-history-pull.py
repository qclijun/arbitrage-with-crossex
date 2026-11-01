import json, sys, time, urllib.request
now = int(time.time())
out = {}
for c in ['BTC_USDT', 'ETH_USDT']:
    rows = []
    to = now
    start = now - 180*86400 + 60
    pages = 0
    while True:
        url = f'https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract={c}&from={start}&to={to}&limit=1000'
        page = json.load(urllib.request.urlopen(url))
        pages += 1
        rows += page
        if len(page) < 1000: break
        to = min(r['t'] for r in page) - 1
        time.sleep(0.3)
    out[c] = {'pages': pages, 'rows': rows}
json.dump({'readAt': now, 'data': out}, open(sys.argv[1], 'w'))
