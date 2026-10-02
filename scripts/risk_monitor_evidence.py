"""Metric contracts and timestamped evidence validation; no network access."""
import json
import math
from pathlib import Path

CONTRACTS = json.loads((Path(__file__).with_name('risk-monitor-metrics.json')).read_text())


def valid_value(value, contract):
    if contract['type'] == 'bool':
        return isinstance(value, bool)
    if contract['type'] == 'enum':
        return isinstance(value, str) and value in contract['values']
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        return False
    if contract.get('positive') and value <= 0:
        return False
    if contract['unit'] == 'count' and (value < 0 or value != int(value)):
        return False
    return True


def evidence_error(key, observation, now):
    contract = CONTRACTS.get(key)
    if contract is None or not isinstance(observation, dict):
        return 'unknown metric or invalid evidence entry'
    if not valid_value(observation.get('value'), contract):
        return 'invalid metric value or type'
    if observation.get('unit', contract['unit']) != contract['unit']:
        return 'unit does not match metric contract'
    for field in ('source', 'evidence'):
        if not isinstance(observation.get(field), str) or not observation[field].strip():
            return 'missing source or evidence'
    for field in ('observed_at', 'ttl_seconds'):
        value = observation.get(field)
        if (not isinstance(value, (int, float)) or isinstance(value, bool)
                or not math.isfinite(value)):
            return 'invalid evidence timestamp or TTL'
    age = now - observation['observed_at']
    if observation['ttl_seconds'] <= 0 or age < 0:
        return 'future evidence or invalid TTL'
    if age > min(observation['ttl_seconds'], contract['max_age_seconds']):
        return 'expired evidence'
    return None
