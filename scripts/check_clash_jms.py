#!/usr/bin/env python3
"""Read-only Clash Verge/JMS checks; Python standard library, no credentials."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import http.client
import json
import math
import os
from pathlib import Path
import re
import socket
import ssl
import time
from urllib.parse import quote, urlencode


PROBE_URL = 'https://www.gstatic.com/generate_204'
TARGETS = [('Google', 'www.gstatic.com', '/generate_204', {204}),
           ('Telegram', 'api.telegram.org', '/', set(range(200, 400)))]


class ApiError(Exception):
    def __init__(self, status):
        self.status = status


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__('localhost', timeout=timeout)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        try:
            self.sock.connect(self.path)
        except OSError:
            self.sock.close()
            raise


def api_get(path, endpoint, timeout):
    connection = UnixHTTPConnection(path, timeout)
    try:
        connection.request('GET', endpoint)
        response = connection.getresponse()
        if response.status != 200:
            raise ApiError(response.status)
        body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise ValueError('response too large')
        result = json.loads(body)
        if not isinstance(result, dict):
            raise ValueError('expected object')
        return result
    finally:
        connection.close()


def error_name(error):
    # Never print exception text: remote errors can include URLs or credentials.
    if isinstance(error, ApiError):
        return f'HTTP {error.status}'
    tunnel = re.fullmatch(r'Tunnel connection failed: (\d{3})[^\r\n]*', str(error))
    return f'CONNECT HTTP {tunnel[1]}' if tunnel else type(error).__name__


def safe_label(name):
    name = str(name).rsplit('@', 1)[-1]
    return re.sub(r'\d+:[A-Za-z0-9_-]{20,}', '[token]', name).replace('\n', ' ')[:120]


def socket_path():
    data = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share'))
    candidates = [Path(f'/run/clash-verge-service/users/{os.getuid()}/verge-mihomo.sock'),
                  data / 'io.github.clash-verge-rev.clash-verge-rev/verge-mihomo.sock']
    for path in candidates:
        try:
            if path.is_socket():
                return path
        except OSError:
            continue
    return candidates[0]


def processes():
    names = set()
    try:
        for path in Path('/proc').glob('[0-9]*/comm'):
            try:
                name = path.read_text().strip()
                if name in ('clash-verge', 'verge-mihomo', 'mihomo', 'clash-verge-ser'):
                    names.add(name)
            except OSError:
                continue
    except OSError:
        pass
    return sorted(names)


def selected_node(proxies, group):
    """Follow nested policy groups; never accept DIRECT as a working JMS node."""
    name, seen = group, set()
    while True:
        if name in seen:
            raise ValueError('policy group cycle')
        seen.add(name)
        item = proxies.get(name)
        if not isinstance(item, dict):
            raise ValueError('missing group or selected node')
        if 'now' not in item:
            return name, item.get('type')
        name = item['now']
        if not isinstance(name, str) or not name:
            raise ValueError('invalid selection')


def group_nodes(proxies, group):
    """Expand every member, retaining partial results when a branch is broken."""
    nodes, expanded, excluded, issues = {}, set(), set(), []

    def visit(name, ancestors):
        if name in ancestors:
            issues.append('嵌套组循环：' + safe_label(name))
            return
        item = proxies.get(name)
        if not isinstance(item, dict):
            issues.append('成员信息缺失：' + safe_label(name))
            return
        kind = str(item.get('type', '')).lower()
        if 'all' in item or 'now' in item or kind in ('selector', 'urltest', 'fallback', 'loadbalance'):
            if name in expanded:
                return
            expanded.add(name)
            members = item.get('all')
            if not isinstance(members, list) or not members:
                issues.append('组成员列表缺失或为空：' + safe_label(name))
                return
            for member in members:
                if isinstance(member, str) and member:
                    visit(member, ancestors | {name})
                else:
                    issues.append('组成员名称无效：' + safe_label(name))
        elif kind in ('direct', 'reject', 'rejectdrop', 'pass'):
            excluded.add(name)
        else:
            nodes[name] = None

    visit(group, set())
    if not nodes:
        issues.append('组内未发现可探测的代理节点')
    return list(nodes), issues, sorted(safe_label(name) for name in excluded)


def node_probe(path, group, proxies, timeout):
    check = {'id': 'jms.node', 'status': 'UNKNOWN'}
    try:
        node, kind = selected_node(proxies, group)
        check.update(node=safe_label(node), nodeType=kind)
        if not isinstance(kind, str) or not kind:
            raise ValueError('missing proxy type')
        if kind.lower() in ('selector', 'urltest', 'fallback', 'loadbalance'):
            raise ValueError('group has no single selected node')
        if kind.lower() in ('direct', 'reject', 'rejectdrop', 'pass'):
            check.update(status='FAIL', detail='当前选择不是可验证的独立代理节点')
            return check
        query = urlencode({'url': PROBE_URL, 'timeout': int(timeout * 1000), 'expected': '204'})
        result = api_get(path, '/proxies/' + quote(node, safe='') + '/delay?' + query, timeout + 2)
        delay = result.get('delay')
        if isinstance(delay, bool) or not isinstance(delay, (int, float)) or not math.isfinite(delay) or delay < 0:
            raise ValueError('invalid delay')
        check.update(status='OK', delayMs=delay, detail='指定节点 HTTPS 探测通过')
    except (PermissionError, FileNotFoundError, ConnectionRefusedError) as error:
        check['detail'] = '无法访问控制接口：' + error_name(error)
    except ApiError as error:
        check.update(status='UNKNOWN' if error.status in (401, 403, 404) else 'FAIL',
                     detail='指定节点探测未通过：' + error_name(error))
    except (OSError, http.client.HTTPException) as error:
        check.update(status='FAIL', detail='指定节点探测失败：' + error_name(error))
    except (ValueError, TypeError) as error:
        check['detail'] = '节点信息缺失或探测响应无效：' + error_name(error)
    return check


def https_probe(port, target, timeout):
    label, host, path, expected = target
    check = {'id': 'proxy.' + label.lower(), 'target': host, 'status': 'UNKNOWN'}
    connection = None
    started = time.monotonic()
    try:
        # Explicit CONNECT ignores HTTP(S)_PROXY/NO_PROXY and keeps TLS verification.
        connection = http.client.HTTPSConnection('127.0.0.1', port, timeout=timeout,
                                                 context=ssl.create_default_context())
        connection.set_tunnel(host, 443)
        connection.request('GET', path, headers={'Connection': 'close'})
        response = connection.getresponse()
        check.update(status='OK' if response.status in expected else 'FAIL',
                     httpStatus=response.status, detail='通过当前规则测试代理入口 HTTPS')
    except PermissionError as error:
        check['detail'] = '本机访问权限不足：' + error_name(error)
    except (OSError, http.client.HTTPException) as error:
        check.update(status='FAIL', detail='代理入口 HTTPS 失败：' + error_name(error))
    finally:
        if connection is not None:
            connection.close()
    check['elapsedMs'] = round((time.monotonic() - started) * 1000)
    return check


def finish(report):
    states = {check['status'] for check in report['checks']}
    report['status'] = 'FAIL' if 'FAIL' in states else 'UNKNOWN' if 'UNKNOWN' in states else 'OK'
    report['complete'] = 'UNKNOWN' not in states
    return report


def collect(path, group, timeout):
    report = {'observedAt': datetime.now().astimezone().isoformat(timespec='seconds'),
              'group': safe_label(group), 'processes': processes(), 'checks': []}
    try:
        config = api_get(path, '/configs', timeout)
        proxy_response = api_get(path, '/proxies', timeout)
        proxies = proxy_response.get('proxies')
        if not isinstance(proxies, dict):
            raise ValueError('missing proxies')
    except (OSError, ApiError, ValueError, http.client.HTTPException) as error:
        report['checks'].append({'id': 'controller', 'status': 'UNKNOWN',
                                 'detail': '无法读取本机控制接口：' + error_name(error)})
        return finish(report)
    report['checks'].append({'id': 'controller', 'status': 'OK', 'detail': '本机控制接口可用'})
    tun = config.get('tun')
    report['mode'] = config.get('mode')
    report['tunEnabled'] = tun.get('enable') if isinstance(tun, dict) else None
    port = config.get('mixed-port') or config.get('port')
    usable_port = isinstance(port, int) and not isinstance(port, bool) and 0 < port <= 65535
    report['proxyPort'] = port if usable_port else None
    nodes, issues, excluded = group_nodes(proxies, group)
    report['checks'].append({'id': 'jms.coverage', 'status': 'UNKNOWN' if issues else 'OK',
                             'detail': '；'.join(issues) if issues else '已递归展开全部成员并去重',
                             'nodeCount': len(nodes), 'excludedPolicies': excluded})
    try:
        selected, selected_type = selected_node(proxies, group)
        if str(selected_type).lower() in ('selector', 'urltest', 'fallback', 'loadbalance'):
            selected = None
        report['currentSelection'] = safe_label(selected) if selected is not None else None
    except (ValueError, TypeError):
        selected = None
        report['currentSelection'] = None
    with ThreadPoolExecutor(max_workers=6) as pool:
        node_jobs = [pool.submit(node_probe, path, node, proxies, timeout) for node in nodes]
        probes = [pool.submit(https_probe, port, target, timeout) for target in TARGETS] if usable_port else []
        node_checks = []
        for index, (name, job) in enumerate(zip(nodes, node_jobs), 1):
            check = job.result()
            check.update(id=f'jms.node.{index}', selected=name == selected)
            node_checks.append(check)
        report['checks'].extend(node_checks)
        report['checks'].extend(probe.result() for probe in probes)
    report['nodeCounts'] = {'total': len(nodes), **{status: sum(c['status'] == status for c in node_checks)
                                                 for status in ('OK', 'FAIL', 'UNKNOWN')}}
    if not usable_port:
        report['checks'].append({'id': 'proxy.port', 'status': 'UNKNOWN',
                                 'detail': '运行配置未提供有效的 HTTP/mixed 代理端口'})
    return finish(report)


def positive_timeout(value):
    timeout = float(value)
    if not math.isfinite(timeout) or not 0 < timeout <= 60:
        raise argparse.ArgumentTypeError('timeout 必须大于 0 且不超过 60 秒')
    return timeout


def main(argv=None):
    parser = argparse.ArgumentParser(description='只读检查 Clash Verge 的 JMS 全部节点和代理入口连通性')
    parser.add_argument('--socket', type=Path, help='Mihomo Unix 控制套接字，默认自动定位当前用户')
    parser.add_argument('--group', default='JMS', help='要检查的代理组，默认 JMS')
    parser.add_argument('--timeout', type=positive_timeout, default=8, help='每项网络操作超时秒数，默认 8')
    parser.add_argument('--json', action='store_true', help='输出结构化结果')
    args = parser.parse_args(argv)
    report = collect(args.socket or socket_path(), args.group, args.timeout)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"Clash/JMS：{report['status']}  快照：{report['observedAt']}")
        print('进程：' + (', '.join(report['processes']) or '未观察到（以控制接口和实测为准）'))
        print(f"模式：{report.get('mode', 'UNKNOWN')}；TUN：{report.get('tunEnabled', 'UNKNOWN')}；代理端口：{report.get('proxyPort', 'UNKNOWN')}")
        if 'nodeCounts' in report:
            counts = report['nodeCounts']
            print(f"节点：共 {counts['total']}，OK {counts['OK']} / FAIL {counts['FAIL']} / UNKNOWN {counts['UNKNOWN']}；当前选择：{report['currentSelection']}")
        for check in report['checks']:
            values = [f"{key}={check[key]}" for key in ('node', 'delayMs', 'httpStatus', 'elapsedMs') if key in check]
            if check.get('selected'):
                values.append('当前选中')
            print(f"[{check['status']}] {check['id']}：{check['detail']} {' '.join(values)}".rstrip())
        if report['status'] == 'UNKNOWN':
            print('请确认 Clash 已启动、控制套接字路径正确，并在允许本机网络访问的环境重跑。')
        print('逐节点探测不切换当前选择；入口测试遵循当前规则，可能直连。未发送 Telegram 消息。')
    return {'OK': 0, 'UNKNOWN': 1, 'FAIL': 2}[report['status']]


if __name__ == '__main__':
    raise SystemExit(main())
