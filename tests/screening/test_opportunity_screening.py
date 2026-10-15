"""Synthetic API → single run → saved reports. No live account fixtures."""
import copy
import contextlib
import io
import importlib.util
import json
import pathlib
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit

ROOT = pathlib.Path(__file__).resolve().parents[2]
NOW = 1791374400

def response(mode='close', count=1):
    pairs, markets = [], []
    for i in range(count):
        legs = []
        for offset, venue in [(1, 'OKX'), (2, 'BINANCE')]:
            leg = dict(marketId=i * 2 + offset, venue=venue, crossexVenue=venue.lower(), crossexSymbol=venue + '_ETH_USDT', base='ETH', midApr=.12, execApr=.1, settleFeeApr=.001)
            legs.append(leg)
            markets.append(dict(leg, bookStatus='ok', execShortApr=.1, execLongApr=.1, oiUsd=100000))
        pairs.append(dict(base='ETH', shortLeg=legs[0], longLeg=legs[1], grossSpreadApr=.08, execSpreadApr=.06, borosImpactApr=.02, makerLeg='short', costs=dict(borosTakerFeeUsd=2, borosSettleFeeUsd=2, perpEntryFeesUsd=2, perpEntrySlippageUsd=2, perpExitFeesUsd=0 if mode == 'roll' else 2, perpExitSlippageUsd=0 if mode == 'roll' else 2, totalUsd=8 if mode == 'roll' else 12, annualizedApr=.01), capital=dict(borosShortImUsd=100, borosLongImUsd=100, perpShortImUsd=100, perpLongImUsd=100, shortLeverageMax=100, longLeverageMax=100), capitalUsd=400, netFixedApr=.05, netFixedAprOnCapital=1.25, effectiveLeverage=25, estProfitUsd=50 + i, secondsToMaturity=3153600, reasons=[]))
    return dict(ok=True, meta=dict(observedAt=NOW * 1000, credentialId='synthetic-secret-id'), data=dict(meta=dict(asOfSec=NOW, notionalUsd=10000, borosEntry='market', entryMode='maker-hedge', exitMode=mode, freshness=dict(marketData=dict(observedAt=NOW * 1000, stale=False), staticData=dict(observedAt=NOW * 1000, stale=False))), groups=[dict(tokenId=1, collateral='USDT', maturity=NOW + 3153600, secondsToMaturity=3153600, underlying='ETH', markets=markets, pairs=pairs, warnings=[])], warnings=[]))

class ScreeningTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('opportunity_screening', ROOT / 'scripts/opportunity_screening.py')
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def run_scan(self, close=None, roll=None, extra=None):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls = []
        def fetch(url, token, timeout):
            self.calls.append((url, token, timeout))
            mode = parse_qs(urlsplit(url).query)['exitMode'][0]
            return copy.deepcopy(close if mode == 'close' else roll)
        token = pathlib.Path(self.temp.name) / 'token'
        token.write_text('synthetic-token')
        args = ['--token-file', str(token), '--output-dir', self.temp.name] + (extra or [])
        with contextlib.redirect_stdout(io.StringIO()):
            code = self.module.run(args, fetch=fetch, now=lambda: NOW)
        files = list(pathlib.Path(self.temp.name).glob('*/report.json'))
        result = json.loads(files[0].read_text()) if files else None
        self.md = files[0].with_suffix('.md').read_text() if files else ''
        return code, result

    def test_single_scan_copies_api_values_and_writes_private_dual_reports(self):
        code, report = self.run_scan(response(), response('roll'))
        self.assertEqual(code, 0)
        self.assertEqual(report['candidates'][0]['estProfitUsd'], 50)
        self.assertEqual(report['candidates'][0]['netFixedAprOnCapital'], 1.25)
        self.assertEqual(report['candidates'][0]['roll']['costs']['totalUsd'], 8)
        self.assertIn('125.00%', self.md)
        self.assertNotIn('synthetic-secret-id', json.dumps(report) + self.md)
        self.assertNotIn('synthetic-token', json.dumps(report) + self.md)
        self.assertEqual(len(self.calls), 2)
        for url, token, timeout in self.calls:
            self.assertEqual(urlsplit(url).path, '/api/opportunities')
            self.assertEqual(parse_qs(urlsplit(url).query)['entryMode'], ['maker-hedge'])
            self.assertEqual(parse_qs(urlsplit(url).query)['borosEntry'], ['market'])
        for file in pathlib.Path(self.temp.name).glob('*/report.*'):
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def current_response(self, mode='close'):
        envelope = response(mode)
        pair = envelope['data']['groups'][0]['pairs'][0]
        pair['borosLegs'] = []
        for side in ('short', 'long'):
            leg = pair[side + 'Leg']
            pair['borosLegs'].append(dict(marketId=leg.pop('marketId'), side=side.upper(),
                                         venue=leg['venue'], spreadVenues=None, execApr=leg.pop('execApr')))
        capital = pair['capital']
        capital['borosIms'] = [dict(marketId=1, imUsd=capital.pop('borosShortImUsd')),
                               dict(marketId=2, imUsd=capital.pop('borosLongImUsd'))]
        return envelope

    def test_current_api_separate_boros_legs_preserve_values_and_roll_matching(self):
        code, report = self.run_scan(self.current_response(), self.current_response('roll'))
        self.assertEqual(code, 0)
        row = report['candidates'][0]
        self.assertEqual(row['shortLeg']['marketId'], 1)
        self.assertEqual(row['longLeg']['marketId'], 2)
        self.assertEqual(row['estProfitUsd'], 50)
        self.assertEqual(row['capital']['borosShortImUsd'], 100)
        self.assertEqual(row['roll']['costs']['totalUsd'], 8)

    def test_current_api_unsupported_or_incomplete_boros_plans_remain_unknown(self):
        for kind in ('empty', 'spread', 'capital', 'venue'):
            with self.subTest(kind=kind):
                close = self.current_response()
                pair = close['data']['groups'][0]['pairs'][0]
                if kind == 'empty':
                    pair['borosLegs'] = []
                elif kind == 'spread':
                    pair['borosLegs'][0]['spreadVenues'] = ['OKX', 'BINANCE']
                    pair['borosLegs'].pop()
                elif kind == 'capital':
                    pair['capital']['borosIms'][0]['marketId'] = 999
                else:
                    pair['borosLegs'][0]['venue'] = 'HYPERLIQUID'
                code, report = self.run_scan(close, self.current_response('roll'))
                self.assertEqual(code, 2)
                self.assertEqual(report['candidates'], [])
                self.assertEqual(report['excluded'][0]['status'], 'UNKNOWN')

    def test_assumed_fees_are_reference_only_unknown(self):
        close = response()
        close['data']['warnings'] = ['Perp fees assume the VIP0 Gate CrossEx schedule — secret synthetic-token']
        close['data']['warningEvidence'] = [dict(code='assumed-fee-schedule')]
        code, report = self.run_scan(close, response('roll'))
        self.assertEqual(code, 2)
        self.assertEqual(report['candidates'], [])
        self.assertEqual(report['excluded'][0]['reference']['values']['estProfitUsd'], 50)
        self.assertNotIn('synthetic-token', json.dumps(report) + self.md)

    def test_malformed_nested_evidence_produces_degraded_report(self):
        for field, value in [('shortLeg', []), ('longLeg', None), ('secondsToMaturity', 'one'), ('capitalUsd', True)]:
            with self.subTest(field=field):
                close = response()
                close['data']['groups'][0]['pairs'][0][field] = value
                code, report = self.run_scan(close, response('roll'))
                self.assertEqual(code, 2)
                self.assertEqual(report['candidates'], [])

    def test_invalid_values_never_rank(self):
        for value in (None, float('nan'), float('inf'), True, '50', {}, []):
            with self.subTest(value=value):
                close = response()
                close['data']['groups'][0]['pairs'][0]['estProfitUsd'] = value
                code, report = self.run_scan(close, response('roll'))
                self.assertEqual(code, 2)
                self.assertEqual(report['candidates'], [])
                self.assertNotIn('NaN', json.dumps(report))

    def test_nonpositive_profit_is_normal_filter_and_empty_scan_is_valid(self):
        for profit in (-10, 0):
            close = response()
            close['data']['groups'][0]['pairs'][0]['estProfitUsd'] = profit
            code, report = self.run_scan(close, response('roll'))
            self.assertEqual(code, 0)
            self.assertEqual(report['candidates'], [])
            self.assertEqual(report['excluded'][0]['status'], 'FILTERED')
        self.assertEqual(self.run_scan(response(count=0), response('roll', count=0))[0], 0)

    def test_friction_uses_gross_spread_and_strict_configurable_limit(self):
        close = response()
        pair = close['data']['groups'][0]['pairs'][0]
        # gross = .08 * 10000 * .5 = 400; execution spread is deliberately different.
        close['data']['groups'][0]['maturity'] = NOW + 15768000
        close['data']['groups'][0]['secondsToMaturity'] = pair['secondsToMaturity'] = 15768000
        pair['costs']['totalUsd'] = 160
        roll = copy.deepcopy(close)
        roll['data']['meta']['exitMode'] = 'roll'
        code, report = self.run_scan(close, roll)
        self.assertEqual(code, 0)
        self.assertEqual(report['candidates'], [])
        item = report['excluded'][0]
        self.assertEqual(item['status'], 'FILTERED')
        self.assertEqual(item['grossProfitUsd'], 400)
        self.assertEqual(item['friction'], .4)
        self.assertIn('friction is not below the configured maximum', item['reasons'])
        code, report = self.run_scan(close, roll, ['--max-friction', '.41'])
        self.assertEqual(code, 0)
        self.assertEqual(report['candidates'][0]['friction'], .4)
        self.assertEqual(report['candidates'][0]['roll']['status'], 'VALID')
        pair['costs']['totalUsd'] = 159.999
        self.assertEqual(len(self.run_scan(close, roll)[1]['candidates']), 1)

    def test_minimum_net_profit_is_notional_ratio_with_strict_boundary(self):
        for profit, included in ((9.99, False), (10, False), (10.01, True)):
            close = response()
            close['data']['groups'][0]['pairs'][0]['estProfitUsd'] = profit
            code, report = self.run_scan(close, response('roll'))
            self.assertEqual(code, 0)
            self.assertEqual(bool(report['candidates']), included)
            self.assertEqual(report['assumptions']['minProfitRatio'], .001)
            self.assertEqual(report['assumptions']['minProfitUsd'], 10)
            self.assertEqual(report['assumptions']['maxFriction'], .4)
        close['data']['groups'][0]['pairs'][0]['estProfitUsd'] = 10
        self.assertEqual(len(self.run_scan(close, response('roll'), ['--min-profit-ratio', '0'])[1]['candidates']), 1)
        self.assertEqual(self.run_scan(response(), response('roll'), ['--min-profit-ratio', '.005'])[1]['candidates'], [])

    def test_minimum_profit_scales_with_per_leg_notional(self):
        close, roll = response(), response('roll')
        for envelope in (close, roll):
            envelope['data']['meta']['notionalUsd'] = 20000
        for profit, included in ((20, False), (20.01, True)):
            close['data']['groups'][0]['pairs'][0]['estProfitUsd'] = profit
            code, report = self.run_scan(close, roll, ['--notional', '20000'])
            self.assertEqual(code, 0)
            self.assertEqual(report['assumptions']['minProfitUsd'], 20)
            self.assertEqual(bool(report['candidates']), included)

    def test_new_gates_preserve_roll_comparison_and_unknown_priority(self):
        roll = response('roll')
        roll['data']['groups'][0]['pairs'][0]['estProfitUsd'] = -1
        roll['data']['groups'][0]['pairs'][0]['costs']['totalUsd'] = 1000
        code, report = self.run_scan(response(), roll)
        self.assertEqual(code, 0)
        self.assertEqual(report['candidates'][0]['roll']['status'], 'VALID')
        close = response()
        close['data']['groups'][0]['pairs'][0]['estProfitUsd'] = 1
        close['data']['groups'][0]['pairs'][0]['costs']['totalUsd'] = None
        code, report = self.run_scan(close, roll)
        self.assertEqual(code, 2)
        self.assertEqual(report['excluded'][0]['status'], 'UNKNOWN')

    def test_friction_denominator_and_numeric_range_are_handled_explicitly(self):
        for spread in (0, -.01):
            close = response()
            close['data']['groups'][0]['pairs'][0]['grossSpreadApr'] = spread
            code, report = self.run_scan(close, response('roll'))
            self.assertEqual(code, 0)
            self.assertEqual(report['candidates'], [])
            self.assertEqual(report['excluded'][0]['status'], 'FILTERED')
            self.assertIsNone(report['excluded'][0]['friction'])
        for spread in (1e308, 1e-312):
            close['data']['groups'][0]['pairs'][0]['grossSpreadApr'] = spread
            code, report = self.run_scan(close, response('roll'))
            self.assertEqual(code, 2)
            self.assertEqual(report['excluded'][0]['status'], 'UNKNOWN')
            self.assertNotIn('Infinity', json.dumps(report))

    def test_gate_parameters_are_validated_before_requests(self):
        for extra in (['--max-friction', '0'], ['--max-friction', '-1'],
                      ['--max-friction', 'nan'], ['--max-friction', 'inf'],
                      ['--min-profit-ratio', '-1'], ['--min-profit-ratio', 'nan'],
                      ['--min-profit-ratio', 'inf'], ['--min-profit-ratio', '1e308']):
            code, report = self.run_scan(response(), response('roll'), extra)
            self.assertEqual(code, 1)
            self.assertIsNone(report)
            self.assertEqual(self.calls, [])

    def test_gate_values_and_explanations_are_present_in_both_formats(self):
        code, report = self.run_scan(response(), response('roll'))
        self.assertEqual(code, 0)
        self.assertEqual(report['candidates'][0]['grossProfitUsd'], 80)
        self.assertAlmostEqual(report['candidates'][0]['friction'], .15)
        self.assertIn('Friction: 15.00%', self.md)
        self.assertIn('gross profit $80.00', self.md)
        close = response()
        close['data']['groups'][0]['pairs'][0]['estProfitUsd'] = 10
        close['data']['groups'][0]['pairs'][0]['costs']['totalUsd'] = 32
        _, report = self.run_scan(close, response('roll'))
        self.assertEqual(len(report['excluded'][0]['reasons']), 2)
        self.assertIn('minimum net profit $10.00', self.md)

    def test_top_limit_and_stable_sort(self):
        close, roll = response(count=12), response('roll', count=12)
        close['data']['groups'][0]['pairs'].reverse()
        code, report = self.run_scan(close, roll)
        self.assertEqual(code, 0)
        self.assertEqual([r['shortLeg']['marketId'] for r in report['candidates']], list(range(1, 20, 2)))
        close['data']['groups'][0]['pairs'][0]['netFixedAprOnCapital'] = 2
        code, report = self.run_scan(close, roll, ['--top', '2'])
        self.assertEqual(len(report['candidates']), 2)
        self.assertEqual(report['candidates'][0]['shortLeg']['marketId'], 23)

    def test_missing_contract_book_cost_or_capital_is_unknown(self):
        for target, field, value in [('market', 'bookStatus', 'insufficient-depth'), ('market', 'crossexSymbol', None), ('cost', 'perpEntryFeesUsd', None), ('capital', 'shortLeverageMax', 0), ('pair', 'capitalUsd', 0)]:
            close = response()
            group = close['data']['groups'][0]
            item = {'market': group['markets'][0], 'pair': group['pairs'][0], 'cost': group['pairs'][0]['costs'], 'capital': group['pairs'][0]['capital']}[target]
            item[field] = value
            code, report = self.run_scan(close, response('roll'))
            self.assertEqual(code, 2)
            self.assertEqual(report['candidates'], [])

    def test_old_future_missing_and_stale_observations_are_unknown(self):
        for meta in ({'observedAt': (NOW - 181) * 1000}, {'observedAt': (NOW + 1) * 1000}, {'observedAt': None}, {'stale': True}, {'coverageComplete': False}):
            close = response()
            close['meta'].update(meta)
            code, report = self.run_scan(close, response('roll'))
            self.assertEqual(code, 2)
            self.assertEqual(report['candidates'], [])
        close = response()
        close['meta']['ts'] = NOW * 1000
        close['meta'].pop('observedAt')
        self.assertEqual(self.run_scan(close, response('roll'))[0], 2)

    def test_roll_missing_skew_scope_or_settings_preserves_valid_close(self):
        changes = [('meta', 'credentialId', 'another-scope'), ('meta', 'observedAt', (NOW - 121) * 1000), ('settings', 'entryMode', 'both-market'), ('settings', 'notionalUsd', 5000), ('group', 'maturity', NOW + 3153601), ('data', 'groups', [])]
        for where, key, value in changes:
            roll = response('roll')
            target = {'meta': roll['meta'], 'settings': roll['data']['meta'], 'group': roll['data']['groups'][0], 'data': roll['data']}[where]
            target[key] = value
            code, report = self.run_scan(response(), roll)
            self.assertEqual(code, 2)
            self.assertEqual(len(report['candidates']), 1)
            self.assertEqual(report['candidates'][0]['roll']['status'], 'UNKNOWN')

    def test_partial_fetch_and_authentication_exit_semantics(self):
        from urllib.error import HTTPError
        for failure, expected in [(RuntimeError('synthetic-token'), 2), (HTTPError('local', 401, 'synthetic-token', {}, None), 1)]:
            with tempfile.TemporaryDirectory() as directory:
                token = pathlib.Path(directory) / 'token'
                token.write_text('synthetic-token')
                def fetch(url, token, timeout):
                    if 'exitMode=roll' in url:
                        raise failure
                    return response()
                code = self.module.run(['--token-file', str(token), '--output-dir', directory], fetch=fetch, now=lambda: NOW)
                self.assertEqual(code, expected)
                if expected == 2:
                    file = next(pathlib.Path(directory).glob('*/report.json'))
                    self.assertNotIn('synthetic-token', file.read_text())

    def test_parameters_remote_url_and_write_failure_return_one(self):
        for options in (['--url', 'https://example.com'], ['--url', 'http://user:pass@127.0.0.1'], ['--url', 'http://127.0.0.1/api/account'], ['--url', 'http://127.0.0.1?x=y'], ['--top', '0'], ['--notional', 'nan'], ['--max-age', '-1']):
            code, report = self.run_scan(response(), response('roll'), options)
            self.assertEqual(code, 1)
            self.assertEqual(self.calls, [])
            self.assertIsNone(report)
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'token'
            file.write_text('synthetic-token')
            code = self.module.run(['--token-file', str(file), '--output-dir', str(file)], fetch=lambda *a: response('roll' if 'exitMode=roll' in a[0] else 'close'), now=lambda: NOW)
            self.assertEqual(code, 1)

    def test_transport_disables_proxy_and_redirects_and_uses_get(self):
        from unittest.mock import patch
        from urllib import request, error
        requests = []
        class Reply:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return json.dumps(response()).encode()
        class Opener:
            def open(self, req, timeout):
                requests.append(req)
                return Reply()
        with patch.object(request, 'build_opener', return_value=Opener()) as build:
            code, report = self.run_scan(response(), response('roll'))
            # Exercise the real transport boundary with synthetic HTTP responses.
            with tempfile.TemporaryDirectory() as directory:
                token = pathlib.Path(directory) / 'token'
                token.write_text('synthetic-token')
                self.module.run(['--token-file', str(token), '--output-dir', directory], now=lambda: NOW)
            handlers = build.call_args.args
            self.assertTrue(any(isinstance(h, request.ProxyHandler) and h.proxies == {} for h in handlers))
            redirect = next(h for h in handlers if isinstance(h, self.module.NoRedirect))
            with self.assertRaises(error.HTTPError):
                redirect.redirect_request(requests[0], None, 302, 'moved', {}, 'https://example.com')
        self.assertTrue(all(req.get_method() == 'GET' and urlsplit(req.full_url).path == '/api/opportunities' for req in requests))

    def test_same_second_runs_are_unique_and_units_consistent(self):
        with tempfile.TemporaryDirectory() as directory:
            token = pathlib.Path(directory) / 'token'
            token.write_text('synthetic-token')
            for _ in range(2):
                self.assertEqual(self.module.run(['--token-file', str(token), '--output-dir', directory], fetch=lambda url, *a: response('roll' if 'exitMode=roll' in url else 'close'), now=lambda: NOW), 0)
            files = list(pathlib.Path(directory).glob('*/report.json'))
            self.assertEqual(len(files), 2)
            for file in files:
                report = json.loads(file.read_text())
                self.assertIn('+08:00', report['timeTaipei'])
                self.assertIn('$50.00', file.with_suffix('.md').read_text())
                self.assertEqual(file.parent.stat().st_mode & 0o777, 0o700)

    def test_partial_valid_candidates_and_nonpositive_term(self):
        close = response(count=2)
        close['data']['groups'][0]['pairs'][1]['secondsToMaturity'] = 0
        code, report = self.run_scan(close, response('roll', count=2))
        self.assertEqual(code, 2)
        self.assertEqual(len(report['candidates']), 1)
        self.assertIn('UNKNOWN', self.md)

    def test_wrong_type_notional_scope_never_matches(self):
        close = response()
        close['data']['meta']['notionalUsd'] = True
        code, report = self.run_scan(close, response('roll'), ['--notional', '1'])
        self.assertEqual(code, 2)
        self.assertEqual(report['candidates'], [])

    def test_credentials_embedded_in_whitelisted_domain_labels_are_redacted(self):
        close, roll = response(), response('roll')
        for envelope in (close, roll):
            group = envelope['data']['groups'][0]
            group['underlying'] = 'synthetic-token'
        code, report = self.run_scan(close, roll)
        self.assertEqual(code, 0)
        self.assertNotIn('synthetic-token', json.dumps(report) + self.md)

    def test_numeric_overflow_saves_unknown_report_instead_of_crashing(self):
        for profit, capital in ((10 ** 400, 400), (1e308, 1e-308)):
            with self.subTest(profit=profit, capital=capital):
                close = response()
                close['data']['groups'][0]['pairs'][0].update(estProfitUsd=profit, capitalUsd=capital)
                code, report = self.run_scan(close, response('roll'))
                self.assertEqual(code, 2)
                self.assertEqual(report['candidates'], [])
                self.assertEqual(report['excluded'][0]['status'], 'UNKNOWN')
                self.assertNotIn('Infinity', json.dumps(report))

    def test_roll_maker_leg_mismatch_preserves_close_and_marks_comparison_unknown(self):
        roll = response('roll')
        roll['data']['groups'][0]['pairs'][0]['makerLeg'] = 'long'
        code, report = self.run_scan(response(), roll)
        self.assertEqual(code, 2)
        self.assertEqual(len(report['candidates']), 1)
        self.assertEqual(report['candidates'][0]['makerLeg'], 'short')
        comparison = report['candidates'][0]['roll']
        self.assertEqual(comparison['status'], 'UNKNOWN')
        self.assertIn('maker leg mismatch', comparison['reasons'])
        self.assertIn('maker leg mismatch', self.md)

    def test_unknown_roll_outside_top_is_saved_and_explains_overall_status(self):
        for problem in ('maker-mismatch', 'missing-match'):
            with self.subTest(problem=problem):
                close, roll = response(count=2), response('roll', count=2)
                if problem == 'maker-mismatch':
                    roll['data']['groups'][0]['pairs'][1]['makerLeg'] = 'long'
                    reason = 'maker leg mismatch'
                else:
                    roll['data']['groups'][0]['pairs'].pop()
                    reason = 'matching roll comparison unavailable'
                code, report = self.run_scan(close, roll, ['--top', '1'])
                self.assertEqual(code, 2)
                self.assertEqual(report['status'], 'UNKNOWN')
                self.assertEqual(len(report['candidates']), 1)
                self.assertEqual(report['candidates'][0]['roll']['status'], 'VALID')
                self.assertEqual(report['dataReasons'], [])
                self.assertEqual(report['excluded'], [])
                issue = report['comparisonIssues'][0]
                self.assertEqual(issue['rank'], 2)
                self.assertFalse(issue['inTop'])
                self.assertEqual(issue['shortLeg']['marketId'], 3)
                self.assertEqual(issue['longLeg']['marketId'], 4)
                self.assertEqual(issue['reasons'], [reason])
                self.assertIn('## Roll comparison issues', self.md)
                self.assertIn('markets 3 → 4', self.md)
                self.assertIn(reason, self.md)

    def test_unrelated_unsupported_market_warning_does_not_exclude_valid_pair(self):
        close, roll = response(), response('roll')
        for envelope in (close, roll):
            group = envelope['data']['groups'][0]
            group['markets'].append(dict(marketId=225, name='ETH Kucoin', venue='Kucoin', crossexVenue=None, crossexSymbol=None))
            group['warnings'] = ["ETH Kucoin trades against Kucoin, which has no CrossEx perp venue — it can't carry a hedge leg here."]
            group['warningEvidence'] = [dict(code='unsupported-perp-venue', marketId=225)]
        code, report = self.run_scan(close, roll)
        self.assertEqual(code, 0)
        self.assertEqual(len(report['candidates']), 1)
        for envelope in (close, roll):
            group = envelope['data']['groups'][0]
            group['markets'][-1].update(crossexVenue='gate', base='ETH')
            group['warnings'] = ["No live CrossEx gate symbol for ETH — ETH Kucoin can't carry a hedge leg here."]
            group['warningEvidence'] = [dict(code='missing-perp-symbol', marketId=225)]
        code, report = self.run_scan(close, roll)
        self.assertEqual(code, 0)
        self.assertEqual(len(report['candidates']), 1)
        for envelope in (close, roll):
            envelope['data']['groups'][0]['warnings'] = ['措辞已改变 synthetic-token']
        self.assertEqual(self.run_scan(close, roll)[0], 0)
        close['data']['groups'][0]['warningEvidence'] = [dict(code='future-warning-code', marketId=225)]
        close['data']['groups'][0]['warnings'] = ['unrecognized source warning']
        code, report = self.run_scan(close, roll)
        self.assertEqual(code, 2)
        self.assertEqual(report['candidates'], [])

    def test_missing_maker_and_costs_have_identified_specific_reasons(self):
        close, roll = response(), response('roll')
        for envelope in (close, roll):
            pair = envelope['data']['groups'][0]['pairs'][0]
            pair['makerLeg'] = None
            pair['costs']['perpEntrySlippageUsd'] = None
            pair['reasons'] = ["No usable okx order book for OKX_ETH_USDT — the perp slippage at $10,000 can't be estimated.", 'synthetic-token synthetic-secret-id private prose']
            envelope['data']['meta']['venueBookFailures'] = [dict(symbol='OKX_ETH_USDT', category='timeout', stage='book')]
        code, report = self.run_scan(close, roll)
        self.assertEqual(code, 2)
        item = report['excluded'][0]
        self.assertEqual(item['underlying'], 'ETH')
        self.assertEqual(item['shortLeg']['marketId'], 1)
        self.assertIn('costs.perpEntrySlippageUsd', item['invalidFields'])
        self.assertIn('maker entry assignment unavailable', item['reasons'])
        self.assertIn('short: perpetual order book unavailable', item['reasons'])
        self.assertNotIn('invalid direction or maturity evidence', item['reasons'])
        self.assertIn('[close, roll]', self.md)
        self.assertIn('markets 1 → 2', self.md)
        self.assertIn('maturity 2026-11-13T08:00:00+08:00', self.md)
        self.assertNotIn('private prose', self.md + json.dumps(report))
        for envelope in (close, roll):
            envelope['data']['groups'][0]['pairs'][0]['reasons'] = ['任意新文案 synthetic-token']
        self.assertEqual(self.run_scan(close, roll)[1]['excluded'][0]['reasons'], item['reasons'])

    def test_legacy_warning_without_machine_evidence_is_unknown(self):
        close = response()
        group = close['data']['groups'][0]
        group['markets'].append(dict(marketId=225, crossexVenue=None))
        group['warnings'] = ["ETH Kucoin trades against Kucoin, which has no CrossEx perp venue — it can't carry a hedge leg here."]
        self.assertEqual(self.run_scan(close, response('roll'))[0], 2)

    def test_invalid_market_warning_scope_cannot_exempt_a_candidate(self):
        for evidence in (dict(code='missing-perp-symbol', marketId=999),
                         dict(code='missing-perp-symbol', marketId=True),
                         dict(code='unsupported-perp-venue', marketId=2),
                         dict(code='unknown-code', marketId=2)):
            close = response()
            group = close['data']['groups'][0]
            group['warnings'] = ['arbitrary display text']
            group['warningEvidence'] = [evidence]
            self.assertEqual(self.run_scan(close, response('roll'))[0], 2)

    def test_invalid_contract_label_does_not_crash_diagnostic_association(self):
        close = response()
        close['data']['groups'][0]['pairs'][0]['shortLeg']['crossexSymbol'] = {}
        code, report = self.run_scan(close, response('roll'))
        self.assertEqual(code, 2)
        self.assertEqual(report['candidates'], [])

    def test_assumed_fee_reference_does_not_depend_on_warning_wording(self):
        close = response()
        close['data']['warnings'] = ['假设费率 synthetic-token']
        close['data']['warningEvidence'] = [dict(code='assumed-fee-schedule')]
        code, report = self.run_scan(close, response('roll'))
        self.assertEqual(code, 2)
        self.assertEqual(report['excluded'][0]['reference']['values']['estProfitUsd'], 50)

    def test_aggregate_consistency_detects_corrupt_response(self):
        close = response()
        close['meta']['observedAt'] -= 1000
        code, report = self.run_scan(close, response('roll'))
        self.assertEqual(code, 2)
        self.assertIn('aggregate observation differs from classified input times', report['dataReasons'])

    def test_report_distinguishes_aggregate_and_market_observation(self):
        close, roll = response(), response('roll')
        for envelope in (close, roll):
            envelope['meta']['observedAt'] = (NOW - 339) * 1000
            envelope['data']['meta']['freshness']['staticData']['observedAt'] = (NOW - 339) * 1000
        code, report = self.run_scan(close, roll)
        self.assertEqual(code, 0)
        for mode in ('close', 'roll'):
            self.assertEqual(report['evidence'][mode + 'ObservedAtMs'], (NOW - 339) * 1000)
            self.assertEqual(report['evidence'][mode + 'MarketObservedAtMs'], NOW * 1000)

    def test_warning_for_selected_market_and_groupwide_warning_remain_unknown(self):
        for warning in ("OKX ETH trades against OKX, which has no CrossEx perp venue — it can't carry a hedge leg here.", "Can't price USDT collateral in USD (no reference market) — this group's book depth and open interest can't be sized in dollars."):
            close = response()
            market = close['data']['groups'][0]['markets'][0]
            market['name'] = 'OKX ETH'
            market['crossexVenue'] = None
            close['data']['groups'][0]['warnings'] = [warning]
            code, report = self.run_scan(close, response('roll'))
            self.assertEqual(code, 2)
            self.assertEqual(report['candidates'], [])

    def test_book_failure_diagnostics_are_saved_rendered_and_sanitized(self):
        close, roll = response(), response('roll')
        close['data']['meta']['venueBookFailures'] = [dict(symbol='HYPERLIQUID_FUTURE_HYPE_USDC', category='timeout', stage='book', httpStatus=None, errorCode='ECONNABORTED', elapsedMs=2501, observedAt=NOW * 1000, stale=False, message='private-body'), dict(symbol='BINANCE_FUTURE_ETH_USDT', category='http', stage='book', httpStatus=429, errorCode='private-code', elapsedMs=100, observedAt=NOW * 1000, stale=False)]
        _, report = self.run_scan(close, roll)
        failures = report['evidence']['close']['venueBookFailures']
        self.assertEqual(failures[0]['elapsedMs'], 2501)
        self.assertIsNone(failures[1]['errorCode'])
        self.assertNotIn('private-', json.dumps(report) + self.md)
        self.assertIn('HTTP=429', self.md)
        self.assertIn('elapsed=2,501.00 ms', self.md)
        self.assertIn('category=timeout', self.md)
        self.assertIn('no HTTP status recorded', self.md)
        self.assertEqual(report['evidence']['roll']['venueBookFailures'], [])

    def test_shared_diagnostics_contract_survives_report_sanitization(self):
        contract = json.loads((ROOT / 'tests/fixtures/venue-book-diagnostics.json').read_text())
        close = response()
        rows = [dict(symbol='OKX_ETH_USDT', category=category, stage=stage, errorCode=code)
                for category in contract['categories'] for stage in contract['stages'] for code in contract['errorCodes']]
        close['data']['meta']['venueBookFailures'] = rows
        _, report = self.run_scan(close, response('roll'))
        saved = report['evidence']['close']['venueBookFailures']
        self.assertEqual(len(saved), len(rows))
        self.assertEqual([item['errorCode'] for item in saved], [item['errorCode'] for item in rows])
        self.assertEqual({item['category'] for item in saved}, set(contract['categories']))
        self.assertEqual({item['stage'] for item in saved}, set(contract['stages']))

    def test_market_and_static_freshness_use_independent_age_limits(self):
        close, roll = response(), response('roll')
        for envelope in (close, roll):
            envelope['meta']['observedAt'] = (NOW - 339) * 1000
            envelope['data']['meta']['freshness'] = dict(marketData=dict(observedAt=(NOW - 10) * 1000, stale=False), staticData=dict(observedAt=(NOW - 339) * 1000, stale=False))
        code, report = self.run_scan(close, roll)
        self.assertEqual(code, 0)
        self.assertEqual(len(report['candidates']), 1)
        self.assertEqual(report['evidence']['close']['marketData']['ageSeconds'], 10)
        self.assertEqual(report['evidence']['close']['staticData']['ageSeconds'], 339)
        self.assertIn('Static data: VALID', self.md)
        self.assertEqual(self.run_scan(close, roll, ['--max-static-age', '300'])[0], 2)

    def test_category_freshness_rejects_old_future_stale_or_missing_evidence(self):
        for category, evidence in (('marketData', dict(observedAt=(NOW - 181) * 1000, stale=False)), ('staticData', dict(observedAt=(NOW - 601) * 1000, stale=False)), ('staticData', dict(observedAt=(NOW + 1) * 1000, stale=False)), ('staticData', dict(observedAt=NOW * 1000, stale=True)), ('staticData', None)):
            close = response()
            close['data']['meta']['freshness'] = dict(marketData=dict(observedAt=NOW * 1000, stale=False), staticData=dict(observedAt=NOW * 1000, stale=False))
            close['data']['meta']['freshness'][category] = evidence
            code, report = self.run_scan(close, response('roll'))
            self.assertEqual(code, 2)
            self.assertEqual(report['candidates'], [])
            self.assertEqual(report['evidence']['close'][category]['status'], 'UNKNOWN')

    def test_legacy_aggregate_timestamp_cannot_prove_category_freshness(self):
        close = response()
        close['data']['meta'].pop('freshness')
        code, report = self.run_scan(close, response('roll'))
        self.assertEqual(code, 2)
        self.assertEqual(report['candidates'], [])
        self.assertIsNone(report['evidence']['close']['marketData']['observedAtMs'])
        self.assertIsNone(report['evidence']['close']['staticData']['observedAtMs'])

    def test_comparison_skew_uses_market_time_not_static_cache_age(self):
        close, roll = response(), response('roll')
        for envelope, age in ((close, 339), (roll, 500)):
            envelope['meta']['observedAt'] = (NOW - age) * 1000
            envelope['data']['meta']['freshness']['staticData']['observedAt'] = (NOW - age) * 1000
        code, report = self.run_scan(close, roll)
        self.assertEqual(code, 0)
        self.assertEqual(report['candidates'][0]['roll']['status'], 'VALID')
        roll['data']['meta']['freshness']['marketData']['observedAt'] = (NOW - 121) * 1000
        code, report = self.run_scan(close, roll)
        self.assertEqual(code, 2)
        self.assertEqual(report['candidates'][0]['roll']['status'], 'UNKNOWN')
