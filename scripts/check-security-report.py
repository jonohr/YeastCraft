#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Fail on high/critical advisories, detected secrets or high/critical config errors."""
import json
import sys

failures = []
for filename in sys.argv[1:]:
    report = json.load(open(filename))
    for result in report.get('Results', []):
        for item in result.get('Vulnerabilities', []):
            if item.get('Severity') in ('HIGH', 'CRITICAL'):
                failures.append(f"{item['Severity']} {item['VulnerabilityID']} ({item.get('PkgName', '?')})")
        for item in result.get('Secrets', []):
            failures.append(f"Secret finding: {item.get('RuleID', 'unknown rule')}")
        for item in result.get('Misconfigurations', []):
            if item.get('Status') == 'FAIL' and item.get('Severity') in ('HIGH', 'CRITICAL'):
                failures.append(f"Configuration finding: {item.get('ID', 'unknown rule')}")
if len(sys.argv) < 2:
    raise SystemExit('Provide at least one Trivy JSON report')
if failures:
    raise SystemExit('\n'.join(failures))
print('Security gate passed; inspect retained reports for lower-severity findings.')
