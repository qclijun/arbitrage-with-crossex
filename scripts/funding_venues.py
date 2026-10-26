"""Read-only public venue reads for the funding screen: settlement history,
order books and 24 h volume / open interest. Each function returns normalised
data or raises; the caller turns a raise into UNKNOWN. Books are
{bids, asks: [(price, units)], complete} with price * units = USD notional;
`complete` is False when a side hit the venue's level cap, so the book may
stop short of what a size needs.
"""
import json
import threading
import time
from collections import namedtuple
from datetime import datetime
from urllib import error, parse, request

MAX_BYTES = 16 * 1024 * 1024


class Http:
    """Paced GET/POST JSON per venue with bounded retries on 429/418/5xx.
    `memo` holds per-run bulk reads (one market list per venue), scoped to this client."""

    def __init__(self, proxy=None, timeout=15, sleep=time.sleep, clock=time.monotonic):
        self.opener = request.build_opener(request.ProxyHandler({'https': proxy} if proxy else {}))
        self.timeout, self.sleep, self.clock = timeout, sleep, clock
        self.locks = {v: threading.Lock() for v in VENUES}
        self.last = dict.fromkeys(VENUES, 0.)
        self.memo, self.memo_lock = {}, threading.Lock()

    def __call__(self, venue, url, body=None):
        for attempt in range(3):
            with self.locks[venue]:
                wait = self.last[venue] + VENUES[venue].pace - self.clock()
                if wait > 0:
                    self.sleep(wait)
                self.last[venue] = self.clock()
            data = None if body is None else json.dumps(body).encode()
            # CrossEx lists non-ASCII tickers (币安人生); urllib needs them percent-encoded.
            req = request.Request(parse.quote(url, safe=":/?&=%"), data=data, headers={'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'funding-screen'})
            try:
                with self.opener.open(req, timeout=self.timeout) as reply:
                    raw = reply.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise ValueError('response too large')
                return json.loads(raw)
            except error.HTTPError as exc:
                if attempt == 2 or not (exc.code in (418, 429) or exc.code >= 500):
                    raise
                retry = exc.headers.get('Retry-After') if exc.headers else None
                self.sleep(min(float(retry), 60) if retry and retry.isdigit() else 10 * (attempt + 1))


def _once(http, key, load):
    """Load once per Http client; a plain callable (tests) loads every time."""
    memo, lock = getattr(http, 'memo', None), getattr(http, 'memo_lock', None)
    if memo is None:
        return load()
    with lock:
        if key not in memo:
            memo[key] = load()
        return memo[key]


def _levels(rows, unit=1.):
    return [(float(p), float(q) * unit) for p, q in rows]


def _book(bids, asks, cap):
    return dict(bids=bids, asks=asks, complete=len(bids) < cap and len(asks) < cap)


# --- Binance-style (Binance, Aster) ---------------------------------------------------------

def _binance_history(http, venue, sym, since, now):
    out, start = [], since
    while True:
        rows = http(venue, f'{VENUES[venue].host}/fapi/v1/fundingRate?symbol={sym}&startTime={start}&endTime={now}&limit=1000')
        out += [(int(r['fundingTime']), float(r['fundingRate'])) for r in rows]
        if len(rows) < 1000:
            return out
        start = out[-1][0] + 1


def _binance_book(http, venue, sym):
    b = http(venue, f'{VENUES[venue].host}/fapi/v1/depth?symbol={sym}&limit=500')
    return _book(_levels(b['bids']), _levels(b['asks']), 500)


def _binance_stats(http, venue, sym, mid):
    host = VENUES[venue].host
    vol = float(http(venue, f'{host}/fapi/v1/ticker/24hr?symbol={sym}')['quoteVolume'])
    oi = float(http(venue, f'{host}/fapi/v1/openInterest?symbol={sym}')['openInterest']) * mid
    return dict(volumeUsd=vol, oiUsd=oi)


# --- Bybit --------------------------------------------------------------------------------

def _bybit_history(http, venue, sym, since, now):
    out, end = [], now
    while True:
        rows = http(venue, f'{VENUES[venue].host}/v5/market/funding/history?category=linear&symbol={sym}&limit=200&endTime={end}')['result']['list']
        page = [(int(r['fundingRateTimestamp']), float(r['fundingRate'])) for r in rows]
        out += page
        if len(page) < 200 or min(t for t, _ in page) <= since:
            return out
        end = min(t for t, _ in page) - 1


def _bybit_book(http, venue, sym):
    b = http(venue, f'{VENUES[venue].host}/v5/market/orderbook?category=linear&symbol={sym}&limit=500')['result']
    return _book(_levels(b['b']), _levels(b['a']), 500)


def _bybit_stats(http, venue, sym, mid):
    t = http(venue, f'{VENUES[venue].host}/v5/market/tickers?category=linear&symbol={sym}')['result']['list'][0]
    return dict(volumeUsd=float(t['turnover24h']), oiUsd=float(t['openInterestValue']))


# --- Gate ---------------------------------------------------------------------------------

def _gate_history(http, venue, sym, since, now):
    rows = http(venue, f'{VENUES[venue].host}/futures/usdt/funding_rate?contract={sym}&limit=1000&from={since // 1000}&to={now // 1000}')
    return [(int(r['t']) * 1000, float(r['r'])) for r in rows]


def _gate_book(http, venue, sym):
    host = VENUES[venue].host
    mult = float(http(venue, f'{host}/futures/usdt/contracts/{sym}')['quanto_multiplier'])
    b = http(venue, f'{host}/futures/usdt/order_book?contract={sym}&limit=300')
    side = lambda rows: _levels([(x['p'], x['s']) for x in rows], mult)  # noqa: E731
    return _book(side(b['bids']), side(b['asks']), 300)


def _gate_stats(http, venue, sym, mid):
    t = http(venue, f'{VENUES[venue].host}/futures/usdt/tickers?contract={sym}')[0]
    return dict(volumeUsd=float(t['volume_24h_quote']), oiUsd=float(t['total_size']) * float(t['quanto_multiplier']) * float(t['mark_price']))


# --- OKX ----------------------------------------------------------------------------------

def _okx_history(http, venue, sym, since, now):
    out, after = [], f'&after={now + 1}'
    while True:
        rows = http(venue, f'{VENUES[venue].host}/public/funding-rate-history?instId={sym}&limit=400{after}')['data']
        page = [(int(r['fundingTime']), float(r.get('realizedRate') or r['fundingRate'])) for r in rows]
        out += page
        if len(page) < 400 or min(t for t, _ in page) <= since:
            return out
        after = f'&after={min(t for t, _ in page)}'


def _okx_book(http, venue, sym):
    host = VENUES[venue].host
    ct = float(http(venue, f'{host}/public/instruments?instType=SWAP&instId={sym}')['data'][0]['ctVal'])
    b = http(venue, f'{host}/market/books?instId={sym}&sz=400')['data'][0]
    return _book(_levels([x[:2] for x in b['bids']], ct), _levels([x[:2] for x in b['asks']], ct), 400)


def _okx_stats(http, venue, sym, mid):
    host = VENUES[venue].host
    t = http(venue, f'{host}/market/ticker?instId={sym}')['data'][0]
    oi = http(venue, f'{host}/public/open-interest?instType=SWAP&instId={sym}')['data'][0]
    return dict(volumeUsd=float(t['volCcy24h']) * float(t['last']), oiUsd=float(oi['oiUsd']))


# --- Hyperliquid --------------------------------------------------------------------------

def _hl_history(http, venue, sym, since, now):
    out, start = [], since
    while True:
        rows = http(venue, VENUES[venue].host, dict(type='fundingHistory', coin=sym, startTime=start, endTime=now))
        out += [(int(r['time']), float(r['fundingRate'])) for r in rows]
        if len(rows) < 500:
            return out
        start = out[-1][0] + 1


def _hl_book(http, venue, sym):
    bids, asks = http(venue, VENUES[venue].host, dict(type='l2Book', coin=sym))['levels']
    side = lambda rows: _levels([(x['px'], x['sz']) for x in rows])  # noqa: E731
    return _book(side(bids), side(asks), 20)  # l2Book shows 20 levels a side


def _hl_stats(http, venue, sym, mid):
    meta, ctxs = _once(http, 'hl-ctxs', lambda: http(venue, VENUES[venue].host, dict(type='metaAndAssetCtxs')))
    for u, c in zip(meta['universe'], ctxs):
        if u['name'] == sym:
            return dict(volumeUsd=float(c['dayNtlVlm']), oiUsd=float(c['openInterest']) * float(c['markPx']))
    raise ValueError('coin not listed')


# --- Kraken -------------------------------------------------------------------------------

def _kraken_history(http, venue, sym, since, now):
    rows = http(venue, f'{VENUES[venue].host}/v4/historicalfundingrates?symbol={sym}')['rates']
    stamp = lambda r: int(datetime.fromisoformat(r['timestamp'].replace('Z', '+00:00')).timestamp() * 1000)  # noqa: E731
    return [(stamp(r), float(r['relativeFundingRate'])) for r in rows]


def _kraken_book(http, venue, sym):
    b = http(venue, f'{VENUES[venue].host}/v3/orderbook?symbol={sym}')['orderBook']
    return dict(bids=_levels(b['bids']), asks=_levels(b['asks']), complete=True)


def _kraken_stats(http, venue, sym, mid):
    for t in _once(http, 'kraken-tickers', lambda: http(venue, f'{VENUES[venue].host}/v3/tickers')['tickers']):
        if t.get('symbol') == sym:
            return dict(volumeUsd=float(t['volumeQuote']), oiUsd=float(t['openInterest']) * float(t['markPrice']))
    raise ValueError('coin not listed')


# Seconds between requests per venue, under each venue's public limit
# (Binance fundingRate: 500 / 5 min / IP; Hyperliquid fundingHistory ~40 weight of 1200 / min).
Venue = namedtuple('Venue', 'pace host native history book stats')
VENUES = dict(
    BINANCE=Venue(.7, 'https://fapi.binance.com', lambda b: f'{b}USDT', _binance_history, _binance_book, _binance_stats),
    ASTER=Venue(.7, 'https://fapi.asterdex.com', lambda b: f'{b}USDT', _binance_history, _binance_book, _binance_stats),
    BYBIT=Venue(.12, 'https://api.bybit.com', lambda b: f'{b}USDT', _bybit_history, _bybit_book, _bybit_stats),
    GATE=Venue(.12, 'https://api.gateio.ws/api/v4', lambda b: f'{b}_USDT', _gate_history, _gate_book, _gate_stats),
    OKX=Venue(.25, 'https://www.okx.com/api/v5', lambda b: f'{b}-USDT-SWAP', _okx_history, _okx_book, _okx_stats),
    HYPERLIQUID=Venue(2., 'https://api.hyperliquid.xyz/info', lambda b: b, _hl_history, _hl_book, _hl_stats),
    KRAKEN=Venue(.5, 'https://futures.kraken.com/derivatives/api', lambda b: f"PF_{'XBT' if b == 'BTC' else b}USD",
                 _kraken_history, _kraken_book, _kraken_stats),
)
SUPPORTED = tuple(VENUES)


def native(venue, base):
    """The venue's own contract name for a CrossEx base, or None when unsupported."""
    return VENUES[venue].native(base) if venue in VENUES else None


def _adapter(venue):
    if venue not in VENUES:
        raise ValueError('unsupported venue')
    return VENUES[venue]


def history(http, venue, base, since, now):
    """[(unix ms, rate per settlement)] in (since, now], ascending."""
    out = _adapter(venue).history(http, venue, native(venue, base), since, now)
    return sorted({t: r for t, r in out if since <= t <= now}.items())


def book(http, venue, base):
    """{bids, asks, complete} in (price, units); price * units is USD."""
    return _adapter(venue).book(http, venue, native(venue, base))


def stats(http, venue, base, mid):
    """{volumeUsd, oiUsd}: 24 h quote volume and open interest at `mid`."""
    return _adapter(venue).stats(http, venue, native(venue, base), mid)
