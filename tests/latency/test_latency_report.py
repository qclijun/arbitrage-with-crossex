"""Offline public report/CLI tests; no running terminal or account required."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
import tempfile
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('latency_report', ROOT / 'scripts/latency_report.py')
reporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reporter)


class ReportTest(unittest.TestCase):
    def test_replay_retains_failed_and_unfinished_requests_in_denominator(self):
        rows = [json.loads(line) for line in (ROOT / 'tests/fixtures/latency/requests.jsonl').read_text().splitlines()]
        result = reporter.summarize(rows)
        groups = {g['connection']: g for g in result['requests']}
        self.assertEqual(groups['cold']['total'], 1)
        self.assertEqual(groups['cold']['success'], 1)
        self.assertEqual(groups['cold']['latencyMs'], {'n': 1, 'p50': 100, 'p95': 100, 'max': 100})
        self.assertEqual(groups['warm']['total'], 2)
        self.assertEqual(groups['warm']['errors'], {'rate-limit': 1, 'unfinished': 1})
        self.assertEqual(groups['warm']['success'], 0)
        self.assertIsNone(groups['warm']['latencyMs']['p95'])
        self.assertEqual(result['queueMs']['status'], 'UNKNOWN')

    def test_pool_budgets_include_each_window_and_merged_percentiles(self):
        passed = reporter.pool_budget([[100] * 100] * 3, [[90] * 100] * 3)
        self.assertEqual(passed['status'], 'PASS')
        self.assertEqual(passed['improvedWindows'], 3)
        short = reporter.pool_budget([[100] * 100] * 3, [[90] * 99] * 3)
        self.assertEqual(short['status'], 'UNKNOWN')
        p50 = reporter.pool_budget([[50] * 50 + [200] * 50] * 3,
                                   [[56] * 50 + [150] * 50] * 3)
        self.assertEqual(p50['status'], 'FAIL')
        self.assertFalse(p50['checks']['mergedP50'])
        # The low-volume bad period does not dominate the merged percentile.
        per_period = reporter.pool_budget([[100] * 1000, [100] * 1000, [100] * 100],
                                         [[80] * 1000, [80] * 1000, [121] * 100])
        self.assertTrue(per_period['checks']['mergedP95'])
        self.assertFalse(per_period['checks']['everyWindowP95'])
        self.assertEqual(per_period['status'], 'FAIL')
        two_thirds = reporter.pool_budget([[100] * 100] * 3,
                                         [[80] * 100, [100] * 100, [100] * 100])
        self.assertFalse(two_thirds['checks']['twoThirdsWindows'])
        self.assertEqual(reporter.pool_budget([], [])['status'], 'UNKNOWN')

    def test_confirmed_exposure_uses_fills_not_reservations_and_deduplicates(self):
        def event(seq, stage, at, **fields):
            return dict(version=1, run='r', deal='d', tick=1, seq=seq,
                        stage=stage, monoMs=at, utcMs=1000 + at,
                        dropped=0, writeFailures=0, rotationFailures=0, **fields)
        rows = [event(1, 'projection', 0, aFilled='0', bFilled='0', bReserved='0', unreserved='0', outcome='ok'),
                event(2, 'fill-confirmed', 10, leg='A', client='a', cumulative='0.3', quantity='0.3'),
                event(3, 'registered', 20, leg='B', client='b', quantity='0.3'),
                event(4, 'projection', 30, aFilled='0.3', bFilled='0', bReserved='0.3', unreserved='0', outcome='ok'),
                event(5, 'fill-confirmed', 50, leg='B', client='b', cumulative='0.1', quantity='0.1'),
                event(6, 'fill-confirmed', 60, leg='B', client='b', cumulative='0.1', quantity='0.1'),
                event(7, 'fill-confirmed', 70, leg='B', client='b', cumulative='0.3', quantity='0.2'),
                event(8, 'tick-end', 80)]
        result = reporter.summarize(rows + rows)
        exposure = result['execution'][0]
        self.assertEqual(exposure['confirmedLocal']['peakBase'], '0.3')
        self.assertEqual(exposure['confirmedLocal']['durationMs'], 60)
        self.assertEqual(exposure['confirmedLocal']['integralBaseMs'], '16.0')
        self.assertEqual(exposure['confirmedLocal']['netBase'], '0.0')
        self.assertEqual(exposure['actualEconomic']['status'], 'UNKNOWN')
        self.assertEqual(exposure['response'][0]['fillToRegisteredMs'], 10)
        self.assertEqual(exposure['response'][0]['quantityBase'], '0.3')
        self.assertEqual(exposure['unreservedBase'], '0')
        lost = reporter.summarize(rows[1:])['execution'][0]
        self.assertEqual(lost['confirmedLocal']['status'], 'UNKNOWN')
        self.assertIsNone(lost['confirmedLocal']['integralBaseMs'])
        self.assertIn('missing-zero-anchor', lost['gaps'])

    def test_report_requires_evidence_even_when_percentile_budgets_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            windows = []
            for group in range(1, 4):
                for index, config in enumerate(('baseline', 'pooled')):
                    start = (group * 2 + index) * 100000
                    run = f'{group}-{config}'
                    rows = []
                    for n in range(100):
                        at = start + n * 500
                        common = dict(version=1, run=run, deal='d', tick=n, operation='sdk-order-read',
                                      startedMonoMs=at, connection='warm', dropped=0, writeFailures=0, rotationFailures=0)
                        rows += [dict(common, seq=n * 2 + 1, stage='send-entry', monoMs=at, utcMs=at),
                                 dict(common, seq=n * 2 + 2, stage='receipt', monoMs=at + (100 if index == 0 else 80),
                                      utcMs=at + (100 if index == 0 else 80), outcome='ok')]
                    file = root / f'{run}.jsonl'
                    file.write_text(''.join(json.dumps(r) + '\n' for r in rows))
                    windows.append(dict(group=group, config=config, startUtcMs=start, endUtcMs=start + 100000,
                                        files=[file.name]))
            manifest = dict(version=1, baseline='baseline', operations=['sdk-order-read'], windows=windows,
                            configurations={c: dict(version='test', configuration=c, machine='host-alias',
                                                    account='account-alias', route='direct')
                                            for c in ('baseline', 'pooled')})
            result = reporter.build_report(manifest, root)
            comparison = result['comparisons'][0]
            self.assertEqual(comparison['performance']['status'], 'PASS')
            self.assertEqual(comparison['status'], 'UNKNOWN')
            self.assertEqual(result['baseline']['status'], 'UNKNOWN')
            self.assertIn('observation-overhead-unverified', result['gaps'])
            self.assertEqual(comparison['strata']['cold']['status'], 'UNKNOWN')
            self.assertEqual(len(result['windows']), 6)
            self.assertEqual(result['windows'][0]['requests'][0]['total'], 100)
            manifest['windows'][2]['startUtcMs'] = manifest['windows'][0]['startUtcMs']
            self.assertEqual(reporter.build_report(manifest, root)['status'], 'UNKNOWN')

    def test_collection_index_and_cli_are_readonly_and_retention_owns_only_reports(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source'
            (source / 'details').mkdir(parents=True)
            original = (ROOT / 'tests/fixtures/latency/requests.jsonl').read_bytes()
            detail = source / 'details/obs-1000-abcdef-1.jsonl'
            detail.write_bytes(original)
            (source / 'status.json').write_text(json.dumps(dict(run='sample', seq=5, dropped=0,
                writeFailures=0, rotationFailures=0, bufferedBytes=0, evidence='COMPLETE')))
            output = root / 'output'
            result = reporter.snapshot(source, output)
            self.assertEqual(detail.read_bytes(), original)
            self.assertTrue(Path(result['files'][0]).exists())
            self.assertEqual(result['networkRequests'], 0)
            self.assertEqual(result['status'], 'UNKNOWN')
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            self.assertEqual((output / 'reports').stat().st_mode & 0o777, 0o700)
            sentinel = output / 'reports/ledger.sqlite'
            sentinel.write_bytes(b'keep')
            expired = output / 'reports/latency-1-abcdef.json'
            expired.write_bytes(b'expired')
            reporter.snapshot(source, output)
            self.assertFalse(expired.exists())
            self.assertEqual(sentinel.read_bytes(), b'keep')
            self.assertEqual(detail.read_bytes(), original)
            with self.assertRaises(ValueError):
                reporter.snapshot(source, source)
            linked = root / 'linked-output'
            linked.symlink_to(output, target_is_directory=True)
            with self.assertRaises(ValueError):
                reporter.snapshot(source, linked)
            # Public CLI replay writes only an owned report; no server needs to run.
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps(dict(version=1, baseline='baseline', operations=['sdk-order-read'],
                configurations={'baseline': dict(version='test', configuration='observation-only',
                    machine='host', account='alias', route='direct')}, windows=[dict(group=1, config='baseline',
                    startUtcMs=1000, endUtcMs=2000, files=result['files'], statusFiles=result['statusFiles'])])))
            cli = subprocess.run([sys.executable, str(ROOT / 'scripts/latency_report.py'), 'replay',
                str(manifest), '--output', str(output)], capture_output=True, text=True)
            self.assertEqual(cli.returncode, 0, cli.stderr)
            saved = json.loads(Path(json.loads(cli.stdout)['report']).read_text())
            self.assertEqual(saved['status'], 'UNKNOWN')
            self.assertEqual(saved['windows'][0]['requests'][0]['total'], 1)
            detail.write_bytes(original + original)
            mutated = reporter.build_report(json.loads(manifest.read_text()), root)
            self.assertIn('source-changed-since-collection', mutated['windows'][0]['gaps'])
            detail.write_bytes(original)
            self.assertEqual(detail.read_bytes(), original)

    def test_loss_clock_jump_missing_fields_and_conflicts_stay_unknown(self):
        base = [json.loads(line) for line in (ROOT / 'tests/fixtures/latency/requests.jsonl').read_text().splitlines()][:2]
        for label, modify, gap in [
            ('loss', lambda r: r[1].update(dropped=1), 'observation-loss-or-counters-missing'),
            ('clock', lambda r: r[1].update(utcMs=10000), 'wall-clock-jump'),
            ('missing', lambda r: r[1].pop('monoMs'), 'missing-clock'),
            ('identity', lambda r: r[1].pop('startedMonoMs'), 'missing-request-identity'),
            ('seq', lambda r: r[1].update(seq=3), 'sequence-gap')]:
            with self.subTest(label=label):
                rows = [dict(r) for r in base]
                modify(rows)
                self.assertIn(gap, reporter.summarize(rows)['gaps'])
        conflict = dict(base[1], outcome='unknown')
        self.assertIn('conflicting-record', reporter.summarize(base + [conflict])['gaps'])
        # Local/SDK nesting must not inflate a network-operation sample.
        nested = [dict(r, seq=r['seq'] + 2, operation='order-read') for r in base]
        groups = reporter.summarize(base + nested)['requests']
        self.assertEqual([g['total'] for g in groups], [1, 1])

    def test_failed_durations_are_separate_and_http_errors_cannot_be_success(self):
        rows = [json.loads(line) for line in (ROOT / 'tests/fixtures/latency/requests.jsonl').read_text().splitlines()][:2]
        rows[1].update(httpStatus=503)
        group = reporter.summarize(rows)['requests'][0]
        self.assertEqual(group['success'], 0)
        self.assertEqual(group['errors'], {'http': 1})
        self.assertEqual(group['allCompletedMs']['p95'], 100)

    def test_unknown_queue_and_final_writer_tail_cannot_pass_a_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = ROOT / 'tests/fixtures/latency/requests.jsonl'
            status = root / 'status.json'
            status.write_text(json.dumps(dict(run='sample', seq=6, dropped=0, writeFailures=0,
                rotationFailures=0, bufferedBytes=0, evidence='COMPLETE')))
            manifest = dict(version=1, baseline='baseline', operations=['sdk-order-read'],
                configurations={'baseline': dict(version='test', configuration='observation-only',
                    machine='host', account='alias', route='direct')}, windows=[dict(group=1, config='baseline',
                    startUtcMs=1000, endUtcMs=2000, files=[str(source)], statusFiles=[str(status)])])
            result = reporter.build_report(manifest, root)
            self.assertIn('final-writer-tail-mismatch', result['windows'][0]['gaps'])
            self.assertEqual(result['status'], 'UNKNOWN')

    def test_input_bounds_privacy_and_retention_capacity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source'
            (source / 'details').mkdir(parents=True)
            record = dict(version=1, seq=1, run='r', authHeader='secret-value', response={'account':'secret'})
            (source / 'details/obs-1000-abc-1.jsonl').write_text(json.dumps(record) + '\n')
            output = root / 'output'
            result = reporter.snapshot(source, output)
            self.assertNotIn('secret', Path(result['statusFiles'][0]).read_text())
            self.assertFalse((output / 'details').exists())
            directory = output / 'reports'
            directory.mkdir(exist_ok=True)
            old = directory / 'latency-9999999999999-abc.json'
            old.write_bytes(b'x' * (10 * reporter.MIB))
            unrelated = directory / 'keep.json'
            unrelated.write_text('keep')
            reporter.save_owned(output, 'reports', b'{}')
            self.assertFalse(old.exists())
            self.assertEqual(unrelated.read_text(), 'keep')
            huge = source / 'details/obs-1001-abc-2.jsonl'
            huge.write_bytes(b'x' * (reporter.MAX_LINE + 1))
            with self.assertRaises(ValueError):
                reporter.snapshot(source, output)

    def test_complete_fixed_comparison_passes_then_resource_or_new_errors_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact = root / 'audit.json'
            audit = dict(status='PASS', metrics=dict(rssDeltaMiB=10, steadyState=True, boundedGrowth=True,
                connectionsMax=2, connectionLimit=4, fdMax=12, fdLimit=20, n=200, p50=1, p95=2, max=3))
            artifact.write_text(json.dumps(audit))
            windows = []
            for group in range(1, 4):
                for index, config in enumerate(('baseline', 'pooled')):
                    start = (group * 2 + index) * 1000000
                    run = f'{group}-{config}'
                    rows = []
                    for n in range(200):
                        at = start + n * 1000
                        common = dict(version=1, run=run, deal='d', tick=n, operation='sdk-order-read',
                            startedMonoMs=at, connection='cold' if n < 100 else 'warm',
                            dropped=0, writeFailures=0, rotationFailures=0)
                        rows += [dict(common, seq=n*2+1, stage='send-entry', monoMs=at, utcMs=at),
                            dict(common, seq=n*2+2, stage='receipt', monoMs=at+(100 if not index else 80),
                                 utcMs=at+(100 if not index else 80), outcome='ok')]
                    (root / f'{run}.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
                    (root / f'{run}-status.json').write_text(json.dumps(dict(run=run, seq=400, dropped=0,
                        writeFailures=0, rotationFailures=0, bufferedBytes=0, evidence='COMPLETE')))
                    windows.append(dict(group=group, config=config, startUtcMs=start, endUtcMs=start+1000000,
                        files=[f'{run}.jsonl'], statusFiles=[f'{run}-status.json'],
                        evidence={key: dict(artifact='audit.json') for key in
                            ('resources','queue','safety','noNewErrors','confoundsCleared')}))
            manifest = dict(version=1, baseline='baseline', operations=['sdk-order-read'],
                observationOverheadEvidence='audit.json', windows=windows,
                configurations={c: dict(version='test', configuration='observation-only' if c == 'baseline' else c,
                    machine='host', account='alias', route='direct') for c in ('baseline', 'pooled')})
            self.assertEqual(reporter.build_report(manifest, root)['status'], 'PASS')
            audit['metrics']['rssDeltaMiB'] = 33
            artifact.write_text(json.dumps(audit))
            self.assertEqual(reporter.build_report(manifest, root)['status'], 'FAIL')
            audit['metrics']['rssDeltaMiB'] = 10
            artifact.write_text(json.dumps(audit))
            path = root / '1-pooled.jsonl'
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            rows[1].update(outcome='unknown', httpStatus=429, errorCategory='rate-limit')
            path.write_text(''.join(json.dumps(r)+'\n' for r in rows))
            result = reporter.build_report(manifest, root)
            self.assertEqual(result['status'], 'FAIL')
            self.assertEqual(result['comparisons'][0]['errorRateNonIncreasingByWindow'], [False, True, True])

            # A baseline alone cannot extrapolate a missing cold stratum.
            baseline_only = copy.deepcopy(manifest)
            baseline_only['configurations'].pop('pooled')
            baseline_only['windows'] = [w for w in baseline_only['windows'] if w['config'] == 'baseline']
            self.assertEqual(reporter.build_report(baseline_only, root)['status'], 'PASS')
            warm_only = copy.deepcopy(baseline_only)
            for window in warm_only['windows']:
                original_path = root / window['files'][0]
                records = [dict(json.loads(line), connection='warm') for line in original_path.read_text().splitlines()]
                warm_path = root / ('warm-' + original_path.name)
                warm_path.write_text(''.join(json.dumps(r)+'\n' for r in records))
                window['files'] = [warm_path.name]
            missing = reporter.build_report(warm_only, root)
            self.assertEqual(missing['baseline']['status'], 'UNKNOWN')
            self.assertTrue(any(layer['connection'] == 'cold' and layer['status'] == 'UNKNOWN'
                                for layer in missing['baseline']['strata']))
            # A safety attestation must never override verified contradictory fills.
            path = root / '1-baseline.jsonl'
            records = [json.loads(line) for line in path.read_text().splitlines()]
            at = 2300000
            common = dict(version=1, run='1-baseline', deal='d', tick=201, dropped=0,
                          writeFailures=0, rotationFailures=0)
            records += [dict(common, seq=401, stage='projection', monoMs=at, utcMs=at,
                             aFilled='0', bFilled='0', bReserved='0', unreserved='0', outcome='ok'),
                        dict(common, seq=402, stage='fill-confirmed', monoMs=at+1, utcMs=at+1,
                             leg='A', client='a', cumulative='0.1', quantity='0.1'),
                        dict(common, seq=403, stage='fill-confirmed', monoMs=at+2, utcMs=at+2,
                             leg='B', client='b', cumulative='0.2', quantity='0.2')]
            path.write_text(''.join(json.dumps(r)+'\n' for r in records))
            status_path = root / '1-baseline-status.json'
            status = json.loads(status_path.read_text())
            status['seq'] = 403
            status_path.write_text(json.dumps(status))
            unsafe = reporter.build_report(baseline_only, root)
            self.assertEqual(unsafe['windows'][0]['execution'][0]['overhedge'], True)
            self.assertEqual(unsafe['status'], 'FAIL')

    def test_collect_index_larger_than_one_record_can_be_replayed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source'
            (source / 'details').mkdir(parents=True)
            line = (ROOT / 'tests/fixtures/latency/requests.jsonl').read_text().splitlines()[0] + '\n'
            for n in range(100):
                (source / f'details/obs-{1000+n}-abc-1.jsonl').write_text(line)
            (source / 'status.json').write_text(json.dumps(dict(run='sample', seq=1, dropped=0,
                writeFailures=0, rotationFailures=0, bufferedBytes=0, evidence='COMPLETE')))
            collected = reporter.snapshot(source, root / 'output')
            self.assertGreater(Path(collected['statusFiles'][0]).stat().st_size, reporter.MAX_LINE)
            manifest = dict(version=1, baseline='baseline', operations=['sdk-order-read'],
                configurations={'baseline': dict(version='test', configuration='observation-only',
                    machine='host', account='alias', route='direct')}, windows=[dict(group=1, config='baseline',
                    startUtcMs=1000, endUtcMs=2000, files=collected['files'], statusFiles=collected['statusFiles'])])
            self.assertEqual(reporter.build_report(manifest, root)['status'], 'UNKNOWN')


    def test_wait_report_keeps_reserved_exposure_and_missing_evidence_separate(self):
        common = dict(version=1, run='r', deal='d', tick=1, stage='hedge-wait',
                      dropped=0, writeFailures=0, rotationFailures=0)
        rows = [dict(common, seq=1, monoMs=1, utcMs=1001, waitState='blocked', waitMs=0,
                     unreserved='0.05', actualUnhedged='0.05'),
                dict(common, seq=2, monoMs=30001, utcMs=31001, waitState='not-required', waitMs=30000,
                     unreserved='0', actualUnhedged='0.05')]
        wait = reporter.summarize(rows + rows)['hedgeWait'][0]
        self.assertEqual(wait['state'], 'not-required')
        self.assertEqual(wait['unreservedBase'], '0')
        self.assertEqual(wait['confirmedUnhedgedBase'], '0.05')
        self.assertEqual(wait['waitMs'], 30000)
        self.assertEqual(wait['actualEconomicStatus'], 'UNKNOWN')
        unknown = dict(rows[-1], seq=3, monoMs=30002, utcMs=31002,
                       waitState='unverified', waitMs=None, actualUnhedged=None)
        wait = reporter.summarize(rows + [unknown])['hedgeWait'][0]
        self.assertIsNone(wait['confirmedUnhedgedBase'])
        self.assertIsNone(wait['waitMs'])


if __name__ == '__main__':
    unittest.main()
