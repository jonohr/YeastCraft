<p align="center">
  <img src="design/brand/wordmark-forest.svg" alt="YeastCraft" width="560">
</p>

<p align="center">
  <a href="#quick-start-with-docker-compose">Get started</a> ·
  <a href="docs/COMPATIBILITY.md">Supported equipment</a> ·
  <a href="docs/README.md">Guides</a> ·
  <a href="https://github.com/jonohr/YeastCraft/issues">Ideas &amp; issues</a>
</p>

# YeastCraft

An independent fermentation control and monitoring app for BrewPi-compatible
controllers, written in Rust with a modern interface and low resource usage.

Built on the work of [Fermentrack](https://github.com/thorrak/fermentrack) by
**John Beeler, Fredrik Steen and contributors**, and the
[BrewPi community](https://github.com/BrewPi). Their ideas, controller integration
and legacy data formats provided the foundation for YeastCraft. BrewPi firmware
handles temperature regulation and heating/cooling cycles on the controller;
YeastCraft sends setpoints, runs profiles and records measurements. This is an independent
project, not an official Fermentrack release. See [full attribution](NOTICE.md).

YeastCraft gives your fermentation chamber a plan: hold a temperature, follow a schedule,
or move to the next step when gravity measurements meet your conditions. Check
progress from your phone or desktop, and let the controller handle the heating
and cooling cycles.

Under the hood, one Rust process serves the interface, collects readings and runs
profiles, with SQLite for storage. Node.js is needed to build the interface, not
to run it. Your fridge already has enough humming away.

> **Early preview — a small project with a real fridge behind it.** Physical
> controller testing so far covers one BrewPi ESP8266 running firmware 0.2.4.
> Other combinations need help from people who own them. Tilt HTTP is experimental;
> direct Bluetooth and firmware flashing are not implemented.
> [What we have tested, and what we have not →](docs/COMPATIBILITY.md)

## What you can do

- BrewPi temperature collection and confirmed beer/chamber setpoints over TCP or serial.
- Timed Hold/Ramp profiles and gravity-based step conditions.
- Start a batch manually, with a saved YC profile, or with a Brewfather fermentation plan.
- iSpindel ingestion, manual gravity readings and calibration from reference samples.
- Sync manual SG readings from Brewfather into the linked active batch.
- Experimental Tilt cloud HTTP and legacy TiltBridge receivers (hardware unverified).
- Batch history, charts, controller-state bands and a bounded raw protocol log.
- Local login, SQLite backup/restore and import from legacy Fermentrack SQLite/CSV data.
- Send active-batch equipment readings to Brewfather under the equipment’s own name.
- Other export adapters are implemented but need real-service testing.
  Destinations send nothing until you configure and enable them.

## A little less RAM, please

This started partly with a simple wish: the fermentation server should leave some
RAM for everything else. Our original Fermentrack installation used about
**490 MiB** in Docker snapshots. In isolated tests of the YeastCraft standalone runtime,
process memory settled around **10 MiB RSS** (about **4 MiB** by Docker accounting),
with temporary peaks around **48 MiB RSS** during concurrent password checks.

Those are different workloads and different memory metrics, not a head-to-head
benchmark. The savings come from both Rust and a simpler single-process design.
Browser memory is separate, and imports or larger workloads can need more RAM.
[The measurements and their limits →](docs/MEMORY.md)

## Quick start with Docker Compose

Requirements: Docker Engine and Docker Compose v2 on Linux amd64, ARM64 or ARMv7.
ARM64 has also passed native application acceptance on a Raspberry Pi 5;
ARM Docker installation and ARMv7 remain verified under emulation. The
minimal runtime contains no shell or Node. See [container builds](docs/CONTAINER.md).
Clone the repository, then build and start it:

```sh
git clone https://github.com/jonohr/YeastCraft.git yeastcraft
cd yeastcraft
mkdir -p private-import
docker compose -f compose.rust.yml up -d --build
```

Open **http://SERVER-IP:8315** from your local network (or
**http://localhost:8315** on the server itself) and create the first administrator account. There is
no default username or password. The password must contain at least 12 characters.
The database is stored in the Compose-managed `yeastcraft_state` volume.

Collection, temperature control and exports are ready to use. Add your controller
or sensor in the app; exports start only when you configure and enable a destination.
No extra startup flags or Compose override is needed.
Follow [installation and controller setup](docs/INSTALLATION.md) for the connection steps.
Do not run two applications against the same controller.

The default port is reachable on the server's IPv4 interfaces. Set up the first
account on a trusted network. Do not forward port 8315 directly from the internet;
use HTTPS with authentication for remote access.

If you prefer access only through a local proxy or SSH tunnel, put
`YEASTCRAFT_BIND_ADDRESS=127.0.0.1` in a local `.env` file beside Compose.
See [network and authentication options](docs/INSTALLATION.md#network-access-and-authentication).
The default installation works on its own; no external login service is required.

## Build and test from source

The container build pins its toolchains and base images. Source builds are verified
with Rust 1.99, Node.js 22 and Python 3 (fixture/emulator tools only).

```sh
cargo build --locked --manifest-path rust/Cargo.toml
npm --prefix ui ci
npm --prefix ui run build
mkdir -p state private-import
rust/target/debug/yeastcraft --db state/yeastcraft.sqlite --static ui/dist
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

## Where next?

| If you want to…                                | Start here                                                   |
| ---------------------------------------------- | ------------------------------------------------------------ |
| Connect a fridge, sensor or export             | [Installation and everyday operations](docs/INSTALLATION.md) |
| Check your equipment before installing         | [Compatibility](docs/COMPATIBILITY.md)                       |
| Let gravity decide the next step               | [Gravity-controlled profiles](docs/GRAVITY_PROFILES.md)      |
| Try a Tilt HTTP sender                         | [Experimental Tilt support](docs/TILT.md)                    |
| Understand the memory numbers                  | [Measurements and methodology](docs/MEMORY.md)               |
| Build for another machine                      | [Containers and ARM](docs/CONTAINER.md)                      |
| Understand CI or prepare a release             | [CI and release guide](docs/RELEASING.md)                    |
| Report a bug, suggest something or lend a hand | [Contributing](CONTRIBUTING.md)                              |

The [documentation index](docs/README.md) also links the test evidence, security
review and licensing details.

## What is brewing next?

Brewfather can supply a starting fermentation plan and manual SG readings for the
linked active batch. Outbound Custom Stream export is separate; automatic
bidirectional measurement synchronization is not implemented.
[Connection guide](docs/BREWFATHER.md) ·
[Integration proposal](https://github.com/jonohr/YeastCraft/issues/1).

Found a rough edge? Have equipment we have not tried? [Open an issue](https://github.com/jonohr/YeastCraft/issues).
A clear description or a careful hardware test is just as welcome as code.

## License and attribution

YeastCraft code is **GPL-3.0-only**, unless a file states otherwise. See [LICENSE](LICENSE)
and [NOTICE.md](NOTICE.md) for Fermentrack, BrewPi and Lucide attribution. This is
an independent project, not an official Fermentrack release.
