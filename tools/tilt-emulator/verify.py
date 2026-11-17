#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Real HTTP integration with local auth, disposable state and synthetic senders."""
import http.cookiejar
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from emulator import packet, send
ROOT = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='rs-tilt-test-') as temp:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    proc = None
    def raw(path, body=None, content='application/json', method=None):
        request = urllib.request.Request(base + path, data=body, method=method, headers={'Content-Type':content})
        try:
            with client.open(request, timeout=10) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, None
    def api(path, body=None, method=None):
        status, data = raw('/api/v1/'+path, None if body is None else json.dumps(body).encode(), method=method)
        assert status == 200, (path,status)
        return data
    def start(enabled=True):
        global proc
        proc = subprocess.Popen([str(ROOT/'rust/target/debug/fermentrack-rs'), '--db', str(Path(temp)/'test.sqlite'),
            '--listen', f'127.0.0.1:{port}', '--static', str(ROOT/'ui/dist'), '--import-root', temp,
            *(['--enable-collection'] if enabled else [])], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try: api('auth/status'); return
            except (OSError, AssertionError): time.sleep(.1)
        raise AssertionError('Server startup failed')
    def stop():
        global proc
        if proc: proc.terminate(); proc.wait(timeout=10); proc=None
    def create(kind, name, data): return api('resources/'+kind, {'name':name,'data':data})
    def points(e): return api('measurements/'+e['id'])
    def update(e): return api('resources/'+e['kind']+'/'+e['id'], {'name':e['name'],'data':e['data']}, 'PUT')
    def check_send(path, payload, content, status=200):
        actual, result = raw(path,payload,content)
        assert actual == status, (actual,status)
        if status == 200: assert result == {'result':'success'}
    try:
        start()
        creds={'username':'synthetic-test','password':secrets.token_urlsafe(24)}
        api('auth/setup',creds);api('auth/login',creds)
        config={'unit':'C','collection_enabled':True,'tilt_color':'PINK','tilt_utc_offset_minutes':60}
        cloud=create('sensors','Synthetic cloud',{**config,'sensor_type':'tilt','tilt_mac':'aa:bb:cc:dd:ee:ff'})
        bridge=create('sensors','Synthetic bridge',{**config,'sensor_type':'tiltbridge','tilt_bridge_id':'test-bridge'})
        cloud_key=api('sensors/'+cloud['id']+'/key',{})
        bridge_key=api('sensors/'+bridge['id']+'/key',{})
        cp,bp=cloud_key['path'],bridge_key['path']
        batch=create('batches','Synthetic fermentation',{'status':'active','sensor':cloud['id']})
        # Official form fixture uses a historical timestamp. It must not become a fresh reading.
        check_send(cp,(ROOT/'tools/tilt-emulator/fixtures/cloud.form').read_bytes(),'application/x-www-form-urlencoded',400)
        stamp=(time.time()+3600)/86400+25569
        body,content=packet('cloud',offset=60,mac='aa:bb:cc:dd:ee:ff',gravity=1.0123,stamp=stamp)
        check_send(cp,body,content)
        assert len(points(cloud))==1 and len(points(batch))==1
        latest=api('resources/sensors/'+cloud['id'])
        assert latest['data']['last_automatic']['values']['gravity']==1.0123
        assert latest['data']['last_values']['gravity_temp']==20.
        # Authenticated account is not required by receiver, but token is required.
        api('auth/logout',{})
        check_send(cp,body,content)
        check_send('/ingest/tilt/not-a-token',body,content,400)
        check_send(bp,body,content,415)
        api('auth/login',creds)
        stop();start();api('auth/login',creds)
        check_send(cp,body,content)
        assert len(points(cloud))==1  # duplicate survives process restart
        for kw in [dict(color='RED'),dict(mac='11:22:33:44:55:66'),dict(gravity=1050),dict(stamp=stamp-1),dict(stamp=stamp+1),dict(temperature=float('nan'))]:
            args=dict(offset=60,mac='aa:bb:cc:dd:ee:ff',stamp=stamp+.00001);args.update(kw)
            b,c=packet('cloud',**args);check_send(cp,b,c,400)
        # In-window out-of-order packets acknowledged but not inserted.
        b,c=packet('cloud',offset=60,mac='aa:bb:cc:dd:ee:ff',stamp=stamp-.00001);check_send(cp,b,c)
        assert len(points(cloud))==1
        check_send(cp,b'{}','application/json',415)
        check_send(cp,b'Color=PINK','application/x-www-form-urlencoded',422)
        check_send(cp,b'X=' + b'x'*20000,'application/x-www-form-urlencoded',413)
        fixture=(ROOT/'tools/tilt-emulator/fixtures/bridge.json').read_bytes()
        check_send(bp,fixture,'application/json');check_send(bp,fixture,'application/json')
        assert len(points(bridge))==1
        v=points(bridge)[0]['values'];assert v['gravity']==1.0123 and v['gravity_temp']==20. and v['weeks_on_battery']==3
        assert 'battery' not in v
        bad=json.loads(fixture);bad['mdns_id']='wrong';check_send(bp,json.dumps(bad).encode(),'application/json',400)
        bad=json.loads(fixture);bad['tilts']['Pink']['tempUnit']='K';check_send(bp,json.dumps(bad).encode(),'application/json',400)
        # Different source types cannot reuse a token.
        check_send('/ingest/tiltbridge/'+cloud_key['token'],fixture,'application/json',400)
        check_send('/iSpindel',json.dumps({'token':cloud_key['token'],'angle':45,'temperature':20,'gravity':1.05}).encode(),'application/json',400)
        # Automatic Tilt profile control is deliberately not offered/accepted.
        status,_=raw('/api/v1/resources/profiles',json.dumps({'name':'Unsupported','data':{'unit':'C','gravity_sensor':cloud['id'],'gravity_readings':'tilt','steps':[{'temperature':18,'hours':24,'transition':'hold','until':{'kind':'sg','sg':1.02}}]}}).encode())
        assert status==400
        # Manual readings preserve last automatic reading and both streams reach active batch.
        api('sensors/'+cloud['id']+'/measurement',{'gravity':1.011})
        assert len(points(batch))==2
        assert api('resources/sensors/'+cloud['id'])['data']['last_automatic']==latest['data']['last_automatic']
        # Complete the batch: sensor ingest continues without appending to finished batch.
        batch['data']['status']='completed';update(batch)
        b,c=packet('cloud',offset=60,mac='aa:bb:cc:dd:ee:ff',stamp=stamp+.0001);check_send(cp,b,c)
        assert len(points(batch))==2 and len(points(cloud))==3
        cloud=api('resources/sensors/'+cloud['id']);cloud['data']['collection_enabled']=False;update(cloud)
        check_send(cp,b,c,400)
        cloud['data']['collection_enabled']=True;update(cloud)
        key=api('sensors/'+cloud['id']+'/key',{});check_send(cp,b,c,400)
        urlfile=Path(temp)/'receiver-url';urlfile.write_text(base+key['path']);urlfile.chmod(0o600)
        result=subprocess.run(['python3',str(ROOT/'tools/tilt-emulator/emulator.py'),'--protocol','cloud','--url-file',str(urlfile),'--mac','aa:bb:cc:dd:ee:ff','--utc-offset','60'],capture_output=True,timeout=15)
        assert result.returncode==0 and key['token'].encode() not in result.stdout+result.stderr
        # Concurrent retries must commit exactly one point (same transaction as watermark).
        before=len(points(cloud))
        concurrent_body,concurrent_type=packet('cloud',offset=60,mac='aa:bb:cc:dd:ee:ff',stamp=stamp+.0002)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _: send(base+key['path'],concurrent_body,concurrent_type),range(8)))
        assert len(points(cloud))==before+1
        # Changing sender offset does not turn local-time clock changes into a stuck watermark.
        cloud=api('resources/sensors/'+cloud['id']);cloud['data']['tilt_utc_offset_minutes']=120;update(cloud)
        b,c=packet('cloud',offset=120,mac='aa:bb:cc:dd:ee:ff',stamp=stamp+1/24+.0003)
        check_send(key['path'],b,c);assert len(points(cloud))==before+2
        # CLI must reject redirects and never print token-bearing URLs on failure.
        class Redirect(BaseHTTPRequestHandler):
            targets=0
            def log_message(self,*args): pass
            def do_POST(self):
                if self.path=='/target': type(self).targets+=1
                self.send_response(307);self.send_header('Location','/target');self.end_headers()
        with ThreadingHTTPServer(('127.0.0.1',0),Redirect) as redirect:
            threading.Thread(target=redirect.serve_forever,daemon=True).start()
            secret_url=f'http://127.0.0.1:{redirect.server_port}/private-test-token'
            urlfile.write_text(secret_url)
            result=subprocess.run(['python3',str(ROOT/'tools/tilt-emulator/emulator.py'),'--protocol','cloud','--url-file',str(urlfile)],capture_output=True,timeout=15)
            assert result.returncode!=0 and Redirect.targets==0
            assert secret_url.encode() not in result.stdout+result.stderr and b'private-test-token' not in result.stdout+result.stderr
            redirect.shutdown()
        stop();start(False);api('auth/login',creds)
        check_send(key['path'],b,c,400);check_send(bp,fixture,'application/json',400)
        print('PASS: local auth, cloud/bridge HTTP, official fixture rejection, units/precision, MAC/color/bridge binding, invalid/stale/future/out-of-order packets, restart deduplication, payload limits, cross-protocol tokens, key rotation, manual/batch history, disabled collection, Tilt profile rejection concurrent replay, UTC-offset changes, redirect rejection and CLI emulator')
    finally: stop()
