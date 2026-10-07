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
    return dict(ok=True, meta=dict(observedAt=NOW * 1000, credentialId='synthetic-secret-id'), data=dict(meta=dict(asOfSec=NOW, notionalUsd=10000, borosEntry='market', entryMode='maker-hedge', exitMode=mode), groups=[dict(tokenId=1, collateral='USDT', maturity=NOW + 3153600, secondsToMaturity=3153600, underlying='ETH', markets=markets, pairs=pairs, warnings=[])], warnings=[]))

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

    def test_assumed_fees_are_reference_only_unknown(self):
        close = response()
        close['data']['warnings'] = ['Perp fees assume the VIP0 Gate CrossEx schedule — secret synthetic-token']
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

    def test_top_limit_and_stable_sort(self):
        close, roll = response(count=7), response('roll', count=7)
        close['data']['groups'][0]['pairs'].reverse()
        code, report = self.run_scan(close, roll)
        self.assertEqual(code, 0)
        self.assertEqual([r['shortLeg']['marketId'] for r in report['candidates']], [1, 3, 5, 7, 9])
        close['data']['groups'][0]['pairs'][0]['netFixedAprOnCapital'] = 2
        code, report = self.run_scan(close, roll, ['--top', '2'])
        self.assertEqual(len(report['candidates']), 2)
        self.assertEqual(report['candidates'][0]['shortLeg']['marketId'], 13)

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
