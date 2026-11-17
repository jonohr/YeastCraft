# Security review

Reviewed 2026-11-17. Scope: the RS source, locked dependencies and minimal runtime
images for amd64, ARM64 and ARMv7. This is an implementation review plus automated
checks, not an independent penetration test. Deployment guidance and reporting
status are in [SECURITY.md](../SECURITY.md).

## Current safeguards

| Area                  | Behavior                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Password work         | At most two simultaneous hash operations; excess requests receive HTTP 429. Permits remain owned by work even if the client disconnects |
| Login failures        | Username length limit, 1,024-entry tracking cap and timed lockouts                                                                      |
| Authentication timing | Cached dummy hash still verified for unknown accounts; password strength is unchanged                                                   |
| Request size          | 4 KiB for setup/login, 64 KiB for iSpindel, separate bounded Tilt receivers                                                             |
| Browser               | Same-origin CSP, frame denial, no-referrer, nosniff and no-store headers                                                                |
| Batch lifecycle       | Active-batch deletion is rejected; finish the batch explicitly                                                                          |
| Runtime               | Non-root process, minimal libraries, no shell/package manager, read-only root via Compose                                               |
| Exports               | HTTPS required; redirects rejected                                                                                                      |
| Import/restore        | Constrained import paths, restore preview and validation; maintenance mode required                                                     |

The password limiter bounds expensive work, not all network traffic. Per-user
lockouts can still be deliberately triggered. A trusted reverse proxy and network
boundary are needed for remote access; this is not a multi-tenant service or a
claim of DDoS resistance. Administrators control export destinations and backups
can contain integration secrets.

Normal startup makes operational workers available; equipment and destinations
must still be individually configured. Compose binds to all IPv4 host interfaces
unless changed. Complete first-account setup on a trusted network, and use HTTPS
with secure cookies for remote access. See [installation](INSTALLATION.md).

## Scan results and reviewed findings

CI retains complete source/runtime JSON reports for its exact candidate. The
scanner is pinned in `scripts/security-audit.sh` (Trivy 0.76.2). Advisory databases
change independently of the source; use the candidate's reports when releasing.

- **Source:** one high-severity advisory in the build-only dependency picomatch
  4.0.7, CVE-2026-112366. No patched release is available at review time. It is not
  part of the shipped Node-free runtime. The narrowly scoped, expiring CI decision
  and remaining build-time exposure are in [build-tool review](security/BUILD_TOOLS.md).
- **Runtime:** the reviewed minimal images have no high/critical findings, with
  26 medium, 12 low and 2 unknown package/advisory findings. These represent
  33 unique CVEs, not 40 independently exploitable flaws. Exact findings and
  applicability are in [runtime triage](security/TRIAGE.md).
- **Secrets/configuration:** reviewed source scans found no secrets or supported
  configuration errors. Gitleaks also scans committed history in CI.

The runtime triage includes an open deployment-dependent DNS availability risk.
Raw scan findings are retained, including the reviewed build-tool exception.
A passing gate does not mean zero findings or zero risk.

## Verification boundaries

Security regression checks cover authentication, secure cookies, cross-origin
writes, invalid-login/SQL-like input, session revocation, request limits and import
symlink escape. SQL values use bound parameters; dynamic table names are allowlisted.
Fresh-install and emulator coverage is described in [validation](VALIDATION.md).

Physical USB/Bluetooth, upstream firmware, arbitrary reverse-proxy deployments,
network flooding and complete hardware certification remain outside this review.

## Reproduce and maintain

After building an image:

```sh
scripts/security-audit.sh /tmp/fermentrack-audit fermentrack-rs:local
python3 scripts/check-security-report.py /tmp/fermentrack-audit/source.json /tmp/fermentrack-audit/runtime.json
npm --prefix ui audit
```

The scan script writes reports; its exit code alone is not an approval. The gate
rejects high/critical findings except the documented build-only case, and rejects
secrets and high/critical failed configuration checks. Review all remaining results
and update dependencies when fixes become available. Source notices and matching
runtime-library sources must be updated with them; see [license review](LICENSE_REVIEW.md).
