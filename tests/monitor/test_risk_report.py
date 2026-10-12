import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from risk_monitor import producer_scope
from risk_report import main, sanitize


class ReadOnlyRiskReportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.root = '0x' + 'a' * 40
        self.config = {'root': self.root, 'state_dir': str(self.folder),
                       'observations_file': str(self.folder / 'observations.json'),
                       'token_file': str(self.folder / 'token')}
        self.config_path = self.folder / 'config.json'
        self.config_path.write_text(json.dumps(self.config))
        (self.folder / 'token').write_text('private-api-token-fixture')
        self.prior = {'gate.mm_health_ratio': {'status': 'CRITICAL', 'criticalMetrics': ['gate.mm_health_ratio']}}
        (self.folder / 'state.json').write_text(json.dumps({'shared_risk_state': self.prior}))
        scope = producer_scope(self.config, {'account': {'userId': 'private-user'}})
        self.report = {'version': 1, 'observedAt': time.time(), 'complete': True, 'state': {}, 'errors': {},
            'scope': {'credentialId': 'private-install-id', 'address': self.root, 'accountId': 0, 'pool': 'ETH-cross'},
            'configuration': {'configId': scope['config_id'], 'stateDir': str(self.folder),
                              'observationsFile': str(self.folder / 'observations.json')},
            'collection': {'account': {'userId': 'private-user'}},
            'checks': [{'id': 'gate.mm_health_ratio', 'label': 'Gate 保证金', 'status': 'OK', 'reason': '',
                'recommendedAction': '检查缓冲', 'metrics': {'gate.mm_health_ratio': {'value': 4.4, 'unit': 'ratio',
                    'observedAt': time.time(), 'ttlSeconds': 3600, 'complete': True, 'source': 'fixture ' + self.root}}}]}

    def tearDown(self):
        self.temp.cleanup()

    def response(self):
        return {'ok': True, 'meta': {'credentialId': 'private-install-id'}, 'data': self.report}

    def invoke(self, json_output=False):
        out = io.StringIO()
        with patch('risk_monitor.request_json', return_value=self.response()) as request, \
                patch('risk_monitor.save', side_effect=AssertionError('State write')), \
                patch('risk_monitor.telegram', side_effect=AssertionError('Notification')), \
                contextlib.redirect_stdout(out):
            code = main(['--config', str(self.config_path)] + (['--json'] if json_output else []))
        return code, out.getvalue(), request

    def test_single_fresh_get_preserves_critical_history_and_all_files(self):
        before = {p.name: p.read_bytes() for p in self.folder.iterdir()}
        code, output, request = self.invoke()
        self.assertEqual(code, 0)
        self.assertIn('风险总结：**OK**', output)
        self.assertIn('4.4 ratio', output)
        self.assertEqual(request.call_count, 1)
        url = urlsplit(request.call_args.args[0])
        self.assertEqual((url.hostname, url.path), ('localhost', '/api/risk/report'))
        query = parse_qs(url.query)
        self.assertEqual(query['fresh'], ['1'])
        self.assertEqual(json.loads(query['previous'][0])['state'], self.prior)
        self.assertEqual({p.name: p.read_bytes() for p in self.folder.iterdir()}, before)

    def test_json_excludes_account_wallet_install_identity_and_credentials(self):
        code, output, _ = self.invoke(True)
        self.assertEqual(code, 0)
        for secret in [self.root, 'private-user', 'private-install-id', 'private-api-token-fixture']:
            self.assertNotIn(secret, output)
        data = json.loads(output)
        self.assertNotIn('collection', data)
        self.assertNotIn('scope', data)
        self.assertEqual(data['counts']['OK'], 1)

    def test_unknown_and_partial_coverage_cannot_be_reported_as_safe(self):
        self.report['checks'][0]['status'] = 'UNKNOWN'
        self.report['checks'][0]['metrics']['gate.mm_health_ratio']['value'] = None
        code, output, _ = self.invoke(True)
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(output)['status'], 'UNKNOWN')
        self.report['checks'][0]['status'] = 'OK'
        self.report['complete'] = False
        self.assertEqual(sanitize(self.report)['status'], 'UNKNOWN')

    def test_account_scope_na_and_pool_details_are_read_only_and_sanitized(self):
        self.report['scope']['pool'] = 'account'
        self.report['checks'].append({'id': 'boros.settlement_net_24h_eth', 'label': '净流入', 'status': 'OK',
            'reason': '', 'metrics': {
                'boros.settlement_net_24h_usd': {'value': 3, 'unit': 'USD/24h', 'complete': True,
                    'details': [{'label': 'ETH cross ' + self.root, 'value': .001, 'unit': 'ETH/24h'}]},
                'boros.buffer_runway_days': {'value': None, 'unit': 'days', 'complete': True, 'applicability': 'NA',
                    'details': [{'label': 'ETH cross', 'value': 'NA', 'unit': 'days'}]}}})
        before = {p.name: p.read_bytes() for p in self.folder.iterdir()}
        code, output, _ = self.invoke()
        self.assertEqual(code, 0)
        self.assertIn('NA days', output)
        self.assertIn('净流入', output)
        self.assertNotIn(self.root, output)
        self.assertEqual({p.name: p.read_bytes() for p in self.folder.iterdir()}, before)

    def test_boros_market_account_redacts_subaccount_suffix_in_json(self):
        market_account = self.root + '000002000123'
        self.report['checks'][0]['metrics']['gate.mm_health_ratio']['source'] = market_account
        code, output, _ = self.invoke(True)
        self.assertEqual(code, 0)
        self.assertNotIn(market_account, output)
        self.assertNotIn(market_account[42:], output)

    def test_expired_response_or_corrupt_state_fails_closed_without_writing(self):
        self.report['observedAt'] = time.time() - 121
        code, output, _ = self.invoke(True)
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output)['status'], 'UNKNOWN')
        (self.folder / 'state.json').write_text('corrupt private-api-token-fixture')
        code, output, request = self.invoke(True)
        self.assertEqual(code, 1)
        self.assertFalse(request.called)
        self.assertNotIn('private-api-token-fixture', output)


if __name__ == '__main__':
    unittest.main()
