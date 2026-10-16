#!/usr/bin/env python3
"""Replay engine observations without network access or engine/ledger imports.

Only aggregate evidence indexes and reports in the dedicated output namespace are written.
See docs/LATENCY-REPORT.md for the manifest and the limits of each measurement.
"""
import argparse
from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation, getcontext
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import time

getcontext().prec = 80
UNKNOWN = 'UNKNOWN'
MIB = 1024 * 1024
MAX_INPUT = 100 * MIB
MAX_LINE = 16 * 1024
INDEX_LIMIT = 256 * 1024


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def distribution(values):
    values = sorted(values)
    def percentile(p):
        return values[max(0, math.ceil(len(values) * p) - 1)] if values else None
    return {'n': len(values), 'p50': percentile(.5), 'p95': percentile(.95),
            'max': values[-1] if values else None}


def summarize(rows, samples=False):
    """Public replay seam. Sequence identity removes copied records, never requests."""
    gaps, seen, clean = set(), {}, []
    for row in rows:
        if not isinstance(row, dict) or row.get('version') != 1:
            gaps.add('invalid-record')
            continue
        run, seq = row.get('run'), row.get('seq')
        if not isinstance(run, str) or not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
            gaps.add('missing-record-identity')
            continue
        key = (run, seq)
        if key in seen:
            if row != seen[key]:
                gaps.add('conflicting-record')
            continue
        seen[key] = row
        if not number(row.get('monoMs')) or not number(row.get('utcMs')):
            gaps.add('missing-clock')
            continue
        if any(row.get(k) != 0 for k in ('dropped', 'writeFailures', 'rotationFailures')):
            gaps.add('observation-loss-or-counters-missing')
        clean.append(row)
    by_run = defaultdict(list)
    for row in clean:
        by_run[row['run']].append(row)
    for run_rows in by_run.values():
        run_rows.sort(key=lambda r: r['seq'])
        for a, b in zip(run_rows, run_rows[1:]):
            if b['seq'] != a['seq'] + 1:
                gaps.add('sequence-gap')
            if b['monoMs'] < a['monoMs']:
                gaps.add('monotonic-regression')
            if abs((b['utcMs'] - a['utcMs']) - (b['monoMs'] - a['monoMs'])) > 1000:
                gaps.add('wall-clock-jump')
    # Outer Venue calls and inner SDK calls remain different operation groups.
    requests = defaultdict(lambda: {'entries': [], 'receipts': []})
    for row in clean:
        if row.get('stage') not in ('send-entry', 'receipt'):
            continue
        operation = row.get('operation')
        started = row.get('startedMonoMs')
        if not isinstance(operation, str) or not number(started):
            gaps.add('missing-request-identity')
            continue
        key = (row['run'], row.get('tick'), row.get('deal'), operation, started,
               row.get('client'), row.get('order'), row.get('leg'))
        requests[key]['entries' if row['stage'] == 'send-entry' else 'receipts'].append(row)
    groups = defaultdict(lambda: {'total': 0, 'success': 0, 'errors': Counter(), 'times': [], 'allTimes': []})
    for request in requests.values():
        entries, receipts = request['entries'], request['receipts']
        sample = (entries or receipts)[0]
        connection = sample.get('connection')
        connection = connection if connection in ('cold', 'warm') else UNKNOWN
        g = groups[(sample['operation'], connection)]
        g['total'] += 1
        if len(entries) != 1 or len(receipts) != 1:
            error = 'unfinished' if entries and not receipts else 'unmatched-or-ambiguous'
            g['errors'][error] += 1
            gaps.add(error)
            continue
        receipt = receipts[0]
        if receipt.get('connection') != sample.get('connection'):
            gaps.add('connection-attribution-conflict')
        elapsed = receipt['monoMs'] - entries[0]['startedMonoMs']
        if elapsed < 0 or entries[0]['startedMonoMs'] > entries[0]['monoMs']:
            g['errors']['invalid-duration'] += 1
            gaps.add('invalid-duration')
            continue
        g['allTimes'].append(elapsed)
        if receipt.get('outcome') == 'ok' and (receipt.get('httpStatus') is None or
                                                        number(receipt.get('httpStatus')) and receipt['httpStatus'] < 400):
            g['success'] += 1
            g['times'].append(elapsed)
        else:
            category = ('rate-limit' if receipt.get('httpStatus') == 429 else
                        'http' if number(receipt.get('httpStatus')) and receipt['httpStatus'] >= 400 else
                        receipt.get('errorCategory') or receipt.get('outcome') or UNKNOWN)
            g['errors'][category] += 1
    output = []
    for (operation, connection), g in sorted(groups.items()):
        output.append({'operation': operation, 'connection': connection, 'total': g['total'],
                       'success': g['success'], 'errors': dict(g['errors']),
                       'latencyMs': distribution(g['times']), 'allCompletedMs': distribution(g['allTimes']),
                       'sampleStatus': 'PASS' if g['success'] >= 100 else UNKNOWN,
                       **({'_samplesMs': g['times']} if samples else {})})
    return {'requests': output, 'gaps': sorted(gaps), 'records': len(clean),
            'inputRecords': len(rows), 'invalidOrDuplicateRecords': len(rows) - len(clean),
            'requestDenominatorStatus': UNKNOWN if gaps else 'COMPLETE',
            'execution': execution_report(clean, gaps),
            'sampleUtcMs': [min((r['utcMs'] for r in clean), default=None),
                            max((r['utcMs'] for r in clean), default=None)],
            'queueMs': {'status': UNKNOWN, 'reason': 'not independently observed by v1 writer'},
            'resources': {'status': UNKNOWN, 'reason': 'no process RSS/FD/socket samples in v1 records'}}


