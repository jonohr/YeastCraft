# Standalone validation

Verified on 2026-11-17 on Linux x86_64. This repository was assembled from source
without the private development Git history, runtime database or deployment files.

- Locked Rust build and all 37 server tests passed; Clippy passed with warnings denied.
- Locked npm installation and production frontend build passed, using the local
  lockfile-provided Playwright runner rather than a shared host installation.
- All 46 browser checks passed across desktop and mobile Chromium projects.
- Local-auth standalone test passed with a new database: first account, rejected
  anonymous access, login/logout, disabled hardware/export defaults, restart
  persistence, BrewPi TCP command/readback/raw log and iSpindel HTTP ingestion.
- iSpindel emulator acceptance passed: ingestion, calibration, unchanged angle,
  corrected device SG, history, invalid credentials/options and redirect rejection.
- Chamber emulator acceptance passed: automatic confirmation windows, manual
  threshold/stability rules, source separation, persisted steps without duplicate
  commands and simulated heating/cooling with thermal lag.
- The Docker Compose installation passed with a fresh named volume and independent
  loopback port: UI delivery, first account, local authentication, default-disabled
  integrations, account/profile persistence after restart, non-root execution and
  healthcheck. The disposable project and volume were removed after testing.

No physical controller or existing production state was used for these checks.
No GitHub repository or release was created. See COMPATIBILITY.md for hardware
limits and the known active-batch deletion behavior. These tests do not constitute
an independent security audit or certification of additional hardware.

Source review checked the export for private hostnames/paths, key/token patterns,
local documentation links and accidentally staged runtime/build files. Generated
fixtures and test databases are excluded by .gitignore. Attribution is retained.
The frontend build currently reports a bundle-size warning for the chart library;
this does not prevent the build or tests from completing.

Reproduction commands are in README.md and CONTRIBUTING.md.

## Experimental Tilt HTTP addition — 2026-11-17

- 43 Rust tests and Clippy with warnings denied passed.
- 50 browser tests passed across desktop/mobile Chromium, including both Tilt
  setup flows, first receipt, connection tools, four-decimal SG and overflow checks.
- Tilt real-HTTP acceptance passed with a disposable locally authenticated server:
  protocol fixtures, unit conversion, color/MAC/bridge identity, malformed/stale/
  future packets, content-type/body limits, concurrent retries, restart persistence,
  UTC-offset changes, token rotation and cross-protocol isolation, manual readings,
  active/completed batch history, disabled collection and unsupported profile rejection.
- CLI simulator acceptance included redirect rejection without printing its secret URL.
- Existing standalone, iSpindel calibration and BrewPi/SG-profile emulator checks passed.
- Updated Docker image built and fresh Compose account/login/restart/volume checks passed.
- Mobile and desktop screenshots were inspected; Tilt metrics and graph legends show
  the supported measurements rather than iSpindel angle/battery-voltage controls.

No physical Tilt, TiltBridge, Bluetooth adapter or production deployment was used.
HTTP integration is experimental and logging-only, with one selected color per
legacy bridge receiving URL. Protocol evidence and remaining limits are in TILT.md.
