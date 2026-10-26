"""Pure screening rules for floating perp-vs-perp funding spreads (layers 1-3).

A day is a rolling 24 h window ending at `now`, never a partial UTC date. Rates
are fractions per settlement; spreads and costs are fractions of ONE leg's
notional. Missing evidence is UNKNOWN, never zero.
"""
import re
import statistics
from collections import Counter

DAY_MS = 86_400_000
HOUR_MS = 3_600_000
PRICE_TOLERANCE = .05          # legs priced further apart are two assets (spreads.ts PRICE_TOLERANCE)
RULES = dict(
    days=14,                   # history window the spread must survive
    min_apr=.15,               # layer 1: 14-day realised spread, annualised
    min_positive_days=11,      # layer 1: days the spread kept its sign
    max_day_share=.30,         # layer 1: one day's share of the 14-day sum
    min_current_apr=0.,        # layer 1: the pair's current spread must reach this (the screen sets its exit line)
    max_current_vs_median=3.,  # layer 1: current spread / median daily spread
    veto_hours=72,             # layer 1: look-back for extreme settlements and interval cuts
    extreme_rate=.005,         # layer 1: one settlement this large reads as a cap event
    max_payback_days=3.,       # layer 2: cost / expected daily spread
    min_net_over_cost=1.,      # layer 2: 14-day net profit must reach this multiple of cost
    min_net_apr=.15,           # layer 2: net of cost over the 14-day hold, annualised
    depth_band=.005,           # layer 3: book depth counted within this distance of mid
    depth_multiple=5.,         # layer 3: depth on each side vs the leg size
    max_bid_ask_bp=5.,         # layer 3
    max_oi_share=.005,         # layer 3: leg size vs the venue's open interest
    min_volume_usd=20e6,       # layer 3: venue 24 h volume
)


def underlying_of(base):
    """1000PEPE, 1MBABYDOGE, kPEPE, SHIB1000 -> (coin, coins per contract unit); mirrors spreads.ts."""
    m = re.match(r'^1M([A-Z].*)$', base)
    if m:
        return m.group(1), 1_000_000
    m = re.match(r'^(1000000|100000|10000|1000)([A-Z].*)$', base)
    if m:
        return m.group(2), int(m.group(1))
    m = re.match(r'^k([A-Z].*)$', base)
    if m:
        return m.group(1), 1000
    m = re.match(r'^([A-Z].*?)(1000000|100000|10000|1000)$', base)
    if m:
        return m.group(1), int(m.group(2))
    return base.upper(), 1


def _interval_hours(times):
    """The longest settlement interval the series keeps (a gap seen at least twice), in hours.
    A cut from 8 h to 1 h keeps 8 h, so the days before the cut still need 3 settlements; a
    single long gap is a missing settlement, not an interval."""
    gaps = [round((b - a) / HOUR_MS) for a, b in zip(times, times[1:])]
    counts = Counter(g for g in gaps if g > 0)
    regular = [g for g, n in counts.items() if n >= 2]
    return max(regular) if regular else (max(counts) if counts else None)


