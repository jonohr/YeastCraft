# Security review — 2026-11-17

Scope: the clean RS source snapshot and locally built standalone images for
amd64, arm64 and arm/v7. This is an implementation review plus automated scanning
and regression testing, not an independent penetration test. No production service,
physical brewing equipment or private runtime database was used.

## Changes made

| Finding | Change | Evidence |
| --- | --- | --- |
| Unbounded concurrent password work could exhaust a small server | At most two password operations; excess requests return 429. Permits remain owned by blocking work even if a client disconnects | Security regression test for setup, login and password change |
| Login failure tracking grew with arbitrary usernames | Username length limit and 1,024-entry cap; existing ten-minute expiry retained | Oversized name/map capacity regression test |
| Dummy password hash was recomputed on every login | Cache it once; still verify an Argon2 hash for unknown users | Known/unknown invalid-login response tests; no weaker password parameters |
| Anonymous input limits were too broad | 4 KiB setup/login; 64 KiB iSpindel. Existing Tilt limits retained | Oversized HTTP body rejection tests |
| Missing browser defense headers | Same-origin CSP, frame denial and no-referrer, alongside nosniff and no-store | Header/origin tests and complete browser suite |
| Empty active batch could be deleted | Reject active-batch deletion in the API and disable it in the interface | Active versus completed batch regression test |
| Runtime included unrelated operating-system tools and libraries | Scratch final stage with only app, UI, loader/libraries and certificates; preserve package provenance | Fresh installs and full emulator suites on all three architectures |

The password limiter limits expensive work, not total incoming network traffic.
Use ingress rate limits where public exposure is required. Existing per-username
lockouts can still be deliberately triggered; this review does not claim DDoS resistance.

## Automated results

Scanner: Trivy 0.76.2, image
`aquasec/trivy@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb`.
Databases were retrieved on the review date. Results change as advisories change.

- Source scan: **0 reported vulnerabilities**, **0 secret findings**, **0 reported
  supported misconfigurations**. Includes both Rust lockfiles and npm development
  dependencies. Generated output, private state and Git internals are excluded.
- `npm audit`: **0 reported vulnerabilities**.
- Each final minimal image: **0 critical, 0 high, 26 medium, 12 low, 2 unknown**
  package/advisory findings. No fixed version was reported for these findings.
- Earlier Debian-slim image: 238 findings (1 critical, 37 high, 108 medium,
  87 low, 5 unknown). Removing unnecessary packages reduced this to 40 per image.
  Counts are package/advisory pairs, not unique exploitable vulnerabilities.
- Remaining findings are recorded in [runtime-findings.csv](security/runtime-findings.csv).
  Debian OS identity and four package records remain detectable in all images.
  This is not a zero-finding or zero-risk claim.

The former critical MiniZip/zlib finding, CVE-2023-45853, was also qualified by
[Debian's advisory](https://security-tracker.debian.org/tracker/CVE-2023-45853):
bookworm's zlib package does not build the affected contrib/minizip code. The final
image does not include zlib at all. Remaining libc/GCC runtime advisories have not
all received a full call-path exploitability analysis. No suppression file hides them.

Dependency license metadata was inventoried: Cargo/npm package records have license
fields. This does not replace checking bundled assets, license alternatives and
source-distribution obligations before publishing. Existing GPL and third-party
notices are retained; copied Debian libraries include their copyright notices.

## Verification and reviewed boundaries

- 48 Rust tests passed; Clippy passed with warnings denied.
- 50 browser tests passed across desktop/mobile Chromium.
- Fresh Compose install on amd64, arm64 and arm/v7: first account, authentication,
  anonymous access rejection, disabled hardware/export defaults, restart persistence,
  UI delivery, non-root configuration and binary healthcheck.
- All three images passed standalone, iSpindel calibration, BrewPi/SG profiles and
  Tilt HTTP acceptance. ARM used QEMU; no physical ARM hardware claim is made.
- Security tests cover protected endpoints, secure-cookie flags, cross-origin writes,
  uniform invalid login/SQL-like input, password session revocation and import symlink escape.
- Query values use bound parameters; reviewed dynamic table names are allowlisted.
- Import resolves and constrains paths to the configured import root. Restore requires
  disabled operational workers, preview confirmation and SQLite/entity checks.
- Exports require HTTPS and disable redirects. Destination selection is a trusted
  administrator capability; it is not a general SSRF sandbox.
- The local administrator controls the whole installation. No tenant isolation or
  granular authorization is promised. First-run setup must remain privately reachable.
- Backup files can include integration secrets. Firmware, BLE/USB hardware, ingress
  deployment and network-level flood resistance are outside this validation.

## Reproduce and maintain

Run `scripts/security-audit.sh /tmp/fermentrack-audit fermentrack-rs:local`, inspect
both JSON files, and repeat for the ARM tags. The script deliberately reports findings
without treating scanner exit zero as security approval. Run `npm --prefix ui audit`
and the test commands in CONTRIBUTING.md. See CONTAINER.md for cross-platform builds
and emulation. Rebuild/rescan when base images or dependency locks change.

Before a stable public release, rerun current advisory scans, review remaining
runtime findings, enable a private vulnerability reporting route and finish the
license/distribution checklist. No GitHub publication or production update occurred.
