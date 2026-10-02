import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from risk_monitor import load, notify_report, telegram

NOW = 1800000000


def report(status='CRITICAL', count=1):
    return {'checks': [{'id': 'risk.' + str(i), 'label': 'Synthetic risk ' + str(i),
                        'status': status, 'reason': 'synthetic ' * 20,
                        'recommendedAction': 'verify ' * 20} for i in range(count)]}


class NotificationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'state.json'

    def tearDown(self):
        self.temp.cleanup()

    def test_queue_is_durable_before_send_and_survives_process_exit(self):
        def crash(text):
            persisted = load(self.path)
            self.assertIn('risk.0', persisted['pending'])
            self.assertNotIn('risk.0', persisted['notified_status'])
            raise SystemExit(1)
        with self.assertRaises(SystemExit):
            notify_report(report(), {}, {}, {}, NOW, crash, self.path)
        restored, sent = load(self.path), []
        notify_report(report(), restored, {}, {}, NOW + 1, sent.append, self.path)
        self.assertEqual(len(sent), 1)
        self.assertFalse(load(self.path)['pending'])

    def test_partial_batches_retry_only_unconfirmed_alerts_after_restart(self):
        sent = []
        def fail_second(text):
            if sent:
                raise RuntimeError('synthetic offline')
            sent.append(text)
        with contextlib.redirect_stderr(io.StringIO()):
            notify_report(report(count=20), {}, {}, {}, NOW, fail_second, self.path)
        persisted = load(self.path)
        confirmed = set(persisted['notified_status'])
        pending = set(persisted['pending'])
        self.assertTrue(confirmed)
        self.assertTrue(pending)
        self.assertFalse(confirmed & pending)
        retry = []
        notify_report(report(count=20), persisted, {}, {}, NOW + 1, retry.append, self.path)
        retry_text = '\n'.join(retry)
        for key in confirmed:
            self.assertNotIn('(' + key + ')', retry_text)
        for key in pending:
            self.assertIn('(' + key + ')', retry_text)
        self.assertFalse(load(self.path)['pending'])
        self.assertEqual(load(self.path)['notify_failures'], 0)

    def test_recovery_of_undelivered_alert_still_requires_debounce(self):
        def fail(text):
            raise RuntimeError('synthetic offline')
        state, sent = {}, []
        with contextlib.redirect_stderr(io.StringIO()):
            notify_report(report(), state, {}, {}, NOW, fail, self.path)
        notify_report(report('OK'), state, {}, {}, NOW + 1, sent.append, self.path)
        self.assertFalse(sent)
        notify_report(report('OK'), state, {}, {}, NOW + 2, sent.append, self.path)
        self.assertEqual(len(sent), 1)
        self.assertIn('[OK]', sent[0])

    def test_immediate_risk_ids_still_debounce_recovery(self):
        for key in ('hedge.direction_match', 'positions.unexpected_change_eth', 'rollover.uncovered_funding_seconds'):
            with self.subTest(key=key):
                state, sent, checks = {}, [], report()
                checks['checks'][0]['id'] = key
                notify_report(checks, state, {}, {}, NOW, sent.append)
                checks['checks'][0]['status'] = 'OK'
                notify_report(checks, state, {}, {}, NOW + 1, sent.append)
                self.assertEqual(len(sent), 1)
                notify_report(checks, state, {}, {}, NOW + 2, sent.append)
                self.assertEqual(len(sent), 2)


    def test_warning_critical_reminder_and_recovery(self):
        state, sent = {}, []
        notify_report(report('WARNING'), state, {}, {}, NOW, sent.append)
        self.assertFalse(sent)
        notify_report(report('WARNING'), state, {}, {}, NOW + 300, sent.append)
        self.assertEqual(len(sent), 1)
        notify_report(report(), state, {}, {}, NOW + 301, sent.append)
        self.assertEqual(len(sent), 2)
        notify_report(report(), state, {}, {}, NOW + 301 + 21600, sent.append)
        self.assertEqual(len(sent), 3)
        notify_report(report('OK'), state, {}, {}, NOW + 301 + 21601, sent.append)
        self.assertEqual(len(sent), 3)
        notify_report(report('OK'), state, {}, {}, NOW + 301 + 21602, sent.append)
        self.assertEqual(len(sent), 4)

    def test_telegram_response_must_confirm_success(self):
        env = {'MONITOR_TELEGRAM_BOT_TOKEN': '123:' + 'x' * 30,
               'MONITOR_TELEGRAM_CHAT_ID': '999'}
        state = {}
        with patch('risk_monitor.request_json', return_value={'ok': False}), contextlib.redirect_stderr(io.StringIO()):
            notify_report(report(), state, {}, env, NOW, state_path=self.path)
        self.assertIn('risk.0', load(self.path)['pending'])
        self.assertNotIn('risk.0', state['notified_status'])
        with patch('risk_monitor.request_json', return_value={'ok': True, 'result': {'message_id': 1}}) as request:
            notify_report(report(), state, {}, env, NOW + 1, state_path=self.path)
        self.assertEqual(state['notified_status']['risk.0'], 'CRITICAL')
        self.assertEqual(request.call_args.kwargs['payload']['chat_id'], '999')
        self.assertEqual(request.call_args.args[0], 'https://api.telegram.org/bot' + env['MONITOR_TELEGRAM_BOT_TOKEN'] + '/sendMessage')

    def test_malformed_telegram_success_does_not_confirm_delivery(self):
        env = {'MONITOR_TELEGRAM_BOT_TOKEN': '123:' + 'x' * 30,
               'MONITOR_TELEGRAM_CHAT_ID': '999'}
        state = {}
        with patch('risk_monitor.request_json', return_value={'ok': True}), contextlib.redirect_stderr(io.StringIO()):
            notify_report(report(), state, {}, env, NOW, state_path=self.path)
        self.assertIn('risk.0', state['pending'])
        self.assertNotIn('risk.0', state['notified_status'])


    def test_notification_redacts_wallet_token_and_chat_id(self):
        token = '123:' + 'x' * 30
        wallet = '0x' + 'a' * 40
        env = {'MONITOR_TELEGRAM_BOT_TOKEN': token, 'MONITOR_TELEGRAM_CHAT_ID': '987654321'}
        checks, sent = report(), []
        checks['checks'][0]['reason'] = wallet + ' ' + token + ' ' + env['MONITOR_TELEGRAM_CHAT_ID']
        notify_report(checks, {}, {}, env, NOW, sent.append)
        for secret in (wallet, token, env['MONITOR_TELEGRAM_CHAT_ID']):
            self.assertNotIn(secret, sent[0])
        self.assertIn('[wallet]', sent[0])

    def test_storage_failure_prevents_delivery(self):
        sent = []
        with patch('risk_monitor.save', side_effect=OSError('synthetic disk failure')):
            with self.assertRaises(OSError):
                notify_report(report(), {}, {}, {}, NOW, sent.append, self.path)
        self.assertFalse(sent)
