"""The v3 rollover watch: median quotes, A/B arithmetic, ledger and decision rules."""
import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
TZ = dt.timezone(dt.timedelta(hours=8))
SIZE = 3.9888313
OLD_MATURITY = 1793318400
NEW_MATURITY = 1795737600
TOKEN = 'synthetic-secret-token'


def epoch(year, month, day, hour=12):
    return dt.datetime(year, month, day, hour, tzinfo=TZ).timestamp()


NOW = epoch(2026, 10, 17)
DECISION_NOW = epoch(2026, 10, 25)


def asset_view(price=2500.0, old_present=True, old_size=SIZE,
               hl_entry=0.077667, okx_entry=0.031072):
    boros = []
    if old_present:
        boros.extend([
            dict(marketId=196, side='SHORT', sizeToken=old_size,
                 entryApr=hl_entry, maturity=OLD_MATURITY),
            dict(marketId=198, side='LONG', sizeToken=old_size,
                 entryApr=okx_entry, maturity=OLD_MATURITY),
        ])
    boros.append(dict(marketId=128, side='SHORT', sizeToken=3.6271309,
                      entryApr=0.079833, maturity=1798156800))
    for p in boros:
        p.update(marketAcc='0xc70f77072a7dae64ac4997c70dabbca39839cbbc000002ffffff',
                 base='ETH', tokenId=2, venue='HYPERLIQUID' if p['marketId'] in (196, 128) else 'OKX')
    return dict(ok=True, data=dict(assets=[dict(base='ETH', priceUsd=price, borosOpen=boros)],
        risk=dict(version=2, address='0xc70f77072a7dae64ac4997c70dabbca39839cbbc', accountId=0,
                  positionsComplete=True, stale=False, observedAt=NOW * 1000, positions=boros)))


def market(market_id, venue, mid, mark, short=None, long=None):
    return dict(marketId=market_id, venue=venue, midApr=mid, markApr=mark,
                execShortApr=short, execLongApr=long, bookStatus='ok')


def opportunity(exec_196=0.0798, exec_198=0.0536, exec_209=0.0745,
                exec_213=0.0513, mid_196=None, mid_198=None, mid_209=None,
                mid_213=None, taker_old=(0.0005, 0.0005),
                taker_new=(0.0005, 0.0005), maturity=NEW_MATURITY):
    mid_196 = exec_196 - 0.002 if mid_196 is None else mid_196
    mid_198 = exec_198 + 0.0036 if mid_198 is None else mid_198
    mid_209 = exec_209 + 0.0012 if mid_209 is None else mid_209
    mid_213 = exec_213 - 0.0009 if mid_213 is None else mid_213
    old_markets = [
        market(196, 'Hyperliquid', mid_196, mid_196 + 0.0001, exec_196, exec_196),
        market(198, 'OKX', mid_198, mid_198 - 0.0001, exec_198, exec_198),
    ]
    new_markets = [
        market(209, 'Hyperliquid', mid_209, mid_209 + 0.0003, exec_209, exec_209),
        market(213, 'OKX', mid_213, mid_213 + 0.0004, exec_213, exec_213),
    ]
    old_pair = dict(borosLegs=[
        dict(marketId=196, takerFeeRate=taker_old[0]),
        dict(marketId=198, takerFeeRate=taker_old[1]),
    ])
    new_pair = dict(borosLegs=[
        dict(marketId=209, takerFeeRate=taker_new[0]),
        dict(marketId=213, takerFeeRate=taker_new[1]),
    ])
    return dict(ok=True, data=dict(groups=[
        dict(maturity=OLD_MATURITY, underlying='ETH',
             markets=old_markets, pairs=[old_pair]),
        dict(maturity=maturity, underlying='ETH',
             markets=new_markets, pairs=[new_pair]),
    ]))


