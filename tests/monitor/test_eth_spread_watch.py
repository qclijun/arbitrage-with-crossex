"""ETH short-Hyperliquid / long-Binance spread watch: offline, public-history and /api/fees shapes."""
from decimal import Decimal
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import eth_spread_watch as watch

H = 3_600_000
D = 24 * H
# 2026-11-02 08:00 UTC, a Binance settlement; the run is 30 minutes later.
CUTOFF = 1793606400000 + 8 * H
NOW = CUTOFF + 30 * 60_000
# The account's CrossEx rates (VIP5): one taker round trip on both legs over 90 days is 0.73% APR.
FEES = [{'exchangeType': 'BINANCE', 'futureMakerFee': '0.0002', 'futureTakerFee': '0.00045', 'specialFeeList': []},
        {'exchangeType': 'HYPERLIQUID', 'futureMakerFee': '0.0002', 'futureTakerFee': '0.00045'}]
BREAKEVEN = Decimal('0.0073')
BELOW = '0.00003333'  # Binance 3.65% APR against HL at its 10.95% baseline


def venue(bn, hl, fees=FEES, start=CUTOFF - 40 * D):
    """Binance every 8h and HL every hour up to CUTOFF, rates as functions of time, plus the terminal's fees."""
    binance = [{'symbol': 'ETHUSDT', 'fundingTime': t + 1, 'fundingRate': bn(t)} for t in range(start, CUTOFF + 1, 8 * H)]
    hyperliquid = [{'coin': 'ETH', 'time': t + 7, 'fundingRate': hl(t)} for t in range(start, CUTOFF + 1, H)]

    def get(url, body=None, headers=None):
        if url.endswith('/api/fees'):
            assert headers == {'x-arb-token': 'secret'}
            return {'ok': True, 'data': fees}
        if 'binance' in url:
            since = int(url.split('startTime=')[1].split('&')[0])
            return [r for r in binance if r['fundingTime'] >= since]
        return [r for r in hyperliquid if r['time'] >= body['startTime']][:500]
    return get


def healthy():
    return venue(lambda t: BELOW, lambda t: '0.0000125')


