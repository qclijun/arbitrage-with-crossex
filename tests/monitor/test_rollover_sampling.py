"""Offline three-sample evidence through the watch report and ledger boundary."""
import json
import unittest
from unittest.mock import patch

import test_rollover_watch as fixtures


class RolloverSamplingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.RolloverWatchTest.setUpClass()

    def setUp(self):
        self.harness = fixtures.RolloverWatchTest('runTest')
        self.harness.setUp()
        self.addCleanup(self.harness.doCleanups)
        self.watch = self.harness.module
        self.address = '0x' + '1' * 40
        self.addCleanup(patch.stopall)
        patch.object(self.watch, 'ADDRESS', self.address).start()
        patch.object(self.watch, 'SIZE', 1.5).start()
        patch.dict(self.watch.PROFILE, address=self.address, totalSize=1.5).start()

    def terminal(self, quotes):
        asset = fixtures.asset_view(old_size=1.5)
        positions = asset['data']['risk']['positions'][:2]
        for position in positions:
            position['marketAcc'] = self.address + '000002ffffff'
        asset['data']['risk'].update(address=self.address, positions=positions)
        asset['data']['assets'][0]['borosOpen'] = positions
        return fixtures.FakeTerminal(asset=asset, quotes=quotes)

    def collect(self, quotes, args=None):
        terminal = self.terminal(quotes)
        code, report = self.harness.run_watch(
            terminal, args=['--interval-seconds', '60'] + (args or []))
        row = json.loads(self.harness.ledger.read_text().splitlines()[-1])
        return code, report, row

    def test_one_available_exit_spread_is_not_a_three_sample_profit(self):
        missing = fixtures.opportunity()
        del missing['data']['groups'][0]['markets'][0]['execLongApr']
        code, report, row = self.collect([fixtures.opportunity(), missing, missing])
        self.assertIsNone(row['E'])
        self.assertIsNone(row['A_usd'])
        self.assertIsNotNone(row['S'])
        self.assertNotIn('选 A′', report)
        self.assertEqual(code, 2)

    def test_failed_requests_and_diagnostic_sampling_remain_unknown(self):
        good = fixtures.opportunity()
        cases = [([good, {}, {}], [], 1), ([good, good, {}], [], 2),
                 ([{}, {}, {}], [], 0), ([good], ['--samples', '1'], 1)]
        for quotes, args, successful in cases:
            with self.subTest(successful=successful, args=args):
                _, report, row = self.collect(quotes, args)
                self.assertEqual(row['sample_count'], successful)
                self.assertEqual(row['sample_expected_count'], 1 if args else 3)
                self.assertFalse(row['sample_complete'])
                self.assertIsNone(row['A_usd'])
                self.assertNotIn('选 A′', report)

    def test_missing_mid_preserves_known_cash_terms_but_not_decision_evidence(self):
        missing = fixtures.opportunity()
        del missing['data']['groups'][0]['markets'][1]['midApr']
        _, report, row = self.collect([fixtures.opportunity(), missing, fixtures.opportunity()])
        self.assertIsNone(row['mid']['198'])
        self.assertIsNone(row['X_max'])
        self.assertIsNotNone(row['E'])
        self.assertIsNotNone(row['A_usd'])
        self.assertFalse(row['sample_complete'])
        self.assertIn('不给建议', report)
        self.assertNotIn('选 A′', report)

    def test_complete_quotes_keep_the_median_and_min_max(self):
        quotes = [fixtures.opportunity(exec_209=rate) for rate in (.075, .077, .073)]
        _, _, row = self.collect(quotes)
        self.assertTrue(row['sample_complete'])
        self.assertEqual(row['sample_count'], 3)
        self.assertEqual(row['sample_expected_count'], 3)
        self.assertAlmostEqual(row['S'], .0237)
        self.assertAlmostEqual(row['S_min'], .0217)
        self.assertAlmostEqual(row['S_max'], .0257)

    def test_incomplete_history_cannot_lower_the_current_consensus(self):
        historical = dict(v=3, quote_size_eth=1.5, now_unix=fixtures.NOW-86400,
                          S=-.2, sample_count=3, sample_expected_count=3,
                          sample_complete=False, sample_interval_seconds=60)
        self.harness.ledger.write_text(json.dumps(historical)+'\n')
        _, _, row = self.collect([fixtures.opportunity()])
        self.assertAlmostEqual(row['S_cons'], .0232)

    def test_scope_mismatched_quotes_are_not_complete_history(self):
        _, report, row = self.collect([fixtures.opportunity()], ['--notional-usd', '15000'])
        self.assertIn('不给建议', report)
        self.assertFalse(row['sample_complete'])

    def test_short_sampling_intervals_are_diagnostic_only(self):
        for interval in ('0', '59'):
            with self.subTest(interval=interval):
                _, report, row = self.collect([fixtures.opportunity()], ['--interval-seconds', interval])
                self.assertFalse(row['sample_complete'])
                self.assertIsNone(row['S_cons'])
                self.assertIn('不给建议', report)
                self.assertNotIn('选 A′', report)


if __name__ == '__main__':
    unittest.main()
