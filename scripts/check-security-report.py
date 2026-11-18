#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Gate scan results; keep narrowly reviewed build-only findings visible."""
from datetime import date
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def reviewed_build_finding(report, result, item, today=None):
    # No wildcard CVE/version exceptions; never applies to runtime images.
    if not (
        report.get('ArtifactType') == 'repository'
        and result.get('Target') == 'ui/package-lock.json'
        and result.get('Type') == 'npm'
        and item.get('VulnerabilityID') == 'CVE-2026-112366'
        and item.get('PkgName') == 'picomatch'
        and item.get('InstalledVersion') == '4.0.7'
        and not item.get('FixedVersion')
        and (today or date.today()) <= date(2026, 12, 17)
    ):
        return False
    lock = json.loads((ROOT / 'ui/package-lock.json').read_text())
    package = lock['packages'].get('node_modules/picomatch', {})
    return package.get('dev') is True and package.get('version') == '4.0.7'


def check(filenames):
    failures = []
    for filename in filenames:
        report = json.load(open(filename))
        for result in report.get('Results', []):
            for item in result.get('Vulnerabilities', []):
                if item.get('Severity') in ('HIGH', 'CRITICAL'):
                    if reviewed_build_finding(report, result, item):
                        print('REVIEWED BUILD-ONLY FINDING: CVE-2026-112366, picomatch 4.0.7; expires 2026-12-17. See docs/security/BUILD_TOOLS.md.')
                    else:
                        failures.append(f"{item['Severity']} {item['VulnerabilityID']} ({item.get('PkgName', '?')})")
            for item in result.get('Secrets', []):
                failures.append(f"Secret finding: {item.get('RuleID', 'unknown rule')}")
            for item in result.get('Misconfigurations', []):
                if item.get('Status') == 'FAIL' and item.get('Severity') in ('HIGH', 'CRITICAL'):
                    failures.append(f"Configuration finding: {item.get('ID', 'unknown rule')}")
    return failures


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit('Provide at least one Trivy JSON report')
    failures = check(sys.argv[1:])
    if failures:
        raise SystemExit('\n'.join(failures))
    print('Security gate passed with documented scope; review retained reports and exceptions.')
