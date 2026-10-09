import contextlib
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.parse
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from risk_monitor import Collector, ROOT, load, main, notify_report, producer_scope, unavailable_report

NOW = 1800000000
ADDRESS = '0x' + '1' * 40
SCOPE = {'credentialId': 'fixture', 'address': ADDRESS, 'accountId': 0, 'pool': 'ETH-cross'}


def response(config=None):
    config = config or {'root': ADDRESS}
    return {'ok': True, 'meta': {'credentialId': 'fixture'}, 'data': {
        'version': 1, 'scope': SCOPE, 'observedAt': NOW, 'state': {}, 'errors': {}, 'complete': True,
        'configuration': {'configId': producer_scope(config, {'account': {'userId': 'gate-user'}})['config_id'],
                          'stateDir': str(Path(config.get('state_dir', ROOT / 'data/risk-monitor')).resolve()),
                          'observationsFile': str(Path(config.get('observations_file', ROOT / 'data/risk-monitor/observations.json')).resolve())},
        'checks': [], 'collection': {'account': {'userId': 'gate-user'}, 'agent': {'root': ADDRESS},
                                    'positions': {}, 'farm': {}}}}


class SharedReportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        token = self.folder / 'api-token'; token.write_text('local-only-token')
        self.config = {'root': ADDRESS, 'token_file': str(token), 'state_dir': str(self.folder)}

    def tearDown(self):
        self.temp.cleanup()

    def test_collector_uses_only_shared_get_and_supplies_persistent_critical_state(self):
        state = {'shared_scope': SCOPE, 'shared_risk_state': {'hedge.perp_net_eth': {
            'status': 'CRITICAL', 'criticalMetrics': ['hedge.perp_net_eth']}}}
        collector = Collector(self.config)
        with patch('risk_monitor.request_json', return_value=response(self.config)) as request, patch('risk_monitor.time.time', return_value=NOW):
            report = collector.collect_report(state)
        url, headers = request.call_args.args
        parsed = urllib.parse.urlsplit(url)
        self.assertEqual(parsed.path, '/api/risk/report')
        query = urllib.parse.parse_qs(parsed.query)
        self.assertEqual(query['fresh'], ['1'])
        self.assertEqual(json.loads(query['previous'][0])['state']['hedge.perp_net_eth']['status'], 'CRITICAL')
        self.assertEqual(headers, {'x-arb-token': 'local-only-token'})
        self.assertEqual(request.call_count, 1)
        self.assertEqual(report['version'], 1)

    def test_wrong_scope_expired_and_malformed_reports_do_not_update_state(self):
        for kind in ('scope', 'expired', 'version', 'identity', 'missing-collection'):
            with self.subTest(kind=kind):
                result = response(self.config)
                if kind == 'scope': result['data']['scope'] = {**SCOPE, 'accountId': 1}
                if kind == 'expired': result['data']['observedAt'] = NOW - 121
                if kind == 'version': result['data']['version'] = 0
                if kind == 'identity': result['meta']['credentialId'] = 'other'
                if kind == 'missing-collection': result['data'].pop('collection')
                state = {'pending': {'prior': {'status': 'CRITICAL'}}}
                before = copy.deepcopy(state)
                with patch('risk_monitor.request_json', return_value=result), patch('risk_monitor.time.time', return_value=NOW):
                    with self.assertRaises(RuntimeError): Collector(self.config).collect_report(state)
                self.assertEqual(state, before)

    def test_terminal_restart_does_not_discard_same_account_notification_queue(self):
        state = {'shared_scope': {**SCOPE, 'credentialId': 'before-restart'},
                 'producer_scope': {'gate_user_id': 'gate-user'}, 'pending': {'prior': {'status': 'CRITICAL'}}}
        with patch('risk_monitor.request_json', return_value=response(self.config)), patch('risk_monitor.time.time', return_value=NOW):
            Collector(self.config).collect_report(state)
        self.assertEqual(state['pending'], {'prior': {'status': 'CRITICAL'}})

    def test_missing_account_identity_preserves_notification_state(self):
        for user in (None, '', '   '):
            with self.subTest(user=user):
                state = {'shared_scope': SCOPE, 'producer_scope': {'gate_user_id': 'gate-user'},
                         'pending': {'prior': {'status': 'WARNING'}}, 'notified_status': {'prior': 'CRITICAL'},
                         'consecutive_status': {'prior': 2}, 'observed_status': {'prior': 'WARNING'}}
                result = response(self.config)
                result['data']['collection']['account'] = {'userId': user}
                result['data']['complete'] = False
                before = copy.deepcopy(state)
                with patch('risk_monitor.request_json', return_value=result), patch('risk_monitor.time.time', return_value=NOW):
                    Collector(self.config).collect_report(state)
                for key in ('pending', 'notified_status', 'consecutive_status', 'observed_status', 'producer_scope'):
                    self.assertEqual(state[key], before[key])

    def test_incompatible_custom_configuration_is_rejected_without_mutating_state(self):
        for key, value in [('thresholds', {'gate.im_coverage': [['gate.im_coverage', 'lt', 1.8, 'WARNING']]}),
                           ('recovery_margin_fraction', .1), ('state_dir', '/tmp/another-risk-state'),
                           ('observations_file', '/tmp/another-observations.json')]:
            with self.subTest(key=key):
                state = {'pending': {'prior': {'status': 'WARNING'}}}
                config = {**self.config, key: value}
                with patch('risk_monitor.request_json', return_value=response(self.config)), patch('risk_monitor.time.time', return_value=NOW):
                    with self.assertRaisesRegex(ValueError, 'configuration'):
                        Collector(config).collect_report(state)
                self.assertEqual(state, {'pending': {'prior': {'status': 'WARNING'}}})

    def test_partial_account_failure_preserves_identity_across_service_runs(self):
        config = self.folder / 'config.json'; config.write_text(json.dumps(self.config))
        previous = {'shared_scope': SCOPE, 'producer_scope': producer_scope(self.config, {'account': {'userId': 'gate-user'}}),
                    'pending': {'prior': {'status': 'WARNING'}}, 'notified_status': {'prior': 'CRITICAL'}}
        (self.folder / 'state.json').write_text(json.dumps(previous))
        result = response(self.config); result['data']['collection']['account'] = None
        result['data']['complete'] = False; result['data']['errors'] = {'account': 'Read failed'}
        with patch('sys.argv', ['risk_monitor.py', '--config', str(config), '--json']), \
                patch('risk_monitor.request_json', return_value=result), patch('risk_monitor.time.time', return_value=NOW), \
                contextlib.redirect_stdout(io.StringIO()):
            for _ in range(2):
                main()
                state = json.loads((self.folder / 'state.json').read_text())
                for key in ('producer_scope', 'pending', 'notified_status'):
                    self.assertEqual(state[key], previous[key])

    def test_incompatible_configuration_exits_clearly_without_notifying_or_overwriting_state(self):
        config = self.folder / 'config.json'; config.write_text(json.dumps({**self.config, 'recovery_margin_fraction': .1}))
        state_file = self.folder / 'state.json'; state_file.write_text('{"pending":{"prior":{"status":"CRITICAL"}}}')
        before = state_file.read_text(); errors = io.StringIO()
        with patch('sys.argv', ['risk_monitor.py', '--config', str(config), '--notify']), \
                patch('risk_monitor.request_json', return_value=response(self.config)), patch('risk_monitor.time.time', return_value=NOW), \
                patch('risk_monitor.notify_report') as notify, contextlib.redirect_stderr(errors):
            self.assertEqual(main(), 1)
            notify.assert_not_called()
        self.assertIn('configuration differs', errors.getvalue())
        self.assertEqual(state_file.read_text(), before)

    def test_unavailable_shared_report_never_runs_legacy_formulas_and_retains_critical(self):
        rules = load(ROOT / 'scripts/risk-monitor-rules.json')
        report = unavailable_report({'critical_metrics': {'hedge.perp_net_eth': ['hedge.perp_net_eth']}}, rules, NOW, 'offline')
        checks = {c['id']: c for c in report['checks']}
        self.assertEqual(checks['hedge.perp_net_eth']['status'], 'CRITICAL')
        self.assertTrue(all(c['status'] in ('UNKNOWN', 'CRITICAL') for c in report['checks']))
        self.assertNotIn('hedge.market_identity_match', checks)
        self.assertTrue(all(c['risk'] != 8 for c in report['checks']))

    def test_paused_and_hidden_checks_do_not_send_or_keep_queued_notifications(self):
        state = {'pending': {'hidden': {'status': 'CRITICAL'}, 'rollover.next_net_apr': {'status': 'WARNING'}}}
        report = {'checks': [{'id': 'rollover.next_net_apr', 'status': 'PAUSED'}]}
        with patch('risk_monitor.telegram') as send:
            notify_report(report, state, {}, {}, NOW)
            send.assert_not_called()
        self.assertEqual(state['pending'], {})

    def test_service_main_uses_shared_report_without_legacy_evaluation_or_delivery_override(self):
        config = self.folder / 'config.json'; config.write_text(json.dumps(self.config))
        result = response(self.config); result['data']['checks'] = [{'id': 'notify.last_success_at', 'risk': 7,
            'label': 'Delivery', 'status': 'UNKNOWN', 'metrics': {}, 'thresholds': [],
            'coverageComplete': False, 'reason': 'Expired evidence', 'recommendedAction': 'verify'}]
        with patch('sys.argv', ['risk_monitor.py', '--config', str(config), '--json']), \
                patch('risk_monitor.request_json', return_value=result), patch('risk_monitor.time.time', return_value=NOW), \
                patch('risk_monitor.evaluate', side_effect=AssertionError('Legacy evaluator used')), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(), 2)
        latest = json.loads((self.folder / 'latest.json').read_text())
        self.assertEqual(latest['checks'][0]['status'], 'UNKNOWN')
        self.assertNotIn('collection', latest)
        state = json.loads((self.folder / 'state.json').read_text())
        self.assertEqual(state['last_complete_run_at'], NOW)
        self.assertEqual(state['producer_scope']['gate_user_id'], 'gate-user')


if __name__ == '__main__':
    unittest.main()
