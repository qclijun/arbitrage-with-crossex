"""Four-configuration replay through the delivered report seam; synthetic evidence only."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('latency_report', ROOT / 'scripts/latency_report.py')
reporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reporter)


def matrix_fixture(root, durations=(100, 80, 100, 80)):
    configs = ('baseline', 'pool', 'wait', 'combined')
    audit = dict(status='PASS', metrics=dict(rssDeltaMiB=10, steadyState=True, boundedGrowth=True,
        connectionsMax=1, connectionLimit=1, poolMaxSockets=1, maxGenerationSockets=1,
        transitionHighWaterIncluded=True, fdMax=12, fdLimit=20, n=200, p50=1, p95=2, max=3))
    (root / 'window.json').write_text(json.dumps(audit))
    windows = []
    for group in range(1, 4):
        for index, config in enumerate(configs):
            start = (group * 4 + index) * 1000000
            run, rows = f'{group}-{config}', []
            for n in range(200):
                at = start + n * 1000
                common = dict(version=1, run=run, deal='d', tick=n, operation='sdk-order-read',
                    startedMonoMs=at, connection='cold' if n < 100 else 'warm',
                    dropped=0, writeFailures=0, rotationFailures=0)
                rows += [dict(common, seq=n*2+1, stage='send-entry', monoMs=at, utcMs=at),
                    dict(common, seq=n*2+2, stage='receipt', monoMs=at+durations[index],
                         utcMs=at+durations[index], outcome='ok')]
            (root / f'{run}.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
            (root / f'{run}-status.json').write_text(json.dumps(dict(run=run, seq=400, dropped=0,
                writeFailures=0, rotationFailures=0, bufferedBytes=0, evidence='COMPLETE')))
            windows.append(dict(group=group, config=config, startUtcMs=start, endUtcMs=start+1000000,
                files=[f'{run}.jsonl'], statusFiles=[f'{run}-status.json'],
                evidence={k: dict(artifact='window.json') for k in
                    ('resources', 'queue', 'safety', 'noNewErrors', 'confoundsCleared')}))
    return dict(version=1, baseline='baseline', operations=['sdk-order-read'], windows=windows,
        observationOverheadEvidence='window.json', optimizationMatrix={c: c for c in configs},
        configurations={c: dict(version='fixed-test', configuration=c, machine='host', account='alias',
            route='direct', skipUnrelatedMakerWait=c in ('wait', 'combined'), poolMaxSockets=1 if c in ('pool', 'combined') else None) for c in configs})


def audited_fixture(root):
    manifest = matrix_fixture(root)
    audits = {
        'overhead': dict(groups=3, minTicksPerGroup=1000, everyGroupWithinBudget=True,
            mergedWithinBudget=True, rssDeltaMiB=12, steadyState=True, boundedGrowth=True),
        'selection': dict(maxSockets=1, baselineCompared=True, concurrencyTested=True, readOnlyCompared=True),
        'safety': {k: True for k in ('makerDependency', 'missingPrice', 'partialCancelRace', 'dustSizing',
            'unknownFreeze', 'intentEdits', 'outageRecovery', 'transportUnknown', 'authRouting',
            'credentialRetirement', 'observationBounds', 'clockUncertainty', 'reservedExposure')},
        'rollback': {k: True for k in ('pool', 'wait', 'combined', 'inFlightDrained', 'ledgerPreserved', 'noResend')},
    }
    for name, metrics in audits.items():
        (root / f'{name}.json').write_text(json.dumps(dict(status='PASS', metrics=metrics)))
    manifest.update(observationOverheadEvidence='overhead.json', poolSelectionEvidence='selection.json',
                    offlineSafetyEvidence='safety.json', rollbackEvidence='rollback.json')
    return manifest


class RolloutTest(unittest.TestCase):
    def test_wait_only_does_not_need_to_improve_signed_read_latency(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = reporter.build_report(matrix_fixture(root), root)
            wait = next(c for c in result['comparisons'] if c['config'] == 'wait')
            self.assertEqual(wait['performance']['status'], 'PASS')
            self.assertEqual(wait['status'], 'PASS')
            # Complete timings alone are never trial approval.
            self.assertEqual(result['trialEligibility']['status'], 'UNKNOWN')
            self.assertFalse(result['trialEligibility']['automaticEnablement'])

    def test_combination_cannot_hide_a_regression_against_pool_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = reporter.build_report(matrix_fixture(root, (100, 60, 100, 80)), root)
            direct = next(c for c in result['comparisons'] if c['config'] == 'combined' and c['referenceConfig'] == 'baseline')
            incremental = next(c for c in result['comparisons'] if c['config'] == 'combined' and c['referenceConfig'] == 'pool')
            self.assertEqual(direct['status'], 'PASS')
            self.assertEqual(incremental['status'], 'FAIL')
            self.assertEqual(result['status'], 'FAIL')
            self.assertEqual(result['trialEligibility']['status'], 'FAIL')

    def test_complete_audited_matrix_only_qualifies_for_manual_trial(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = reporter.build_report(audited_fixture(root), root)
            self.assertEqual(result['trialEligibility']['status'], 'PASS')
            self.assertEqual(set(result['trialEligibility']['configurations']), {'pool', 'wait', 'combined'})
            self.assertFalse(result['trialEligibility']['automaticEnablement'])
            self.assertEqual(result['trialEligibility']['naturalTrading'], 'UNKNOWN')
            self.assertTrue(any(p['path'].endswith('selection.json') for p in result['provenance']))

    def test_declared_selections_must_match_each_matrix_role(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = audited_fixture(root)
            manifest['configurations']['baseline']['poolMaxSockets'] = 1
            self.assertEqual(reporter.build_report(manifest, root)['trialEligibility']['status'], 'FAIL')
            manifest['configurations']['baseline']['poolMaxSockets'] = None
            del manifest['configurations']['combined']['skipUnrelatedMakerWait']
            self.assertEqual(reporter.build_report(manifest, root)['trialEligibility']['status'], 'UNKNOWN')
            manifest['configurations']['combined']['skipUnrelatedMakerWait'] = True
            del manifest['configurations']['baseline']['poolMaxSockets']
            self.assertEqual(reporter.build_report(manifest, root)['trialEligibility']['status'], 'UNKNOWN')

    def test_missing_audits_and_explicit_safety_or_resource_failures_never_enable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = audited_fixture(root)
            for key in ('rollbackEvidence', 'poolSelectionEvidence', 'offlineSafetyEvidence'):
                missing = copy.deepcopy(manifest)
                missing.pop(key)
                self.assertEqual(reporter.build_report(missing, root)['trialEligibility']['status'], 'UNKNOWN')
            safety = json.loads((root / 'safety.json').read_text())
            safety['metrics']['unknownFreeze'] = False
            (root / 'safety.json').write_text(json.dumps(safety))
            result = reporter.build_report(manifest, root)
            self.assertEqual(result['trialEligibility']['status'], 'FAIL')
            self.assertEqual(result['status'], 'FAIL')
            self.assertFalse(result['trialEligibility']['automaticEnablement'])
            safety['metrics']['unknownFreeze'] = True
            (root / 'safety.json').write_text(json.dumps(safety))
            overhead = json.loads((root / 'overhead.json').read_text())
            overhead['metrics']['rssDeltaMiB'] = 33
            (root / 'overhead.json').write_text(json.dumps(overhead))
            self.assertEqual(reporter.build_report(manifest, root)['trialEligibility']['status'], 'FAIL')
            overhead['metrics']['rssDeltaMiB'] = 12
            overhead['metrics']['minTicksPerGroup'] = 999
            (root / 'overhead.json').write_text(json.dumps(overhead))
            self.assertEqual(reporter.build_report(manifest, root)['trialEligibility']['status'], 'UNKNOWN')

    def test_duplicate_or_incomplete_matrix_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = matrix_fixture(root)
            manifest['optimizationMatrix']['combined'] = 'pool'
            with self.assertRaises(ValueError):
                reporter.build_report(manifest, root)

    def test_final_parameter_is_bound_to_measured_generations_and_transition_high_water(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = audited_fixture(root)
            path = root / 'window.json'
            audit = json.loads(path.read_text())
            audit['metrics'].update(connectionsMax=4, connectionLimit=4)
            path.write_text(json.dumps(audit))
            # Multiple retiring generations may legitimately overlap at four sockets.
            self.assertEqual(reporter.build_report(manifest, root)['trialEligibility']['status'], 'PASS')
            audit['metrics']['maxGenerationSockets'] = 4
            path.write_text(json.dumps(audit))
            self.assertEqual(reporter.build_report(manifest, root)['trialEligibility']['status'], 'FAIL')
            audit['metrics']['maxGenerationSockets'] = 1
            audit['metrics']['poolMaxSockets'] = 4
            path.write_text(json.dumps(audit))
            self.assertEqual(reporter.build_report(manifest, root)['trialEligibility']['status'], 'FAIL')
            audit['metrics']['poolMaxSockets'] = 1
            audit['metrics']['transitionHighWaterIncluded'] = False
            path.write_text(json.dumps(audit))
            self.assertEqual(reporter.build_report(manifest, root)['trialEligibility']['status'], 'FAIL')
            audit['metrics']['transitionHighWaterIncluded'] = True
            del audit['metrics']['poolMaxSockets']
            path.write_text(json.dumps(audit))
            self.assertEqual(reporter.build_report(manifest, root)['trialEligibility']['status'], 'UNKNOWN')


if __name__ == '__main__':
    unittest.main()
