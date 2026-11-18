#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Verify a previous server binary can hand its database to YeastCraft, in isolation."""
import argparse
import http.cookiejar
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('previous_binary', type=Path)
args = parser.parse_args()
previous = args.previous_binary.resolve(strict=True)
root = Path(__file__).resolve().parents[1]
current = root / 'rust/target/debug/yeastcraft'
with tempfile.TemporaryDirectory(prefix='yeastcraft-upgrade-') as folder:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    database = Path(folder) / 'fermentrack.sqlite'
    credentials = {'username': 'upgrade-test', 'password': 'synthetic-upgrade-password-123'}
    ids = {}
    for binary in (previous, current):
        client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

        def api(path, body=None):
            request = urllib.request.Request(base + '/api/v1/' + path,
                data=None if body is None else json.dumps(body).encode(),
                headers={'Content-Type': 'application/json', 'Origin': base})
            with client.open(request, timeout=5) as response:
                return json.load(response)

        help_text = subprocess.check_output([str(binary), '--help'], text=True)
        if '--maintenance' in help_text:
            safety_flags = ['--maintenance']
        else:
            assert '--enable-collection' in help_text, 'Unknown previous binary defaults'
            safety_flags = []  # Previous opt-in workers remain disabled.
        proc = subprocess.Popen([str(binary), '--db', str(database), '--listen', f'127.0.0.1:{port}',
            '--static', str(root / 'ui/dist'), '--import-root', folder, *safety_flags],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(100):
                try:
                    status = api('auth/status')
                    break
                except OSError:
                    if proc.poll() is not None:
                        raise AssertionError('Server exited before readiness')
                    time.sleep(.05)
            else:
                raise AssertionError('Server did not start')
            if binary == previous:
                assert not status['configured']
                api('auth/setup', credentials)
            else:
                assert status['configured'], 'Upgrade lost the existing account'
            api('auth/login', credentials)
            if binary == previous:
                for kind, data in [('profiles', {'points': [{'days': 0, 'temperature': 18}]}),
                                   ('sensors', {'sensor_type': 'ispindel', 'collection_enabled': False})]:
                    record = api('resources/' + kind, {'name': 'Preserved ' + kind, 'data': data})
                    ids[kind] = record['id']
            else:
                for kind, identifier in ids.items():
                    assert api(f'resources/{kind}/{identifier}')['name'] == 'Preserved ' + kind
                assert database.is_file()
                assert not (Path(folder) / 'yeastcraft.sqlite').exists()
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
print('PASS: old database/account, login, profile and sensor identity preserved across the rename')
