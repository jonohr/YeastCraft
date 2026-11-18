#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Run acceptance suites against a Docker image on a Linux Docker host.

Only the test server launch is substituted; emulators and assertions are shared
with source acceptance. All endpoints/state are disposable and local.
"""
import argparse
import os
import pathlib
import runpy
import secrets
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', default='yeastcraft:local')
parser.add_argument('--platform')
parser.add_argument('--qemu', type=pathlib.Path, help='Optional static QEMU user emulator')
options = parser.parse_args()
if options.qemu:
    options.qemu = options.qemu.resolve(strict=True)
original = subprocess.Popen
containers = []


def start(args, *positional, **kwargs):
    if isinstance(args, list) and str(args[0]) == str(ROOT / 'rust/target/debug/yeastcraft'):
        name = 'rs-image-check-' + secrets.token_hex(5)
        containers.append(name)
        mounts = {}
        for flag in ['--db', '--static', '--import-root', '--proxy-proof-file']:
            if flag in args:
                path = pathlib.Path(args[args.index(flag) + 1]).resolve()
                if flag in ['--db', '--proxy-proof-file']:
                    path = path.parent
                mounts[str(path)] = mounts.get(str(path), False) or flag == '--db'
        cmd = ['docker', 'run', '--rm', '--name', name, '--network', 'host',
               '--user', f'{os.getuid()}:{os.getgid()}',
               '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=256m']
        if options.platform:
            cmd += ['--platform', options.platform]
        if options.qemu:
            cmd += ['--entrypoint', '/qemu', '-v', f'{options.qemu}:/qemu:ro']
        for path, writable in mounts.items():
            cmd += ['-v', f'{path}:{path}' + ('' if writable else ':ro')]
        dbdir = str(pathlib.Path(args[args.index('--db') + 1]).resolve().parent)
        cmd += ['-e', 'SQLITE_TMPDIR=' + dbdir, options.image]
        if options.qemu:
            cmd += ['/usr/local/bin/yeastcraft']
        args = [*cmd, *args[1:]]
    return original(args, *positional, **kwargs)


subprocess.Popen = start
try:
    for relative in ['scripts/verify-standalone.py', 'tools/ispindel-emulator/verify.py',
                     'tools/brewpi-emulator/verify.py', 'tools/tilt-emulator/verify.py']:
        script = ROOT / relative
        sys.path.insert(0, str(script.parent))
        sys.modules.pop('emulator', None)
        sys.argv = [str(script)]
        print('IMAGE TEST', relative, flush=True)
        runpy.run_path(str(script), run_name='__main__')
        sys.path.pop(0)
finally:
    subprocess.Popen = original
    for name in containers:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
