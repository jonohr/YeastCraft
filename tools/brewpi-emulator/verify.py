#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Real HTTP ingest + real TCP command/readback, with disposable accelerated history."""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.request
from emulator import Server

ROOT = Path(__file__).resolve().parents[2]

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

def wait(predicate, message):
    end = time.monotonic() + 8
    while time.monotonic() < end:
        try:
            if predicate(): return
        except (OSError, ValueError): pass
        time.sleep(.1)
    raise AssertionError(message)

with tempfile.TemporaryDirectory(prefix='ferm-sg-test-') as temp, Server(speed=360) as fridge:
    threading.Thread(target=fridge.serve_forever, daemon=True).start()
    proof = 'b' * 64
    Path(temp, 'proof').write_text(proof)
    db = Path(temp, 'test.sqlite')
    base = f'http://127.0.0.1:{free_port()}'
    proc = None
    def api(path, body=None, method=None):
        req = urllib.request.Request(base + '/api/v1/' + path, data=None if body is None else json.dumps(body).encode(),
            method=method, headers={'x-fermentrack-proxy-proof': proof, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=5) as r: return json.load(r)
    def start():
        global proc
        proc = subprocess.Popen([str(ROOT/'rust/target/debug/fermentrack-rs'), '--db', str(db), '--listen', base.split('//')[1],
            '--static', str(ROOT/'ui/dist'), '--import-root', temp, '--disable-internal-auth', '--proxy-proof-file', str(Path(temp,'proof')),
            '--enable-collection', '--enable-control'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait(lambda: api('auth/status'), 'server startup')
    def stop():
        global proc
        if proc:
            proc.terminate(); proc.wait(timeout=10); proc = None
    def resource(kind, name, data): return api('resources/'+kind, {'name':name,'data':data})
    def device(): return api('resources/devices/'+dev['id'])
    def tick():
        # Production cadence is unchanged. Restart exercises the persisted cursor
        # and immediately runs one collector iteration in the isolated instance.
        stop(); start()
        wait(lambda: device()['data'].get('last_seen', 0) > restarted_at[0], 'collector readback')
        restarted_at[0] = int(time.time()*1000)
    def send(sg):
        result = subprocess.run([str(ROOT/'tools/ispindel-emulator/target/debug/ispindel-emulator'),
            '--url', base+'/iSpindel', '--gravity', str(sg), '--angle', '45', '--count', '1'],
            env={**os.environ, 'ISPINDEL_TOKEN':token}, capture_output=True, text=True, timeout=15)
        assert result.returncode == 0, result.stderr
    def target(value):
        wait(lambda: fridge.chamber.settings['fridgeSet'] == value, f'Expected target {value}, got {fridge.chamber.settings}')
    def assign(readings='ispindel', until=None):
        p=resource('profiles','SYNTHETIC SG '+readings, {'unit':'C','control_sensor':'chamber','gravity_sensor':sensor['id'],
            'gravity_readings':readings,'steps':[
                {'temperature':18,'hours':24,'transition':'hold','until':until or {'kind':'sg','sg':1.020}},
                {'temperature':21,'hours':24,'transition':'hold'}]})
        api('devices/'+dev['id']+'/profile', {'profile':p['id'],'confirm_ownership':True})
        tick(); target(18)
    def age_points(minutes):
        # ONLY this temporary DB. No forged timestamps on production ingest/API.
        stop()
        with sqlite3.connect(db) as c:
            now=int(time.time()*1000)
            row=c.execute('select data from entities where id=?',(dev['id'],)).fetchone()
            data=json.loads(row[0]); data['profile_run']['entered']=now-int((max(minutes)+1)*60000)
            c.execute('update entities set data=? where id=?',(json.dumps(data),dev['id']))
            rows=c.execute('select rowid from points where source=? order by time desc,sequence desc',(sensor['id'],)).fetchall()
            for i, row in enumerate(rows[len(minutes):]):
                c.execute('update points set time=? where rowid=?',(now-int((max(minutes)+5)*60000)-i,row[0]))
            for row, age in zip(rows, minutes):
                c.execute('update points set time=? where rowid=?',(now-int(age*60000), row[0]))
        start()
        wait(lambda: device()['data'].get('last_seen',0)>now, 'aged collector')
        restarted_at[0]=int(time.time()*1000)
    try:
        start()
        sensor=resource('sensors','SYNTHETIC iSpindel',{'sensor_type':'ispindel','collection_enabled':True,'unit':'C','gravity_source':'device','reported_gravity_unit':'SG'})
        token=api('sensors/'+sensor['id']+'/key',{})['token']
        dev=resource('devices','SYNTHETIC chamber',{'host':'127.0.0.1','port':fridge.server_address[1],'connection_type':'wifi','unit':'C','collection_enabled':True})
        restarted_at=[0]
        assert fridge.chamber.reply('t')[1]['s'] == 1
        assign()
        assert fridge.chamber.reply('t')[1]['s'] == 4
        send(1.019); tick(); target(18)
        assert device()['data']['profile_run']['step']==0
        print('PASS: single iSpindel value cannot change target', flush=True)
        send(1.019); send(1.019); tick(); target(18)
        assert device()['data']['profile_run']['step']==0
        print('PASS: rapid repeated packets cannot bypass confirmation time', flush=True)
        age_points([0,5,10.1]); target(21)
        assert device()['data']['profile_run']['step']==1
        assert device()['data']['profile_run']['last_transition']['evidence']['count']==3
        before=len(fridge.chamber.commands); tick(); target(21)
        assert len(fridge.chamber.commands)==before
        print('PASS: three confirmed readings change target; restart preserves step without duplicate command', flush=True)
        assign('manual')
        send(1.010); tick(); target(18)
        api('sensors/'+sensor['id']+'/measurement',{'gravity':1.019})
        tick(); target(21)
        print('PASS: manual threshold changes target with one measurement; automatic source ignored', flush=True)
        assign('ispindel',{'kind':'stable','hours':1,'tolerance':.001})
        for value in [1.012,1.0123,1.0125,1.0122,1.012]: send(value)
        tick(); target(18)
        age_points([0,15,30,45,60.1]); target(21)
        print('PASS: automatic stability requires observations over the full period', flush=True)
        assign('manual',{'kind':'stable','hours':48,'tolerance':.001})
        api('sensors/'+sensor['id']+'/measurement',{'gravity':1.012})
        tick(); target(18)
        # Age the single observation; it still must not prove stability.
        age_points([48*60+1]); target(18)
        api('sensors/'+sensor['id']+'/measurement',{'gravity':1.0125})
        tick(); target(21)
        print('PASS: one old manual value cannot prove stability; two spanning 48 hours can', flush=True)
        # The mock chamber reports temperature movement and controller state.
        _, values=fridge.chamber.reply('t')
        assert values['s'] == 3 and values['ft'] != 20
        with fridge.chamber.lock:
            fridge.chamber.fridge = 21
        assert fridge.chamber.reply('t')[1]['s'] == 0
        print('PASS: simulated heating/cooling and thermal lag; no real hardware or production state used', flush=True)
    finally:
        stop(); fridge.shutdown()