def market_terms(now=NOW):
    rows = []
    for mid in (196, 198, 209, 213):
        maturity = OLD_MATURITY if mid in (196, 198) else NEW_MATURITY
        period = 3600 if mid in (196, 209) else 28800
        rows.append(dict(marketId=mid, tokenId=2, imData=dict(maturity=maturity),
                         platform=dict(platformId='Hyperliquid' if mid in (196, 209) else 'OKX'),
                         config=dict(takerFee='500000000000000'),
                         extConfig=dict(settleFeeRate='1000000000000000', paymentPeriod=period),
                         data=dict(timeToMaturity=maturity-int(now)//period*period)))
    return dict(results=rows, resumeToken=None, syncStatus=dict(timestamp=now))


def simulation(blocker=None, gas=5.0, shortfall=0.0, size=SIZE, depth=100):
    blockers = [] if blocker is None else [dict(code='venue-refused', message=blocker)]
    ids = [198, 196, 213, 209]
    execs = [.0536, .0798, .0513, .0745]
    legs = [dict(marketId=mid, venue='OKX' if i % 2 == 0 else 'Hyperliquid', base='ETH',
                 direction='short' if i in (0, 3) else 'long', execApr=execs[i], midApr=execs[i],
                 slippageApr=.005 if i < 2 else .0025, sizeWithinTolerance=depth, bookStatus='ok',
                 sizing=dict(deltaSize=-size if i in (0, 3) else size, orderSide='short' if i in (0, 3) else 'long'))
            for i, mid in enumerate(ids)]
    def step(rows, maturity):
        return dict(simulation=dict(legs=rows, collateral='ETH', collateralPriceUsd=2500,
                    secondsToMaturity=maturity-NOW, estSpreadApr=.0212, takerDragApr=.001, reasons=[]),
                    gate=dict(warnings=[]))
    return dict(ok=True, data=dict(simulatedAtMs=NOW*1000,
        gate=dict(blockers=blockers, warnings=[], margin=dict(need=.04, availableBefore=.06,
                  availableAfterExit=.14, shortfall=shortfall, availableAfter=.1)), gasBalanceUsd=gas,
        venue=dict(status='Refused' if blocker else 'Succeed', orders=[dict(action='close' if i < 2 else 'open',
                   marketId=mid, filled=not bool(blocker), matchedSize=size if not blocker else None, error=None) for i, mid in enumerate(ids)]),
        exit=step(legs[:2], OLD_MATURITY), entry=step(legs[2:], NEW_MATURITY)))


class FakeTerminal:
    def __init__(self, asset=None, quotes=None, sim=None, terms=None):
        self.asset = asset if asset is not None else asset_view()
        self.quotes = quotes if quotes is not None else [opportunity()]
        self.sim = sim if sim is not None else simulation()
        self.terms = terms
        self.calls = []
        self.quote_index = 0
        self.now = NOW

    def __call__(self, url, token, timeout, data=None):
        self.calls.append((url, token, data))
        if 'api-boros.pendle.finance/apis/v1/markets/by-ids?' in url:
            assert token == '' and data is None
            if isinstance(self.terms, Exception): raise self.terms
            return copy.deepcopy(self.terms if self.terms is not None else market_terms(self.now))
        if '/api/asset-view/' in url:
            if isinstance(self.asset, Exception):
                raise self.asset
            result = copy.deepcopy(self.asset)
            result['data']['risk']['observedAt'] = self.now * 1000
            return result
        if '/api/opportunities?' in url:
            quote = self.quotes[min(self.quote_index, len(self.quotes) - 1)]
            self.quote_index += 1
            return copy.deepcopy(quote)
        if url.endswith('/api/boros/roll/simulate'):
            if isinstance(self.sim, Exception):
                raise self.sim
            q = json.loads(data)['exit']['legs'][0]['size']
            result = copy.deepcopy(self.sim(q) if callable(self.sim) else self.sim)
            d = result['data']; d['simulatedAtMs'] = self.now * 1000
            for name, maturity in (('exit', OLD_MATURITY), ('entry', NEW_MATURITY)):
                d[name]['simulation']['secondsToMaturity'] = maturity - self.now
                for leg in d[name]['simulation']['legs']:
                    leg['sizing']['deltaSize'] = q if leg['sizing']['deltaSize'] > 0 else -q
            for order in d['venue']['orders']:
                if order['filled']: order['matchedSize'] = q
            return result
        raise AssertionError('unexpected URL ' + url)


class RolloverWatchTest(unittest.TestCase):
    def test_fee_clock_rounding_and_cash_comparison_are_separate_from_risk_discount(self):
        from decimal import Decimal, ROUND_CEILING
        agg = self.module.aggregate_samples([self.module.extract_sample(opportunity()['data'])])
        terms = self.module.parse_market_terms(market_terms(), NOW)
        c = self.module.compute(NOW, 2500, agg, [], dt.datetime.fromtimestamp(NOW, TZ).date(), 1.6,
                                terms=terms)
        fees = {m: (Decimal('1.6') * Decimal(t['taker_raw']) * t['fee_seconds'] / 31536000)
                .to_integral_value(rounding=ROUND_CEILING) for m, t in terms.items()}
        self.assertEqual(c['fee_A_eth_by_market'], {str(m): str(v / Decimal(10)**18) for m, v in fees.items()})
        self.assertGreater(c['settlement_A'], 0)
        self.assertAlmostEqual(c['settlement_A'], c['settlement_B'])
        self.assertLess(c['A_minus_B_cash_ref'], 0)
        self.assertGreater(c['A_minus_B_risk_adjusted_ref'], 0)
        self.assertAlmostEqual(c['S_r_star'] - c['S_r_star_cash'], .005)
        zero = self.module.compute(NOW, 2500, agg, [], dt.datetime.fromtimestamp(NOW, TZ).date(), 1.6,
                                   terms=terms, risk_premium=0)
        self.assertEqual(zero['A'], c['A'])
        self.assertEqual(zero['A_minus_B_cash_ref'], zero['A_minus_B_risk_adjusted_ref'])
        self.assertEqual(zero['S_r_star'], zero['S_r_star_cash'])

    def test_missing_or_stale_fee_clocks_do_not_produce_profit_or_tendency(self):
        payload = market_terms()
        payload['syncStatus']['timestamp'] = NOW-121
        with self.assertRaises(self.module.WatchError):
            self.module.parse_market_terms(payload, NOW)
        agg = self.module.aggregate_samples([self.module.extract_sample(opportunity()['data'])])
        c = self.module.compute(NOW, 2500, agg, [], dt.datetime.fromtimestamp(NOW, TZ).date())
        self.assertIsNone(c['A'])
        self.assertIsNone(c['S_r_star'])

    def test_bad_market_evidence_is_rejected_and_not_replaced_with_fallback_fees(self):
        for kind in ('duplicate', 'currency', 'maturity', 'rate', 'clock', 'pagination'):
            data = market_terms()
            if kind == 'duplicate': data['results'][0] = data['results'][1]
            if kind == 'currency': data['results'][0]['tokenId'] = 3
            if kind == 'maturity': data['results'][0]['imData']['maturity'] += 86400
            if kind == 'rate': data['results'][0]['extConfig']['settleFeeRate'] = None
            if kind == 'clock': data['results'][0]['data']['timeToMaturity'] += 1
            if kind == 'pagination': data['resumeToken'] = 'more'
            with self.subTest(kind=kind), self.assertRaises(self.module.WatchError):
                self.module.parse_market_terms(data, NOW)
        code, row = self.run_json(FakeTerminal(terms=RuntimeError('unavailable')))
        self.assertEqual(code, 2)
        self.assertIsNone(row['A_usd'])
        self.assertIsNone(row['M'])

    def test_public_terms_get_never_receives_the_local_token_or_allows_public_posts(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return b'{}'
        class Opener:
            def open(self, req, timeout):
                self.request = req
                return Response()
        opener = Opener()
        with patch.object(self.module.request, 'build_opener', return_value=opener):
            self.module.fetch_json(self.module.TERMS_URL, TOKEN, 1)
        self.assertNotIn(TOKEN, str(opener.request.headers))
        self.assertEqual(opener.request.method, 'GET')
        with self.assertRaises(self.module.WatchError):
            self.module.fetch_json(self.module.TERMS_URL, TOKEN, 1, b'{}')

    def test_v2_profit_history_is_incompatible_with_v3(self):
        today = dt.datetime.fromtimestamp(NOW, TZ).date()
        history = [dict(v=2, now_unix=NOW, S=.0001, A_usd=999, M=-99)]
        self.assertEqual(self.module.consensus_min(history, today, .023, SIZE), .023)
        self.assertEqual(self.module.previous_row(history, today, SIZE), (None, None))

    def test_settlement_costs_differ_when_old_and_new_fee_rates_differ(self):
        data = market_terms()
        for row in data['results']:
            if row['marketId'] in (209, 213): row['extConfig']['settleFeeRate'] = '2000000000000000'
        terms = self.module.parse_market_terms(data, NOW)
        agg = self.module.aggregate_samples([self.module.extract_sample(opportunity()['data'])])
        c = self.module.compute(NOW, 2500, agg, [], dt.datetime.fromtimestamp(NOW, TZ).date(), terms=terms)
        self.assertGreater(c['settlement_A'], c['settlement_B'])
        cash_a = (self.module.L-c['E'])*c['t_old']*c['N']+c['S']*c['t_new']*c['N']-c['fee_A']-c['settlement_A']
        self.assertAlmostEqual(c['A'], cash_a)

    def partial_asset(self, rolled):
        data = asset_view(old_size=SIZE-rolled)
        rows = data['data']['risk']['positions']
        for mid, side, venue in ((209, 'SHORT', 'HYPERLIQUID'), (213, 'LONG', 'OKX')):
            rows.append(dict(marketId=mid, side=side, venue=venue, sizeToken=rolled, base='ETH', tokenId=2,
                             marketAcc=self.module.ADDRESS+'000002ffffff', maturity=NEW_MATURITY, entryApr=.05))
        return data

    def test_full_failure_finds_a_prime_and_quotes_the_verified_size(self):
        fake = FakeTerminal(sim=lambda q: simulation(blocker='depth' if q > 1.99 else None, depth=1.980117))
        code, row = self.run_json(fake, args=['--receipt-success'])
        self.assertEqual(code, 0)
        self.assertFalse(row['full_batch_ready'])
        self.assertTrue(row['batch_ready'])
        self.assertEqual(row['roll_path'], 'A_PRIME')
        self.assertAlmostEqual(row['quote_size_eth'], 1.98)
        self.assertAlmostEqual(row['N_usd'], 1.98*2500)
        quote_urls = [url for url, _, _ in fake.calls if '/api/opportunities?' in url]
        self.assertTrue(all('notionalUsd=4950' in url for url in quote_urls))
        self.assertIsNone(row['A_after_batch_overhead_usd'])
        _, report = self.run_watch(FakeTerminal(sim=lambda q: simulation(blocker='depth' if q > 1.99 else None, depth=1.980117)))
        self.assertIn('A′', report)
        self.assertNotIn('CRITICAL', report)

    def test_partial_progress_quotes_remaining_and_ignores_other_maturities(self):
        fake = FakeTerminal(asset=self.partial_asset(1))
        _, row = self.run_json(fake, args=['--batch-overhead-usd', '.25'])
        self.assertEqual(row['progress_state'], 'PARTIAL')
        self.assertEqual(row['rolled_eth'], 1)
        self.assertAlmostEqual(row['remaining_eth'], SIZE-1)
        self.assertAlmostEqual(row['quote_size_eth'], SIZE-1)
        self.assertAlmostEqual(row['A_after_batch_overhead_usd'], row['A_usd']-.25)
        posts = [json.loads(body) for _, _, body in fake.calls if body]
        self.assertTrue(all(abs(leg['size']-(SIZE-1)) < 1e-9 for body in posts for leg in body['exit']['legs']))

    def test_imbalanced_partial_positions_are_not_treated_as_completed(self):
        asset = self.partial_asset(1)
        asset['data']['risk']['positions'] = [p for p in asset['data']['risk']['positions'] if p['marketId'] != 196]
        fake = FakeTerminal(asset=asset)
        _, report = self.run_watch(fake)
        self.assertIn('不给建议', report)
        self.assertNotIn('盯盘结束', report)
        self.assertFalse(any(body for _, _, body in fake.calls))

    def test_history_is_compared_only_at_the_same_quote_size(self):
        today = dt.datetime.fromtimestamp(NOW, TZ).date()
        history = [dict(v=3, quote_size_eth=SIZE, now_unix=NOW, S=.001), dict(v=3, now_unix=NOW, quote_size_eth=1, S=.03)]
        self.assertEqual(self.module.consensus_min(history, today, .025, 1), .025)
        self.assertEqual(self.module.consensus_min(history, today, .025, SIZE), .001)

    def test_pending_execution_never_probes_or_recommends_a_new_batch(self):
        fake = FakeTerminal()
        _, row = self.run_json(fake, args=['--execution-pending'])
        self.assertIsNone(row['batch_ready'])
        self.assertEqual(row['roll_path'], 'UNKNOWN')
        self.assertFalse(any(body for _, _, body in fake.calls))
        self.assertTrue(any('禁止' in warn for warn in row['warns']))

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location(
            'rollover_watch', ROOT / 'scripts/rollover_watch.py')
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.token = self.dir / 'token'
        self.token.write_text(TOKEN)
        self.ledger = self.dir / 'rollover-watch.jsonl'
        self.latest = self.dir / 'latest.json'

    def run_watch(self, terminal, now=NOW, args=None):
        terminal.now = now
        argv = [
            '--token-file', str(self.token),
            '--ledger', str(self.ledger),
            '--latest-json', str(self.latest),
            '--samples', '3',
            '--interval-seconds', '0',
        ] + (args or [])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = self.module.run(argv, fetch=terminal, now=lambda: now,
                                   sleep=lambda _: None)
        return code, output.getvalue()

    def run_json(self, terminal, now=NOW, args=None):
        code, output = self.run_watch(terminal, now, ['--json'] + (args or []))
        return code, json.loads(output)

    def test_three_samples_use_medians_and_record_required_v3_fields(self):
        quotes = [
            opportunity(exec_209=0.073, exec_213=0.051),
            opportunity(exec_209=0.075, exec_213=0.051),
            opportunity(exec_209=0.077, exec_213=0.051),
        ]
        fake = FakeTerminal(quotes=quotes)
        code, row = self.run_json(fake)

        self.assertEqual(code, 0)
        self.assertEqual(row['v'], 3)
        self.assertEqual(row['watch_scope'], {'address': self.module.ADDRESS, 'account_id': 0,
                                             'size': SIZE, 'terminal': 'http://127.0.0.1:6688'})
        self.assertEqual(row['sample_count'], 3)
        self.assertEqual(row['sample_interval_seconds'], 0)
        self.assertAlmostEqual(row['S'], 0.024, places=12)
        self.assertAlmostEqual(row['S_min'], 0.022, places=12)
        self.assertAlmostEqual(row['S_max'], 0.026, places=12)
        self.assertAlmostEqual(row['E'], 0.0262, places=12)
        self.assertEqual(row['gate_G'], 'VERIFIED')
        self.assertEqual(row['fee_source'], 'market-clock')
        self.assertAlmostEqual(row['f_x'], 0.001)
        self.assertAlmostEqual(row['f_n'], 0.001)
        self.assertEqual(set(row['exec']), {'196', '198', '209', '213'})
        self.assertEqual(set(row['mid']), {'196', '198', '209', '213'})

        N = SIZE * 2500.0
        t_old = (OLD_MATURITY - NOW) / 31536000
        t_new = (NEW_MATURITY - NOW) / 31536000
        t_reopen = t_new - t_old
        terms = self.module.parse_market_terms(market_terms(), NOW)
        fee_a = sum(float(v) for v in self.module.clock_trade_fees(SIZE, terms).values())*2500
        fee_b = 0.001 * t_reopen * N
        r_b = 0.005 * t_reopen * N
        a = (0.046595 - 0.0262) * t_old * N + 0.024 * t_new * N - fee_a - .002*t_new*N
        s_r_star = (a - 0.046595 * t_old * N + fee_b + .002*t_new*N + r_b) / (t_reopen * N)
        self.assertAlmostEqual(row['N_usd'], N, places=9)
        self.assertAlmostEqual(row['fee_A'], fee_a, places=9)
        self.assertAlmostEqual(row['fee_B'], fee_b, places=9)
        self.assertAlmostEqual(row['R_B'], r_b, places=9)
        self.assertAlmostEqual(row['A_usd'], a, places=9)
        self.assertAlmostEqual(row['S_r_star'], s_r_star, places=12)
        self.assertAlmostEqual(row['S_cons'], 0.024, places=12)
        self.assertAlmostEqual(row['M'], 0.024 - s_r_star, places=12)

        ledger = [json.loads(line) for line in self.ledger.read_text().splitlines()]
        self.assertEqual(len(ledger), 1)
        self.assertEqual(ledger[0], row)
        self.assertNotIn(TOKEN, json.dumps(row))

        posts = [call for call in fake.calls if call[2] is not None]
        self.assertEqual(len(posts), 1)
        self.assertTrue(posts[0][0].endswith('/api/boros/roll/simulate'))
        body = json.loads(posts[0][2])
        exit_legs = {leg['marketId']: leg for leg in body['exit']['legs']}
        self.assertEqual(exit_legs[198]['slippageApr'], 0.005)
        self.assertEqual(exit_legs[196]['slippageApr'], 0.005)
        self.assertTrue(all(leg['slippageApr'] == .0025 for leg in body['entry']['legs']))

    def test_chinese_report_starts_with_conclusion_table_and_advice(self):
        fake = FakeTerminal()
        code, report = self.run_watch(fake, args=['--b-approved'])
        self.assertEqual(code, 0)
        self.assertTrue(report.startswith('结论：'))
        self.assertIn('| 指标 | 今日 | 较昨日 |', report)
        self.assertIn('| S |', report)
        self.assertIn('| E |', report)
        self.assertIn('| S_r* |', report)
        self.assertIn('| S_cons |', report)
        self.assertIn('| M |', report)
        self.assertIn('| A_usd |', report)
        self.assertIn('| X_max |', report)
        self.assertIn('| G | VERIFIED |', report)
        self.assertIn('当日建议：', report)
        self.assertIn('纯现金倾向：', report)
        self.assertIn('不是实付费用', report)
        self.assertIn('不是到手净利润', report)
        self.assertIn('A′', report)
        self.assertNotIn(TOKEN, report)

    def test_old_leg_entry_mismatch_is_warned_recorded_and_advice_suppressed(self):
        fake = FakeTerminal(asset=asset_view(hl_entry=0.08))
        code, report = self.run_watch(fake)
        self.assertEqual(code, 0)
        self.assertIn('当日不给建议', report)
        row = json.loads(self.ledger.read_text().splitlines()[0])
        self.assertTrue(any('locked entry changed' in warn for warn in row['warns']))
        self.assertIsNotNone(row['A_usd'])

    def test_missing_old_legs_end_the_watch_without_quotes(self):
        fake = FakeTerminal(asset=asset_view(old_present=False))
        code, report = self.run_watch(fake)
        self.assertEqual(code, 0)
        self.assertIn('盯盘结束', report)
        self.assertIn('旧腿 196/198 不在仓', report)
        self.assertEqual(fake.quote_index, 0)
        row = json.loads(self.ledger.read_text().splitlines()[0])
        self.assertIsNone(row['A_usd'])
        self.assertEqual(row['v'], 3)

    def test_unreachable_terminal_reports_unknown_and_writes_nothing(self):
        fake = FakeTerminal()
        fake.asset = RuntimeError('connection refused')
        code, output = self.run_watch(fake)
        self.assertEqual(code, 2)
        self.assertIn('UNKNOWN', output)
        self.assertIn('留待下轮', output)
        self.assertFalse(self.ledger.exists())

    def test_missing_opportunity_fee_rates_use_verified_market_config(self):
        quote = opportunity(taker_old=(None, None))
        code, row = self.run_json(FakeTerminal(quotes=[quote]))
        self.assertEqual(code, 0)
        self.assertAlmostEqual(row['f_x'], 0.001)
        self.assertAlmostEqual(row['f_n'], 0.001)
        self.assertEqual(row['fee_source'], 'market-clock')
        self.assertFalse(any('回退' in warn for warn in row['warns']))

    def test_slippage_over_half_a_percent_blocks_the_roll(self):
        quote = opportunity(exec_198=0.06, mid_198=0.03)
        code, report = self.run_watch(FakeTerminal(quotes=[quote]))
        self.assertEqual(code, 0)
        self.assertIn('其他规模须另行预检', report)
        self.assertIn('滑点检查未过', report)
        row = json.loads(self.ledger.read_text().splitlines()[0])
        self.assertGreater(row['X_max'], 0.005)

    def test_missing_slippage_evidence_is_unknown_not_an_over_limit_critical(self):
        quote = opportunity()
        del quote['data']['groups'][0]['markets'][1]['midApr']
        code, report = self.run_watch(FakeTerminal(quotes=[quote]))
        self.assertEqual(code, 0)
        self.assertIn('滑点字段缺失', report)
        self.assertIn('A/A′ 无法确认', report)
        self.assertNotIn('CRITICAL', report)
        row = json.loads(self.ledger.read_text().splitlines()[0])
        self.assertIsNone(row['X_max'])

    def test_full_failure_and_no_verified_smaller_candidate_stays_unknown(self):
        fake = FakeTerminal(sim=simulation(
            blocker='Exit · OKX ETHUSDT 30 Oct 2026 — Slippage too high: only 2.1374 ETH fills'))
        code, report = self.run_watch(fake)
        self.assertEqual(code, 0)
        self.assertIn('A′状态UNKNOWN', report)
        self.assertIn('venue-refused', report)
        self.assertIn('B 未获批', report)
        self.assertIn('人工决策', report)
        row = json.loads(self.ledger.read_text().splitlines()[0])
        self.assertTrue(any('滚门禁未确认' in warn for warn in row['warns']))

    def test_blocked_roll_with_approved_b_points_to_b(self):
        fake = FakeTerminal(sim=simulation(blocker='depth too thin'))
        code, report = self.run_watch(fake, args=['--b-approved'])
        self.assertEqual(code, 0)
        self.assertNotIn('CRITICAL', report)
        self.assertIn('B 已获批', report)

    def test_simulate_failure_keeps_the_economics_and_marks_the_gate_unknown(self):
        fake = FakeTerminal(sim=RuntimeError('timeout'))
        code, row = self.run_json(fake)
        self.assertEqual(code, 0)
        self.assertIsNotNone(row['A_usd'])
        self.assertTrue(any('roll simulate 失败' in warn for warn in row['warns']))

    def test_new_maturity_mismatch_is_a_warning(self):
        quote = opportunity(maturity=NEW_MATURITY + 86400)
        code, row = self.run_json(FakeTerminal(quotes=[quote]))
        self.assertEqual(code, 2)
        self.assertIsNone(row['A_usd'])
        self.assertTrue(any('不符' in warn for warn in row['warns']))

    def test_consensus_uses_only_three_natural_days_of_v3_rows(self):
        today = dt.datetime.fromtimestamp(NOW, TZ).date()
        rows = [
            dict(v=1, ts='2026-10-16T09:00:00+08:00', S=0.0001),
            dict(v=3, quote_size_eth=SIZE, now_unix=int(dt.datetime.combine(
                today - dt.timedelta(days=3), dt.time(9), TZ).timestamp()), S=0.0005),
            dict(v=3, quote_size_eth=SIZE, now_unix=int(dt.datetime.combine(
                today - dt.timedelta(days=2), dt.time(9), TZ).timestamp()), S=0.019),
            dict(v=3, quote_size_eth=SIZE, now_unix=int(dt.datetime.combine(
                today - dt.timedelta(days=1), dt.time(9), TZ).timestamp()), S=0.020),
        ]
        self.ledger.write_text('\n'.join(json.dumps(row) for row in rows) + '\n')

        quote = opportunity(exec_209=0.075, exec_213=0.051)
        code, row = self.run_json(FakeTerminal(quotes=[quote]))
        self.assertEqual(code, 0)
        self.assertAlmostEqual(row['S'], 0.024)
        self.assertAlmostEqual(row['S_cons'], 0.019)
        self.assertNotAlmostEqual(row['S_cons'], 0.0005)
        self.assertNotAlmostEqual(row['S_cons'], 0.0001)

    def test_report_compares_with_yesterday(self):
        today = dt.datetime.fromtimestamp(NOW, TZ).date()
        yesterday = int(dt.datetime.combine(
            today - dt.timedelta(days=1), dt.time(9), TZ).timestamp())
        self.ledger.write_text(json.dumps(dict(
            v=3, quote_size_eth=SIZE, now_unix=yesterday, S=0.020, E=0.030, S_r_star=0.028,
            S_cons=0.019, M=-0.008)) + '\n')
        fake = FakeTerminal(quotes=[opportunity(exec_209=0.075, exec_213=0.051)])
        code, report = self.run_watch(fake)
        self.assertEqual(code, 0)
        self.assertIn('（变化列：较昨日）', report)
        self.assertIn('+40.00bp', report)

    def test_b_tendency_with_approval_is_an_executable_b_advice(self):
        quote = opportunity(exec_196=0.11, exec_198=0.05,
                            mid_196=0.1105, mid_198=0.0505,
                            exec_209=0.0713, mid_209=0.0720)
        fake = FakeTerminal(quotes=[quote])
        code, report = self.run_watch(fake, args=['--b-approved'])
        self.assertEqual(code, 0)
        self.assertIn('倾向 B', report)
        self.assertIn('B 已获批', report)
        self.assertIn('按 B 执行清单准备', report)

    def test_decision_point_lists_cashflows_and_picks_approved_b(self):
        quote = opportunity(exec_196=0.11, exec_198=0.05,
                            mid_196=0.1105, mid_198=0.0505,
                            exec_209=0.0713, mid_209=0.0720)
        fake = FakeTerminal(quotes=[quote])
        code, report = self.run_watch(fake, now=DECISION_NOW, args=['--b-approved'])
        self.assertEqual(code, 0)
        self.assertIn('二次决策点', report)
        self.assertIn('A 现金流', report)
        self.assertIn('B 现金流', report)
        self.assertIn('到期日值守', report)
        self.assertIn('资金费空档', report)
        self.assertIn('二选一建议：B', report)

    def test_decision_point_without_b_approval_chooses_the_roll(self):
        quote = opportunity(exec_196=0.11, exec_198=0.05,
                            mid_196=0.1105, mid_198=0.0505,
                            exec_209=0.0713, mid_209=0.0720)
        fake = FakeTerminal(quotes=[quote])
        code, report = self.run_watch(fake, now=DECISION_NOW)
        self.assertEqual(code, 0)
        self.assertIn('B 未获批', report)
        self.assertIn('二选一建议：滚（A′）', report)

    def test_decision_point_prefers_approved_b_when_the_roll_is_blocked(self):
        fake = FakeTerminal(sim=simulation(blocker='depth too thin'))
        code, report = self.run_watch(fake, now=DECISION_NOW, args=['--b-approved'])
        self.assertEqual(code, 0)
        self.assertIn('二选一建议：B（滚不可执行，B 已获批）', report)
        self.assertIn('二次决策点：选 B', report)
        self.assertNotIn('两者均不可执行', report)

    def test_funding_gap_over_300_seconds_is_critical(self):
        self.latest.write_text(json.dumps(dict(checks=[dict(metrics=dict(
            **{'rollover.uncovered_funding_seconds': dict(value=400)}))])))
        code, report = self.run_watch(FakeTerminal())
        self.assertEqual(code, 0)
        self.assertIn('资金费空档 400 秒', report)
        row = json.loads(self.ledger.read_text().splitlines()[0])
        self.assertTrue(any('CRITICAL' in warn for warn in row['warns']))

    def test_no_write_leaves_the_ledger_absent(self):
        fake = FakeTerminal()
        code, _ = self.run_watch(fake, args=['--no-write'])
        self.assertEqual(code, 0)
        self.assertFalse(self.ledger.exists())


if __name__ == '__main__':
    unittest.main()
