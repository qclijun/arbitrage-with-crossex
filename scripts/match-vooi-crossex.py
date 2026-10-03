import json
from pathlib import Path
from collections import Counter
from datetime import datetime, timezone

gate = json.loads(Path('/tmp/gate-crossex-symbols.json').read_text())
symbols = {r['symbol']: r for r in gate if r.get('business_type') == 'FUTURE' and r.get('state') == 'live'}
items = []
for offset in (0, 200, 400, 600):
    d = json.loads(Path(f'/tmp/vooi-crossex-scanner-{offset}.json').read_text())
    print('PAGE', offset, len(d['items']), d['total'])
    items.extend(d['items'])
matched = {}
misses = Counter()
venues = Counter()
for item in items:
    for p in item['pairs']:
        legs = [p['long'], p['short']]
        venues.update(x['exchange'] for x in legs)
        keys = [f"{x['exchange'].upper()}_FUTURE_{x['baseSymbol']}_{x['quoteSymbol']}" for x in legs]
        if legs[0]['exchange'] == legs[1]['exchange']:
            continue
        if any(k not in symbols for k in keys):
            misses.update(k for k in keys if k not in symbols)
            continue
        rate = float(p['fundingSpread1h'])
        if rate <= 0:
            continue
        row = dict(asset=item['asset'], category=item['category'], long=keys[0], short=keys[1],
                   apr=rate*8760*100, funding8h=rate*8*100,
                   avg24hApr=None if p['avgFundingSpread24h'] is None else float(p['avgFundingSpread24h'])*8760*100,
                   priceSpreadPct=None if p['priceSpread'] is None else float(p['priceSpread'])*100,
                   priceSpreadAtSizePct=None if p['priceSpreadAtSize'] is None else float(p['priceSpreadAtSize'])*100,
                   grossFunding24hUsd=1000*rate*24,
                   positiveSince=p['fundingSpreadPositiveSince'],
                   minVolume24hUsd=min(float(x['volume24h']) for x in legs),
                   minOpenInterestUsd=min(float(x['openInterest']) for x in legs),
                   supportCross=[symbols[k].get('support_cross') for k in keys], vooiPair=p)
        matched[tuple(keys)] = row
rows = sorted(matched.values(), key=lambda x:x['apr'], reverse=True)
snapshot = dict(fetchedAt=datetime.now(timezone.utc).isoformat(),notionalPerLegUsd=1000,rows=rows)
Path('/tmp/vooi-crossex-matched.json').write_text(json.dumps(snapshot,ensure_ascii=False,indent=2))
print('SUMMARY',json.dumps(dict(assetsScanned=len(set(x['asset'] for x in items)),venues=venues,matchedPairs=len(rows),matchedAssets=len(set(x['asset'] for x in rows)),venuePairs=Counter(x['long'].split('_')[0]+' -> '+x['short'].split('_')[0] for x in rows),missing=misses.most_common(15)),ensure_ascii=False))
for row in rows[:30]:
    print(json.dumps({k:v for k,v in row.items() if k!='vooiPair'},ensure_ascii=False))
