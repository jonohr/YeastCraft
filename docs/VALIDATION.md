# What we have tested

This preview has automated checks and limited physical-hardware experience.
The distinction matters: a simulator can check a command sequence, but it cannot
tell us how your fermenter responds to cooling.

Evidence reviewed 2026-11-20. [GitHub Actions](https://github.com/jonohr/YeastCraft/actions)
provides results for individual source revisions. [Compatibility](COMPATIBILITY.md)
is the concise equipment/support reference; [installation](INSTALLATION.md) is
the place to start using the app.

## Automated coverage

| Area                 | Checks                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Server               | 75 Rust tests; Clippy with warnings denied                                                                                   |
| Interface            | 66 desktop/mobile Chromium tests; frontend production build                                                                  |
| Fresh installation   | First account, login/logout, anonymous access rejection, account/profile persistence, non-root configuration and healthcheck |
| Operational defaults | Normal worker availability, per-device configuration, explicit maintenance mode and conflicting CLI flags                    |
| Profiles             | Timed and gravity steps, source separation, confirmations, restart persistence and target readback                           |
| iSpindel             | Real HTTP ingest, angle/device/server SG, calibration, history, invalid credentials and redirect rejection                   |
| Tilt HTTP            | Synthetic protocol fixtures, units, identity, timestamps, duplicates, malformed packets, token rotation and restart behavior |
| Import and restore   | Synthetic SQLite/CSV data, preview, validation, backup and restore                                                           |
| Containers           | Fresh Compose and all emulator acceptance suites on native amd64 and emulated ARM64/ARMv7                                    |
| Release assembly     | Matching source/image commits, runtime-library versions, image identities and checksums; deliberate mismatch rejection       |

Automated checks use temporary databases and loopback emulators. They do not use
physical brewing equipment, production accounts or external export destinations.
The chart bundle currently produces a size warning; the build and browser checks
still pass. Reproduction commands are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Physical equipment

A BrewPi ESP8266 with firmware 0.2.4 has been used for collection, reconnect,
setpoints/readback, profile trials and pin/probe assignments. This does not establish
compatibility with every BrewPi board or firmware, or complete-fermentation validation
of the gravity-based conditions.

The ARM64 application and its packaged loader/libraries passed the four emulator
acceptance suites natively on a Raspberry Pi 5 running Debian 12 with 16 KiB pages.
That host did not have Docker: this validates application/runtime-library behavior,
not native container isolation or Compose installation. ARMv7 hardware, physical
USB serial and Bluetooth remain unverified.

## Brewfather delivery

The REST API and Custom Stream paths were checked separately with an authorized
real account, outside the automated test suite:

- Two manual SG measurements entered in Brewfather were imported into the active
  YC batch and shown in its chart, with their original times and manual origin.
- The equipment retained its real name across the integration. The owner attached
  it to the intended Brewfather batch; repeated temperature deliveries were then
  read back through the batch API, including beer, chamber and room temperatures
  and the target.
- A scheduled delivery recorded success in YC. Successful HTTP response variants,
  explicit rejection, HTTP failures and redirects are covered by synthetic tests.
- Application restarts preserved the profile, its start time, the manual readings
  and the persisted reporting interval. Desktop/mobile checks verified the live UI.

The verified source revision was `0e14b2de17ba0b4f34978030d3c11ede67c23388`;
[CI and candidate assembly](https://github.com/jonohr/YeastCraft/actions/runs/44732451045)
passed for that revision. The server/interface counts above refer to that run;
emulator suites and packaging/security checks run in addition.

This establishes repeated delivery and batch association, not long-running
reliability or a complete fermentation. **Finish batch** stopping delivery,
disconnection, restore safety and duplicate prevention are automatically tested;
live Finish batch acceptance and extended runtime observation remain pending.
Automatic iSpindel SG export has synthetic coverage; this live check verified
temperatures, not a fresh physical iSpindel measurement. Other export services
still need real-account checks. No local manual SG export is implemented.

## Scope and limits

- [Security review](SECURITY_AUDIT.md): implementation review and scanners, not an independent penetration test.
- [Memory](MEMORY.md): bounded observations, not a RAM guarantee.
- [Licensing](LICENSE_REVIEW.md): notices and corresponding-source packaging.
- [CI and releases](RELEASING.md): the checks applied to a candidate before review.

A passing run covers its exact source revision and test inputs. It does not certify
additional hardware, predict thermal response in a full fermenter, or replace
checking your controller mode, probe assignment and returned target at first use.
