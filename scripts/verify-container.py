#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Test the built standalone Compose image in a disposable project and volume."""
import http.cookiejar
import argparse
import json
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', default='yeastcraft:local')
parser.add_argument('--platform')
parser.add_argument('--qemu', type=Path, help='Optional static QEMU user emulator for a foreign architecture')
args = parser.parse_args()
if args.qemu:
    args.qemu = args.qemu.resolve(strict=True)
with tempfile.TemporaryDirectory(prefix='yeastcraft-compose-') as temp:
    folder = Path(temp)
    (folder / 'private-import').mkdir()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    config = (ROOT / 'compose.rust.yml').read_text().replace('context: .', f'context: {ROOT}')
    # Acceptance always stays on loopback, independently of the normal LAN default.
    config = config.replace('${YEASTCRAFT_BIND_ADDRESS:-0.0.0.0}:8315:8315', f'127.0.0.1:{port}:8315')
    (folder / 'compose.yml').write_text(config)
    compose = ['docker', 'compose', '-p', 'ferm-fresh-' + secrets.token_hex(4), '-f', str(folder / 'compose.yml')]
    service = {'image': args.image}
    if args.platform:
        service['platform'] = args.platform
    if args.qemu:
        service.update({
            'entrypoint': ['/qemu', '/usr/local/bin/yeastcraft'],
            'command': ['--listen', '0.0.0.0:8315'],
            'volumes': [f'{args.qemu}:/qemu:ro'],
            'healthcheck': {'test': ['CMD', '/qemu', '/usr/local/bin/yeastcraft', 'healthcheck']},
        })
    override = folder / 'override.json'
    override.write_text(json.dumps({'services': {'yeastcraft': service}}))
    compose += ['-f', str(override)]
    def docker(*args):
        return subprocess.run([*compose, *args], check=True, capture_output=True, text=True).stdout
    base = f'http://127.0.0.1:{port}'
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def api(path, data=None):
        request = urllib.request.Request(base + '/api/v1/' + path,
            data=None if data is None else json.dumps(data).encode(),
            headers={'Content-Type': 'application/json', 'Origin': base})
        with client.open(request, timeout=10) as response:
            return json.load(response)
    def ready():
        for _ in range(100):
            try:
                return api('auth/status')
            except (OSError, ValueError):
                time.sleep(.2)
        raise AssertionError('Container failed to start')
    try:
        docker('up', '-d', '--no-build')
        assert ready()['configured'] is False
        with urllib.request.urlopen(base) as response:
            assert b'<html' in response.read()
        try:
            api('resources/devices')
            raise AssertionError('Anonymous access accepted')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        credentials = {'username': 'fresh-install-test', 'password': secrets.token_urlsafe(24)}
        api('auth/setup', credentials)
        api('auth/login', credentials)
        assert api('resources/devices') == []
        flags = api('diagnostics')
        assert all(flags[key] for key in ('collection_enabled', 'control_enabled', 'exports_enabled'))
        profile = api('resources/profiles', {'name': 'Standalone persistence check', 'data': {
            'unit': 'C', 'steps': [{'temperature': 18, 'hours': 24, 'transition': 'hold'}]}})
        docker('restart')
        assert ready()['configured'] is True
        api('auth/login', credentials)
        assert api('resources/profiles/' + profile['id'])['name'] == 'Standalone persistence check'
        prefix = ['/qemu'] if args.qemu else []
        container = docker('ps', '-q', 'yeastcraft').strip()
        user = subprocess.check_output(['docker', 'inspect', '--format', '{{.Config.User}}', container], text=True).strip()
        assert user == '1000:1000', f'Unexpected runtime user: {user}'
        docker('exec', '-T', 'yeastcraft', *prefix, '/usr/local/bin/yeastcraft', 'healthcheck')
        api('auth/logout', {})
        try:
            api('resources/profiles')
            raise AssertionError('Session survived logout')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        print('PASS: standalone Compose, fresh volume, UI, local setup/login/logout, operational defaults, persisted account/profile after restart, non-root, healthcheck')
    except Exception:
        print(docker('logs', '--tail', '40'))
        raise
    finally:
        docker('down', '--volumes', '--remove-orphans')
