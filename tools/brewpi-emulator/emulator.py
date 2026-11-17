#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Loopback-only BrewPi protocol emulator. No physical controller access."""
import argparse
import json
import math
import socketserver
import threading
import time

class Chamber:
    def __init__(self, speed=1.0):
        self.lock = threading.Lock()
        self.speed = speed
        self.settings = {'mode': 'o', 'beerSet': None, 'fridgeSet': None}
        self.beer = self.fridge = 20.0
        self.state = 1
        self.last = time.monotonic()
        self.commands = []

    def reply(self, command):
        with self.lock:
            now = time.monotonic()
            seconds = (now - self.last) * self.speed
            self.last = now
            mode = self.settings['mode']
            target = self.settings['beerSet' if mode == 'b' else 'fridgeSet']
            measured = self.beer if mode == 'b' else self.fridge
            self.state = 1 if mode == 'o' or target is None else 4 if measured > target + .2 else 3 if measured < target - .2 else 0
            ambient = 2 if self.state == 4 else 35 if self.state == 3 else 20
            self.fridge += (ambient - self.fridge) * (1 - math.exp(-seconds / 900))
            self.beer += (self.fridge - self.beer) * (1 - math.exp(-seconds / 7200))
            if command.startswith('j'):
                changes = json.loads(command[1:])
                if 'mode' in changes and changes['mode'] not in ('o', 'b', 'f'):
                    raise ValueError('Unsupported mode')
                for key in ('beerSet', 'fridgeSet'):
                    value = changes.get(key)
                    if value is not None and (not isinstance(value, (int, float)) or not -20 <= value <= 50):
                        raise ValueError('Invalid setpoint')
                self.settings.update({k: v for k, v in changes.items() if k in self.settings})
                self.commands.append(dict(changes))
                return 'S', self.settings.copy()
            if command == 's':
                return 'S', self.settings.copy()
            if command == 'c':
                return 'C', {'tempFormat': 'C'}
            if command == 't':
                return 'T', {'bt': round(self.beer, 3), 'ft': round(self.fridge, 3), 'rt': 20,
                             'bs': self.settings['beerSet'], 'fs': self.settings['fridgeSet'], 's': self.state}
            if command == 'n':
                return 'N', {'v': '0.2.4', 'b': 'EMULATOR'}
            return 'D', {'message': 'Unsupported emulator command'}

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        for line in self.rfile:
            try:
                prefix, data = self.server.chamber.reply(line.decode().strip())
                self.wfile.write((prefix + ':' + json.dumps(data) + '\n').encode())
                self.wfile.flush()
            except (ValueError, OSError):
                return

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    def __init__(self, port=0, speed=1.0):
        self.chamber = Chamber(speed)
        super().__init__(('127.0.0.1', port), Handler)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=18323)
    parser.add_argument('--speed', type=float, default=1.0, help='Thermal model speed, not the app/profile clock')
    args = parser.parse_args()
    if not math.isfinite(args.speed) or args.speed <= 0:
        parser.error('speed must be positive and finite')
    with Server(args.port, args.speed) as server:
        print(f'SYNTHETIC BrewPi chamber on 127.0.0.1:{server.server_address[1]}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