def daily_sums(settlements, now, days):
    """Funding per rolling day, newest first; None unless every day holds its full count of
    settlements (24 h / the series' interval). A day with a missing settlement is UNKNOWN, not
    a day whose missing settlements were zero."""
    interval = _interval_hours(sorted(t for t, _ in settlements))
    if interval is None:
        return None
    need = int(24 // interval)
    sums, counts = [0.] * days, [0] * days
    for t, rate in settlements:
        i = int((now - t) // DAY_MS) if t <= now else -1
        if 0 <= i < days and t > now - (i + 1) * DAY_MS:
            sums[i] += rate
            counts[i] += 1
    return sums if all(n >= need for n in counts) else None


def _min_gap_hours(times):
    gaps = [round((b - a) / HOUR_MS) for a, b in zip(times, times[1:])]
    return min(gaps) if gaps else None


def vetoes(settlements, now, rules):
    """An extreme settlement or a shortened interval in the look-back marks an event, not a regime."""
    cut = now - rules['veto_hours'] * HOUR_MS
    window = now - rules['days'] * DAY_MS
    recent = sorted((t, r) for t, r in settlements if cut < t <= now)
    older = sorted(t for t, _ in settlements if window < t <= cut)
    out = []
    if any(abs(r) >= rules['extreme_rate'] for _, r in recent):
        out.append('extreme settlement')
    a, b = _min_gap_hours([t for t, _ in recent]), _min_gap_hours(older)
    if a is not None and b is not None and a < b:
        out.append(f'interval cut {b}h->{a}h')
    return out


def layer1(short_hist, long_hist, current_apr, now, rules=RULES):
    """Persistence of the realised spread: short receives `short_hist`, long pays `long_hist`."""
    days = rules['days']
    short_days, long_days = daily_sums(short_hist, now, days), daily_sums(long_hist, now, days)
    if short_days is None or long_days is None:
        return dict(status='UNKNOWN', reasons=[f'history does not cover {days} full days'], metrics={})
    spread = [a - b for a, b in zip(short_days, long_days)]
    total = sum(spread)
    median = statistics.median(spread)
    mean7 = sum(spread[:7]) / 7
    m = dict(realisedApr=total / days * 365, positiveDays=sum(x > 0 for x in spread), medianDaily=median,
             mean7Daily=mean7, expectedDaily=min(median, mean7), currentApr=current_apr,
             maxDayShare=max(spread) / total if total > 0 else None,
             currentVsMedian=current_apr / (median * 365) if median > 0 else None)
    reasons = []
    if m['realisedApr'] < rules['min_apr']:
        reasons.append(f"realised {days}d APR {m['realisedApr']:.1%} < {rules['min_apr']:.0%}")
    if m['positiveDays'] < rules['min_positive_days']:
        reasons.append(f"positive days {m['positiveDays']}/{days} < {rules['min_positive_days']}")
    if m['maxDayShare'] is None or m['maxDayShare'] > rules['max_day_share']:
        reasons.append('one day dominates the sum' if m['maxDayShare'] is not None else 'no positive sum')
    if current_apr < rules['min_current_apr'] or current_apr <= 0:
        reasons.append(f"current spread {current_apr:.1%} below {max(rules['min_current_apr'], 0):.0%}")
    if m['currentVsMedian'] is None or m['currentVsMedian'] > rules['max_current_vs_median']:
        reasons.append('current spread far above median' if m['currentVsMedian'] is not None else 'median spread not positive')
    for side, hist in (('short', short_hist), ('long', long_hist)):
        reasons += [f'{side} leg: {v}' for v in vetoes(hist, now, rules)]
    return dict(status='FAIL' if reasons else 'PASS', reasons=reasons, metrics=m)


def book_metrics(book, notional, band):
    """Mid, bid-ask, depth within `band` per side and slippage to fill `notional` USD each way.

    A book marked `complete=False` (the venue capped its levels) cannot show what lies past its
    last level: a fill it cannot reach, or depth short of the band's edge, is then unknown."""
    bids = sorted(book.get('bids') or [], key=lambda x: -x[0])
    asks = sorted(book.get('asks') or [], key=lambda x: x[0])
    if not bids or not asks or bids[0][0] <= 0 or asks[0][0] <= bids[0][0]:
        return None
    mid = (bids[0][0] + asks[0][0]) / 2
    complete = book.get('complete', True)

    def slip(levels):
        left, cost, units = notional, 0., 0.
        for price, qty in levels:
            take = min(left, price * qty)
            cost += take
            units += take / price
            left -= take
            if left <= 1e-9:
                return abs(cost / units - mid) / mid
        return None
    return dict(mid=mid, bidAskBp=(asks[0][0] - bids[0][0]) / mid * 1e4,
                bidDepthUsd=sum(p * q for p, q in bids if p >= mid * (1 - band)),
                askDepthUsd=sum(p * q for p, q in asks if p <= mid * (1 + band)),
                sellSlip=slip(bids), buySlip=slip(asks), complete=complete,
                bandSeen=complete or (bids[-1][0] < mid * (1 - band) and asks[-1][0] > mid * (1 + band)))


def cost_and_capacity(short, long, fee_round_trip, expected_daily, notional, rules=RULES):
    """Cost/payback (layer 2) and capacity (layer 3).

    `short`/`long`: dict(book=book_metrics(...) or None, mult=coins per unit,
    volumeUsd, oiUsd). `fee_round_trip`: taker open + close on both legs.
    """
    fail2, fail3, unknown2, unknown3 = [], [], [], []
    for side, leg in (('short', short), ('long', long)):
        b = leg.get('book')
        if b is None:
            unknown3.append(f'{side} book unavailable')
            continue
        if b['sellSlip'] is None or b['buySlip'] is None:
            (fail3 if b['complete'] else unknown3).append(f'{side} book cannot fill ${notional:,.0f}'
                                                         + ('' if b['complete'] else ' within the levels the venue shows'))
        if min(b['bidDepthUsd'], b['askDepthUsd']) < rules['depth_multiple'] * notional:
            (fail3 if b['bandSeen'] else unknown3).append(f"{side} depth within {rules['depth_band']:.1%} < {rules['depth_multiple']:g}x size"
                                                          + ('' if b['bandSeen'] else ' (book truncated inside the band)'))
        if b['bidAskBp'] > rules['max_bid_ask_bp']:
            fail3.append(f"{side} bid-ask {b['bidAskBp']:.1f}bp > {rules['max_bid_ask_bp']:g}bp")
        for key, test, why in (('oiUsd', lambda v: notional <= rules['max_oi_share'] * v, f"size > {rules['max_oi_share']:.1%} of OI"),
                               ('volumeUsd', lambda v: v >= rules['min_volume_usd'], f"24h volume < ${rules['min_volume_usd'] / 1e6:g}M")):
            v = leg.get(key)
            if v is None:
                unknown3.append(f'{side} {key} unavailable')
            elif not test(v):
                fail3.append(f'{side} {why}')
    m = {}
    sb, lb = short.get('book'), long.get('book')
    slips = None if sb is None or lb is None else (sb['sellSlip'], lb['buySlip'], sb['buySlip'], lb['sellSlip'])
    if fee_round_trip is None:
        unknown2.append('fee rate unknown')
    if slips is None or None in slips:
        unknown2.append('slippage unknown')
    if sb is not None and lb is not None:
        s_unit, l_unit = sb['mid'] / short['mult'], lb['mid'] / long['mult']
        if max(s_unit, l_unit) / min(s_unit, l_unit) - 1 > PRICE_TOLERANCE:  # the check spreads.ts skips for unpriced legs
            fail2.append('legs priced as two different assets')
    if not unknown2 and not fail2:
        # A long leg dearer than the short is paid at entry; a cheaper one is not banked, it tends to close by exit.
        basis = max(0., (l_unit - s_unit) / s_unit)
        cost = fee_round_trip + sum(slips) + basis
        m = dict(feeRoundTrip=fee_round_trip, entrySlip=slips[0] + slips[1], exitSlip=slips[2] + slips[3], basis=basis, cost=cost)
        if expected_daily <= 0:
            fail2.append('expected daily spread not positive')
        else:
            net = expected_daily * rules['days'] - cost
            m.update(paybackDays=cost / expected_daily, net14=net, netApr=net / rules['days'] * 365)
            if m['paybackDays'] > rules['max_payback_days']:
                fail2.append(f"payback {m['paybackDays']:.1f}d > {rules['max_payback_days']:g}d")
            if net < rules['min_net_over_cost'] * cost:
                fail2.append('14-day net below cost')
            if m['netApr'] < rules['min_net_apr']:
                fail2.append(f"net APR {m['netApr']:.1%} < {rules['min_net_apr']:.0%}")

    def status(fails, unknowns):
        return 'FAIL' if fails else 'UNKNOWN' if unknowns else 'PASS'
    return dict(layer2=dict(status=status(fail2, unknown2), reasons=fail2 + unknown2),
                layer3=dict(status=status(fail3, unknown3), reasons=fail3 + unknown3), metrics=m)
