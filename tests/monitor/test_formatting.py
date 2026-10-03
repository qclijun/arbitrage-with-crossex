from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from risk_monitor import format_check, format_metric_value


class MetricFormattingTests(unittest.TestCase):
    def test_display_precision_matches_metric_units(self):
        cases = [
            (1234.5678912345, 'USD', '1234.57'),
            (0.000123456789, 'ETH', '0.000123'),
            (-0.000123456789, 'ETH/24h', '-0.000123'),
            (1.234567891, 'ratio', '1.2346'),
            (0.123456789, 'APR fraction', '0.1235'),
            (2.34567891, 'percentage points', '2.35'),
            (6.123456789, 'days', '6.12'),
            (12.34567891, 'seconds', '12.3'),
            (1800000000.123, 'unix seconds', '1800000000'),
            (3, 'count', '3'),
        ]
        for value, unit, expected in cases:
            with self.subTest(unit=unit):
                self.assertEqual(format_metric_value(value, unit), expected)

    def test_tiny_nonzero_values_never_appear_as_zero(self):
        self.assertEqual(format_metric_value(1.23456789e-9, 'ETH'), '1.23e-09')
        self.assertEqual(format_metric_value(-1.23456789e-9, 'ETH'), '-1.23e-09')
        self.assertEqual(format_metric_value(-0.0, 'ETH'), '0.000000')

    def test_unknown_and_non_numeric_values_remain_clear(self):
        self.assertEqual(format_metric_value(None, 'ETH'), 'UNKNOWN')
        self.assertEqual(format_metric_value(False, 'bool'), 'False')
        self.assertEqual(format_metric_value('clear', 'enum'), 'clear')

    def test_conditions_follow_the_corresponding_metric(self):
        check = {
            'id': 'boros.im_coverage', 'status': 'OK', 'reason': '',
            'metrics': {'boros.im_coverage': {'value': 1.456789, 'unit': 'ratio'}},
            'thresholds': [
                ['boros.im_coverage', 'lt', 1.3, 'WARNING'],
                ['boros.im_coverage', 'lt', 1.15, 'CRITICAL'],
            ],
        }
        self.assertIn('boros.im_coverage=1.4568 ratio (WARNING < 1.3; CRITICAL < 1.15)', format_check(check))
        self.assertNotIn('within configured management thresholds', format_check(check))

    def test_each_metric_uses_its_own_current_conditions_and_keeps_error_reason(self):
        check = {
            'id': 'hedge', 'status': 'UNKNOWN', 'reason': 'missing/expired: hedge.direction_match',
            'metrics': {
                'hedge.perp_net_eth': {'value': -0.01, 'unit': 'ETH'},
                'hedge.direction_match': {'value': None, 'unit': 'bool'},
            },
            'thresholds': [
                ['hedge.perp_net_eth', 'abs_gt', 0.02, 'WARNING'],
                ['hedge.direction_match', 'eq', False, 'CRITICAL'],
            ],
        }
        output = format_check(check)
        self.assertIn('hedge.perp_net_eth=-0.010000 ETH (WARNING |value| > 0.02)', output)
        self.assertIn('hedge.direction_match=UNKNOWN bool (CRITICAL = False)', output)
        self.assertIn('missing/expired: hedge.direction_match', output)


if __name__ == '__main__':
    unittest.main()
