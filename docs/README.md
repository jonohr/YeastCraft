# The fermentation notebook

Start with your fridge. Dig into the internals when you need them.

## Get brewing

| Guide                                                       | What it helps with                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| [Quick start](../README.md#quick-start-with-docker-compose) | Build RS, open the app and create your account                        |
| [Installation and operations](INSTALLATION.md)              | Connect equipment, set temperatures, export readings and keep backups |
| [Compatibility](COMPATIBILITY.md)                           | Check tested hardware and the limits of this preview                  |
| [Gravity-controlled profiles](GRAVITY_PROFILES.md)          | Let measurements decide when a temperature step finishes              |
| [Tilt HTTP receivers](TILT.md)                              | Try experimental Tilt integrations and understand their boundaries    |

## Look under the lid

| Reference                                     | What is inside                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| [Containers and ARM](CONTAINER.md)            | Runtime contents, platform builds and emulation                                 |
| [CI and releasing](RELEASING.md)              | Pull requests, automated checks and release packages                            |
| [Memory measurements](MEMORY.md)              | Our observations, matched tests and the difference between Docker usage and RSS |
| [Validation record](VALIDATION.md)            | Dated checks, including fresh installs, simulators and hardware evidence        |
| [Security policy](../SECURITY.md)             | Deployment guidance and reporting status                                        |
| [Security review](SECURITY_AUDIT.md)          | Findings, fixes and remaining limits                                            |
| [Runtime advisory triage](security/TRIAGE.md) | Applicability of individual scanner findings                                    |
| [License review](LICENSE_REVIEW.md)           | Dependencies, notices and corresponding-source packaging                        |

The [build-tool advisory review](security/BUILD_TOOLS.md) explains the current
scoped CI exception separately from runtime findings.

## Help it grow

The [contribution guide](../CONTRIBUTING.md) covers bug reports, ideas, hardware
checks and code changes. No spare fridge? The [iSpindel](../tools/ispindel-emulator/README.md),
[BrewPi chamber](../tools/brewpi-emulator/README.md) and
[Tilt](../tools/tilt-emulator/README.md) emulators let you work with synthetic data.

Planned work lives in [GitHub Issues](https://github.com/jonohr/fermentrack-rs/issues).
The [Brewfather integration proposal](https://github.com/jonohr/fermentrack-rs/issues/1)
is a plan, not a list of features you can use today.

The validation and audit documents describe test coverage and its limits, not a
promise that every board, firmware or future revision behaves identically. If
your setup teaches us something new, please bring the details.
