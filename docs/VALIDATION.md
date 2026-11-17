# Standalone validation

This is a dated engineering record. For setup instructions, start with
[installation](INSTALLATION.md); for the current support summary, see
[compatibility](COMPATIBILITY.md). Later sections record changes that supersede
earlier defaults and test counts.

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
limits. These tests do not constitute
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

## Standalone allocator default — 2026-11-17

The runtime image now includes `MALLOC_MMAP_THRESHOLD_=131072`. All 43 Rust tests
and 50 desktop/mobile browser tests passed with the setting. Fresh Compose checks
and standalone/iSpindel/BrewPi/Tilt acceptance passed against the built image.
The matched memory workload settled at 4.12 MiB Docker-style usage and 10.24 MiB
process RSS after repeated and concurrent local logins. See MEMORY.md for peaks,
methodology and limitations. The existing live deployment was not changed.

## Minimal image, ARM and security review — 2026-11-17

48 Rust tests, Clippy and 50 desktop/mobile browser tests passed after security
hardening. The final scratch images passed fresh Compose installation and all
standalone/iSpindel/BrewPi/Tilt acceptance suites on native amd64 and emulated
ARM64/ARMv7. ARM teardown occasionally logs a Python emulator connection reset
when the server stops; the behavioral assertions and cleanup still passed.

The runtime contains no shell or package manager; binary healthchecks and restart
persistence work. Image sizes and reproduction are in CONTAINER.md. Scan results,
fixed findings and remaining medium/low advisories are in SECURITY_AUDIT.md.
Physical ARM hardware, live deployment and registry publication remain untested
or unchanged respectively. Earlier memory measurements are historical and were
not remeasured for this image/authentication change.

## Native ARM64 application acceptance — 2026-11-17

The exact ARM64 release binary and its loader/libraries extracted from the minimal
image passed all four standalone/iSpindel/BrewPi/Tilt acceptance suites on a physical
Raspberry Pi 5, Debian 12 aarch64, Python 3.11.2 and a 16 KiB page size. This covers
local authentication, restart persistence, synthetic ingest/calibration, confirmed
TCP control and gravity profiles, and experimental Tilt HTTP. The test helper was
cross-compiled separately; the app was not rebuilt or emulated on the Pi.

The host has no Docker, so this was native application/runtime-library validation,
not a native Compose/container isolation test. `/proc/PID/maps` verified that all
loaded shared libraries came from the extracted image. A separate cold healthcheck
process measured 6,544 KiB RSS; this is not comparable to the loaded x86 memory test.
No packages/services were installed or changed. Tests ran at low priority using
only loopback and temporary synthetic databases. The test bundle was removed;
existing host services remained active and its unrelated workload stayed idle.

The subsequent image update adds compressed license notices only; the runtime
code and libraries are unchanged. Native ARM Docker, physical ARMv7, USB/Bluetooth
and complete physical fermentation tests are still outside this evidence.

## Normal operation and network defaults — 2026-11-17

Normal server startup now makes collection, control and export workers available
without enable flags. A fresh database still has no equipment or destinations;
individual configuration/ownership and enabled-state checks remain in place.
Explicit `--maintenance` suspends all workers for restore/testing. Individual
disable switches and conflict detection are tested; former enable flags remain
accepted for existing launch configurations.

Compose now publishes to all IPv4 host interfaces by default. The optional
FERMENTRACK_BIND_ADDRESS setting selects loopback or a specific host address.
Both configurations were validated; acceptance still binds only disposable
loopback ports and never contacts physical hardware or external export services.

49 Rust tests and Clippy passed. All 50 desktop/mobile browser tests passed with
explicit maintenance-mode fixture servers. Fresh Compose and standalone/iSpindel/
BrewPi/Tilt acceptance passed against all three rebuilt images (native amd64,
emulated ARM64/ARMv7). Standalone checks verify normal startup flags, real local
command/ingest, restart persistence and maintenance rejection of control commands.
Live installations were not changed. Previous exact native-Pi binary hashes and
source-bundle receipts describe their earlier snapshots; regenerate release assets
for this new source revision.

## Brewfather real-account export — 2026-11-17

With explicit account-owner authorization, the standalone amd64 image
`sha256:87d6aa49e26ea2a95e6ae25356c8b5b0ba5868c956f68414581712d4332959ec`
sent one synthetic reading through its actual export worker to Brewfather Custom
Stream over HTTPS. The saved account endpoint was reused without printing or
committing its logging ID. No external credentials are included in test fixtures.

The separate device name was `Fermentrack RS test`: temperature 20.25 C, chamber
19.50 C, room 21.75 C and gravity 1.042 SG. Local account setup/login, payload
preview, destination activation and the worker's successful HTTP response path
were exercised. `last_success` matched `last_attempt`; `last_error` was null.

The owner subsequently supplied a Brewfather Devices screenshot showing Success
and matching SG 1.042, temperature 20.3 C, room 21.8 C and fridge 19.5 C (rounded
for display). This confirms receipt and account display. The worker itself checks
HTTP status, not the response body. No repeated 15-minute update or long-running
export test was performed; batch association remains a Brewfather user action.

Following that check, export `report_source` now identifies the application as
`Fermentrack RS` for Brewfather, Brewer's Friend and Grainfather. Brewfather's
`name` remains the selected controller or sensor name, independent of batch name.
The screenshot above predates this sender-label change; no new external reading
was sent for this text-only change.

The disposable container used a fresh tmpfs database, collection/control disabled,
one export destination and a 24-hour retry interval to limit the test to one
attempt. The container and temporary state were removed immediately afterward.
The live RS installation, controller and existing batch histories were unchanged.
Routine automated tests remain local-only; this was a separately authorized
external acceptance check. Protocol reference:
[Brewfather Custom Stream](https://docs.brewfather.app/integrations/custom-stream).

## GitHub staging — 2026-11-17

The clean source history was pushed to `jonohr/fermentrack-rs`, verified private
at the time of upload. Gitleaks scanned all 29 commits through `312983c` with no
findings. A separate historical-blob check found no matches for the private
installation markers checked. This is source staging, not a public binary release.
CI, a verified private vulnerability reporting route and matching release/source
artifacts remain release preparation work. Brewfather follow-up is tracked in
[issue 1](https://github.com/jonohr/fermentrack-rs/issues/1).
