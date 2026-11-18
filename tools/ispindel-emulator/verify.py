#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""End-to-end emulator checks, using only disposable state and loopback listeners."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
EMULATOR = HERE / 'target/debug/ispindel-emulator'

def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

with tempfile.TemporaryDirectory(prefix='ispindel-emulator-') as temp:
    proof = 'a' * 64
    Path(temp, 'proof').write_text(proof)
    base = f'http://127.0.0.1:{port()}'
    server = subprocess.Popen([
        str(ROOT / 'rust/target/debug/yeastcraft'),
        '--db', str(Path(temp, 'test.sqlite')), '--listen', base.split('//')[1],
        '--static', str(ROOT / 'ui/dist'), '--import-root', temp,
        '--disable-internal-auth', '--proxy-proof-file', str(Path(temp, 'proof')),
        '--enable-collection',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    def api(path, body=None):
        request = urllib.request.Request(base + '/api/v1/' + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'x-yeastcraft-proxy-proof': proof, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)
    env = {k: v for k, v in os.environ.items() if k != 'ISPINDEL_TOKEN'}
    def run(*args, token=None):
        return subprocess.run([str(EMULATOR), *args], env={**env, **({'ISPINDEL_TOKEN': token} if token else {})}, capture_output=True, text=True, timeout=15)
    try:
        for _ in range(100):
            try:
                api('auth/status')
                break
            except (OSError, ValueError):
                if server.poll() is not None:
                    raise RuntimeError('Isolated server failed to start')
                time.sleep(.05)
        else:
            raise RuntimeError('Isolated server not ready')
        sensor = api('resources/sensors', {'name': 'Emulator fixture', 'data': {
            'sensor_type': 'ispindel', 'collection_enabled': True, 'unit': 'C',
            'gravity_source': 'device', 'reported_gravity_unit': 'SG'}})
        token = api(f'sensors/{sensor["id"]}/key', {})['token']
        result = run('--url', base + '/iSpindel', '--scenario', str(HERE/'fermentation.json'), '--interval', '.1', '--speed', '432000', '--count', '3', token=token)
        assert result.returncode == 0, result.stderr
        assert token not in result.stdout + result.stderr
        points = api('measurements/' + sensor['id'])
        assert len(points) == 3, points
        assert sorted(round(p['values']['angle'], 3) for p in points) == [55., 60., 60.]
        latest = api('resources/sensors/' + sensor['id'])['data']['last_values']
        assert latest['gravity'] == 1.0517, latest
        assert latest['gravity_source'] == 'device'
        assert latest['reading_source'] == 'ispindel'
        assert run('--url', base+'/iSpindel', token='invalid-token').returncode != 0
        assert len(api('measurements/' + sensor['id'])) == 3
        preview = run('--gravity', '1.040', token=token)
        assert preview.returncode == 0 and token not in preview.stdout
        assert json.loads(preview.stdout)['token'] == '<redacted>'
        assert run('--interval', '0').returncode != 0
        assert run('--url', base+'/iSpindel').returncode != 0

        class Handler(BaseHTTPRequestHandler):
            requests = 0
            def do_POST(self):
                Handler.requests += 1
                self.send_response(302)
                self.send_header('Location', '/must-not-follow')
                self.end_headers()
            def log_message(self, *args):
                pass
        stub = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=stub.serve_forever, daemon=True)
        thread.start()
        try:
            redirect = run('--url', f'http://127.0.0.1:{stub.server_port}/ingest', token=token)
            assert redirect.returncode != 0 and Handler.requests == 1
            assert token not in redirect.stderr
        finally:
            stub.shutdown()
            stub.server_close()
        calibrated = str(Path(temp, 'calibration.json'))
        fit = run('--fit', str(HERE/'references.json'), '--degree', '2', '--output', calibrated)
        assert fit.returncode == 0, fit.stderr
        model_args = ['--model', str(HERE/'sensor-model.json'), '--gravity', '1.050']
        bad = json.loads(run(*model_args, '--calibration', str(HERE/'uncalibrated.json')).stdout)
        good = json.loads(run(*model_args, '--calibration', calibrated).stdout)
        assert abs(good['gravity'] - 1.05) < 1e-9
        assert abs(bad['gravity'] - 1.05) > .005
        assert bad['angle'] == good['angle']
        for cal in [str(HERE/'uncalibrated.json'), calibrated]:
            sent = run(*model_args, '--calibration', cal, '--url', base+'/iSpindel', token=token)
            assert sent.returncode == 0, sent.stderr
        latest = api('resources/sensors/' + sensor['id'])['data']['last_values']
        assert latest['gravity'] == 1.05 and abs(latest['angle'] - good['angle']) < 1e-9
        assert len(api('measurements/' + sensor['id'])) == 5
        assert run('--model', str(HERE/'sensor-model.json')).returncode != 0
        print('PASS: isolated ingest, calibration fit/apply, unchanged angle, corrected device SG, history, invalid token/options and redirect rejection')
    finally:
        server.terminate()
        server.wait(timeout=10)
