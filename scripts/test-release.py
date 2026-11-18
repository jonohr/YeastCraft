#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Synthetic release assembly tests: no Docker, network or real account needed."""
from datetime import date
import runpy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
COMMIT = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()


def archive(path, entries):
    with tarfile.open(path, 'w:gz') as tar:
        for name, value in entries.items():
            data = value if isinstance(value, bytes) else json.dumps(value).encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))


class ReleaseChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        archive(self.folder / 'yeastcraft-source.tar.gz', {
            'yeastcraft-source/RELEASE-SOURCE.json': {'commit': COMMIT, 'runtime_packages': {'libc6': 'fixture'}}})
        for arch in ['amd64', 'arm64', 'armv7']:
            tag = f'yeastcraft:{COMMIT[:12]}-{arch}'
            config = json.dumps({'config': {'Labels': {'org.opencontainers.image.revision': COMMIT}}}).encode()
            image_id = 'sha256:' + hashlib.sha256(config).hexdigest()
            filename = f'yeastcraft-linux-{arch}.docker.tar.gz'
            archive(self.folder / filename, {'manifest.json': [{'Config': 'config.json', 'RepoTags': [tag]}], 'config.json': config})
            (self.folder / f'image-{arch}.json').write_text(json.dumps({'commit': COMMIT, 'arch': arch,
                'image_id': image_id, 'tag': tag, 'archive': filename, 'runtime_packages': {'libc6': 'fixture'}}))

    def run_assembly(self):
        return subprocess.run(['python3', str(ROOT / 'scripts/assemble-release.py'), str(self.folder)], capture_output=True)

    def test_matching_assets_and_checksums(self):
        result = self.run_assembly()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        checked = subprocess.run(['sha256sum', '-c', 'SHA256SUMS'], cwd=self.folder, capture_output=True)
        self.assertEqual(checked.returncode, 0)
        self.assertIn('pull_policy: never', (self.folder / 'compose.yml').read_text())
        self.assertNotIn('build:', (self.folder / 'compose.yml').read_text())

    def test_old_source_bundle_rejected(self):
        archive(self.folder / 'yeastcraft-source.tar.gz', {
            'yeastcraft-source/RELEASE-SOURCE.json': {'commit': 'old', 'runtime_packages': {'libc6': 'fixture'}}})
        self.assertNotEqual(self.run_assembly().returncode, 0)

    def test_missing_image_rejected(self):
        (self.folder / 'yeastcraft-linux-armv7.docker.tar.gz').unlink()
        self.assertNotEqual(self.run_assembly().returncode, 0)

    def test_mismatched_library_sources_rejected(self):
        path = self.folder / 'image-arm64.json'
        data = json.loads(path.read_text());data['runtime_packages']['libc6'] = 'new-version'
        path.write_text(json.dumps(data))
        self.assertNotEqual(self.run_assembly().returncode, 0)

    def test_changed_image_config_rejected(self):
        archive(self.folder / 'yeastcraft-linux-amd64.docker.tar.gz', {
            'manifest.json': [{'Config': 'config.json', 'RepoTags': [f'yeastcraft:{COMMIT[:12]}-amd64']}],
            'config.json': b'{}'})
        self.assertNotEqual(self.run_assembly().returncode, 0)


class SecurityScopeChecks(unittest.TestCase):
    def test_review_never_applies_to_runtime_or_fixed_versions(self):
        review = runpy.run_path(str(ROOT / 'scripts/check-security-report.py'))['reviewed_build_finding']
        result = {'Target': 'ui/package-lock.json', 'Type': 'npm'}
        finding = {'VulnerabilityID': 'CVE-2026-112366', 'PkgName': 'picomatch', 'InstalledVersion': '4.0.7'}
        self.assertTrue(review({'ArtifactType': 'repository'}, result, finding, date(2026, 11, 17)))
        self.assertFalse(review({'ArtifactType': 'container_image'}, result, finding, date(2026, 11, 17)))
        self.assertFalse(review({'ArtifactType': 'repository'}, result, finding, date(2026, 12, 18)))
        self.assertFalse(review({'ArtifactType': 'repository'}, result, {**finding, 'FixedVersion': '4.0.8'}, date(2026, 11, 17)))
        self.assertFalse(review({'ArtifactType': 'repository'}, result, {**finding, 'VulnerabilityID': 'OTHER'}, date(2026, 11, 17)))


if __name__ == '__main__':
    unittest.main()
