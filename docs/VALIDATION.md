# What we have tested

This preview has automated checks and limited physical-hardware experience.
The distinction matters: a simulator can check a command sequence, but it cannot
tell us how your fermenter responds to cooling.

Evidence reviewed 2026-11-18. [GitHub Actions](https://github.com/jonohr/fermentrack-rs/actions)
provides results for individual source revisions. [Compatibility](COMPATIBILITY.md)
is the concise equipment/support reference; [installation](INSTALLATION.md) is
the place to start using the app.

## Automated coverage

| Area                 | Checks                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Server               | 49 Rust tests; Clippy with warnings denied                                                                                   |
| Interface            | 50 desktop/mobile Chromium tests; frontend production build                                                                  |
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

An explicitly authorized test sent synthetic readings through the standalone
image's export worker to a real Brewfather Custom Stream account. The owner
confirmed the displayed readings and Success status: SG 1.042, temperature 20.3 C,
room 21.8 C and fridge 19.5 C, matching the submitted values after display rounding.
The separate test device was not a real fermentation. The disposable container
and state were removed; the normal installation was unchanged.

This verifies delivery and account display. It does not establish long-running
export reliability or REST synchronization. Batch association is done in Brewfather.
Payload tests cover the `YeastCraft` sender label and preservation of the selected
controller or sensor name. Other export services still need real-account checks.

## Scope and limits

- [Security review](SECURITY_AUDIT.md): implementation review and scanners, not an independent penetration test.
- [Memory](MEMORY.md): bounded observations, not a RAM guarantee.
- [Licensing](LICENSE_REVIEW.md): notices and corresponding-source packaging.
- [CI and releases](RELEASING.md): the checks applied to a candidate before review.

A passing run covers its exact source revision and test inputs. It does not certify
additional hardware, predict thermal response in a full fermenter, or replace
checking your controller mode, probe assignment and returned target at first use.
