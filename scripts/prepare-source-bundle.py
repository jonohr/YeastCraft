#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Prepare matching source for a release; writes outside the repo and never publishes.

Includes the committed project, locked crate/npm source archives, Rust library
sources and original Debian source packages for copied runtime components.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import tomllib
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=Path, help='New .tar.gz output outside the checkout')
args = parser.parse_args()
output = args.output.resolve()
if output.exists() or output.is_relative_to(ROOT):
    parser.error('Use a new output path outside the checkout')
if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT):
    parser.error('Commit the intended release snapshot first')
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
CACHE = Path(tempfile.gettempdir()) / 'rs-source-downloads'
CACHE.mkdir(exist_ok=True)


def download(url, path, digest=None, algorithm='sha256', encoded=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    value = hashlib.new(algorithm)
    cached = CACHE / hashlib.sha256(url.encode()).hexdigest()
    response = cached.open('rb') if cached.exists() else urllib.request.urlopen(url, timeout=90)
    with response, path.open('wb') as target:
        while chunk := response.read(1024 * 1024):
            value.update(chunk)
            target.write(chunk)
    actual = base64.b64encode(value.digest()).decode() if encoded else value.hexdigest()
    if digest and actual != digest:
        raise RuntimeError(f'Checksum mismatch for {path.name}')
    if not cached.exists():
        shutil.copyfile(path, cached)


with tempfile.TemporaryDirectory(prefix='rs-source-bundle-') as temporary:
    root = Path(temporary) / 'fermentrack-rs-source'
    root.mkdir()
    archive = Path(temporary) / 'project.tar'
    subprocess.run(['git', 'archive', '--format=tar', '-o', str(archive), commit], cwd=ROOT, check=True)
    subprocess.run(['tar', '-xf', str(archive), '-C', str(root)], check=True)
    sources = root / 'dependency-sources'
    crates = {}
    for relative in ['rust/Cargo.lock', 'tools/ispindel-emulator/Cargo.lock']:
        for package in tomllib.loads((root / relative).read_text())['package']:
            if 'source' in package:
                assert package['source'].startswith('registry+https://github.com/rust-lang/crates.io-index')
                crates[(package['name'], package['version'])] = package['checksum']
    for (name, version), checksum in sorted(crates.items()):
        filename = f'{name}-{version}.crate'
        destination = sources / 'cargo' / filename
        cached = list((Path.home() / '.cargo/registry/cache').glob('*/' + filename))
        if cached:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(cached[0], destination)
            assert hashlib.sha256(destination.read_bytes()).hexdigest() == checksum
        else:
            download(f'https://static.crates.io/crates/{name}/{filename}', destination, checksum)
    lock = json.loads((root / 'ui/package-lock.json').read_text())
    count = 0
    for location, package in sorted(lock['packages'].items()):
        if not location:
            continue
        url = package['resolved']
        assert url.startswith('https://registry.npmjs.org/')
        algorithm, digest = package['integrity'].split('-', 1)
        filename = location.replace('/', '_') + '-' + package['version'] + '.tgz'
        download(url, sources / 'npm' / filename, digest, algorithm, True)
        count += 1
    for source in json.loads((root / 'docs/security/npm-upstream-sources.json').read_text()):
        filename = source['name'].replace('/', '_') + '-' + source['version'] + '.tar.gz'
        download(source['url'], sources / 'npm-upstream' / filename, source['sha256'])
    rustc = shutil.which('rustc') or str(Path.home() / '.cargo/bin/rustc')
    sysroot = Path(subprocess.check_output([rustc, '--print', 'sysroot'], text=True).strip())
    channel = tomllib.loads((sysroot / 'lib/rustlib/multirust-channel-manifest.toml').read_text())
    rust = channel['pkg']['rust-src']['target']['*']
    assert '1.99.1' in rust['xz_url'], 'Update source selection alongside the pinned build toolchain'
    download(rust['xz_url'], sources / 'rust' / 'rust-src-1.99.1.tar.xz', rust['xz_hash'])
    # Versions come from the retained package metadata in the reviewed runtime.
    for package, version, directory in [
        ('glibc', '2.36-9+deb12u14', 'g/glibc'),
        ('gcc-12', '12.2.0-14+deb12u1', 'g/gcc-12'),
        ('ca-certificates', '20250419~deb12u2', 'c/ca-certificates'),
    ]:
        base = 'https://deb.debian.org/debian/pool/main/' + directory + '/'
        dsc = sources / 'debian' / f'{package}_{version}.dsc'
        try:
            download(base + dsc.name, dsc)
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
            base = 'https://security.debian.org/debian-security/pool/updates/main/' + directory + '/'
            download(base + dsc.name, dsc)
        checksums = False
        for line in dsc.read_text().splitlines():
            if line == 'Checksums-Sha256:':
                checksums = True
                continue
            if checksums and not line.startswith(' '):
                break
            if checksums:
                digest, size, filename = line.split()
                assert Path(filename).name == filename
                destination = dsc.parent / filename
                download(base + filename, destination, digest)
                assert destination.stat().st_size == int(size)
    (root / 'SOURCE-BUNDLE.txt').write_text(
        f'Project commit: {commit}\n'
        f'Locked sources: {len(crates)} Rust crates, {count} npm archives.\n'
        'Original source archives and notices retain their upstream licenses.\n'
        'Cargo and npm archives are checksum-verified against the lockfiles.\n'
        'Rust library sources are verified against the installed toolchain manifest.\n'
        'Debian archives are checked against their accompanying source descriptors.\n'
        'See README.md for builds; the original source archives are also included\n'
        'for inspection and redistribution without relying on registry retention.\n')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(output, 'w:gz') as tar:
        tar.add(root, arcname=root.name)
    print(f'Prepared {output.name}; commit {commit}; sha256 {hashlib.sha256(output.read_bytes()).hexdigest()}')
