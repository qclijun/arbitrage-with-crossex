import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from risk_monitor import Collector, evaluate, load, notify_report, save


NOW = 1800000000


def fixture():
    return {
        'account': {'marginBalance': '1000', 'initialMargin': '800', 'maintenanceMargin': '250',
                    'assets': [{'coin': 'USDT', 'liability': '0'}, {'coin': 'USDC', 'liability': '0'}]},
        'positions': {'positions': [
            {'symbol': 'HYPERLIQUID_FUTURE_ETH_USDC', 'positionQty': '-3', 'entryPrice': '3001', 'markPrice': '3001', 'upnl': '0', 'updateTime': NOW * 1000},
            {'symbol': 'BINANCE_FUTURE_ETH_USDT', 'positionQty': '3', 'entryPrice': '3000', 'markPrice': '3000', 'upnl': '0', 'updateTime': NOW * 1000}]},
        'farm': {'coverage': {'borosPositionsComplete': True, 'borosTxnsComplete': True, 'settlementsFromSec': 0, 'perpClosedFromSec': 0}, 'warnings': [], 'assets': [{
            'base': 'ETH', 'priceUsd': 3000, 'earliestSec': NOW - 3600,
            'borosOpen': [
                {'marketId': 1, 'venue': 'HYPERLIQUID', 'side': 'SHORT', 'sizeToken': 3, 'entryApr': .08, 'markApr': .08,
                 'maturity': NOW + 86400 * 80, 'mtmUsd': 0, 'imUsd': 100, 'settleFeeApr': .001},
                {'marketId': 2, 'venue': 'BINANCE', 'side': 'LONG', 'sizeToken': 3, 'entryApr': .04, 'markApr': .04,
                 'maturity': NOW + 86400 * 80, 'mtmUsd': 0, 'imUsd': 100, 'settleFeeApr': .001}],
            'perpOpen': [
                {'symbol': 'HYPERLIQUID_FUTURE_ETH_USDC', 'venue': 'HYPERLIQUID', 'side': 'SHORT', 'qty': 3, 'feesUsd': 4},
                {'symbol': 'BINANCE_FUTURE_ETH_USDT', 'venue': 'BINANCE', 'side': 'LONG', 'qty': 3, 'feesUsd': 2}],
            'borosHistory': [{'tradeFeeUsd': 1, 'settleUsd': 0}, {'tradeFeeUsd': 1, 'settleUsd': 0}]}]},
        'context': {'crossByToken': [{'tokenId': 2, 'available': .03}], 'isolatedByMarket': []},
        'agent': {'approval': 'approved', 'expiry': NOW + 86400 * 365},
        'interest': {'buckets': []},
        'orders': [], 'deals': [], 'alerts': [], 'health': {'status': 'ok'}}


class RiskMonitorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = {'root': 'synthetic', 'observations_file': str(Path(self.temp.name) / 'observations.json'),
                       'baseline': {'opened_at': NOW - 3600, 'boros': {'1': -3, '2': 3},
                                    'perps': {'HYPERLIQUID_FUTURE_ETH_USDC': -3, 'BINANCE_FUTURE_ETH_USDT': 3}}}
        self.rules = load(Path(__file__).resolve().parents[2] / 'scripts/risk-monitor-rules.json', [])

    def tearDown(self):
        self.temp.cleanup()

    def check(self, data, key, **kwargs):
        report = evaluate(data, self.config, {}, self.rules, NOW, **kwargs)
        return next(c for c in report['checks'] if c['id'] == key)

    def test_every_risk_and_check_emitted_with_no_data(self):
        report = evaluate({}, self.config, {}, self.rules, NOW, {'collector': 'offline'})
        self.assertEqual(len(report['checks']), 29)
        self.assertEqual({c['risk'] for c in report['checks']}, set(range(1, 9)) - {3})
        self.assertTrue(all(c['metrics'] for c in report['checks']))
        self.assertTrue(all(c['status'] != 'OK' for c in report['checks']))

    def test_invalid_position_quantity_is_unknown_not_zero(self):
        data = fixture()
        data['positions']['positions'][0]['positionQty'] = None
        check = self.check(data, 'hedge.perp_net_eth')
        self.assertEqual(check['status'], 'UNKNOWN')
        self.assertIsNone(check['metrics']['hedge.perp_net_eth']['value'])


    def test_initial_margin_not_confused_with_maintenance(self):
        data = fixture()
        im = self.check(data, 'gate.im_coverage')['metrics']['gate.im_coverage']['value']
        mm = self.check(data, 'gate.mm_health_ratio')['metrics']['gate.mm_health_ratio']['value']
        self.assertEqual(im, 1.25)
        self.assertEqual(mm, 4)
        self.assertEqual(self.check(data, 'boros.mm_health_ratio')['status'], 'UNKNOWN')

    def test_automatic_liquidation_distance_and_thresholds(self):
        for distance, status in ((.4, 'OK'), (.2, 'WARNING'), (.1, 'CRITICAL'), (0, 'CRITICAL'),
                                 (None, 'UNKNOWN'), (-.1, 'UNKNOWN'), (float('nan'), 'UNKNOWN')):
            with self.subTest(distance=distance):
                data = fixture()
                data['liquidation'] = {'distance': distance, 'assumptions': 'synthetic model'}
                check = self.check(data, 'gate.liquidation_distance_pct')
                self.assertEqual(check['status'], status)
                self.assertIn('synthetic model', check['metrics']['gate.liquidation_distance_pct']['source'])

    def test_failed_liquidation_read_is_unknown(self):
        data = fixture()
        data['liquidation'] = None
        self.assertEqual(self.check(data, 'gate.liquidation_distance_pct')['status'], 'UNKNOWN')

    def test_current_daily_interest_reuses_wallet_estimates(self):
        data = fixture()
        data['account']['assets'] = [
            {'coin': 'USDT', 'exchangeType': 'CROSSEX', 'liability': '2000'},
            {'coin': 'USDC', 'exchangeType': 'HYPERLIQUID', 'liability': '12000'},
            {'coin': 'USDC', 'exchangeType': 'LIGHTER', 'liability': '1000'}]
        data['interest']['buckets'] = [
            {'coin': 'USDT', 'venue': 'CROSSEX', 'borrow': 2000, 'ratePerYear': .0876, 'interestPerDayUsd': .48},
            {'coin': 'USDC', 'venue': 'HYPERLIQUID', 'borrow': 12000, 'ratePerYear': .1752, 'interestPerDayUsd': .96},
            {'coin': 'USDC', 'venue': 'LIGHTER', 'borrow': 1000, 'ratePerYear': .0876, 'interestPerDayUsd': .24}]
        metric = self.check(data, 'gate.liability_usdt')['metrics']['gate.interest_daily_usd']
        self.assertAlmostEqual(metric['value'], 1.68)
        self.assertEqual(metric['coverage'], 'derived')
        self.assertEqual(metric['unit'], 'USD/day')

    def test_hl_interest_free_borrow_is_still_a_liability(self):
        data = fixture()
        data['account']['assets'] = [{'coin': 'USDC', 'exchangeType': 'HYPERLIQUID', 'liability': '10000'}]
        data['interest']['buckets'] = [{'coin': 'USDC', 'venue': 'HYPERLIQUID', 'borrow': 10000,
                                      'ratePerYear': .0876, 'interestPerDayUsd': 0}]
        metrics = self.check(data, 'gate.liability_usdt')['metrics']
        self.assertEqual(metrics['gate.liability_usdc']['value'], 10000)
        self.assertEqual(metrics['gate.interest_daily_usd']['value'], 0)

    def test_daily_interest_missing_or_inconsistent_inputs_are_unknown(self):
        for change in ('offline', 'missing', 'invalid_buckets', 'rate', 'cost', 'borrow', 'duplicate', 'coin'):
            with self.subTest(change=change):
                data = fixture()
                data['account']['assets'] = [{'coin': 'USDT', 'exchangeType': 'CROSSEX', 'liability': '2000'}]
                bucket = {'coin': 'USDT', 'venue': 'CROSSEX', 'borrow': 2000,
                          'ratePerYear': .0876, 'interestPerDayUsd': .48}
                data['interest'] = {'buckets': [bucket]}
                if change == 'offline':
                    data['interest'] = None
                elif change == 'missing':
                    data['interest']['buckets'] = []
                elif change == 'invalid_buckets':
                    data['interest']['buckets'] = {'invalid': True}
                elif change == 'rate':
                    bucket['ratePerYear'] = None
                elif change == 'cost':
                    bucket['interestPerDayUsd'] = float('nan')
                elif change == 'borrow':
                    bucket['borrow'] = 1000
                elif change == 'duplicate':
                    data['interest']['buckets'].append(dict(bucket))
                else:
                    data['account']['assets'][0]['coin'] = 'ETH'
                self.assertIsNone(self.check(data, 'gate.liability_usdt')['metrics']['gate.interest_daily_usd']['value'])

    def test_no_borrow_has_zero_daily_interest_and_overrides_external_record(self):
        save(self.config['observations_file'], {'metrics': {'gate.interest_daily_usd': {
            'value': 99, 'observed_at': NOW, 'ttl_seconds': 3600, 'source': 'synthetic', 'evidence': 'synthetic'}}})
        metric = self.check(fixture(), 'gate.liability_usdt')['metrics']['gate.interest_daily_usd']
        self.assertEqual(metric['value'], 0)
        self.assertEqual(metric['coverage'], 'derived')

    def test_collector_reads_interest_without_starting_a_job(self):
        token = Path(self.temp.name) / 'token'
        token.write_text('synthetic')
        collector = Collector({'token_file': str(token)})
        calls = []

        def get(name, path):
            calls.append((name, path))
            return {'account': {'assets': []}, 'buckets': []} if name == 'interest' else {}

        with patch.object(collector, 'get', side_effect=get):
            data = collector.collect()
        self.assertIn(('interest', '/account/interest?fresh=1'), calls)
        self.assertIn(('liquidation', '/account/liquidation?fresh=1'), calls)
        self.assertFalse(any('/rebalance' in path for _, path in calls))
        self.assertEqual(data['account'], {'assets': []})
        self.assertEqual(data['interest']['buckets'], [])

    def test_unexpected_change_is_critical_without_adl_evidence(self):
        data = fixture()
        data['farm']['assets'][0]['borosOpen'][0]['sizeToken'] = 2
        check = self.check(data, 'positions.unexpected_change_eth')
        self.assertEqual(check['status'], 'CRITICAL')
        self.assertTrue(check['coverageComplete'])
        self.assertEqual(set(check['metrics']), {'positions.unexpected_change_eth'})

    def test_removed_adl_metric_does_not_latch_old_critical(self):
        state = {'critical_metrics': {'positions.unexpected_change_eth': ['positions.adl_event_count']},
                 'risk_status': {'positions.unexpected_change_eth': 'CRITICAL'}}
        report = evaluate(fixture(), self.config, state, self.rules, NOW)
        check = next(c for c in report['checks'] if c['id'] == 'positions.unexpected_change_eth')
        self.assertEqual(check['status'], 'OK')
        self.assertEqual(check['metrics']['positions.unexpected_change_eth']['value'], 0)
        self.assertTrue(check['coverageComplete'])
        self.assertEqual(state['critical_metrics']['positions.unexpected_change_eth'], [])

    def test_wrong_direction_is_immediate_critical(self):
        data = fixture()
        data['farm']['assets'][0]['borosOpen'][0]['side'] = 'LONG'
        self.assertEqual(self.check(data, 'hedge.hl_size_gap_eth')['status'], 'CRITICAL')

    def test_missing_leg_is_not_neutral(self):
        data = fixture()
        data['positions']['positions'].pop()
        self.assertEqual(self.check(data, 'hedge.perp_net_eth')['status'], 'CRITICAL')

    def test_expired_boros_leaves_funding_gap(self):
        data = fixture()
        for b in data['farm']['assets'][0]['borosOpen']:
            b['maturity'] = NOW - 1
        self.assertEqual(self.check(data, 'rollover.uncovered_funding_seconds')['status'], 'WARNING')

    def test_stale_real_timestamp_not_response_time(self):
        data = fixture()
        for p in data['positions']['positions']:
            p['updateTime'] = (NOW - 1000) * 1000
        self.assertEqual(self.check(data, 'data.age_seconds')['status'], 'CRITICAL')

    def test_missing_basis_inputs_preserve_other_measurements(self):
        data = fixture()
        data['positions']['positions'][0]['markPrice'] = None
        data['positions']['positions'][0]['upnl'] = None
        report = evaluate(data, self.config, {}, self.rules, NOW)
        check = next(c for c in report['checks'] if c['id'] == 'basis.mark_spread_usd_per_eth')
        self.assertEqual(check['status'], 'UNKNOWN')
        self.assertIsNone(check['metrics']['basis.mark_spread_usd_per_eth']['value'])
        self.assertIsNone(check['metrics']['basis.pnl_usd']['value'])
        gate = next(c for c in report['checks'] if c['id'] == 'gate.im_coverage')
        self.assertEqual(gate['status'], 'OK')


    def test_expired_evidence_never_green(self):
        save(self.config['observations_file'], {'metrics': {'boros.mm_health_ratio': {
            'value': 5, 'observed_at': NOW - 100, 'ttl_seconds': 50, 'source': 'official', 'evidence': 'local-reference'}}})
        self.assertEqual(self.check(fixture(), 'boros.mm_health_ratio')['status'], 'UNKNOWN')

    def test_fresh_evidence_and_threshold_override(self):
        save(self.config['observations_file'], {'metrics': {'boros.mm_health_ratio': {
            'value': 1.4, 'observed_at': NOW, 'ttl_seconds': 50, 'source': 'official', 'evidence': 'local-reference'}}})
        self.assertEqual(self.check(fixture(), 'boros.mm_health_ratio')['status'], 'WARNING')
        self.config['thresholds'] = {'boros.mm_health_ratio': [['boros.mm_health_ratio', 'lt', 1.1, 'CRITICAL']]}
        self.assertEqual(self.check(fixture(), 'boros.mm_health_ratio')['status'], 'OK')

    def test_stablecoins_not_assumed_one(self):
        self.assertEqual(self.check(fixture(), 'stablecoin.usdt_usd')['status'], 'UNKNOWN')

    def test_nonpositive_external_usd_quote_is_unknown(self):
        save(self.config['observations_file'], {'metrics': {'stablecoin.usdt_usd': {
            'value': -1, 'unit': 'USD', 'observed_at': NOW, 'ttl_seconds': 120,
            'source': 'independent USD quote', 'evidence': 'synthetic quote'}}})
        check = self.check(fixture(), 'stablecoin.usdt_usd')
        self.assertEqual(check['status'], 'UNKNOWN')
        self.assertIsNone(check['metrics']['stablecoin.usdt_usd']['value'])


    def test_notification_retry_dedup_and_recovery(self):
        state = {}
        report = {'checks': [{'id': 'x', 'label': 'Synthetic test', 'status': 'CRITICAL', 'reason': 'test', 'recommendedAction': 'verify'}]}
        def fail(text):
            raise RuntimeError('offline')
        notify_report(report, state, {}, {}, NOW, fail)
        self.assertIn('x', state['pending'])
        self.assertNotIn('x', state['notified_status'])
        sent = []
        notify_report(report, state, {}, {}, NOW + 1, sent.append)
        self.assertEqual(len(sent), 1)
        self.assertFalse(state['pending'])
        notify_report(report, state, {}, {}, NOW + 2, sent.append)
        self.assertEqual(len(sent), 1)
        report['checks'][0]['status'] = 'OK'
        notify_report(report, state, {}, {}, NOW + 3, sent.append)
        notify_report(report, state, {}, {}, NOW + 4, sent.append)
        self.assertEqual(len(sent), 2)
        self.assertEqual(state['notified_status']['x'], 'OK')

    def test_warning_debounce(self):
        state, sent = {}, []
        report = {'checks': [{'id': 'x', 'label': 'test', 'status': 'WARNING', 'reason': 'test', 'recommendedAction': 'verify'}]}
        notify_report(report, state, {}, {}, NOW, sent.append)
        self.assertFalse(sent)
        notify_report(report, state, {}, {}, NOW + 300, sent.append)
        self.assertEqual(len(sent), 1)

    def test_state_permissions_and_atomic_json(self):
        path = Path(self.temp.name) / 'state.json'
        save(path, {'x': 1})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(load(path), {'x': 1})

    def test_remote_terminal_url_rejected_before_token_read(self):
        with self.assertRaises(ValueError):
            Collector({'terminal_url': 'http://example.com'})

    def test_invalid_execution_quantity_is_unknown(self):
        data = fixture()
        data['deals'] = [{'pair': {'mode': 'RUNNING'}, 'orders': [],
                          'projection': {'unhedged': None, 'anyPending': False, 'anyQuarantined': False}}]
        check = self.check(data, 'execution.unhedged_eth')
        self.assertEqual(check['status'], 'UNKNOWN')
        self.assertIsNone(check['metrics']['execution.unhedged_eth']['value'])


    def test_halted_nested_deal_and_actual_unhedged(self):
        data = fixture()
        data['deals'] = [{'pair': {'mode': 'HALTED'}, 'orders': [],
                          'projection': {'unhedged': .1, 'anyPending': False, 'anyQuarantined': False}}]
        check = self.check(data, 'execution.unhedged_eth')
        self.assertEqual(check['status'], 'CRITICAL')
        self.assertEqual(check['metrics']['execution.halted_count']['value'], 1)

    def test_positive_raw_short_quantity_uses_position_side(self):
        data = fixture()
        data['positions']['positions'][0]['positionQty'] = '3'
        data['positions']['positions'][0]['positionSide'] = 'SHORT'
        self.assertEqual(self.check(data, 'hedge.perp_net_eth')['status'], 'OK')
        data['positions']['positions'][0]['positionSide'] = 'LONG'
        self.assertEqual(self.check(data, 'hedge.hl_size_gap_eth')['status'], 'CRITICAL')

    def test_all_boros_missing_is_critical(self):
        data = fixture()
        data['farm']['assets'][0]['borosOpen'] = []
        self.assertEqual(self.check(data, 'positions.unexpected_change_eth')['status'], 'CRITICAL')

    def test_funding_gap_timer_starts_after_normal_tick(self):
        data, state = fixture(), {}
        evaluate(data, self.config, state, self.rules, NOW)
        for b in data['farm']['assets'][0]['borosOpen']:
            b['maturity'] = NOW - 1
        evaluate(data, self.config, state, self.rules, NOW + 300)
        report = evaluate(data, self.config, state, self.rules, NOW + 901)
        self.assertEqual(next(c for c in report['checks'] if c['id'] == 'rollover.uncovered_funding_seconds')['status'], 'CRITICAL')

    def test_maturity_is_reported_in_days(self):
        check = self.check(fixture(), 'rollover.days_to_maturity')
        self.assertEqual(check['metrics']['rollover.days_to_maturity']['unit'], 'days')
        self.assertEqual(check['metrics']['rollover.days_to_maturity']['value'], 80)
        self.assertEqual(set(check['metrics']), {'rollover.days_to_maturity'})
        self.assertEqual(check['status'], 'OK')
        self.assertTrue(check['coverageComplete'])

    def test_maturity_alerts_without_plan_evidence(self):
        for days, expected in ((13, 'WARNING'), (.5, 'CRITICAL')):
            with self.subTest(days=days):
                data = fixture()
                for leg in data['farm']['assets'][0]['borosOpen']:
                    leg['maturity'] = NOW + days * 86400
                check = self.check(data, 'rollover.days_to_maturity')
                self.assertEqual(check['status'], expected)
                self.assertTrue(check['coverageComplete'])


    def test_group_maturity_and_market_book_status_for_roll(self):
        data = fixture()
        for leg in data['farm']['assets'][0]['borosOpen']:
            leg['maturity'] = NOW + 13 * 86400
        data['opportunities'] = {'groups': [{'maturity': NOW + 86400 * 160,
            'markets': [{'marketId': 3, 'bookStatus': 'ok'}, {'marketId': 4, 'bookStatus': 'ok'}],
            'pairs': [{'base': 'ETH', 'netFixedApr': .03,
                       'shortLeg': {'marketId': 3, 'venue': 'Hyperliquid'},
                       'longLeg': {'marketId': 4, 'venue': 'Binance'}}]}]}
        self.assertEqual(self.check(data, 'rollover.next_net_apr')['status'], 'OK')

    def test_rollover_window_boundary_and_pending_alerts(self):
        rules = [{**rule, 'enabled': True} for rule in self.rules]
        other_rollover = {r['id'] for r in rules if r['id'].startswith('rollover.')
                          and r['id'] != 'rollover.days_to_maturity'}
        for days, active in ((80, False), (14, False), (14 - 1 / 86400, True), (0, True), (-1, True)):
            with self.subTest(days=days):
                data = fixture()
                for leg in data['farm']['assets'][0]['borosOpen']:
                    leg['maturity'] = NOW + days * 86400
                key = 'rollover.next_net_apr'
                state = {'pending': {key: {'status': 'WARNING'}},
                         'observed_status': {key: 'WARNING'}, 'uncovered_since': NOW - 1000}
                report = evaluate(data, self.config, state, rules, NOW)
                ids = {c['id'] for c in report['checks']}
                self.assertIn('rollover.days_to_maturity', ids)
                self.assertEqual(other_rollover & ids, other_rollover if active else set())
                self.assertEqual(set(report['inactiveRolloverChecks']), set() if active else other_rollover)
                if not active:
                    self.assertNotIn(key, state['pending'])
                    self.assertNotIn(key, state['observed_status'])
                    self.assertNotIn('uncovered_since', state)

    def test_missing_maturity_does_not_suppress_unverifiable_critical(self):
        key = 'rollover.uncovered_funding_seconds'
        state = {'critical_metrics': {key: [key]}, 'risk_status': {key: 'CRITICAL'}}
        report = evaluate({}, self.config, state, self.rules, NOW)
        checks = {c['id']: c for c in report['checks']}
        self.assertEqual(checks['rollover.days_to_maturity']['status'], 'UNKNOWN')
        self.assertEqual(checks[key]['status'], 'CRITICAL')
        self.assertEqual(report['inactiveRolloverChecks'], [])

    def test_maturity_does_not_depend_on_price(self):
        data = fixture()
        data['farm']['assets'][0]['priceUsd'] = None
        self.assertEqual(self.check(data, 'rollover.days_to_maturity')['metrics']['rollover.days_to_maturity']['value'], 80)

    def test_partial_positions_do_not_clear_critical_or_pending_alerts(self):
        for completeness, key in ((coverage, metric) for coverage in (None, False)
                                  for metric in ('rollover.next_net_apr', 'rollover.uncovered_funding_seconds')):
            with self.subTest(completeness=completeness, metric=key):
                data = fixture()
                data['farm']['assets'][0]['borosOpen'].pop()
                data['farm']['coverage']['borosPositionsComplete'] = completeness
                state = {'critical_metrics': {key: [key]}, 'risk_status': {key: 'CRITICAL'},
                         'pending': {key: {'status': 'CRITICAL'}}}
                report = evaluate(data, self.config, state, self.rules, NOW)
                checks = {c['id']: c for c in report['checks']}
                self.assertEqual(checks['rollover.days_to_maturity']['status'], 'UNKNOWN')
                self.assertEqual(checks[key]['status'], 'CRITICAL')
                self.assertEqual(state['pending'][key]['status'], 'CRITICAL')
                self.assertEqual(report['inactiveRolloverChecks'], [])

    def test_other_subaccount_cannot_suppress_rollover_checks(self):
        self.config['account_id'] = 1
        report = evaluate(fixture(), self.config, {}, self.rules, NOW)
        self.assertEqual(report['inactiveRolloverChecks'], [])
        maturity = next(c for c in report['checks'] if c['id'] == 'rollover.days_to_maturity')
        self.assertEqual(maturity['status'], 'UNKNOWN')

    def test_collector_scans_rollover_only_inside_window(self):
        token = Path(self.temp.name) / 'token'
        token.write_text('synthetic')
        for days, enabled, expected in ((80, True, False), (14, True, False),
                                       (13, True, True), (-1, True, True),
                                       (13, False, False), (None, True, False)):
            with self.subTest(days=days, enabled=enabled):
                data = fixture()
                for leg in data['farm']['assets'][0]['borosOpen']:
                    leg['maturity'] = NOW + days * 86400 if days is not None else None
                collector = Collector({'token_file': str(token), 'root': '0x' + '1' * 40,
                                       'scan_rollover': enabled})
                calls = []
                def get(name, path):
                    calls.append(path)
                    return data.get(name, {})
                with patch.object(collector, 'get', side_effect=get), \
                        patch.object(collector, 'public_boros', return_value={}), \
                        patch.object(collector, 'public_settlements', return_value=None), \
                        patch('risk_monitor.time.time', return_value=NOW):
                    collected = collector.collect()
                self.assertEqual(any(path.startswith('/opportunities?') for path in calls), expected)
                self.assertEqual('opportunities' in collected, expected)

    def test_raw_boros_group_margin_and_no_fake_reconstruction(self):
        data = fixture()
        self.assertEqual(self.check(data, 'boros.im_coverage')['status'], 'UNKNOWN')
        self.config['root'] = '0x' + '1' * 40
        data['boros_raw'] = {'results': [{'marketAcc': self.config['root'] + '000002ffffff',
            'netBalance': '100000000000000000', 'initialMargin': '75000000000000000',
            'availableInitialMargin': '25000000000000000', 'availableMaintMargin': '60000000000000000'}]}
        self.assertAlmostEqual(self.check(data, 'boros.mm_health_ratio')['metrics']['boros.mm_health_ratio']['value'], 2.5)

    def test_selected_cross_balance_is_not_total_eth_exposure(self):
        for rule in self.rules:
            if rule['risk'] == 3:
                rule['enabled'] = True
        data = fixture()
        self.config['root'] = '0x' + '1' * 40
        data['boros_raw'] = {'results': [{'marketAcc': self.config['root'] + '000002ffffff',
            'netBalance': '100000000000000000', 'initialMargin': '75000000000000000',
            'availableInitialMargin': '25000000000000000', 'availableMaintMargin': '60000000000000000'}]}
        check = self.check(data, 'collateral.eth_net')
        self.assertIsNone(check['metrics']['collateral.eth_net']['value'])
        self.assertEqual(check['status'], 'UNKNOWN')

    def test_disabled_checks_clear_queued_alerts(self):
        disabled = ('collateral.eth_net', 'collateral.stress_loss_usd', 'basis.executable_exit_cost_usd')
        state = {'pending': {key: {'id': key, 'status': 'UNKNOWN'} for key in disabled},
                 'observed_status': {key: 'UNKNOWN' for key in disabled},
                 'risk_status': {key: 'CRITICAL' for key in disabled},
                 'critical_metrics': {key: ['collateral.stress_loss_profit_ratio'] for key in disabled}}
        save(self.config['observations_file'], {'metrics': {'collateral.eth_net': {
            'value': 1, 'observed_at': NOW, 'ttl_seconds': 3600,
            'source': 'synthetic total exposure', 'evidence': 'synthetic reference'}}})
        report = evaluate(fixture(), self.config, state, self.rules, NOW)
        self.assertFalse(any(c['risk'] == 3 for c in report['checks']))
        self.assertFalse(any(key.startswith('collateral.') for c in report['checks'] for key in c['metrics']))
        self.assertFalse(any(c['id'] == 'basis.executable_exit_cost_usd' for c in report['checks']))
        self.assertTrue(any(c['id'] == 'basis.mark_spread_usd_per_eth' for c in report['checks']))
        for key in ('pending', 'observed_status', 'risk_status', 'critical_metrics'):
            self.assertFalse(any(check_id in state[key] for check_id in disabled))
        sent = []
        notify_report(report, state, {}, {}, NOW, sent.append)
        self.assertFalse(any('collateral.' in message for message in sent))
        self.assertFalse(any('basis.executable_exit_cost_usd' in message for message in sent))


    def test_critical_not_erased_by_lost_data(self):
        data, state = fixture(), {}
        data['account']['marginBalance'] = '200'
        evaluate(data, self.config, state, self.rules, NOW)
        report = evaluate({}, self.config, state, self.rules, NOW + 300, {'collector': 'offline'})
        self.assertEqual(next(c for c in report['checks'] if c['id'] == 'gate.mm_health_ratio')['status'], 'CRITICAL')

    def test_incomplete_boros_ledger_never_used_for_runway(self):
        data = fixture()
        self.config['root'] = '0x' + '1' * 40
        data['boros_raw'] = {'results': [{'marketAcc': self.config['root'] + '000002ffffff',
            'netBalance': '100000000000000000', 'initialMargin': '75000000000000000',
            'availableInitialMargin': '25000000000000000', 'availableMaintMargin': '60000000000000000'}]}
        data['farm']['coverage']['borosTxnsComplete'] = False
        state = {'samples': [{'time': NOW - 86400, 'root': self.config['root'], 'settlement_eth': 0, 'coverage_complete': True}]}
        report = evaluate(data, self.config, state, self.rules, NOW)
        check = next(c for c in report['checks'] if c['id'] == 'boros.settlement_net_24h_eth')
        self.assertEqual(check['status'], 'UNKNOWN')
        self.assertEqual(len(state['samples']), 1)


    def test_partial_settlement_coverage_not_used_for_runway(self):
        data, state = fixture(), {'samples': [{'time': NOW - 86400, 'root': 'synthetic', 'settlement_eth': 0}]}
        data['farm']['coverage']['settlementsFromSec'] = NOW
        self.assertEqual(self.check(data, 'boros.settlement_net_24h_eth')['status'], 'UNKNOWN')
        evaluate(data, self.config, state, self.rules, NOW)
        self.assertEqual(len(state['samples']), 1)


if __name__ == '__main__':
    unittest.main()
