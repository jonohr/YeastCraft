#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Verify matching release artifacts, then write install files and checksums."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
a = parser.parse_args()
folder = a.directory.resolve()
root = Path(__file__).resolve().parents[1]
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
with tarfile.open(folder / 'yeastcraft-source.tar.gz') as source:
    manifest = json.load(source.extractfile('yeastcraft-source/RELEASE-SOURCE.json'))
assert manifest['commit'] == commit, 'Source bundle is for another commit'
images = []
for arch in ['amd64', 'arm64', 'armv7']:
    receipt = json.loads((folder / f'image-{arch}.json').read_text())
    assert receipt['commit'] == commit and receipt['arch'] == arch, 'Image provenance mismatch'
    assert receipt['runtime_packages'] == manifest['runtime_packages'], 'Runtime versions differ from packaged sources'
    assert receipt['archive'] == f'yeastcraft-linux-{arch}.docker.tar.gz'
    assert receipt['tag'] == f'yeastcraft:{commit[:12]}-{arch}'
    with tarfile.open(folder / receipt['archive']) as archive:
        entries = json.load(archive.extractfile('manifest.json'))
        assert len(entries) == 1 and entries[0]['RepoTags'] == [receipt['tag']], 'Unexpected Docker tags'
        config = archive.extractfile(entries[0]['Config']).read()
        assert 'sha256:' + hashlib.sha256(config).hexdigest() == receipt['image_id'], 'Docker image ID mismatch'
        labels = json.loads(config)['config']['Labels']
        assert labels['org.opencontainers.image.revision'] == commit
    images.append(receipt)
(folder / 'release-manifest.json').write_text(json.dumps({'commit': commit, 'images': images}, indent=2) + '\n')
compose = (root / 'compose.rust.yml').read_text()
compose = compose.replace('    build:\n      context: .\n      dockerfile: Dockerfile.rust\n', '')
compose = compose.replace('image: yeastcraft:local', f'image: yeastcraft:{commit[:12]}-${{YEASTCRAFT_ARCH:-amd64}}\n    pull_policy: never')
(folder / 'compose.yml').write_text(compose)
(folder / 'INSTALL.txt').write_text(f'''YeastCraft — release candidate
Source commit: {commit}

These Docker archives contain the complete standalone app. No Node installation
or compilation is required. Choose amd64, arm64 or armv7 for your Linux host.

1. Download the complete asset set into a new directory.
2. Verify: sha256sum -c SHA256SUMS
3. Load your architecture, for example:
   docker load -i yeastcraft-linux-amd64.docker.tar.gz
4. mkdir -p private-import
5. YEASTCRAFT_ARCH=amd64 docker compose up -d
6. Open http://SERVER-IP:8315 on a trusted network and create your account.

Use YEASTCRAFT_ARCH=arm64 or YEASTCRAFT_ARCH=armv7 for those platforms in step 5, and load the
matching archive in step 3. Keep the same Compose project/directory for upgrades.
Back up your data first; do not use docker compose down -v unless deleting it.

Optional: set YEASTCRAFT_BIND_ADDRESS=127.0.0.1 in .env for loopback-only access.
Never run two applications against the same controller.
See the installation and compatibility guides in the matching source bundle.
The source archive includes project and dependency sources and license notices;
keep it available alongside the images when redistributing them.
''')
(folder / 'RELEASE-NOTES.md').write_text(f'''# YeastCraft preview

A small fermentation controller with a Rust server and a mobile/desktop interface.
This is an early preview, built on the work of Fermentrack and the BrewPi community.

Source revision: `{commit}`.

The candidate passed Rust, desktop/mobile, fresh-install and emulator checks in
this workflow. The three Docker archives are standalone installs for Linux amd64,
ARM64 and ARMv7; ARM containers are tested under emulation. This does not extend
the physical-hardware support described in `docs/COMPATIBILITY.md`.

Start with `INSTALL.txt`. `SHA256SUMS` covers every supplied asset except itself.
The full corresponding-source archive accompanies all binary images.

This candidate does not publish registry images. Publishing the reviewed GitHub
release triggers GHCR upload of these exact images, without rebuilding them.
Review security reports and current known limitations before publishing.
''')
lines = []
for path in sorted(folder.iterdir()):
    if path.is_file() and path.name != 'SHA256SUMS':
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        lines.append(f'{digest}  {path.name}\n')
(folder / 'SHA256SUMS').write_text(''.join(lines))
print(f'Assembled {len(lines)} matching assets for {commit}')
