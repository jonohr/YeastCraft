#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Package a tested local image, retaining commit and runtime-package provenance."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', required=True)
parser.add_argument('--arch', required=True, choices=['amd64', 'arm64', 'armv7'])
parser.add_argument('--output', required=True, type=Path)
a = parser.parse_args()
root = Path(__file__).resolve().parents[1]
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
info = json.loads(subprocess.check_output(['docker', 'image', 'inspect', a.image]))[0]
assert info['Config']['Labels']['org.opencontainers.image.revision'] == commit, 'Image/source revision mismatch'
assert info['Architecture'] == ('arm' if a.arch == 'armv7' else a.arch), 'Wrong image architecture'
if a.arch == 'armv7':
    assert info.get('Variant') == 'v7', 'Wrong ARM variant'
tag = f'fermentrack-rs:{commit[:12]}-{a.arch}'
a.output.mkdir(parents=True, exist_ok=True)
archive = a.output / f'fermentrack-rs-linux-{a.arch}.docker.tar.gz'
assert not archive.exists(), 'Refusing to overwrite image archive'
container = subprocess.check_output(['docker', 'create', a.image], text=True).strip()
try:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'status'
        subprocess.run(['docker', 'cp', f'{container}:/var/lib/dpkg/status', str(path)], check=True, stdout=subprocess.DEVNULL)
        packages = {}
        for paragraph in path.read_text().split('\n\n'):
            fields = dict(line.split(': ', 1) for line in paragraph.splitlines() if ': ' in line and not line.startswith(' '))
            if 'Package' in fields:
                packages[fields['Package']] = fields['Version']
finally:
    subprocess.run(['docker', 'rm', container], check=True, stdout=subprocess.DEVNULL)
subprocess.run(['docker', 'tag', a.image, tag], check=True)
with archive.open('wb') as output:
    save = subprocess.Popen(['docker', 'save', tag], stdout=subprocess.PIPE)
    try:
        compressed = subprocess.run(['gzip', '-n'], stdin=save.stdout, stdout=output)
    finally:
        save.stdout.close()
    assert save.wait() == 0 and compressed.returncode == 0, 'Image archive failed'
(a.output / f'image-{a.arch}.json').write_text(json.dumps({
    'commit': commit, 'arch': a.arch, 'image_id': info['Id'], 'tag': tag,
    'archive': archive.name, 'runtime_packages': packages,
}, indent=2) + '\n')
print(f'Packaged {archive.name} from {info["Id"]}')