class SpreadWatch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.token = Path(self.tmp.name) / 'api-token'
        self.token.write_text('secret\n')

    def tearDown(self):
        self.tmp.cleanup()

    def run_watch(self, get, *argv):
        out = io.StringIO()
        with redirect_stdout(out):
            code = watch.main(['--json', '--token-file', str(self.token), *argv], get=get, now=NOW)
        return code, json.loads(out.getvalue())

    def test_healthy_spread_is_ok_against_the_accounts_own_fees(self):
        code, result = self.run_watch(healthy())
        self.assertEqual((code, result['status'], result['failed']), (0, 'OK', []))
        self.assertEqual(Decimal(result['breakeven']), BREAKEVEN)
        self.assertEqual(result['breakeven_source'], '按 taker 成交，taker 费率 Binance 0.045% / HL 0.045%，持有 90 天，借款 0.00%')
        self.assertEqual(Decimal(result['month']['hyperliquid']), Decimal('0.1095'))
        self.assertAlmostEqual(float(result['month']['net']), 0.1095 - 0.00003333 * 3 * 365, places=12)
        self.assertEqual((result['cutoff'], Decimal(result['binance_baseline_share'])), (CUTOFF, 0))

    def test_break_even_follows_execution_hold_borrow_and_a_symbol_special_rate(self):
        fees = [FEES[0] | {'specialFeeList': [{'symbol': 'BINANCE_FUTURE_ETH_USDT', 'makerFeeRate': '0', 'takerFeeRate': '0.0003'}]}, FEES[1]]
        _, result = self.run_watch(venue(lambda t: BELOW, lambda t: '0.0000125', fees),
                                   '--execution', 'limit-hedge', '--hold-days', '30', '--borrow-apr', '0.01')
        # Maker on Binance (0%) and taker on HL (0.045%), twice, over 30 days, plus 1%.
        self.assertEqual(Decimal(result['breakeven']), Decimal('0.00090') * 365 / 30 + Decimal('0.01'))

    def test_a_fresh_drop_below_break_even_warns_but_does_not_alert(self):
        # Binance reached HL 28 days ago: the 30-day net crossed below break-even only in the last week.
        turn = CUTOFF - 28 * D
        code, result = self.run_watch(venue(lambda t: '0.0001' if t > turn else BELOW, lambda t: '0.0000125'))
        self.assertEqual((code, result['status'], result['below_breakeven_7d']), (1, 'WARN', False))
        self.assertEqual(result['failed'], ['net_30d_below_breakeven', 'binance_back_at_baseline'])

    def test_seven_days_below_break_even_is_an_alert(self):
        code, result = self.run_watch(venue(lambda t: '0.0001', lambda t: '0.0000125'))
        self.assertEqual((code, result['status'], result['below_breakeven_7d']), (2, 'ALERT', True))
        code, result = self.run_watch(venue(lambda t: '0.0001', lambda t: '0.00001'))
        self.assertEqual(result['failed'], ['net_30d_below_breakeven', 'net_7d_negative_twice', 'binance_back_at_baseline'])
        self.assertEqual(code, 2)

    def test_binance_back_at_baseline_warns_even_while_the_month_still_pays(self):
        recent = CUTOFF - 16 * D
        code, result = self.run_watch(venue(lambda t: '0.0001' if t > recent else '-0.0001', lambda t: '0.0000125'))
        self.assertEqual((code, result['status'], result['failed']), (1, 'WARN', ['binance_back_at_baseline']))

    def test_one_negative_week_alone_is_not_a_reversal(self):
        week = CUTOFF - 7 * D
        code, result = self.run_watch(venue(lambda t: BELOW, lambda t: '0.0000125' if t <= week else '0.000001'))
        self.assertEqual((code, result['failed']), (0, []))
        self.assertLess(Decimal(result['last_7d']['net']), 0)

    def test_a_fixed_break_even_skips_the_fee_read(self):
        base = healthy()
        code, result = self.run_watch(lambda url, body=None, headers=None: (_ for _ in ()).throw(OSError('no terminal'))
                                      if url.endswith('/api/fees') else base(url, body, headers), '--breakeven', '0.015')
        self.assertEqual((code, Decimal(result['breakeven']), result['breakeven_source']), (0, Decimal('0.015'), '手动指定'))

    def test_missing_history_or_fees_is_unknown_never_ok(self):
        base = healthy()
        code, result = self.run_watch(lambda url, body=None, headers=None:
                                      [r for r in base(url, body) if r.get('time') != CUTOFF - 5 * H + 7]
                                      if 'hyperliquid' in url else base(url, body, headers))
        self.assertEqual((code, result['status']), (3, 'UNKNOWN'))
        self.assertIn('hyperliquid-gapped', result['reason'])
        extra = {'symbol': 'ETHUSDT', 'fundingTime': CUTOFF - 4 * H, 'fundingRate': '0.0001'}
        _, result = self.run_watch(lambda url, body=None, headers=None: sorted(
            base(url, body, headers) + [extra], key=lambda r: r['fundingTime']) if 'binance' in url else base(url, body, headers))
        self.assertIn('binance-not-8h-or-gapped', result['reason'])
        _, result = self.run_watch(venue(lambda t: BELOW, lambda t: '0.0000125', FEES[:1]))
        self.assertIn('fees-missing-hyperliquid', result['reason'])
        _, result = self.run_watch(healthy(), '--terminal-url', 'http://example.com:6688')
        self.assertIn('terminal-url-not-loopback', result['reason'])
        code, result = self.run_watch(lambda url, body=None, headers=None: (_ for _ in ()).throw(OSError('offline')))
        self.assertEqual((code, result['reason']), (3, 'OSError: offline'))

    def test_a_float_rate_or_another_coin_is_rejected(self):
        _, result = self.run_watch(venue(lambda t: 0.0001, lambda t: '0.0000125'))
        self.assertIn('rate-not-string', result['reason'])
        base = healthy()
        _, result = self.run_watch(lambda url, body=None, headers=None:
                                   [{**r, 'coin': 'BTC'} for r in base(url, body)] if 'hyperliquid' in url else base(url, body, headers))
        self.assertIn('hyperliquid-page-invalid', result['reason'])

    def test_log_appends_one_line_per_run(self):
        log = Path(self.tmp.name) / 'runs.jsonl'
        for _ in range(2):
            self.run_watch(healthy(), '--log', str(log))
        self.assertEqual([json.loads(line)['status'] for line in log.read_text().splitlines()], ['OK', 'OK'])


if __name__ == '__main__':
    unittest.main()