def pool_budget(baseline, candidate):
    """Nearest-rank percentiles, no averaging of window percentiles."""
    if (len(baseline) < 3 or len(baseline) != len(candidate) or
            any(len(w) < 100 or any(not number(v) or v < 0 for v in w)
                for w in baseline + candidate)):
        return {'status': UNKNOWN, 'reason': 'need >=3 paired windows, >=100 successes in each'}
    b = distribution([v for w in baseline for v in w])
    c = distribution([v for w in candidate for v in w])
    windows = []
    for bw, cw in zip(baseline, candidate):
        bp, cp = distribution(bw)['p95'], distribution(cw)['p95']
        windows.append({'baselineP95': bp, 'candidateP95': cp,
                        'improved': bp > 0 and cp * 10 <= bp * 9,
                        'withinRegressionBudget': cp - bp <= max(bp / 10, 20)})
    improved = sum(w['improved'] for w in windows)
    checks = {'mergedP95': b['p95'] > 0 and c['p95'] * 10 <= b['p95'] * 9,
              'twoThirdsWindows': improved * 3 >= len(windows) * 2,
              'mergedP50': c['p50'] * 10 <= b['p50'] * 11,
              'everyWindowP95': all(w['withinRegressionBudget'] for w in windows)}
    return {'status': 'PASS' if all(checks.values()) else 'FAIL', 'checks': checks,
            'improvedWindows': improved, 'windows': windows, 'baselineMs': b, 'candidateMs': c}


