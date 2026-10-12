#!/usr/bin/env python3
"""One-shot read-only Risk report; no monitor locks, state writes or messages."""
import argparse
import datetime as dt
import json
import math
from pathlib import Path
import re
import sys

from risk_monitor import Collector, DEFAULT_CONFIG, ROOT

STATUSES = ('CRITICAL', 'WARNING', 'UNKNOWN', 'OK', 'PAUSED')
KEY_METRICS = {
    'gate.equity_usd': 'Gate 账户权益',
    'gate.upnl_usd': 'Gate 当前浮盈亏',
    'gate.loss_equity_ratio': 'Gate 浮亏/权益',
    'boros.equity_usd': 'Boros 账户权益',
    'boros.mtm_loss_equity_ratio': 'Boros 浮亏/权益',
    'boros.settlement_net_24h_usd': 'Boros 24h净流入',
    'boros.settlement_net_24h_eth': 'ETH 24h净流入',
    'boros.settlement_net_24h_btc': 'BTC 24h净流入',
    'boros.buffer_runway_days': '流出池最短历史续航',
    'hedge.perp_net_btc': '永续净 BTC 敞口',
    'hedge.residual_usd': '永续残余绝对美元敞口',
    'hedge.residual_equity_ratio': '永续残余敞口/Gate权益',
    'boros.pool_available_nonnegative': '逐池可用抵押品非负',
    'gate.im_coverage': 'Gate 初始保证金覆盖',
    'gate.mm_health_ratio': 'Gate 维持保证金覆盖',
    'gate.liability_usdt': 'USDT 借款',
    'gate.liability_usdc': 'USDC 借款',
    'boros.im_coverage': 'Boros 初始保证金覆盖',
    'boros.mm_health_ratio': 'Boros 维持保证金覆盖',
    'boros.available_eth': 'Boros 可用 ETH',
    'boros.rate_mtm_usd': 'Boros 利率估值盈亏',
    'hedge.perp_net_eth': '永续净 ETH 敞口',
    'execution.unhedged_eth': '执行未对冲残留',
    'rollover.days_to_maturity': '距到期天数',
    'agent.gas_balance_usd': 'Gas 余额',
}


def read_object(path, optional=False):
    path = Path(path)
    if optional and not path.exists():
        return {}
    if path.stat().st_size > 1024 * 1024:
        raise ValueError('Oversized local configuration/state')
    result = json.loads(path.read_text())
    if not isinstance(result, dict):
        raise ValueError('Invalid local configuration/state')
    return result


def collect(config_path):
    config = read_object(ROOT / 'scripts/risk-monitor-config.example.json')
    config.update(read_object(config_path))
    # Keep the same previous CRITICAL/hysteresis evidence as the background service.
    state = read_object(Path(config.get('state_dir', ROOT / 'data/risk-monitor')) / 'state.json', optional=True)
    return Collector(config).collect_report(state)


def sanitize(report):
    checks = report.get('checks')
    stamp = report.get('observedAt')
    if (report.get('version') != 1 or not isinstance(checks, list) or not checks
            or not isinstance(report.get('complete'), bool)
            or not isinstance(stamp, (int, float)) or isinstance(stamp, bool) or not math.isfinite(stamp)):
        raise ValueError('Malformed shared Risk report')
    account = (report.get('collection') or {}).get('account') or {}
    secrets = [str(v) for v in [account.get('userId'), *(report.get('scope') or {}).values()]
               if isinstance(v, str) and len(v) >= 6]

    def clean(value):
        if isinstance(value, str):
            value = re.sub(r'0x[0-9a-fA-F]{40,64}\b', '[redacted]', value)
            for secret in secrets:
                value = value.replace(secret, '[redacted]')
            return re.sub(r'\b\d+:[A-Za-z0-9_-]{20,}', '[redacted]', value)
        if isinstance(value, dict):
            return {k: clean(v) for k, v in value.items()}
        if isinstance(value, list):
            return [clean(v) for v in value]
        return value

    visible = []
    for check in checks:
        if (not isinstance(check, dict) or check.get('status') not in STATUSES
                or not isinstance(check.get('id'), str) or not isinstance(check.get('metrics'), dict)):
            raise ValueError('Malformed shared Risk check')
        metrics = {}
        for key, metric in check['metrics'].items():
            if not isinstance(metric, dict):
                raise ValueError('Malformed shared Risk metric')
            metrics[key] = {k: metric.get(k) for k in ('value', 'unit', 'observedAt', 'ttlSeconds', 'complete', 'reason', 'source', 'applicability', 'details')}
        visible.append(clean({'id': check['id'], 'label': check.get('label', check['id']),
                              'status': check['status'], 'reason': check.get('reason', ''),
                              'recommendedAction': check.get('recommendedAction', ''), 'metrics': metrics}))
    counts = {status: sum(c['status'] == status for c in visible) for status in STATUSES}
    status = next((s for s in STATUSES[:3] if counts[s]), 'OK')
    if status == 'OK' and (not report['complete'] or report.get('errors')):
        status = 'UNKNOWN'
    return {'status': status, 'observedAt': stamp, 'complete': report['complete'], 'counts': counts,
            'errors': {key: 'Read failed or stale' for key in (report.get('errors') or {})}, 'checks': visible}


