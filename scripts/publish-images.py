#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Publish already-tested release archives; only called after release publication."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
a = parser.parse_args()
tag = os.environ['RELEASE_TAG']
assert re.fullmatch(r'v[0-9][A-Za-z0-9_.-]*', tag), 'Use a version tag such as v0.1.0-preview.1'
repo = os.environ['REPOSITORY'].lower()
assert re.fullmatch(r'[a-z0-9_.-]+/[a-z0-9_.-]+', repo)
manifest = json.loads((a.directory / 'release-manifest.json').read_text())
assert {i['arch'] for i in manifest['images']} == {'amd64', 'arm64', 'armv7'}
root = Path(__file__).resolve().parents[1]
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
assert manifest['commit'] == commit, 'Release tag and tested source differ'
registry = 'ghcr.io/' + repo
subprocess.run(['docker', 'login', 'ghcr.io', '-u', os.environ['REGISTRY_USER'], '--password-stdin'],
               input=os.environ['GH_TOKEN'] + '\n', text=True, check=True)
try:
    refs = []
    for image in manifest['images']:
        subprocess.run(['docker', 'load', '-i', str(a.directory / image['archive'])], check=True)
        loaded = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image['tag']]))[0]
        assert loaded['Id'] == image['image_id'], 'Loaded image ID differs from tested image'
        target = f"{registry}:{tag}-{image['arch']}"
        subprocess.run(['docker', 'tag', image['image_id'], target], check=True)
        subprocess.run(['docker', 'push', target], check=True)
        digests = json.loads(subprocess.check_output(['docker', 'image', 'inspect', target]))[0]['RepoDigests']
        refs.append(next(d for d in digests if d.startswith(registry + '@sha256:')))
    subprocess.run(['docker', 'buildx', 'imagetools', 'create', '--tag', f'{registry}:{tag}', *refs], check=True)
    subprocess.run(['docker', 'buildx', 'imagetools', 'inspect', f'{registry}:{tag}'], check=True)
finally:
    subprocess.run(['docker', 'logout', 'ghcr.io'], check=True)
