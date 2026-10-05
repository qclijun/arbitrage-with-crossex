import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from risk_monitor import main, producer_scope, notify_report

NOW = 1800000000
ROOT = '0x' + '1' * 40


class TerminalEvidenceTest(unittest.TestCase):
    def test_record_uses_only_verified_recent_scope_without_collecting(self):
        for kind in ('valid', 'legacy', 'expired', 'future', 'changed-config', 'malformed-state', 'malformed-scope'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                folder = Path(tmp)
                config = {'root': ROOT, 'state_dir': tmp, 'observations_file': str(folder / 'observations.json')}
                scope = producer_scope(config, {'account': {'userId': 'fixture'}})
                state = {'producer_scope': scope, 'observed_at': NOW - 10}
                if kind == 'legacy':
                    state.pop('producer_scope')
                if kind == 'expired':
                    state['observed_at'] = NOW - 3601
                if kind == 'future':
                    state['observed_at'] = NOW + 1
                if kind == 'changed-config':
                    config['recovery_margin_fraction'] = .04
                if kind == 'malformed-scope':
                    state['producer_scope'] = ['unexpected']
                (folder / 'state.json').write_text('{bad-json' if kind == 'malformed-state' else json.dumps(state))
                (folder / 'config.json').write_text(json.dumps(config))
                args = ['risk_monitor.py', '--config', str(folder / 'config.json'), '--record', 'stablecoin.usdt_usd',
                        '--value', '1', '--source', 'synthetic review', '--evidence', 'fixture', '--ttl-seconds', '120']
                with patch('sys.argv', args), patch('risk_monitor.time.time', return_value=NOW), patch('risk_monitor.Collector') as collector, contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(main(), 0)
                    collector.assert_not_called()
                entry = json.loads((folder / 'observations.json').read_text())['metrics']['stablecoin.usdt_usd']
                self.assertEqual(entry.get('scope'), scope if kind == 'valid' else None)
                self.assertEqual(entry.get('coverage_complete'), True if kind == 'valid' else None)

    def test_confirmed_notification_retains_positive_message_id(self):
        report = {'checks': [{'id': 'fixture', 'label': 'Fixture', 'status': 'CRITICAL', 'reason': 'synthetic', 'recommendedAction': 'verify'}]}
        state = {}
        notify_report(report, state, {}, {}, NOW, sender=lambda text: {'message_id': 55})
        self.assertEqual(state['notify_last_success'], NOW)
        self.assertEqual(state['notify_last_message_id'], 55)
        legacy = {}
        notify_report(report, legacy, {}, {}, NOW, sender=lambda text: None)
        self.assertNotIn('notify_last_message_id', legacy)


if __name__ == '__main__':
    unittest.main()
