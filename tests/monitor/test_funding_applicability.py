"""Ticket 16: the monitor's continuous ETH funding-gap chain uses the floating
exemption the Risk report proved (version 2), never recomputes or widens it,
shares the terminal's gap identity, and never restarts the clock because some
quantity was proven to float."""
import copy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from risk_monitor import Collector, record_funding_gap
from test_shared_report import ADDRESS, NOW, response

LONG, SHORT = 'OKX_FUTURE_ETH_USDT', 'HYPERLIQUID_FUTURE_ETH_USDC'
# fundingGapFingerprint (src/core/risk.ts) for the same legs, computed by the
# terminal; the two must stay byte-identical.
TERMINAL_PLAIN = '["object",[["account_id",["number","0000000000000000"]],["boros",["array",[]]],["perps",["array",[["array",[["string","HYPERLIQUID_FUTURE_ETH_USDC"],["string","HYPERLIQUID"],["string","SHORT"],["number","4008000000000000"]]],["array",[["string","OKX_FUTURE_ETH_USDT"],["string","OKX"],["string","LONG"],["number","4008000000000000"]]]]]],["root",["string","0x1111111111111111111111111111111111111111"]]]]'
TERMINAL_FLOATING = '["object",[["account_id",["number","0000000000000000"]],["boros",["array",[]]],["floating",["array",[["array",[["string","HYPERLIQUID_FUTURE_ETH_USDC"],["string","SHORT"],["number","3ff0000000000000"]]],["array",[["string","OKX_FUTURE_ETH_USDT"],["string","LONG"],["number","3ff0000000000000"]]]]]],["perps",["array",[["array",[["string","HYPERLIQUID_FUTURE_ETH_USDC"],["string","HYPERLIQUID"],["string","SHORT"],["number","4008000000000000"]]],["array",[["string","OKX_FUTURE_ETH_USDT"],["string","OKX"],["string","LONG"],["number","4008000000000000"]]]]]],["root",["string","0x1111111111111111111111111111111111111111"]]]]'


def collection(floating=None):
    legs = [{'symbol': LONG, 'exchange': 'OKX', 'side': 'LONG', 'qty': 3},
            {'symbol': SHORT, 'exchange': 'HYPERLIQUID', 'side': 'SHORT', 'qty': 3}]
    data = {'agent': {'root': ADDRESS},
            'positions': {'positions': [{'symbol': LONG, 'positionQty': '3'}, {'symbol': SHORT, 'positionQty': '-3'}],
                          'exposure': [{'base': 'ETH', 'legs': legs}]},
            'farm': {'risk': {'address': ADDRESS, 'accountId': 0, 'positionsComplete': True, 'stale': False, 'positions': []}}}
    if floating is not None:
        data['fundingApplicability'] = [{'symbol': s, 'side': side, 'qty': q, 'sliceIds': ['F']} for s, side, q in floating]
    return data


CONFIG = {'root': ADDRESS, 'account_id': 0}


class FundingApplicabilityTest(unittest.TestCase):
    def test_version_one_collection_keeps_the_terminal_identity_and_full_gap(self):
        state = {}
        record_funding_gap(collection(), CONFIG, state, NOW)
        self.assertEqual(state['funding_gap']['fingerprint'], TERMINAL_PLAIN)
        self.assertEqual(state['funding_gap']['uncovered_eth'], 6)

    def test_proven_floating_quantity_leaves_no_gap(self):
        state = {}
        record_funding_gap(collection([(LONG, 'LONG', '3'), (SHORT, 'SHORT', '3')]), CONFIG, state, NOW)
        self.assertEqual(state['funding_gap']['uncovered_eth'], 0)

    def test_identity_matches_the_terminal_with_an_exemption(self):
        state = {}
        record_funding_gap(collection([(LONG, 'LONG', '1'), (SHORT, 'SHORT', '1')]), CONFIG, state, NOW)
        self.assertEqual(state['funding_gap']['fingerprint'], TERMINAL_FLOATING)
        self.assertEqual(state['funding_gap']['uncovered_eth'], 4)

    def test_a_new_exemption_never_restarts_the_clock_on_the_rest_of_the_gap(self):
        state = {}
        record_funding_gap(collection(), CONFIG, state, NOW - 500)
        record_funding_gap(collection([(LONG, 'LONG', '1'), (SHORT, 'SHORT', '1')]), CONFIG, state, NOW)
        self.assertEqual(state['funding_gap']['started_at'], NOW - 500)
        # A wider gap is a new one: the evidence for the old clock no longer covers it.
        record_funding_gap(collection(), CONFIG, state, NOW + 10)
        self.assertEqual(state['funding_gap']['started_at'], NOW + 10)

    def test_decimal_quantities_match_the_terminal_exactly(self):
        state = {}
        data = collection([(LONG, 'LONG', '3.67'), (SHORT, 'SHORT', '3.67')])
        for leg in data['positions']['exposure'][0]['legs']:
            leg['qty'] = 4.03
        record_funding_gap(data, CONFIG, state, NOW)
        self.assertEqual(state['funding_gap']['uncovered_eth'], 0.72)  # 0.36 on each source, exactly

    def test_an_unknown_exemption_neither_extends_nor_restarts_the_history(self):
        state = {}
        record_funding_gap(collection([(LONG, 'LONG', '1'), (SHORT, 'SHORT', '1')]), CONFIG, state, NOW - 500)
        before = copy.deepcopy(state)
        data = collection()
        data['fundingApplicability'] = None
        record_funding_gap(data, CONFIG, state, NOW)
        self.assertEqual(state, before)

    def test_malformed_or_oversized_evidence_records_no_history(self):
        for floating in ([(LONG, 'LONG', '4')], [(LONG, 'UP', '1')], [(LONG, 'LONG', '1e-3')], [(SHORT, 'LONG', '1')]):
            with self.subTest(floating=floating):
                state = {'funding_gap': {'started_at': NOW - 1}}
                record_funding_gap(collection(floating), CONFIG, state, NOW)
                self.assertNotIn('funding_gap', state)

    def test_collector_accepts_version_two_only_with_its_exemption_list(self):
        with tempfile.TemporaryDirectory() as folder:
            token = Path(folder) / 'api-token'
            token.write_text('local-only-token')
            config = {'root': ADDRESS, 'token_file': str(token), 'state_dir': folder}
            ok = copy.deepcopy(response(config))
            ok['data']['version'] = 2
            ok['data']['collection']['fundingApplicability'] = None  # UNKNOWN is a valid answer
            bad = copy.deepcopy(ok)
            bad['data']['collection'].pop('fundingApplicability')
            with patch('risk_monitor.request_json', return_value=ok), patch('risk_monitor.time.time', return_value=NOW):
                self.assertEqual(Collector(config).collect_report({})['version'], 2)
            with patch('risk_monitor.request_json', return_value=bad), patch('risk_monitor.time.time', return_value=NOW):
                with self.assertRaises(RuntimeError):
                    Collector(config).collect_report({})


if __name__ == '__main__':
    unittest.main()
