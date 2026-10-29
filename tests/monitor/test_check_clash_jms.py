import contextlib
import io
import json
from pathlib import Path
import ssl
import sys
import unittest
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, quote, unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import check_clash_jms as checker


class ClashJmsTest(unittest.TestCase):
    def setUp(self):
        self.node = 'private-account@example.test:443'
        self.proxies = {'JMS': {'type': 'Selector', 'now': 'nested', 'all': ['nested', self.node, 'DIRECT']},
                        'nested': {'type': 'Fallback', 'now': self.node, 'all': [self.node]},
                        'DIRECT': {'type': 'Direct'},
                        self.node: {'type': 'Vless', 'alive': False, 'password': 'private-password'}}
        self.calls = []

    def api(self, path, endpoint, timeout):
        self.calls.append(endpoint)
        if endpoint == '/configs':
            return {'mixed-port': 7897, 'mode': 'rule', 'tun': {'enable': True}}
        if endpoint == '/proxies':
            return {'proxies': self.proxies}
        return {'delay': 123}

    def collect(self, api=None):
        with patch.object(checker, 'api_get', side_effect=api or self.api), \
                patch.object(checker, 'processes', return_value=[]), \
                patch.object(checker, 'https_probe', side_effect=lambda port, target, timeout: {
                    'id': target[0], 'status': 'OK', 'detail': 'HTTPS passed'}):
            return checker.collect('/test.sock', 'JMS', 3)

    def test_success_resolves_nested_group_and_performs_fresh_node_probe(self):
        report = self.collect()
        self.assertEqual(report['status'], 'OK')
        self.assertTrue(report['complete'])
        node = next(c for c in report['checks'] if c['id'].startswith('jms.node.'))
        self.assertEqual(node['node'], 'example.test:443')
        self.assertEqual(node['delayMs'], 123)
        self.assertTrue(node['selected'])
        self.assertEqual(report['nodeCounts'], {'total': 1, 'OK': 1, 'FAIL': 0, 'UNKNOWN': 0})
        self.assertEqual(report['checks'][1]['excludedPolicies'], ['DIRECT'])
        self.assertEqual(sum('/delay?' in call for call in self.calls), 1)
        delay = next(c for c in self.calls if c.startswith('/proxies/'))
        parsed = urlsplit(delay)
        self.assertEqual(unquote(parsed.path.removeprefix('/proxies/').removesuffix('/delay')), self.node)
        self.assertEqual(parse_qs(parsed.query), {'url': [checker.PROBE_URL], 'timeout': ['3000'], 'expected': ['204']})
        self.assertNotIn('private-account', json.dumps(report))
        self.assertNotIn('private-password', json.dumps(report))

    def test_direct_only_is_not_counted_as_a_working_jms_node(self):
        self.proxies['JMS']['all'] = ['DIRECT']
        self.proxies['nested']['now'] = 'DIRECT'
        report = self.collect()
        self.assertEqual(report['status'], 'UNKNOWN')
        self.assertEqual(report['nodeCounts']['total'], 0)
        self.assertFalse(any('/delay?' in c for c in self.calls))

    def test_missing_group_and_cycles_are_unknown(self):
        for proxies in [{}, {'JMS': {'now': 'JMS', 'all': ['JMS']}}, {'JMS': {'all': []}},
                        {'JMS': {'now': self.node}}]:
            with self.subTest(proxies=proxies):
                self.proxies = proxies
                report = self.collect()
                self.assertEqual(report['status'], 'UNKNOWN')
                self.assertFalse(report['complete'])

    def test_node_timeout_fails_even_when_proxy_entry_tests_pass(self):
        def api(path, endpoint, timeout):
            if '/delay?' in endpoint:
                raise checker.ApiError(504)
            return self.api(path, endpoint, timeout)
        report = self.collect(api)
        self.assertEqual(report['status'], 'FAIL')
        node = next(c for c in report['checks'] if c['id'].startswith('jms.node.'))
        self.assertIn('HTTP 504', node['detail'])

    def test_every_node_is_probed_and_backup_failure_is_not_hidden(self):
        backup = 'second-private@backup.test:443'
        self.proxies['nested']['all'].append(backup)
        self.proxies[backup] = {'type': 'Shadowsocks'}
        quote_backup = quote(backup, safe='')

        def api(path, endpoint, timeout):
            if quote_backup in endpoint:
                raise checker.ApiError(504)
            return self.api(path, endpoint, timeout)

        report = self.collect(api)
        self.assertEqual(report['status'], 'FAIL')
        self.assertTrue(report['complete'])
        self.assertEqual(report['nodeCounts'], {'total': 2, 'OK': 1, 'FAIL': 1, 'UNKNOWN': 0})
        nodes = [c for c in report['checks'] if c['id'].startswith('jms.node.')]
        self.assertEqual(len({c['id'] for c in nodes}), 2)
        self.assertEqual([(c['status'], c['selected']) for c in nodes], [('OK', True), ('FAIL', False)])

    def test_bad_branch_keeps_healthy_nodes_but_marks_coverage_unknown(self):
        self.proxies['JMS']['all'].extend(['missing', 'cycle'])
        self.proxies['cycle'] = {'type': 'LoadBalance', 'all': ['cycle', self.node]}
        report = self.collect()
        self.assertEqual(report['status'], 'UNKNOWN')
        self.assertFalse(report['complete'])
        self.assertEqual(report['nodeCounts']['OK'], 1)
        self.assertEqual(sum('/delay?' in c for c in self.calls), 1)

    def test_permissions_are_unknown_without_exposing_exception_secrets(self):
        report = self.collect(lambda *args: (_ for _ in ()).throw(PermissionError('bot123:private-secret')))
        self.assertEqual(report['status'], 'UNKNOWN')
        self.assertNotIn('private-secret', json.dumps(report))
        self.assertIn('PermissionError', report['checks'][0]['detail'])

    def test_controller_disappearing_does_not_prove_node_is_dead(self):
        errors = [FileNotFoundError(), ConnectionRefusedError(), checker.ApiError(404)]
        for error in errors:
            with self.subTest(error=error), patch.object(checker, 'api_get', side_effect=error):
                result = checker.node_probe('/test.sock', 'JMS', self.proxies, 2)
                self.assertEqual(result['status'], 'UNKNOWN')

    def test_invalid_delay_never_reports_ok_but_zero_is_valid(self):
        for delay in [None, True, -1, float('nan'), float('inf'), '123', 0]:
            with self.subTest(delay=delay), patch.object(checker, 'api_get', return_value={'delay': delay}):
                result = checker.node_probe('/test.sock', 'JMS', self.proxies, 2)
                self.assertEqual(result['status'], 'OK' if delay == 0 and not isinstance(delay, bool) else 'UNKNOWN')

    def test_missing_http_port_does_not_invent_a_default_port(self):
        def api(path, endpoint, timeout):
            return {'mixed-port': 0, 'port': 0} if endpoint == '/configs' else self.api(path, endpoint, timeout)
        report = self.collect(api)
        self.assertEqual(report['status'], 'UNKNOWN')
        self.assertIsNone(report['proxyPort'])

    def test_https_uses_explicit_connect_and_keeps_tls_verification(self):
        connection = MagicMock()
        connection.getresponse.return_value.status = 204
        with patch.object(checker.http.client, 'HTTPSConnection', return_value=connection) as factory:
            check = checker.https_probe(7897, checker.TARGETS[0], 3)
        self.assertEqual(check['status'], 'OK')
        connection.set_tunnel.assert_called_once_with('www.gstatic.com', 443)
        context = factory.call_args.kwargs['context']
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        connection.close.assert_called_once()

    def test_tls_failure_and_unexpected_status_fail(self):
        connection = MagicMock()
        connection.request.side_effect = ssl.SSLCertVerificationError('private error URL')
        with patch.object(checker.http.client, 'HTTPSConnection', return_value=connection):
            result = checker.https_probe(7897, checker.TARGETS[0], 3)
        self.assertEqual(result['status'], 'FAIL')
        self.assertIn('SSLCertVerificationError', result['detail'])
        self.assertNotIn('private error', result['detail'])
        connection.request.side_effect = None
        connection.getresponse.return_value.status = 302
        with patch.object(checker.http.client, 'HTTPSConnection', return_value=connection):
            self.assertEqual(checker.https_probe(7897, checker.TARGETS[0], 3)['status'], 'FAIL')

    def test_controller_uses_get_and_closes_connection(self):
        connection = MagicMock()
        connection.getresponse.return_value.status = 200
        connection.getresponse.return_value.read.return_value = b'{"mode":"rule"}'
        with patch.object(checker, 'UnixHTTPConnection', return_value=connection):
            self.assertEqual(checker.api_get('/test.sock', '/configs', 3), {'mode': 'rule'})
        connection.request.assert_called_once_with('GET', '/configs')
        connection.close.assert_called_once()

    def test_cli_json_and_exit_codes(self):
        for status, code in [('OK', 0), ('UNKNOWN', 1), ('FAIL', 2)]:
            with self.subTest(status=status), patch.object(checker, 'collect', return_value={'status': status}), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(checker.main(['--socket', '/test.sock', '--json']), code)
                self.assertEqual(json.loads(output.getvalue())['status'], status)


if __name__ == '__main__':
    unittest.main()
