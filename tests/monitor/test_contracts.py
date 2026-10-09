import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from risk_monitor import evaluate, heartbeat_check, load, notify_report, save, telegram
from risk_monitor_evidence import CONTRACTS

ROOT = Path(__file__).resolve().parents[2]
NOW = 1800000000


class ContractTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.config = {'observations_file': str(self.folder / 'observations.json')}
        self.rules = load(ROOT / 'scripts/risk-monitor-rules.json')

    def tearDown(self):
        self.temp.cleanup()

    def observation(self, value, **fields):
        return {'value': value, 'observed_at': NOW, 'ttl_seconds': 50,
                'source': 'synthetic official review', 'evidence': 'synthetic reference', **fields}

    def test_every_check_has_an_independent_risk_scenario(self):
        # Literal cases come from the checklist, not from recomputing conditions.
        cases = {
            'boros.im_coverage': ('boros.im_coverage', 1.1, 'CRITICAL'),
            'boros.mm_health_ratio': ('boros.mm_health_ratio', 1.1, 'CRITICAL'),
            'boros.available_eth': ('boros.available_eth', 0, 'CRITICAL'),
            'boros.adverse_spread_pp': ('boros.adverse_spread_pp', 3, 'CRITICAL'),
            'boros.settlement_net_24h_eth': ('boros.buffer_runway_days', 1, 'CRITICAL'),
            'gate.im_coverage': ('gate.im_coverage', 1, 'CRITICAL'),
            'gate.mm_health_ratio': ('gate.mm_health_ratio', 1, 'CRITICAL'),
            'gate.liability_usdt': ('gate.liability_usdt', 1, 'WARNING'),
            'gate.liquidation_distance_pct': ('gate.liquidation_distance_pct', .1, 'CRITICAL'),
            'collateral.eth_net': ('collateral.stress_loss_profit_ratio', 2, 'WARNING'),
            'collateral.stress_loss_usd': ('collateral.stress_loss_profit_ratio', 2, 'WARNING'),
            'basis.mark_spread_usd_per_eth': ('basis.loss_profit_ratio', .6, 'CRITICAL'),
            'basis.executable_exit_cost_usd': ('basis.depth_coverage_ratio', .5, 'WARNING'),
            'hedge.perp_net_eth': ('hedge.perp_net_eth', -.02, 'CRITICAL'),
            'hedge.hl_size_gap_eth': ('hedge.direction_match', False, 'CRITICAL'),
            'hedge.maturity_match': ('hedge.maturity_match', False, 'CRITICAL'),
            'hedge.market_identity_match': ('hedge.market_identity_match', False, 'CRITICAL'),
            'execution.unhedged_eth': ('execution.unhedged_eth', .01, 'CRITICAL'),
            'positions.unexpected_change_eth': ('positions.unexpected_change_eth', .01, 'CRITICAL'),
            'rollover.days_to_maturity': ('rollover.days_to_maturity', .5, 'CRITICAL'),
            'rollover.next_net_apr': ('rollover.next_net_apr', -.01, 'WARNING'),
            'rollover.incremental_margin_usd': ('rollover.post_roll_coverage', 1, 'WARNING'),
            'rollover.uncovered_funding_seconds': ('rollover.uncovered_funding_seconds', 301, 'CRITICAL'),
            'market.trading_status': ('market.trading_status', 'halted', 'CRITICAL'),
            'data.age_seconds': ('data.age_seconds', 601, 'CRITICAL'),
            'service.http_ok': ('service.http_ok', False, 'WARNING'),
            'agent.approval': ('agent.approval', 'not-approved', 'CRITICAL'),
            'agent.gas_balance_usd': ('agent.gas_balance_usd', .1, 'CRITICAL'),
            'monitor.heartbeat_age_s': ('monitor.heartbeat_age_s', 661, 'CRITICAL'),
            'notify.last_success_at': ('notify.failure_streak', 3, 'CRITICAL'),
            'stablecoin.usdt_usd': ('stablecoin.usdt_usd', .98, 'CRITICAL'),
            'custody.incident_status': ('custody.incident_status', 'active', 'CRITICAL'),
            'protocol.incident_status': ('protocol.incident_status', 'active', 'CRITICAL'),
        }
        self.assertEqual(set(cases), {r['id'] for r in self.rules})
        for rule in self.rules:
            with self.subTest(check=rule['id']):
                key, value, expected = cases[rule['id']]
                save(self.config['observations_file'], {'metrics': {key: self.observation(value)}})
                # Retain coverage for paused checks so they can be restored safely.
                report = evaluate({}, self.config, {'notify_failures': 3}, [{**rule, 'enabled': True}], NOW)
                self.assertEqual(report['checks'][0]['status'], expected)

    def test_invalid_evidence_and_contract_expiry_cannot_clear_risk(self):
        rule = next(r for r in self.rules if r['id'] == 'boros.mm_health_ratio')
        entries = [self.observation('5'), self.observation(True), self.observation(float('nan')),
                   self.observation(5, unit='USD'), self.observation(5, source=' '),
                   self.observation(5, observed_at=NOW + 1),
                   self.observation(5, observed_at=NOW - 3601, ttl_seconds=999999)]
        for entry in entries:
            with self.subTest(entry=entry):
                # Handwritten files can contain nonfinite JSON; the reader must reject it.
                Path(self.config['observations_file']).write_text(json.dumps({'metrics': {'boros.mm_health_ratio': entry}}))
                check = evaluate({}, self.config, {}, [rule], NOW)['checks'][0]
                self.assertEqual(check['status'], 'UNKNOWN')
                self.assertFalse(check['coverageComplete'])

    def test_exact_boundary_and_recovery_hysteresis(self):
        rule = next(r for r in self.rules if r['id'] == 'boros.im_coverage')
        def run(value, state):
            save(self.config['observations_file'], {'metrics': {'boros.im_coverage': self.observation(value)}})
            return evaluate({}, self.config, state, [rule], NOW)['checks'][0]['status']
        self.assertEqual(run(1.15, {}), 'WARNING')
        state = {}
        self.assertEqual(run(1.1, state), 'CRITICAL')
        self.assertEqual(run(1.16, state), 'CRITICAL')
        self.assertEqual(run(1.19, state), 'WARNING')
        self.assertEqual(run(1.31, state), 'WARNING')
        self.assertEqual(run(1.35, state), 'OK')

    def test_event_evidence_is_not_a_safety_guarantee(self):
        records = {key: self.observation(value) for key, value in {
            'custody.incident_status': 'clear', 'custody.withdrawal_status': 'available'}.items()}
        save(self.config['observations_file'], {'metrics': records})
        rule = next(r for r in self.rules if r['id'] == 'custody.incident_status')
        check = evaluate({}, self.config, {}, [rule], NOW)['checks'][0]
        self.assertEqual(check['status'], 'OK')
        self.assertIn('not proof of safety', check['reason'])
        self.assertEqual(check['metrics']['custody.incident_status']['expiresAt'], NOW + 50)

    def test_contract_covers_every_metric_with_units_and_source(self):
        self.assertEqual(set(CONTRACTS), {m for r in self.rules for m in r['metrics']})
        self.assertEqual(len(CONTRACTS), 68)
        for contract in CONTRACTS.values():
            self.assertTrue(contract['unit'])
            self.assertTrue(contract['source'])
            self.assertGreater(contract['max_age_seconds'], 0)

    def test_external_heartbeat_missing_malformed_stale_future_and_incomplete(self):
        path = self.folder / 'heartbeat.json'
        self.assertEqual(heartbeat_check(path, NOW, 300)['status'], 'CRITICAL')
        for value in ('{', 'null', '[]', '{"observedAt": NaN, "complete": true}'):
            path.write_text(value)
            self.assertEqual(heartbeat_check(path, NOW, 300)['status'], 'CRITICAL')
        cases = [({'observedAt': NOW - 660, 'complete': True}, 'OK'),
                 ({'observedAt': NOW - 661, 'complete': True}, 'CRITICAL'),
                 ({'observedAt': NOW + 1, 'complete': True}, 'CRITICAL'),
                 ({'observedAt': NOW, 'complete': False, 'lastCompleteAt': NOW - 100}, 'WARNING'),
                 ({'observedAt': NOW, 'complete': False, 'lastCompleteAt': NOW - 661}, 'CRITICAL'),
                 ({'observedAt': NOW, 'complete': False}, 'CRITICAL')]
        for beat, status in cases:
            save(path, beat)
            self.assertEqual(heartbeat_check(path, NOW, 300)['status'], status)

    def test_cli_heartbeat_never_needs_terminal_or_credentials(self):
        config = self.folder / 'config.json'
        save(config, {'terminal_url': 'http://invalid.invalid', 'token_file': '/no-token'})
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/risk_monitor.py'), '--config', str(config),
                                 '--heartbeat', str(self.folder / 'missing.json')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['status'], 'CRITICAL')
        self.assertFalse(result.stderr)

    def test_cli_record_rejects_invalid_types_and_excess_ttl(self):
        config = self.folder / 'config.json'
        save(config, self.config)
        for value, ttl in [('"clear"', '3600'), ('NaN', '120'), ('1', '3600')]:
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/risk_monitor.py'), '--config', str(config),
                '--record', 'stablecoin.usdt_usd', '--value', value, '--source', 'synthetic', '--evidence', 'synthetic',
                '--ttl-seconds', ttl], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
        self.assertFalse(Path(self.config['observations_file']).exists())
