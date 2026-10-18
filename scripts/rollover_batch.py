"""Pure watch-profile progress and batch preview policy. Never performs IO to a venue."""
import json
import math
from pathlib import Path

PROFILE = json.loads(Path(__file__).with_name('rollover-watch-profile.json').read_text())


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def same_size(value, size):
    return finite(value) and abs(value - size) <= 1e-9


def progress(positions):
    """Quantity conservation proves progress, never a successful receipt."""
    def quantity(mid, side, venue, maturity, entry=None):
        rows = [p for p in positions if p.get('marketId') == mid]
        if not rows:
            return 0
        p = rows[0]
        if (len(rows) != 1 or str(p.get('marketAcc', '')).lower() != PROFILE['address'] + '000002ffffff'
                or p.get('tokenId') != 2 or p.get('base') != 'ETH'
                or str(p.get('venue', '')).upper() != venue or p.get('side') != side
                or not finite(p.get('sizeToken')) or p['sizeToken'] < 0 or p.get('maturity') != maturity
                or entry is not None and (not finite(p.get('entryApr')) or abs(p['entryApr'] - entry) > .0001 + 1e-12)):
            raise ValueError('Watch position identity, quantity or locked entry changed')
        return p['sizeToken']
    old = [quantity(p['marketId'], p['side'], p['venue'], PROFILE['oldMaturity'], p['entryApr']) for p in PROFILE['legs']]
    new = [quantity(p['targetId'], p['side'], p['venue'], PROFILE['newMaturity']) for p in PROFILE['legs']]
    if not same_size(old[0], old[1]) or not same_size(new[0], new[1]):
        raise ValueError('Unbalanced old/new legs — reconcile execution before another batch')
    if old[0] == new[0] == 0:
        return dict(remaining=0, rolled=0, state='EXITED')
    if not same_size(old[0] + new[0], PROFILE['totalSize']):
        raise ValueError('Old remaining + new rolled does not equal the approved total')
    return dict(remaining=old[0], rolled=new[0], state='ROLLED' if old[0] == 0 else 'PARTIAL' if new[0] > 0 else 'UNSTARTED')


def roll_request(address, size):
    return dict(address=address, exit={'legs': [dict(marketId=p['marketId'],
                direction='short' if p['side'] == 'LONG' else 'long', size=size,
                slippageApr=PROFILE['exitTolerance']) for p in PROFILE['legs']]},
                entry={'legs': [dict(marketId=p['targetId'], direction=p['side'].lower(), size=size,
                slippageApr=PROFILE['entryTolerance']) for p in PROFILE['legs']]})


def preview(sim, size, now):
    observed = sim.get('simulatedAtMs')
    gate = sim.get('gate') or {}
    if (not finite(observed) or observed / 1000 > now or now - observed / 1000 > 120
            or not isinstance(gate.get('blockers'), list) or not isinstance(gate.get('warnings'), list)):
        raise ValueError('Invalid/stale batch snapshot')
    exit = sim.get('exit', {}).get('simulation', {})
    entry = sim.get('entry', {}).get('simulation', {})
    legs = exit.get('legs', []) + entry.get('legs', [])
    if len(legs) != 4:
        raise ValueError('Four-leg plan, size, tolerance or maturity mismatch')
    for i, leg in enumerate(legs):
        p, close = PROFILE['legs'][i % 2], i < 2
        side = ('short' if p['side'] == 'LONG' else 'long') if close else p['side'].lower()
        sizing = leg.get('sizing') or {}
        if (leg.get('marketId') != p['marketId' if close else 'targetId'] or leg.get('direction') != side
                or str(leg.get('venue', '')).upper() != p['venue'] or leg.get('base') != 'ETH'
                or not finite(sizing.get('deltaSize')) or not same_size(abs(sizing['deltaSize']), size)
                or sizing.get('orderSide') != side
                or not same_size(leg.get('slippageApr'), PROFILE['exitTolerance' if close else 'entryTolerance'])):
            raise ValueError('Four-leg plan, size, tolerance or maturity mismatch')
    if (exit.get('collateral') != 'ETH' or entry.get('collateral') != 'ETH'
            or not finite(exit.get('secondsToMaturity')) or not finite(entry.get('secondsToMaturity'))
            or abs(observed / 1000 + exit['secondsToMaturity'] - PROFILE['oldMaturity']) > 120
            or abs(observed / 1000 + entry['secondsToMaturity'] - PROFILE['newMaturity']) > 120):
        raise ValueError('Four-leg plan, size, tolerance or maturity mismatch')
    depths = [p.get('sizeWithinTolerance') if p.get('bookStatus') in ('ok', 'insufficient-depth') else None for p in legs]
    depth = min(depths) if all(finite(q) and q >= 0 for q in depths) else None
    venue, margin = sim.get('venue') or {}, gate.get('margin') or {}
    orders = venue.get('orders') or []
    complete = (venue.get('status') in ('Succeed', 'Refused') and len(orders) == 4
                and all(o.get('marketId') == legs[i]['marketId'] and o.get('action') == ('close' if i < 2 else 'open') for i, o in enumerate(orders)))
    ready = None
    if complete and (venue['status'] == 'Refused' or gate['blockers']):
        ready = False
    elif complete and (finite(sim.get('gasBalanceUsd')) and depth is not None
            and all(finite(margin.get(k)) for k in ('availableAfter', 'availableAfterExit', 'need', 'shortfall'))
            and all(finite(p.get('execApr')) and finite(p.get('midApr')) and p['midApr'] != 0 for p in legs)):
        ready = (all(o.get('filled') is True and same_size(o.get('matchedSize'), size) and not o.get('error') for o in orders)
                 and sim['gasBalanceUsd'] >= PROFILE['gasMinimumUsd'] and margin['availableAfter'] >= 0
                 and margin['shortfall'] == 0 and depth + 1e-9 >= size
                 and all(abs(p['execApr'] - p['midApr']) <= p['slippageApr'] + 1e-12 for p in legs))
    return dict(ready=ready, depth=depth, coverage=None if depth is None else min(1, depth / size), venueComplete=bool(complete), legs=legs)


def next_probe(upper, previous, price):
    """Bounded advisory grid, not a venue lot size or an approved trial quantity."""
    if not finite(price) or price <= 0:
        return None
    grid = 10 ** PROFILE['probeDecimals']
    size = math.floor((upper if previous is None else previous / 2) * grid) / grid
    return size if size > 0 and size * price >= PROFILE['minimumOrderUsd'] else None


def discover(simulate, remaining, now):
    """Each probe sees today's unconsumed account/book; no multi-batch fill promise."""
    full = simulate(remaining)
    state = preview(full, remaining, now())
    result = dict(full=full, full_state=state, selected=full if state['ready'] is True else None,
                  size=remaining if state['ready'] is True else None, probes=[])
    if state['ready'] is not False or state['depth'] is None or not finite(full.get('gasBalanceUsd')) or full['gasBalanceUsd'] < PROFILE['gasMinimumUsd']:
        return result
    upper = min(remaining, state['depth'])
    previous = remaining if upper >= remaining - 1e-9 else None
    for _ in range(PROFILE['maxProbes']):
        q = next_probe(upper, previous, full['entry']['simulation'].get('collateralPriceUsd'))
        if q is None:
            break
        try:
            sim = simulate(q)
            current = preview(sim, q, now())
            result['probes'].append(dict(size=q, ready=current['ready']))
            if current['ready'] is True:
                result.update(selected=sim, size=q)
                break
            if current['ready'] is None:
                break
        except Exception:
            result['probes'].append(dict(size=q, ready=None))
            break
        previous = q
    return result
