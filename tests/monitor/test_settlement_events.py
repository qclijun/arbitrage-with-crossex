from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from risk_monitor import Collector, evaluate, load, settlement_net_24h

NOW = 1800000000
ROOT = '0x' + '1' * 40
POOL = ROOT + '000002ffffff'


def event(event_id='1', amount='-1000000000000000', stamp=NOW, pool=POOL):
    return {'id': event_id, 'timestamp': stamp, 'marketAcc': pool,
            'marketId': 128, 'settlement': amount, 'fee': '999999999999999'}


def ledger(rows):
    return {'root': ROOT, 'accountId': 0, 'complete': True, 'rows': rows}


class SettlementEventsTest(unittest.TestCase):
    def test_exact_window_signed_net_and_deduplication(self):
        rows = [event(), event(), event('2', '400000000000000', NOW - 1),
                event('3', '-9000000000000000', NOW - 86400),
                event('4', '-9000000000000000', NOW + 1)]
        self.assertAlmostEqual(settlement_net_24h(ledger(rows), {'root': ROOT}, NOW), -.0006)

    def test_other_pools_are_excluded(self):
        rows = [event(), event('2', pool=ROOT + '010002ffffff'),
                event('3', pool=ROOT + '000001ffffff'),
                event('4', pool=ROOT + '000002000080'),
                event('5', pool='0x' + '2' * 40 + '000002ffffff')]
        self.assertEqual(settlement_net_24h(ledger(rows), {'root': ROOT}, NOW), -.001)

    def test_complete_empty_window_is_zero(self):
        self.assertEqual(settlement_net_24h(ledger([]), {'root': ROOT}, NOW), 0)
        self.assertEqual(settlement_net_24h(ledger([event(stamp=NOW - 86401)]), {'root': ROOT}, NOW), 0)

    def test_incomplete_invalid_or_conflicting_events_are_unknown(self):
        bad_ledgers = [None, {**ledger([]), 'complete': False},
                       {**ledger([]), 'root': 'other'}, {**ledger([]), 'accountId': 1}]
        for fields in ({'settlement': None}, {'settlement': 'nan'}, {'settlement': '0.1'},
                       {'timestamp': None}, {'timestamp': True}, {'id': ''}, {'marketAcc': ''}):
            bad_ledgers.append(ledger([{**event(), **fields}]))
        bad_ledgers.append(ledger([event(), event(amount='1')]))
        for value in bad_ledgers:
            with self.subTest(ledger=value):
                self.assertIsNone(settlement_net_24h(value, {'root': ROOT}, NOW))

    def test_first_run_needs_no_samples_price_or_open_position(self):
        with tempfile.TemporaryDirectory() as folder:
            config = {'root': ROOT, 'observations_file': str(Path(folder) / 'missing.json')}
            rules = load(Path(__file__).resolve().parents[2] / 'scripts/risk-monitor-rules.json')
            state = {}
            report = evaluate({'boros_settlements': ledger([event()])}, config, state, rules, NOW)
            check = next(c for c in report['checks'] if c['id'] == 'boros.settlement_net_24h_eth')
            self.assertEqual(check['metrics']['boros.settlement_net_24h_eth']['value'], -.001)
            self.assertIsNone(check['metrics']['boros.buffer_runway_days']['value'])
            self.assertNotIn('samples', state)

    def test_pagination_and_no_terminal_token_sent(self):
        with tempfile.TemporaryDirectory() as folder:
            token = Path(folder) / 'token'
            token.write_text('secret-terminal-token')
            collector = Collector({'token_file': str(token)})
            pages = [{'results': [event()], 'resumeToken': 'page 2'},
                     {'results': [event(), event('2')], 'resumeToken': None}]
            with patch('risk_monitor.request_json', side_effect=pages) as request:
                result = collector.public_settlements(ROOT)
            self.assertEqual(settlement_net_24h(result, {'root': ROOT}, NOW), -.002)
            self.assertIn('resumeToken=page+2', request.call_args_list[1].args[0])
            self.assertNotIn('x-arb-token', request.call_args.args[1])
            self.assertEqual(collector.errors, {})

    def test_buffer_uses_same_pool_available_collateral(self):
        with tempfile.TemporaryDirectory() as folder:
            config = {'root': ROOT, 'observations_file': str(Path(folder) / 'missing.json')}
            rules = load(Path(__file__).resolve().parents[2] / 'scripts/risk-monitor-rules.json')
            for amount, expected in (('-1000000000000000', 25), ('0', 999999),
                                     ('1000000000000000', 999999)):
                with self.subTest(amount=amount):
                    data = {'boros_settlements': ledger([event(amount=amount)]),
                            'farm': {'assets': [{'base': 'ETH', 'priceUsd': 3000}]},
                            'boros_raw': {'results': [{'marketAcc': POOL,
                                'netBalance': '100000000000000000',
                                'initialMargin': '75000000000000000',
                                'availableInitialMargin': '25000000000000000',
                                'availableMaintMargin': '60000000000000000'}]}}
                    report = evaluate(data, config, {}, rules, NOW)
                    check = next(c for c in report['checks'] if c['id'] == 'boros.settlement_net_24h_eth')
                    self.assertEqual(check['metrics']['boros.buffer_runway_days']['value'], expected)
                    self.assertTrue(check['coverageComplete'])

    def test_runway_uses_native_balance_without_price_or_positive_im(self):
        with tempfile.TemporaryDirectory() as folder:
            config = {'root': ROOT, 'observations_file': str(Path(folder) / 'missing.json')}
            rules = load(Path(__file__).resolve().parents[2] / 'scripts/risk-monitor-rules.json')
            for price, im, net in ((None, '0', None), (None, '75000000000000000', '100000000000000000'),
                                   (3000, '0', '100000000000000000'), (3000, None, None)):
                with self.subTest(price=price, im=im, net=net):
                    data = {'boros_settlements': ledger([event()]),
                            'farm': {'assets': [{'base': 'ETH', 'priceUsd': price}]},
                            'boros_raw': {'results': [{'marketAcc': POOL, 'netBalance': net,
                                'initialMargin': im, 'availableInitialMargin': '1000000000000000'}]}}
                    report = evaluate(data, config, {}, rules, NOW)
                    check = next(c for c in report['checks'] if c['id'] == 'boros.settlement_net_24h_eth')
                    self.assertEqual(check['metrics']['boros.buffer_runway_days']['value'], 1)
                    self.assertEqual(check['status'], 'CRITICAL')
                    self.assertTrue(check['coverageComplete'])

    def test_page_failures_and_caps_never_return_partial_total(self):
        with tempfile.TemporaryDirectory() as folder:
            token = Path(folder) / 'token'
            token.write_text('synthetic')
            for pages in ([{'results': [event()], 'resumeToken': 'next'}, RuntimeError('offline')],
                          [{'results': [event()], 'resumeToken': 'same'}] * 2,
                          [{'results': [], 'resumeToken': 'next'}],
                          [{'unexpected': []}],
                          [{'results': [event()], 'resumeToken': str(i)} for i in range(50)]):
                collector = Collector({'token_file': str(token)})
                with patch('risk_monitor.request_json', side_effect=pages):
                    self.assertIsNone(collector.public_settlements(ROOT))
                self.assertIn('boros_settlements', collector.errors)


if __name__ == '__main__':
    unittest.main()
