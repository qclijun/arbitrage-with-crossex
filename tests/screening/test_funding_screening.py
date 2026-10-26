"""Funding-spread screen: pure rules and an offline end-to-end pass. No network."""
import contextlib
import io
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import funding_rules as rules  # noqa: E402
import funding_screening as screening  # noqa: E402
import funding_venues as venues  # noqa: E402

NOW = 1_792_800_000_000
H, D = rules.HOUR_MS, rules.DAY_MS


def series(rate, hours=8, days=15, spike=None):
    """Settlements every `hours` back from NOW; `spike` = (hours ago, rate)."""
    out = [(NOW - k * hours * H, rate) for k in range(days * 24 // hours)]
    if spike:
        out.append((NOW - spike[0] * H + 1, spike[1]))
    return sorted(out)


def book(mid, usd_per_level, levels=50, step=.0002, complete=True):
    return dict(bids=[(mid * (1 - step * (i + 1)), usd_per_level / mid) for i in range(levels)],
                asks=[(mid * (1 + step * (i + 1)), usd_per_level / mid) for i in range(levels)], complete=complete)


class RulesTest(unittest.TestCase):
    def test_underlying(self):
        self.assertEqual(rules.underlying_of('1000PEPE'), ('PEPE', 1000))
        self.assertEqual(rules.underlying_of('kPEPE'), ('PEPE', 1000))
        self.assertEqual(rules.underlying_of('1MBABYDOGE'), ('BABYDOGE', 1_000_000))
        self.assertEqual(rules.underlying_of('SHIB1000'), ('SHIB', 1000))
        self.assertEqual(rules.underlying_of('ETH'), ('ETH', 1))

    def test_daily_sums_need_every_day(self):
        self.assertEqual(len(rules.daily_sums(series(.0001), NOW, 14)), 14)
        gap = [x for x in series(.0001) if not NOW - 6 * D < x[0] <= NOW - 5 * D]
        self.assertIsNone(rules.daily_sums(gap, NOW, 14))
        self.assertIsNone(rules.daily_sums(series(.0001, days=10), NOW, 14))

    def test_a_day_missing_one_settlement_is_unknown_not_zero(self):
        partial = [x for x in series(.0001) if x[0] != NOW - 5 * 24 * H - 8 * H]  # 2 of the day's 3
        self.assertIsNone(rules.daily_sums(partial, NOW, 14))

    def test_interval_cut_keeps_the_older_days_complete(self):
        cut = [x for x in series(.0003) if x[0] <= NOW - 72 * H] + series(.0001, hours=1, days=3)
        self.assertIsNotNone(rules.daily_sums(cut, NOW, 14))

    def test_steady_spread_passes(self):
        # 0.03% / 8 h vs 0.01% / 8 h: 0.06% a day, ~21.9% APR.
        res = rules.layer1(series(.0003), series(.0001), .22, NOW)
        self.assertEqual(res['status'], 'PASS', res['reasons'])
        self.assertAlmostEqual(res['metrics']['expectedDaily'], .0006)
        self.assertEqual(res['metrics']['positiveDays'], 14)

    def test_current_spread_must_be_positive_and_above_the_line(self):
        flipped = rules.layer1(series(.0003), series(.0001), -.1, NOW)
        self.assertEqual(flipped['status'], 'FAIL')
        self.assertTrue(any('current spread' in r for r in flipped['reasons']))
        low = rules.layer1(series(.0003), series(.0001), .03, NOW, dict(rules.RULES, min_current_apr=.05))
        self.assertIn('current spread 3.0% below 5%', low['reasons'])

    def test_one_day_squeeze_fails(self):
        # Flat 0.01% both sides plus a 2% cap print 30 h ago on the short leg only.
        res = rules.layer1(series(.0001, spike=(30, .02)), series(.0001), 9., NOW)
        self.assertEqual(res['status'], 'FAIL')
        joined = ' '.join(res['reasons'])
        for why in ('positive days', 'one day dominates', 'median spread not positive', 'short leg: extreme settlement'):
            self.assertIn(why, joined)

    def test_interval_cut_and_current_spike_veto(self):
        cut = [x for x in series(.0003) if x[0] <= NOW - 72 * H] + series(.0001, hours=1, days=3)
        res = rules.layer1(cut, series(.00002), .2, NOW)
        self.assertIn('short leg: interval cut 8h->1h', res['reasons'])
        hot = rules.layer1(series(.0003), series(.0001), 1.5, NOW)
        self.assertIn('current spread far above median', hot['reasons'])

    def test_book_metrics(self):
        m = rules.book_metrics(book(100., 1000), 3000, .005)
        self.assertAlmostEqual(m['bidAskBp'], 4.)
        self.assertAlmostEqual(m['bidDepthUsd'], 25000, delta=100)
        self.assertGreater(m['buySlip'], .0002)
        self.assertLess(m['buySlip'], .0006)
        self.assertIsNone(rules.book_metrics(book(100., 10, levels=3), 3000, .005)['buySlip'])
        self.assertIsNone(rules.book_metrics(dict(bids=[(101, 1)], asks=[(100, 1)]), 10, .005))

    def leg(self, mid=100., usd=4000, mult=1, levels=50, complete=True):
        return dict(book=rules.book_metrics(book(mid, usd, levels, complete=complete), 1000, .005), mult=mult, volumeUsd=5e7, oiUsd=1e7)

    def test_cost_and_capacity_pass_and_cost(self):
        res = rules.cost_and_capacity(self.leg(), self.leg(), .00192, .002, 1000)
        self.assertEqual((res['layer2']['status'], res['layer3']['status']), ('PASS', 'PASS'), res)
        m = res['metrics']
        self.assertAlmostEqual(m['cost'], m['feeRoundTrip'] + m['entrySlip'] + m['exitSlip'] + m['basis'])
        self.assertAlmostEqual(m['paybackDays'], m['cost'] / .002)

    def test_basis_uses_unit_prices(self):
        # Long venue lists 1000X at 1000x the price: same coin, no basis.
        res = rules.cost_and_capacity(self.leg(), self.leg(mid=100_000., mult=1000), .00192, .002, 1000)
        self.assertAlmostEqual(res['metrics']['basis'], 0.)

    def test_legs_priced_as_two_assets_fail(self):
        res = rules.cost_and_capacity(self.leg(), self.leg(mid=120.), .00192, .002, 1000)
        self.assertEqual(res['layer2']['status'], 'FAIL')
        self.assertIn('legs priced as two different assets', res['layer2']['reasons'])

    def test_failures_and_unknowns(self):
        thin = rules.cost_and_capacity(self.leg(usd=50), self.leg(), .00192, .002, 1000)
        self.assertEqual(thin['layer3']['status'], 'FAIL')
        slow = rules.cost_and_capacity(self.leg(), self.leg(), .00192, .0002, 1000)
        self.assertEqual(slow['layer2']['status'], 'FAIL')
        nofee = rules.cost_and_capacity(self.leg(), dict(self.leg(), oiUsd=None), None, .002, 1000)
        self.assertEqual((nofee['layer2']['status'], nofee['layer3']['status']), ('UNKNOWN', 'UNKNOWN'))

    def test_truncated_book_short_of_size_is_unknown_not_fail(self):
        # 20 shallow levels, all inside the band, and the venue capped the book: depth past them is unseen.
        capped = rules.cost_and_capacity(self.leg(usd=40, levels=20, complete=False), self.leg(), .00192, .002, 1000)
        self.assertEqual(capped['layer3']['status'], 'UNKNOWN', capped['layer3'])
        full = rules.cost_and_capacity(self.leg(usd=40, levels=20), self.leg(), .00192, .002, 1000)
        self.assertEqual(full['layer3']['status'], 'FAIL')


class StageTest(unittest.TestCase):
    def test_stage_is_the_leading_run_of_passes(self):
        p = lambda *s: {f'layer{i + 1}': dict(status=v) for i, v in enumerate(s)}  # noqa: E731
        self.assertEqual(screening.stage(p('PASS', 'FAIL', 'PASS')), 1)
        self.assertEqual(screening.stage(p('PASS', 'PASS', 'UNKNOWN')), 2)
        self.assertEqual(screening.stage(p('PASS', 'PASS', 'PASS')), 3)
        self.assertEqual(screening.stage(p('FAIL')), 0)


def fake_http(rates, extra=None):
    """Venue API stand-in: Binance and Bybit, steady books and stats; `extra(url, body)` for others."""
    def http(venue, url, body=None):
        if extra:
            hit = extra(url, body)
            if hit is not None:
                return hit
        if 'fundingRate?' in url:
            return [dict(fundingTime=t, fundingRate=str(r)) for t, r in rates['BINANCE']]
        if 'funding/history' in url:
            return dict(result=dict(list=[dict(fundingRateTimestamp=str(t), fundingRate=str(r)) for t, r in reversed(rates['BYBIT'])]))
        b = book(100., 4000)
        if '/depth' in url:
            return dict(bids=[[str(p), str(q)] for p, q in b['bids']], asks=[[str(p), str(q)] for p, q in b['asks']])
        if 'orderbook' in url:
            return dict(result=dict(b=[[str(p), str(q)] for p, q in b['bids']], a=[[str(p), str(q)] for p, q in b['asks']]))
        if 'ticker/24hr' in url:
            return dict(quoteVolume='5e7')
        if 'openInterest' in url:
            return dict(openInterest='100000')
        if 'tickers' in url:
            return dict(result=dict(list=[dict(turnover24h='5e7', openInterestValue='1e7')]))
        raise AssertionError(url)
    return http


class VenueParsersTest(unittest.TestCase):
    def test_native_names(self):
        self.assertEqual(venues.native('OKX', 'ETH'), 'ETH-USDT-SWAP')
        self.assertEqual(venues.native('GATE', 'ETH'), 'ETH_USDT')
        self.assertEqual(venues.native('KRAKEN', 'BTC'), 'PF_XBTUSD')
        self.assertIsNone(venues.native('LIGHTER', 'ETH'))

    def test_history_readers(self):
        t = NOW - 8 * H
        replies = {
            'GATE': [dict(t=t // 1000, r='0.0001')],
            'OKX': dict(data=[dict(fundingTime=str(t), realizedRate='0.0002', fundingRate='0.0009')]),
            'HYPERLIQUID': [dict(time=t, fundingRate='0.0003')],
            'KRAKEN': dict(rates=[dict(timestamp='2026-10-23T16:00:00Z', relativeFundingRate='0.0004')]),
        }
        for venue, reply in replies.items():
            got = venues.history(lambda v, url, body=None, r=reply: r, venue, 'ETH', NOW - 2 * D, NOW)
            self.assertEqual(len(got), 1, venue)
        self.assertEqual(venues.history(lambda *a, **k: replies['OKX'], 'OKX', 'ETH', NOW - 2 * D, NOW)[0][1], .0002)

    def test_book_readers_and_level_caps(self):
        hl = dict(levels=[[dict(px='99', sz='1')] * 20, [dict(px='101', sz='1')] * 20])
        self.assertFalse(venues.book(lambda *a, **k: hl, 'HYPERLIQUID', 'ETH')['complete'])
        def gate(v, url, body=None):
            return dict(quanto_multiplier='0.01') if '/contracts/' in url else dict(bids=[dict(p='99', s='100')], asks=[dict(p='101', s='100')])
        g = venues.book(gate, 'GATE', 'ETH')
        self.assertEqual((g['bids'][0], g['complete']), ((99., 1.), True))
        def okx(v, url, body=None):
            return dict(data=[dict(ctVal='0.1')]) if 'instruments' in url else dict(data=[dict(bids=[['99', '10', '0', '1']], asks=[['101', '10', '0', '1']])])
        self.assertEqual(venues.book(okx, 'OKX', 'ETH')['asks'][0], (101., 1.))

    def test_bulk_read_is_cached_per_client(self):
        calls = []
        meta = ([dict(universe=[dict(name='ETH')]), [dict(dayNtlVlm='1', openInterest='2', markPx='3')]])

        class Client(venues.Http):
            def __call__(self, venue, url, body=None):
                calls.append(url)
                return meta
        client = Client(sleep=lambda s: None)
        venues.stats(client, 'HYPERLIQUID', 'ETH', 3.)
        venues.stats(client, 'HYPERLIQUID', 'ETH', 3.)
        self.assertEqual(len(calls), 1)
        venues.stats(Client(sleep=lambda s: None), 'HYPERLIQUID', 'ETH', 3.)
        self.assertEqual(len(calls), 2)


def spread_row(coin, short_apr=.6, long_apr=.05, unquoted=()):
    """A /api/funding-spreads row: Binance receives, Bybit pays, Lighter unsupported."""
    return dict(underlying=coin, spreadApr=short_apr - long_apr, priceMismatch=False, unquotedVenues=list(unquoted), venues=[
        dict(venue='BINANCE', symbol=f'BINANCE_FUTURE_{coin}_USDT', apr=short_apr),
        dict(venue='BYBIT', symbol=f'BYBIT_FUTURE_{coin}_USDT', apr=long_apr),
        dict(venue='LIGHTER', symbol=f'LIGHTER_FUTURE_{coin}_USDC', apr=0.)])


class ScreenTest(unittest.TestCase):

    def test_taker_rate_prefers_symbol_override(self):
        fees = [dict(exchangeType='BINANCE', futureTakerFee='0.00048', specialFeeList=[dict(symbol='BINANCE_FUTURE_ETH_USDT', takerFeeRate='0.0003')])]
        self.assertEqual(screening.taker_rate(fees, 'BINANCE_FUTURE_ETH_USDT'), .0003)
        self.assertEqual(screening.taker_rate(fees, 'BINANCE_FUTURE_SOL_USDT'), .00048)
        self.assertIsNone(screening.taker_rate(fees, 'GATE_FUTURE_SOL_USDT'))

    def test_screen_end_to_end(self):
        fees = [dict(exchangeType=v, futureTakerFee='0.00048') for v in ('BINANCE', 'BYBIT')]
        http = fake_http(dict(BINANCE=series(.0006), BYBIT=series(.0001)))
        rows = [spread_row('AAA', unquoted=['OKX']), spread_row('LOW', .03, .02)]
        res = screening.screen(rows, fees, http, NOW, 1000, .05)
        self.assertEqual(res['funnel']['snapshotCandidates'], 1)
        best = res['coins'][0]
        self.assertEqual((best['coin'], best['stage'], best['short']['venue']), ('AAA', 3, 'BINANCE'))
        self.assertAlmostEqual(best['metrics']['feeRoundTrip'], .00192)
        self.assertEqual((res['funnel']['allThree'], res['funnel']['withUnquotedVenues']), (1, 1))
        self.assertEqual(best['unquotedVenues'], ['OKX'])

    def test_reversed_pair_fails_its_own_snapshot_line(self):
        # The coin's best snapshot spread clears the line; its reversed pair (short BYBIT) does not.
        pairs = screening._layer1_pairs({'AAA': spread_row('AAA')['venues'][:2]},
                                        {('BINANCE', 'AAA'): series(.0006), ('BYBIT', 'AAA'): series(.0001)}, {}, NOW,
                                        dict(rules.RULES, min_current_apr=.05))
        flipped = next(p for p in pairs['AAA'] if p['short']['venue'] == 'BYBIT')
        self.assertEqual(flipped['layer1']['status'], 'FAIL')

    def test_http_encodes_non_ascii_tickers(self):
        seen = []

        class Opener:
            def open(self, req, timeout):
                seen.append(req.full_url)
                return contextlib.closing(io.BytesIO(b'[]'))
        http = venues.Http(sleep=lambda s: None)
        http.opener = Opener()
        venues.history(http, 'BINANCE', '币安人生', 0, NOW)
        self.assertIn('symbol=%E5%B8%81%E5%AE%89%E4%BA%BA%E7%94%9FUSDT&startTime=0', seen[0])

    def test_failed_history_is_unknown_with_its_reason(self):
        def broken(venue, url, body=None):
            raise OSError('down')
        res = screening.screen([spread_row('AAA')], [], broken, NOW, 1000, .05)
        self.assertEqual(res['funnel']['layer1Unknown'], 1)
        self.assertEqual(res['coins'][0]['layer1']['status'], 'UNKNOWN')
        self.assertIn('OSError', res['coins'][0]['layer1']['reasons'][0])

    def test_programming_errors_are_not_swallowed(self):
        def bug(venue, url, body=None):
            raise NameError('typo')
        with self.assertRaises(NameError):
            screening.screen([spread_row('AAA')], [], bug, NOW, 1000, .05)


class RunTest(unittest.TestCase):
    def run_once(self, out, spreads_meta, fees_ok=True):
        rows = [spread_row('AAA')]

        def fetch(base, path, token, timeout):
            if path == '/api/fees':
                if not fees_ok:
                    raise OSError('down')
                return dict(ok=True, data=[dict(exchangeType=v, futureTakerFee='0.00048') for v in ('BINANCE', 'BYBIT')])
            return dict(ok=True, data=dict(rows=rows, feeds=[dict(venue='OKX', ok=False)], assumedFeeTier=None), meta=spreads_meta)
        token = pathlib.Path(out) / 'token'
        token.write_text('t')
        http = fake_http(dict(BINANCE=series(.0006), BYBIT=series(.0001)))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return screening.run(['--token-file', str(token), '--output-dir', out], fetch=fetch, http=http, now=lambda: NOW / 1000)

    def test_complete_evidence_exits_0_and_runs_do_not_collide(self):
        with tempfile.TemporaryDirectory() as out:
            self.assertEqual(self.run_once(out, dict(coverageComplete=True)), 0)
            self.assertEqual(self.run_once(out, dict(coverageComplete=True)), 0)  # same second, distinct runId
            self.assertEqual(len([p for p in pathlib.Path(out).iterdir() if p.is_dir()]), 2)

    def test_incomplete_coverage_or_assumed_fees_exit_2(self):
        with tempfile.TemporaryDirectory() as out:
            self.assertEqual(self.run_once(out, dict(coverageComplete=False)), 2)
            self.assertEqual(self.run_once(out, dict(coverageComplete=True), fees_ok=False), 2)

    def test_bad_arguments_return_1(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(screening.run(['--notional', 'x']), 1)

    def test_evidence_issues(self):
        env = dict(meta=dict(stale=True, coverageComplete=False), data=dict(feeds=[dict(venue='GATE', ok=False)], assumedFeeTier='vip0'))
        issues = screening.evidence_issues(env, True)
        self.assertEqual(len(issues), 4)
        self.assertIn('incomplete funding coverage: GATE', issues)


if __name__ == '__main__':
    unittest.main()