def quantity(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{1,40}(\.\d{1,18})?', value):
        raise ValueError('invalid decimal quantity')
    return Decimal(value)


def execution_report(rows, inherited_gaps):
    """Reconstruct LOCAL confirmations only; never use reservations as fills."""
    deals = defaultdict(list)
    for row in rows:
        if isinstance(row.get('deal'), str):
            deals[(row['run'], row['deal'])].append(row)
    result = []
    for (run, deal), events in sorted(deals.items()):
        events.sort(key=lambda r: r['seq'])
        gaps = set(inherited_gaps)
        anchor = next((r for r in events if r.get('stage') == 'projection'), None)
        anchored = bool(anchor and anchor.get('outcome') == 'ok' and
                        anchor.get('aFilled') == '0' and anchor.get('bFilled') == '0' and
                        anchor.get('bReserved') == '0' and
                        not any(r.get('stage') in ('fill-confirmed', 'registered') and
                                r['seq'] < anchor['seq'] for r in events))
        if not anchored:
            gaps.add('missing-zero-anchor')
        filled, net, peak, integral = {}, Decimal(0), Decimal(0), Decimal(0)
        overhedge = False
        duration, previous = 0, events[0]['monoMs']
        pending, registrations, responses = [], {}, []
        unreserved = None
        for row in events:
            at = row['monoMs']
            elapsed = at - previous
            if elapsed < 0:
                gaps.add('monotonic-regression')
                elapsed = 0
            integral += abs(net) * Decimal(str(elapsed))
            if net:
                duration += elapsed
            previous = at
            stage = row.get('stage')
            try:
                if row.get('quantityUnit', 'base') != 'base' or row.get('conversion', 'venue-normalized-base') != 'venue-normalized-base':
                    raise ValueError('unsupported quantity conversion')
                if stage == 'projection':
                    a, b = quantity(row.get('aFilled')), quantity(row.get('bFilled'))
                    if a - b != net or row.get('outcome') != 'ok':
                        gaps.add('unverified-projection')
                    unreserved = str(quantity(row.get('unreserved')))
                elif stage == 'fill-confirmed':
                    leg, client = row.get('leg'), row.get('client')
                    if leg not in ('A', 'B') or not isinstance(client, str):
                        raise ValueError('fill attribution missing')
                    key = (leg, client)
                    cumulative = quantity(row.get('cumulative'))
                    old = filled.get(key, Decimal(0))
                    if cumulative < old:
                        gaps.add('cumulative-regression')
                        continue
                    delta = cumulative - old
                    if not delta:
                        continue
                    if delta != quantity(row.get('quantity')):
                        gaps.add('missing-fill-history')
                    filled[key] = cumulative
                    net += delta if leg == 'A' else -delta
                    peak = max(peak, abs(net))
                    overhedge = overhedge or net < 0
                    if leg == 'A':
                        pending.append([delta, at])
                elif stage == 'registered' and row.get('leg') == 'B':
                    qty = quantity(row.get('quantity'))
                    client = row.get('client')
                    if not isinstance(client, str) or client in registrations or qty <= 0:
                        raise ValueError('reservation attribution missing')
                    remaining, allocations = qty, []
                    for item in pending:
                        used = min(remaining, item[0])
                        if used:
                            allocations.append({'quantityBase': str(used), 'fillToRegisteredMs': at - item[1]})
                            item[0] -= used
                            remaining -= used
                    response = {'quantityBase': str(qty), 'registeredMonoMs': at,
                                'status': UNKNOWN if remaining or not anchored else 'PASS',
                                'fillToRegisteredMs': at - min((at - a['fillToRegisteredMs'] for a in allocations), default=at)
                                if not remaining and anchored else None,
                                'allocations': allocations if not remaining and anchored else [],
                                'registeredToSendMs': None, 'sendToReceiptMs': None}
                    if remaining:
                        gaps.add('unattributed-reservation')
                    registrations[client] = response
                    responses.append(response)
                elif stage in ('send-entry', 'receipt') and row.get('operation') == 'create':
                    response = registrations.get(row.get('client'))
                    if response:
                        if stage == 'send-entry' and 'sendMonoMs' not in response:
                            response['sendMonoMs'] = at
                            response['startedMonoMs'] = row.get('startedMonoMs')
                            response['registeredToSendMs'] = at - response['registeredMonoMs']
                        elif stage == 'receipt' and row.get('startedMonoMs') == response.get('startedMonoMs') and 'sendMonoMs' in response:
                            response['sendToReceiptMs'] = at - response['sendMonoMs']
                            response['outcome'] = row.get('outcome', UNKNOWN)
            except (ValueError, InvalidOperation):
                gaps.add('quantity-or-attribution-missing')
        valid = not gaps and anchored
        for response in responses:
            response['attributionStatus'] = response['status'] if valid else UNKNOWN
            if not valid:
                response['fillToRegisteredMs'] = None
                response['allocations'] = []
            if (not valid or response.get('registeredToSendMs') is None or
                    response.get('sendToReceiptMs') is None or
                    response.get('registeredToSendMs', -1) < 0 or response.get('sendToReceiptMs', -1) < 0):
                response['status'] = UNKNOWN
        result.append({'run': run, 'deal': deal, 'gaps': sorted(gaps),
                       'unreservedBase': unreserved, 'response': responses,
                       'confirmedLocal': {'status': 'PASS' if valid else UNKNOWN,
                           'peakBase': str(peak) if valid else None,
                           'netBase': str(net) if valid else None,
                           'durationMs': duration if valid else None,
                           'integralBaseMs': str(integral) if valid else None,
                           'boundary': 'local cumulative confirmations; censored at last record'},
                       'actualEconomic': {'status': UNKNOWN, 'clockErrorMs': None,
                           'reason': 'v1 has no verified native fill times/identities or cross-venue clock calibration'},
                       'makerIdentity': UNKNOWN, 'overhedge': overhedge if valid else UNKNOWN,
                       'dustBase': None})
    return result


def load_json(path, limit=MAX_LINE):
    with path.open('rb') as handle:
        raw = handle.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('JSON file exceeds size limit')
    return json.loads(raw)


def read_records(path, budget):
    rows = []
    consumed = 0
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        while True:
            line = handle.readline(MAX_LINE + 1)
            if not line:
                break
            budget[0] += len(line)
            consumed += len(line)
            budget[1] += 1
            if len(line) > MAX_LINE or budget[0] > MAX_INPUT or budget[1] > 100000:
                raise ValueError('observation input exceeds bounded replay limit')
            digest.update(line)
            try:
                rows.append(json.loads(line))
            except (ValueError, UnicodeError):
                # A live append may end halfway through a record. Never invent its receipt.
                rows.append({'invalid': True})
    return rows, {'path': str(path), 'sha256': digest.hexdigest(), 'bytes': consumed}


def status_of(statuses):
    if 'FAIL' in statuses:
        return 'FAIL'
    return 'PASS' if statuses and all(s == 'PASS' for s in statuses) else UNKNOWN


def attestation(item, root, provenance):
    """Load an explicit audited artifact; a manifest PASS alone is never evidence."""
    if not isinstance(item, dict) or not isinstance(item.get('artifact'), str):
        return {'status': UNKNOWN}
    path = (root / item['artifact']).resolve()
    try:
        raw = path.read_bytes() if path.stat().st_size <= 256 * 1024 else b''
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get('status') not in ('PASS', 'FAIL'):
            return {'status': UNKNOWN}
        provenance[str(path)] = {'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        # Never propagate arbitrary artifact text or account/config payloads.
        metrics = data.get('metrics', {})
        metrics = {k: v for k, v in metrics.items() if re.fullmatch('[a-zA-Z0-9]{1,48}', k) and
                   (v is None or isinstance(v, bool) or number(v))} if isinstance(metrics, dict) else {}
        return {'status': data['status'], 'metrics': metrics, 'artifact': str(path)}
    except (OSError, ValueError, TypeError):
        return {'status': UNKNOWN}


def validate_external(key, item):
    if item['status'] != 'PASS':
        return item
    metrics = item.get('metrics', {})
    if key == 'resources':
        required = ('rssDeltaMiB', 'connectionsMax', 'connectionLimit', 'fdMax', 'fdLimit')
        if any(not number(metrics.get(k)) for k in required):
            return {**item, 'status': UNKNOWN}
        if metrics.get('steadyState') is not True or metrics.get('boundedGrowth') is not True:
            return {**item, 'status': UNKNOWN}
        within = (metrics['rssDeltaMiB'] <= 32 and 0 <= metrics['connectionsMax'] <= metrics['connectionLimit'] and
                  0 <= metrics['fdMax'] <= metrics['fdLimit'] and metrics['connectionLimit'] > 0 and metrics['fdLimit'] > 0)
        if not within:
            return {**item, 'status': 'FAIL'}
    if key == 'queue':
        if (any(not number(metrics.get(k)) for k in ('n', 'p50', 'p95', 'max')) or metrics['n'] < 100 or
                not 0 <= metrics['p50'] <= metrics['p95'] <= metrics['max']):
            return {**item, 'status': UNKNOWN}
    return item


def build_report(manifest, root):
    """Replay a declared schedule. Metadata/attestations are supplied evidence, not measurements."""
    if manifest.get('version') != 1:
        raise ValueError('unsupported manifest version')
    windows = manifest.get('windows', [])
    configurations = manifest.get('configurations', {})
    operations = manifest.get('operations', [])
    baseline = manifest.get('baseline')
    if (not isinstance(windows, list) or len(windows) > 256 or not isinstance(configurations, dict) or
            not isinstance(operations, list) or not operations or len(operations) > 32 or
            any(not isinstance(op, str) or not re.fullmatch('[a-zA-Z-]{1,48}', op) for op in operations) or
            baseline not in configurations):
        raise ValueError('invalid manifest schedule/configurations/operations')
    gaps, output, provenance, cache, budget = set(), [], {}, {}, [0, 0]
    metadata = {}
    for name, config in configurations.items():
        if not re.fullmatch('[a-zA-Z0-9_-]{1,48}', name) or not isinstance(config, dict):
            raise ValueError('invalid configuration')
        metadata[name] = {key: config.get(key) for key in ('version', 'configuration', 'machine', 'account', 'route')}
        if any(not isinstance(v, str) or not v or len(v) > 160 for v in metadata[name].values()):
            gaps.add('configuration-metadata-missing')
        if any(config.get(key) != configurations[baseline].get(key) for key in ('machine', 'account', 'route')):
            gaps.add('configuration-confounded')
    overhead = attestation({'artifact': manifest.get('observationOverheadEvidence')}, root, provenance)
    if overhead['status'] != 'PASS':
        gaps.add('observation-overhead-unverified')
    schedule, samples = [], {}
    for window in windows:
        if not isinstance(window, dict):
            raise ValueError('invalid window')
        config, group = window.get('config'), window.get('group')
        start, end = window.get('startUtcMs'), window.get('endUtcMs')
        if config not in configurations or not isinstance(group, int) or isinstance(group, bool) or group < 1:
            raise ValueError('invalid window identity')
        if not number(start) or not number(end) or start >= end:
            raise ValueError('invalid window time')
        if (group, config) in samples:
            raise ValueError('duplicate window identity')
        schedule.append((start, end, group, config))
        rows = []
        paths = window.get('files', [])
        if not isinstance(paths, list) or len(paths) > 256:
            raise ValueError('invalid evidence file list')
        for name in paths:
            path = (root / name).resolve()
            if path not in cache:
                cache[path], provenance[str(path)] = read_records(path, budget)
            # Invalid or untimed records cannot silently vanish from denominator evidence.
            rows += [r for r in cache[path] if not isinstance(r, dict) or not number(r.get('utcMs')) or
                     start <= r['utcMs'] < end]
        summary = summarize(rows, samples=True)
        sample = {(g['operation'], g['connection']): g.pop('_samplesMs') for g in summary['requests']}
        samples[(group, config)] = sample
        window_gaps = set(summary['gaps'])
        if not rows:
            window_gaps.add('no-observations')
        if any(g['connection'] == UNKNOWN for g in summary['requests']):
            window_gaps.add('connection-state-unknown')
        # Optional final writer status detects dropped tails invisible in details.
        statuses = window.get('statusFiles', [])
        if not isinstance(statuses, list) or len(statuses) > 256:
            raise ValueError('invalid writer status file list')
        if not statuses:
            window_gaps.add('final-writer-status-missing')
        status_runs, status_sequences = set(), {}
        for name in statuses:
            path = (root / name).resolve()
            status = load_json(path, limit=INDEX_LIMIT)
            for source in status.get('sources', []):
                current = provenance.get(source.get('path'))
                if current is None or current.get('sha256') != source.get('sha256'):
                    window_gaps.add('source-changed-since-collection')
            status_runs.add(status.get('run'))
            if isinstance(status.get('seq'), int):
                status_sequences[status.get('run')] = max(status_sequences.get(status.get('run'), 0), status['seq'])
            if (status.get('evidence') != 'COMPLETE' or
                    any(status.get(k) != 0 for k in ('dropped', 'writeFailures', 'rotationFailures', 'bufferedBytes'))):
                window_gaps.add('writer-status-incomplete')
        record_runs = {r.get('run') for r in rows if isinstance(r, dict) and r.get('run')}
        if record_runs - status_runs:
            window_gaps.add('writer-run-status-missing')
        for run in record_runs & status_runs:
            maximum = max((r.get('seq', 0) for name in paths for r in cache[(root / name).resolve()]
                           if isinstance(r, dict) and r.get('run') == run and isinstance(r.get('seq'), int)), default=0)
            if status_sequences.get(run) != maximum:
                window_gaps.add('final-writer-tail-mismatch')
        # Queue/resource evidence is unavailable from current writer. A linked audited
        # artifact may supply it later; never infer these values from request RTT.
        evidence = dict(window.get('evidence', {}))
        checks = {}
        for key in ('safety', 'resources', 'queue', 'noNewErrors', 'confoundsCleared'):
            item = validate_external(key, attestation(evidence.get(key), root, provenance))
            checks[key] = item['status']
            evidence[key] = item
        summary['resources'] = evidence['resources']
        summary['queueMs'] = evidence['queue']
        if any(v == UNKNOWN for v in checks.values()):
            window_gaps.add('acceptance-evidence-missing')
        observed_safety_failure = any(e['overhedge'] is True for e in summary['execution'])
        summary.update({'group': group, 'config': config, 'declaredUtcMs': [start, end],
                        'gaps': sorted(window_gaps), 'evidenceChecks': checks,
                        'externalEvidence': evidence,
                        'pocRejectRate': {'status': UNKNOWN, 'denominator': sum(g['total'] for g in summary['requests']
                                           if g['operation'] == 'sdk-create'),
                                          'reason': 'no parsed POC rejection labels in v1'},
                        'status': 'FAIL' if observed_safety_failure or 'FAIL' in checks.values() else UNKNOWN if window_gaps else 'PASS'})
        output.append(summary)
    schedule.sort()
    if any(a[1] > b[0] for a, b in zip(schedule, schedule[1:])):
        gaps.add('overlapping-windows')
    groups = sorted({w['group'] for w in output})
    if len(groups) < 3:
        gaps.add('insufficient-alternating-groups')
    expected_order = None
    for group in groups:
        order = [config for _, _, g, config in schedule if g == group]
        if not order or order[0] != baseline or set(order) != set(configurations):
            gaps.add('non-alternating-schedule')
        if expected_order is not None and order != expected_order:
            gaps.add('non-alternating-schedule')
        expected_order = order
    if [g for _, _, g, _ in schedule] != sorted(g for _, _, g, _ in schedule):
        gaps.add('interleaved-groups')
    comparisons = []
    for config in configurations:
        if config == baseline:
            continue
        for operation in operations:
            def values(group, cfg, connection=None):
                return [v for (op, conn), durations in samples.get((group, cfg), {}).items()
                        if op == operation and (connection is None or conn == connection) for v in durations]
            performance = pool_budget([values(g, baseline) for g in groups], [values(g, config) for g in groups])
            strata = {conn: pool_budget([values(g, baseline, conn) for g in groups],
                                       [values(g, config, conn) for g in groups]) for conn in ('cold', 'warm', UNKNOWN)}
            relevant = [w for w in output if w['config'] in (baseline, config)]
            # Compare error rates with all requests as denominator; category-specific.
            error_checks, error_increased = [], False
            for group in groups:
                counts = []
                for cfg in (baseline, config):
                    gs = [g for w in relevant if w['config'] == cfg and w['group'] == group
                          for g in w['requests'] if g['operation'] == operation]
                    counts.append((sum(g['total'] for g in gs),
                                   Counter({k: sum(g['errors'].get(k, 0) for g in gs)
                                            for g in gs for k in g['errors']})))
                (bt, be), (ct, ce) = counts
                increased = bool(bt and ct and any(ce[k] * bt > be[k] * ct for k in ce))
                error_increased = error_increased or increased
                error_checks.append(bool(bt and ct and not increased))
            statuses = [performance['status'], strata['cold']['status'], strata['warm']['status']] + [w['status'] for w in relevant]
            if gaps or not relevant:
                statuses.append(UNKNOWN)
            if not all(error_checks):
                statuses.append('FAIL' if error_increased else UNKNOWN)
            comparisons.append({'config': config, 'operation': operation, 'performance': performance,
                                'strata': strata, 'errorRateNonIncreasingByWindow': error_checks,
                                'status': status_of(statuses)})
    baseline_windows = [w for w in output if w['config'] == baseline]
    baseline_status = status_of([w['status'] for w in baseline_windows] +
                              [UNKNOWN if gaps or len(baseline_windows) < 3 else 'PASS'] +
                              ['PASS' if all(sum(g['success'] for g in w['requests']
                                               if g['operation'] == op and g['connection'] == conn) >= 100
                                             for w in baseline_windows for op in operations for conn in ('cold', 'warm')) else UNKNOWN])
    return {'version': 1, 'status': status_of([baseline_status] + [c['status'] for c in comparisons]),
            'baseline': {'config': baseline, 'status': baseline_status,
                         'strata': [{'group': w['group'], 'operation': op, 'connection': conn,
                                     'status': 'PASS' if sum(g['success'] for g in w['requests'] if
                                         g['operation'] == op and g['connection'] == conn) >= 100 else UNKNOWN}
                                    for w in baseline_windows for op in operations for conn in ('cold', 'warm')]}, 'configurations': metadata,
            'operations': operations, 'observationOverhead': overhead, 'gaps': sorted(gaps), 'windows': output, 'comparisons': comparisons,
            'provenance': list(provenance.values()),
            'limitations': ['No engine/network operations performed; existing observations read only.',
                            'v1 cannot independently measure socket queue, connection state, RSS/FD or precise economic exposure.',
                            'External evidence checks are supplied attestations, not inferred from RTT.',
                            'PASS is a local budget check, not a statistical significance or live trading guarantee.']}


# Output is a dedicated aggregate namespace, never the live engine-observation directory.
OWNED = re.compile(r'latency-(\d+)-[a-f0-9]+(?:-status)?\.(?:jsonl|json)$')
STATUS_KEYS = set('run seq dropped writeFailures rotations rotationFailures bufferedBytes idCacheBytes evidence'.split())


def retain(directory, kind, incoming):
    """Remove only this command's copies, oldest first; age and bytes both apply."""
    if kind != 'reports':
        raise ValueError('only aggregate report output is supported')
    cap, age = 10 * MIB, 30 * 86400000
    if incoming > cap:
        raise ValueError('output exceeds retention capacity')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink():
        raise ValueError('output directory must not be a symlink')
    entries = []
    for path in directory.iterdir():
        match = OWNED.fullmatch(path.name)
        if match and path.is_file() and not path.is_symlink():
            entries.append((int(match[1]), path, path.stat().st_size))
    total = sum(size for _, _, size in entries) + incoming
    now = int(time.time() * 1000)
    for at, path, size in sorted(entries):
        if at < now - age or total > cap:
            path.unlink()
            total -= size


def save_owned(output, kind, payload):
    import os
    import secrets
    if output.is_symlink():
        raise ValueError('output root must not be a symlink')
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = output / kind
    suffix = f'latency-{int(time.time() * 1000)}-{secrets.token_hex(8)}'
    retain(directory, kind, len(payload))
    path = directory / (suffix + '.json')
    # Exclusive creation cannot overwrite a ledger, previous report, or symlink.
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(payload)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return path, None


def snapshot(source, output):
    """One-shot passive evidence index. No duplicate detail quota or venue IO."""
    if output.is_symlink():
        raise ValueError('output root must not be a symlink')
    source, resolved_output = source.resolve(), output.resolve()
    if source == resolved_output or source in resolved_output.parents or resolved_output in source.parents:
        raise ValueError('collection output and live source must be separate directory trees')
    budget, files = [0, 0], []
    status_path = source / 'status.json'
    before = load_json(status_path) if status_path.exists() else {}
    for path in sorted((source / 'details').glob('obs-*.jsonl')):
        if not re.fullmatch(r'obs-\d+-[a-f0-9]+-\d+\.jsonl', path.name) or path.is_symlink():
            continue
        _, provenance = read_records(path, budget)
        files.append(provenance)
        if len(files) > 256:
            raise ValueError('too many observation files for one collection index')
    after = load_json(status_path) if status_path.exists() else {}
    status = {k: v for k, v in after.items() if k in STATUS_KEYS}
    if before != after or not files:
        status['evidence'] = UNKNOWN
    # Persist only an aggregate index and writer counters; original details remain
    # under the existing writer's shared 7-day/100-MiB quota. No raw detail copy.
    status.update({'sources': files, 'collectedUtcMs': int(time.time() * 1000),
                   'writerStableDuringCollection': before == after})
    payload = (json.dumps(status, allow_nan=False, indent=2) + '\n').encode()
    if len(payload) > INDEX_LIMIT:
        raise ValueError('collection index exceeds size limit')
    path, _ = save_owned(output, 'reports', payload)
    return {'status': UNKNOWN, 'files': [f['path'] for f in files], 'statusFiles': [str(path.resolve())],
            'sources': files, 'writerStableDuringCollection': before == after,
            'networkRequests': 0, 'reason': 'index only; sampling, overhead and comparison gates not accepted'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    collect = commands.add_parser('collect', help='index existing observations once, no network requests')
    collect.add_argument('--source', type=Path, required=True, help='existing engine-observation directory')
    collect.add_argument('--output', type=Path, required=True, help='separate aggregate evidence directory')
    replay = commands.add_parser('replay', help='generate report from manifest and local JSONL')
    replay.add_argument('manifest', type=Path)
    replay.add_argument('--output', type=Path, required=True, help='dedicated retained report directory')
    args = parser.parse_args()
    try:
        if args.command == 'collect':
            result = snapshot(args.source, args.output)
        else:
            manifest = load_json(args.manifest, limit=256 * 1024)
            report = build_report(manifest, args.manifest.resolve().parent)
            encoded = (json.dumps(report, indent=2, allow_nan=False) + '\n').encode()
            path, _ = save_owned(args.output, 'reports', encoded)
            result = {'status': report['status'], 'baseline': report['baseline'], 'report': str(path.resolve())}
        print(json.dumps(result, allow_nan=False))
    except (OSError, ValueError, TypeError, KeyError) as error:
        # Do not echo input records, paths containing secrets, or arbitrary exception text.
        print(json.dumps({'status': UNKNOWN, 'error': type(error).__name__,
                          'reason': 'invalid/inaccessible input or output; no measurement accepted'}), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
