#!/usr/bin/env python3
"""Generate independent user units; never installs or starts services."""
import argparse
import sys
from pathlib import Path
from risk_monitor import ROOT


def quote(value):
    value = str(value)
    if '\n' in value or '\r' in value:
        raise ValueError('unit paths must not contain newlines')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--heartbeat', help='External host: mirrored heartbeat file')
    parser.add_argument('--config', help='External host: independent monitor configuration')
    parser.add_argument('--output-dir', default=str(ROOT / 'data/risk-monitor'))
    parser.add_argument('--check-seconds', type=int, default=60)
    args = parser.parse_args()
    if bool(args.heartbeat) != bool(args.config):
        parser.error('external units need both --heartbeat and --config')
    if args.check_seconds < 10:
        parser.error('check interval must be at least 10 seconds')
    folder = Path(args.output_dir).resolve()
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    command = quote(sys.executable) + ' ' + quote(ROOT / 'scripts/risk_monitor.py')
    name = 'arbitrage-risk-heartbeat' if args.heartbeat else 'arbitrage-risk-monitor'
    if args.heartbeat:
        command += ' --heartbeat ' + quote(Path(args.heartbeat).resolve()) + ' --config ' + quote(Path(args.config).resolve()) + ' --notify'
        service = '[Service]\nType=oneshot\nExecStart=' + command + '\nSuccessExitStatus=2\nUMask=0077\n'
        timer = '[Unit]\nDescription=Independent risk heartbeat checks\n\n[Timer]\nOnBootSec=30\nOnUnitInactiveSec=' + str(args.check_seconds) + '\nUnit=' + name + '.service\n\n[Install]\nWantedBy=timers.target\n'
        path = folder / (name + '.timer')
        path.write_text(timer)
        path.chmod(0o600)
    else:
        service = '[Service]\nType=simple\nExecStart=' + command + ' --watch --notify\nRestart=always\nRestartSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n'
    path = folder / (name + '.service')
    path.write_text('[Unit]\nDescription=Read-only four-leg risk monitor\nAfter=network-online.target\n\n' + service)
    path.chmod(0o600)
    print(path)
    if args.heartbeat:
        print(folder / (name + '.timer'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
