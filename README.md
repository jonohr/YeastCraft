# Fermentrack RS

An independent Rust rewrite of Fermentrack, with a redesigned interface,
additional features, and a focus on low resource usage.

Built on the work of [Fermentrack](https://github.com/thorrak/fermentrack) by
**John Beeler, Fredrik Steen and contributors**, and the
[BrewPi community](https://github.com/BrewPi). Their ideas, controller integration
and legacy data formats provided the foundation for RS. This is an independent
project, not an official Fermentrack release. See [full attribution](NOTICE.md).

One Rust server process serves the React interface, collects readings and runs
fermentation profiles, with SQLite for storage. Node.js is needed to build the
interface, not to run the application.

**Early preview.** Tested with one BrewPi ESP8266 controller running firmware 0.2.4.
Other hardware combinations need testing. Tilt HTTP receivers are experimental;
direct Bluetooth and firmware flashing are not implemented. See [compatibility](docs/COMPATIBILITY.md) for the distinction between
physical hardware checks and simulator tests.

## Features

- BrewPi temperature collection and confirmed beer/chamber setpoints over TCP or serial.
- Timed Hold/Ramp profiles and gravity-based step conditions.
- iSpindel ingestion, manual gravity readings and calibration from reference samples.
- Experimental Tilt cloud HTTP and legacy TiltBridge receivers (hardware unverified).
- Batch history, charts, controller-state bands and a bounded raw protocol log.
- Local login, SQLite backup/restore and import from legacy Fermentrack SQLite/CSV data.
- Export adapters, disabled until explicitly configured and enabled.

## Quick start with Docker Compose

Requirements: Docker Engine and Docker Compose v2 on Linux amd64, ARM64 or ARMv7.
ARM64 has also passed native application acceptance on a Raspberry Pi 5;
ARM Docker installation and ARMv7 remain verified under emulation. The
minimal runtime contains no shell or Node. See [container builds](docs/CONTAINER.md).
From this checkout:

```sh
mkdir -p private-import
docker compose -f compose.rust.yml up -d --build
```

Open **http://SERVER-IP:8315** from your local network (or
**http://localhost:8315** on the server itself) and create the first administrator account. There is
no default username or password. The password must contain at least 12 characters.
The database is stored in the Compose-managed `rust_state` volume.

Collection, temperature control and exports are ready to use. Add your controller
or sensor in the app; exports start only when you configure and enable a destination.
No extra startup flags or Compose override is needed.
Follow [installation and controller setup](docs/INSTALLATION.md) for the connection steps.
Do not run two applications against the same controller.

The default port is reachable on the server's IPv4 interfaces. Set up the first
account on a trusted network. Do not forward port 8315 directly from the internet;
use HTTPS with authentication for remote access.

If you prefer access only through a local proxy or SSH tunnel, put
`FERMENTRACK_BIND_ADDRESS=127.0.0.1` in a local `.env` file beside Compose.
See [network and authentication options](docs/INSTALLATION.md#network-access-and-authentication).
The standalone installation does not require Authentik, a proxy proof or another service.

## Build and test from source

The container build pins its toolchains and base images. Source builds are verified
with Rust 1.99, Node.js 22 and Python 3 (fixture/emulator tools only).

```sh
cargo build --locked --manifest-path rust/Cargo.toml
npm --prefix ui ci
npm --prefix ui run build
mkdir -p state private-import
rust/target/debug/fermentrack-rs --db state/fermentrack.sqlite --static ui/dist
```

Tests:

```sh
cargo test --locked --manifest-path rust/Cargo.toml
cargo clippy --locked --manifest-path rust/Cargo.toml --all-targets -- -D warnings
python3 scripts/make-demo.py fixtures/browser
(cd ui && npx playwright install --with-deps chromium)
npm --prefix ui test
```

Browser tests use a temporary database and loopback port 8316. They do not require
brewery hardware. [CONTRIBUTING.md](CONTRIBUTING.md) describes simulator and clean
installation checks.

## Documentation

- [Installation, enabling equipment, backup and authentication](docs/INSTALLATION.md)
- [Compatibility and known limitations](docs/COMPATIBILITY.md)
- [Experimental Tilt HTTP setup and limits](docs/TILT.md)
- [Standalone validation](docs/VALIDATION.md)
- [Minimal container and ARM builds](docs/CONTAINER.md)
- [Security policy](SECURITY.md) and [review results](docs/SECURITY_AUDIT.md)
- [Gravity-controlled profiles](docs/GRAVITY_PROFILES.md)
- [iSpindel emulator](tools/ispindel-emulator/README.md)
- [BrewPi chamber emulator](tools/brewpi-emulator/README.md)

## License and attribution

RS code is **GPL-3.0-only**, unless a file states otherwise. See [LICENSE](LICENSE)
and [NOTICE.md](NOTICE.md) for Fermentrack, BrewPi and Lucide attribution. This is
an independent project, not an official Fermentrack release.
