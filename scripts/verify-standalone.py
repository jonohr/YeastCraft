#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Verify fresh local auth, restart persistence, and emulator command/ingest."""
import http.cookiejar
import importlib.util
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('chamber', ROOT / 'tools/brewpi-emulator/emulator.py')
chamber = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chamber)

with tempfile.TemporaryDirectory(prefix='fermentrack-standalone-') as temp, chamber.Server(speed=60) as fridge:
    threading.Thread(target=fridge.serve_forever, daemon=True).start()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    credentials = {'username': 'standalone-test', 'password': secrets.token_urlsafe(24)}
    proc = None

    def api(path, body=None, opener=client):
        request = urllib.request.Request(base + '/api/v1/' + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json', 'Origin': base})
        with opener.open(request, timeout=10) as response:
            return json.load(response)

    def start(maintenance=False):
        global proc
        proc = subprocess.Popen([str(ROOT / 'rust/target/debug/fermentrack-rs'),
            '--db', str(Path(temp) / 'fresh.sqlite'), '--listen', f'127.0.0.1:{port}',
            '--static', str(ROOT / 'ui/dist'), '--import-root', temp,
            *(['--maintenance'] if maintenance else [])],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                return api('auth/status')
            except (OSError, ValueError):
                if proc.poll() is not None:
                    raise AssertionError('Server exited during startup')
                time.sleep(.1)
        raise AssertionError('Server did not start')

    def stop():
        global proc
        if proc:
            proc.terminate()
            proc.wait(timeout=10)
            proc = None

    try:
        assert start()['configured'] is False
        try:
            api('resources/devices')
            raise AssertionError('Anonymous access was accepted')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        api('auth/setup', credentials)
        api('auth/login', credentials)
        flags = api('diagnostics')
        assert all(flags[key] for key in ('control_enabled', 'collection_enabled', 'exports_enabled'))
        assert api('resources/devices') == []
        def resource(kind, name, data):
            return api('resources/' + kind, {'name': name, 'data': data})
        sensor = resource('sensors', 'Synthetic iSpindel', {'sensor_type': 'ispindel',
            'collection_enabled': True, 'unit': 'C', 'gravity_source': 'device', 'reported_gravity_unit': 'SG'})
        token = api(f"sensors/{sensor['id']}/key", {})['token']
        device = resource('devices', 'Synthetic chamber', {'host': '127.0.0.1',
            'port': fridge.server_address[1], 'connection_type': 'wifi', 'unit': 'C',
            'collection_enabled': True, 'control_claimed': True})
        stop()
        assert start()['configured'] is True
        api('auth/login', credentials)
        assert api('resources/devices/' + device['id'])['name'] == 'Synthetic chamber'
        api(f"devices/{device['id']}/command", {'mode': 'f', 'temperature': 18, 'confirm_ownership': True})
        assert fridge.chamber.settings['fridgeSet'] == 18
        assert api(f"devices/{device['id']}/protocol-log")
        result = subprocess.run([str(ROOT / 'tools/ispindel-emulator/target/debug/ispindel-emulator'),
            '--url', base + '/iSpindel', '--gravity', '1.050', '--angle', '45', '--count', '1'],
            env={**os.environ, 'ISPINDEL_TOKEN': token}, capture_output=True, timeout=15)
        assert result.returncode == 0, 'iSpindel emulator send failed'
        stop()
        assert start(maintenance=True)['configured'] is True
        api('auth/login', credentials)
        flags = api('diagnostics')
        assert not any(flags[key] for key in ('control_enabled', 'collection_enabled', 'exports_enabled'))
        try:
            api(f"devices/{device['id']}/command", {'mode': 'f', 'temperature': 19})
            raise AssertionError('Maintenance accepted a control command')
        except urllib.error.HTTPError as error:
            assert error.code == 400
        assert fridge.chamber.settings['fridgeSet'] == 18
        api('auth/logout', {})
        try:
            api('resources/devices')
            raise AssertionError('Logout did not revoke session')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        print('PASS: empty database, first account, local login/logout, operational defaults, explicit maintenance, restart persistence, BrewPi command/readback/log, iSpindel ingest')
    finally:
        stop()
        fridge.shutdown()