def markdown(report):
    stamp = report.get('observedAt')
    when = dt.datetime.fromtimestamp(stamp, dt.timezone(dt.timedelta(hours=8))).isoformat(timespec='seconds') if stamp else 'UNKNOWN'
    lines = [f"风险总结：**{report['status']}**", f'快照时间：{when}（台北时间）']
    if not report.get('counts'):
        return '\n\n'.join(lines + [report['reason'], '数据不可验证，不能判断当前持仓安全。'])
    lines += [' · '.join(f'{s} {n}' for s, n in report['counts'].items()),
              f"数据覆盖：{'完整' if report['complete'] else '不完整'}。"]
    if report['errors']:
        lines += ['读取失败或过期的来源：' + '、'.join(report['errors'])]
    rows = ['| 指标 | 当前值 | 判定 |', '|---|---:|---|']
    for check in report['checks']:
        for key, metric in check['metrics'].items():
            if key not in KEY_METRICS:
                continue
            value = metric['value']
            if metric.get('applicability') == 'NA':
                shown = 'NA'
            elif value is None:
                shown = 'UNKNOWN'
            elif isinstance(value, (int, float)) and not isinstance(value, bool):
                shown = f'{value:.6g}'
            else:
                shown = str(value)
            rows.append(f"| {KEY_METRICS[key]} | {shown} {metric.get('unit') or ''} | {check['status']} |")
            for detail in metric.get('details') or []:
                detail_value = detail.get('value')
                detail_shown = 'UNKNOWN' if detail_value is None else f'{detail_value:+.6g}' if isinstance(detail_value, (int, float)) and not isinstance(detail_value, bool) else str(detail_value)
                rows.append(f"| ↳ {detail.get('label', '')} | {detail_shown} {detail.get('unit', '')} | {check['status']} |")
    lines.append('\n'.join(rows))
    attention = [c for c in report['checks'] if c['status'] in STATUSES[:3]]
    for check in attention:
        lines.append(f"- **{check['status']} {check['label']}**：{check['reason']}；建议：{check['recommendedAction']}")
    if not attention and report['status'] == 'OK':
        lines.append('当前共享风险判定未触发预警；这不是未来风险保证。')
    operational = [c for c in report['checks'] if c['id'] in ('service.http_ok', 'monitor.heartbeat_age_s', 'notify.last_success_at')]
    lines.append('服务与通知：' + '；'.join(f"{c['label']} {c['status']}" for c in operational))
    paused = [c for c in report['checks'] if c['status'] == 'PAUSED']
    if paused:
        lines.append('暂停检查：' + '、'.join(c['label'] for c in paused) + '；暂停不等于已通过。')
    lines.append('Telegram OK 表示已确认送达历史与最新采集状态有效，不是当前通道连通性探测。本次仅查询，未调整仓位或发送消息。')
    return '\n\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=str(DEFAULT_CONFIG))
    parser.add_argument('--json', action='store_true', help='Print a sanitized report instead of Markdown')
    args = parser.parse_args(argv)
    try:
        report = sanitize(collect(args.config))
        code = 0 if report['status'] == 'OK' else 2
    except Exception as exc:
        report = {'status': 'UNKNOWN', 'observedAt': None, 'complete': False, 'counts': None,
                  'checks': [], 'reason': f'风险查询失败（{type(exc).__name__}）；检查终端、配置及本机访问权限。'}
        code = 1
    print(json.dumps(report, ensure_ascii=False, allow_nan=False) if args.json else markdown(report))
    return code


if __name__ == '__main__':
    sys.exit(main())
