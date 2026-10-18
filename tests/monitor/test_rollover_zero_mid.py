"""Missing midpoint quotes cannot supply rollover slippage evidence."""
import copy
import datetime as dt
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import rollover_watch as watch
import rollover_batch as batch


class ZeroMidEvidenceTests(unittest.TestCase):
    def setUp(self):
        address = '0x' + '1' * 40
        self.profile_patch = patch.dict(watch.PROFILE, address=address)
        self.profile_patch.start()
        self.addCleanup(self.profile_patch.stop)
        self.address_patch = patch.object(watch, 'ADDRESS', address)
        self.address_patch.start()
        self.addCleanup(self.address_patch.stop)

    def quote(self):
        return dict(groups=[dict(underlying='ETH', maturity=watch.EXPECTED_NEW_MATURITY,
            markets=[dict(marketId=m, midApr=.06, markApr=.07,
                          execLongApr=.061, execShortApr=.061)
                     for m in watch.MARKETS])])

    def evidence(self, quote):
        samples = [watch.extract_sample(copy.deepcopy(quote)) for _ in range(3)]
        agg = watch.aggregate_samples(samples)
        now = watch.OLD_MATURITY - 86400
        computed = watch.compute(now, 2500, agg, [], dt.date(2026, 10, 29))
        return agg, computed

    def test_missing_mid_cannot_be_a_slippage_pass_or_failure(self):
        for mid in (0, None, float('nan'), float('inf'), -float('inf'), 'missing'):
            with self.subTest(mid=mid):
                quote = self.quote()
                leg = quote['groups'][0]['markets'][0]
                if mid == 'missing':
                    del leg['midApr']
                else:
                    leg['midApr'] = mid
                leg['execLongApr'] = .001  # Near zero must not produce a false pass.
                agg, computed = self.evidence(quote)
                self.assertIsNone(agg['mid'][watch.OLD_HL])
                self.assertIsNone(computed['deviations'][watch.OLD_HL])
                self.assertIsNone(computed['X_max'])
                passed, missing, over = watch.slippage_status(computed['deviations'])
                self.assertFalse(passed)
                self.assertEqual(missing, [watch.OLD_HL])
                self.assertEqual(over, [])

    def test_negative_mid_and_zero_execution_are_real_quotes(self):
        for mid, execution, deviation in ((-.02, -.019, .001), (.001, 0, .001)):
            with self.subTest(mid=mid, execution=execution):
                quote = self.quote()
                quote['groups'][0]['markets'][0].update(midApr=mid, execLongApr=execution)
                agg, computed = self.evidence(quote)
                self.assertEqual(agg['mid'][watch.OLD_HL], mid)
                self.assertEqual(agg['exec'][watch.OLD_HL], execution)
                self.assertAlmostEqual(computed['deviations'][watch.OLD_HL], deviation)
                self.assertEqual(watch.slippage_status(computed['deviations']), (True, [], []))

    def test_batch_preview_requires_finite_nonzero_midpoints(self):
        now = watch.OLD_MATURITY - 86400
        request = batch.roll_request(watch.ADDRESS, 1)
        legs = request['exit']['legs'] + request['entry']['legs']
        for i, leg in enumerate(legs):
            leg.update(venue=watch.PROFILE['legs'][i % 2]['venue'], base='ETH',
                       execApr=.06, midApr=.06, sizeWithinTolerance=2, bookStatus='ok',
                       sizing=dict(deltaSize=-1 if leg['direction'] == 'short' else 1,
                                   orderSide=leg['direction']))
        sim = dict(simulatedAtMs=now * 1000, gasBalanceUsd=5,
            exit=dict(simulation=dict(legs=legs[:2], collateral='ETH', secondsToMaturity=86400)),
            entry=dict(simulation=dict(legs=legs[2:], collateral='ETH',
                                      secondsToMaturity=watch.EXPECTED_NEW_MATURITY - now)),
            gate=dict(blockers=[], warnings=[], margin=dict(availableAfter=1, availableAfterExit=1,
                                                            need=0, shortfall=0)),
            venue=dict(status='Succeed', orders=[dict(marketId=l['marketId'],
                action='close' if i < 2 else 'open', filled=True, matchedSize=1, error=None)
                for i, l in enumerate(legs)]))
        for mid in (0, None, float('nan'), float('inf'), -float('inf')):
            with self.subTest(mid=mid):
                candidate = copy.deepcopy(sim)
                candidate['entry']['simulation']['legs'][0].update(midApr=mid, execApr=.001)
                self.assertIsNone(batch.preview(candidate, 1, now)['ready'])
