#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Synthetic Tilt HTTP sender. No Bluetooth and no real sensor claims."""
import argparse
import json
import math
from pathlib import Path
import time
import urllib.parse
import urllib.request

COLORS = ['RED', 'GREEN', 'BLACK', 'PURPLE', 'ORANGE', 'BLUE', 'YELLOW', 'PINK']
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def packet(protocol, color='PINK', gravity=1.050, temperature=20., bridge_id='test-bridge', offset=0, mac='', stamp=None):
    if protocol == 'cloud':
        fields = {'Timepoint': str((time.time() + offset * 60) / 86400 + 25569 if stamp is None else stamp),
                  'Temp': str(temperature * 9 / 5 + 32), 'SG': str(gravity),
                  'Beer': 'Synthetic test', 'Color': color + (':' + mac if mac else ''), 'Comment': ''}
        return urllib.parse.urlencode(fields).encode(), 'application/x-www-form-urlencoded; charset=utf-8'
    fields = {'mdns_id': bridge_id, 'tilts': {color.title(): {'color': color.title(), 'temp': str(temperature),
        'tempUnit': 'C', 'gravity': str(gravity), 'high_resolution': True, 'sends_battery': False, 'rssi': -60}}}
    return json.dumps(fields).encode(), 'application/json'

def send(url, payload, content_type):
    req = urllib.request.Request(url, data=payload, headers={'Content-Type': content_type})
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=10) as response:
        assert response.status == 200
        assert json.load(response)['result'] == 'success'

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--protocol', choices=['cloud', 'bridge'], required=True)
    p.add_argument('--url-file', type=Path, help='Private file containing the complete receiving URL. Omit for dry run.')
    p.add_argument('--color', choices=COLORS, default='PINK')
    p.add_argument('--gravity', type=float, default=1.050)
    p.add_argument('--temperature', type=float, default=20., help='Degrees C; cloud sender converts to F.')
    p.add_argument('--bridge-id', default='test-bridge')
    p.add_argument('--utc-offset', type=int, default=0, help='Minutes, matching the receiver setting.')
    p.add_argument('--mac', default='')
    p.add_argument('--count', type=int, default=1)
    p.add_argument('--interval', type=float, default=30.)
    a = p.parse_args()
    if not (.5 <= a.gravity <= 2 and -40 <= a.temperature <= 100 and 0 < a.count <= 10000 and math.isfinite(a.interval) and a.interval >= .1 and -720 <= a.utc_offset <= 840):
        p.error('Invalid measurement, count, interval or UTC offset')
    url = a.url_file.read_text().strip() if a.url_file else None
    if url and urllib.parse.urlsplit(url).scheme not in ('http', 'https'):
        p.error('Receiving URL must use HTTP or HTTPS')
    for i in range(a.count):
        body, content = packet(a.protocol, a.color, a.gravity, a.temperature, a.bridge_id, a.utc_offset, a.mac)
        if url:
            try: send(url, body, content)
            except Exception:
                # urllib exceptions contain the secret URL; never print them.
                p.exit(1, 'Send failed; check destination, receiver configuration and token.\n')
            print('Synthetic packet accepted')
        else: print(body.decode())
        if i + 1 < a.count: time.sleep(a.interval)
if __name__ == '__main__': main()
