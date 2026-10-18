"""Offline decision safety checks at the watch CLI/report/ledger seam."""
import contextlib
import io
import datetime as dt
import json
import unittest

import test_rollover_watch as support


class RolloverDecisionTest(unittest.TestCase):
    setUpClass = classmethod(support.RolloverWatchTest.setUpClass.__func__)
    setUp = support.RolloverWatchTest.setUp
    run_watch = support.RolloverWatchTest.run_watch
    run_json = support.RolloverWatchTest.run_json

    def test_suppression_blocks_decision_advice_at_every_date(self):
        for day in (24, 25, 26):
            for scenario in ('notional', 'position', 'pending', 'approved-b'):
                with self.subTest(day=day, scenario=scenario):
                    fake = support.FakeTerminal()
                    args = ['--notional-usd', '12000'] if scenario == 'notional' else []
                    if scenario == 'position':
                        fake.asset = support.asset_view(hl_entry=.08)
                    if scenario == 'approved-b':
                        args = ['--b-approved', '--notional-usd', '12000']
                    if scenario == 'pending':
                        args = ['--execution-pending']
                    _, report = self.run_watch(fake, now=support.epoch(2026, 10, day), args=args)
                    self.assertIn('当日不给建议', report)
                    for action in ('二选一建议：滚', '二选一建议：B', '选 滚', '执行主批', '先用最小可验证规模试批'):
                        self.assertNotIn(action, report)

    def test_known_critical_gap_survives_missing_profit_and_suppression(self):
        for missing_fee in (False, True):
            for suppressed in (False, True):
                with self.subTest(missing_fee=missing_fee, suppressed=suppressed):
                    self.latest.write_text(json.dumps(dict(checks=[dict(metrics={
                        'rollover.uncovered_funding_seconds': dict(value=301)})])))
                    fake = support.FakeTerminal(terms=RuntimeError('synthetic missing fee') if missing_fee else None)
                    _, report = self.run_watch(fake, args=['--execution-pending'] if suppressed else [])
                    self.assertTrue(report.startswith('结论：CRITICAL'), report.splitlines()[0])
                    self.assertIn('资金费空档 301 秒', report)
                    if missing_fee:
                        self.assertIn('UNKNOWN', report)
                    if suppressed:
                        self.assertIn('当日不给建议', report)
                        self.assertIn('禁止新批次或重发', report)
                    row = json.loads(self.ledger.read_text().splitlines()[-1])
                    self.assertTrue(any('CRITICAL: 资金费空档 301 秒' in w for w in row['warns']))

    def test_gap_boundary_and_missing_gap_do_not_invent_critical(self):
        for gap in (300, None):
            with self.subTest(gap=gap):
                self.latest.write_text(json.dumps(dict(checks=[dict(metrics={
                    'rollover.uncovered_funding_seconds': dict(value=gap)})])))
                _, report = self.run_watch(support.FakeTerminal(terms=RuntimeError('missing')))
                self.assertTrue(report.startswith('结论：UNKNOWN'))
                self.assertNotIn('CRITICAL: 资金费空档', report)

    def test_decision_date_requires_actual_admission_even_with_technical_candidate(self):
        for day in (24, 25, 26):
            for candidate in (True, False):
                for approved in (False, True):
                    with self.subTest(day=day, candidate=candidate, approved=approved):
                        fake = support.FakeTerminal(sim=support.simulation(blocker=None if candidate else 'synthetic depth'))
                        _, report = self.run_watch(fake, now=support.epoch(2026, 10, day),
                                                  args=['--b-approved'] if approved else ['--receipt-success', '--batch-overhead-usd', '0'])
                        row = json.loads(self.ledger.read_text().splitlines()[-1])
                        self.assertTrue(row['execution_admission'].startswith('UNKNOWN'))
                        if day >= 25 and not approved:
                            self.assertTrue(report.startswith('结论：CRITICAL'), report.splitlines()[0])
                            self.assertIn('实盘准入', report)
                            self.assertIn('退出', report)
                            self.assertNotIn('二选一建议：滚', report)
                        elif day >= 25:
                            self.assertIn('二选一建议：B', report)
                            self.assertIn('执行前仍需', report)
                        else:
                            self.assertFalse(report.startswith('结论：CRITICAL'))

    def test_watch_cutoff_stops_before_any_network_or_sampling_sleep(self):
        for stamp in ((2026, 10, 29, 0, 0, 0), (2026, 10, 29, 12, 0, 0),
                      (2026, 10, 30, 9, 0, 0), (2026, 11, 1, 0, 0, 0)):
            with self.subTest(stamp=stamp):
                now = dt.datetime(*stamp, tzinfo=support.TZ).timestamp()
                fake = support.FakeTerminal(asset=RuntimeError('terminal unavailable'))
                output = io.StringIO()
                def reject_sleep(_):
                    self.fail('cutoff must not enter sampling sleep')
                with contextlib.redirect_stdout(output):
                    code = self.module.run(['--token-file', str(self.token), '--ledger', str(self.ledger)],
                                           fetch=fake, now=lambda: now, sleep=reject_sleep)
                self.assertEqual(code, 0)
                report = output.getvalue()
                self.assertIn('日期截止', report)
                self.assertIn('不再继续', report)
                self.assertEqual(fake.calls, [])
                self.assertNotIn('二选一建议', report)
                self.assertNotIn('退出完成', report)
                row = json.loads(self.ledger.read_text().splitlines()[-1])
                self.assertEqual(row['watch_status'], 'ENDED_DATE_CUTOFF')
                self.assertIsNone(row['A_usd'])
                self.assertNotIn(row.get('progress_state'), ('ROLLED', 'EXITED'))

    def test_last_second_before_cutoff_still_samples_and_cutoff_honors_json_no_write(self):
        before = dt.datetime(2026, 10, 28, 23, 59, 59, tzinfo=support.TZ).timestamp()
        fake = support.FakeTerminal()
        self.run_watch(fake, now=before, args=['--no-write'])
        self.assertEqual(fake.quote_index, 3)
        self.assertFalse(self.ledger.exists())
        self.token.unlink()
        cutoff = before + 1
        fake = support.FakeTerminal()
        code, row = self.run_json(fake, now=cutoff, args=['--no-write'])
        self.assertEqual(code, 0)
        self.assertEqual(row['watch_status'], 'ENDED_DATE_CUTOFF')
        self.assertFalse(self.ledger.exists())
        self.assertEqual(fake.calls, [])

    def test_running_watch_limits_sleep_to_cutoff_and_never_fetches_after_it(self):
        cutoff = dt.datetime(2026, 10, 29, tzinfo=support.TZ).timestamp()
        for cross_after in ('sleep', 'asset', 'simulate', 'discover-probe', 'quote-first',
                            'quote-last', 'terms', 'terms-skip', 'refresh'):
            with self.subTest(cross_after=cross_after):
                clock = [cutoff - (300 if cross_after == 'refresh' else 1)]
                fake = support.FakeTerminal(sim=support.simulation(blocker='synthetic depth', depth=1)
                                            if cross_after == 'discover-probe' else None)
                sleeps = []
                assets = []
                def fetch(url, token, timeout, data=None):
                    self.assertLess(clock[0], cutoff, 'network after cutoff')
                    fake.now = clock[0]
                    result = fake(url, token, timeout, data)
                    if '/api/asset-view/' in url:
                        assets.append(url)
                    crossed = (
                        cross_after == 'asset' and '/api/asset-view/' in url
                        or cross_after in ('simulate', 'discover-probe') and url.endswith('/simulate')
                        or cross_after == 'quote-first' and fake.quote_index == 1 and '/opportunities?' in url
                        or cross_after == 'quote-last' and fake.quote_index == 3 and '/opportunities?' in url
                        or cross_after in ('terms', 'terms-skip') and url == self.module.TERMS_URL
                        or cross_after == 'refresh' and len(assets) == 2)
                    if crossed:
                        clock[0] = cutoff
                    return result
                def sleep(seconds):
                    self.assertLess(clock[0], cutoff, 'sleep after cutoff')
                    self.assertLessEqual(seconds, cutoff - clock[0])
                    sleeps.append(seconds)
                    if cross_after in ('sleep', 'refresh'):
                        clock[0] += seconds
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    argv = ['--token-file', str(self.token), '--ledger', str(self.ledger),
                            '--latest-json', str(self.latest)]
                    if cross_after == 'terms-skip':
                        argv.append('--skip-simulate')
                    code = self.module.run(argv,
                                           fetch=fetch, now=lambda: clock[0], sleep=sleep)
                self.assertEqual(code, 0)
                self.assertIn('日期截止', output.getvalue())
                self.assertNotIn('二选一建议', output.getvalue())
                if cross_after == 'sleep':
                    self.assertEqual(sleeps, [1])
                    self.assertEqual(fake.quote_index, 1)
                row = json.loads(self.ledger.read_text().splitlines()[-1])
                self.assertEqual(row['watch_status'], 'ENDED_DATE_CUTOFF')
                self.assertIsNone(row['A_usd'])
                self.assertEqual(row['progress_state'], 'UNKNOWN')

    def test_changed_position_after_sampling_suppresses_every_recommendation(self):
        fake = support.FakeTerminal()
        fake.now = support.DECISION_NOW
        calls = []
        def changed_fetch(url, token, timeout, data=None):
            result = fake(url, token, timeout, data)
            if '/api/asset-view/' in url:
                calls.append(url)
                if len(calls) > 1:
                    result['data']['risk']['positions'][0]['sizeToken'] = support.SIZE - .1
            if url.endswith('/api/boros/roll/simulate'):
                result['data']['simulatedAtMs'] = (fake.now - 61) * 1000
            return result
        class Terminal:
            now = support.DECISION_NOW
            def __call__(self, *args, **kwargs):
                return changed_fetch(*args, **kwargs)
        _, report = self.run_watch(Terminal(), now=support.DECISION_NOW)
        self.assertGreaterEqual(len(calls), 2)
        self.assertIn('当日不给建议', report)
        self.assertNotIn('二选一建议：滚', report)
        self.assertNotIn('二选一建议：B', report)
        self.assertNotIn('执行主批', report)


if __name__ == '__main__':
    unittest.main()
