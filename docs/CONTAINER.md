# Minimal container and ARM builds

The standalone image starts from `scratch` and contains the Rust
binary, static interface, CA bundle, required glibc/libgcc libraries and loader,
license notices, user identity and package provenance. Debian is only a library
assembly stage. There is no shell, apt, OpenSSL executable, Node or Python runtime.
The application healthcheck runs the server binary directly.

The process uses UID/GID 1000:1000. Compose keeps the root filesystem read-only,
drops capabilities, enables no-new-privileges, and limits memory/PIDs. Database
files and temporary SQLite/backup files live in the writable state volume.
Normal startup enables collection/control/export workers; equipment and destinations
are configured in the app. Use `--maintenance` explicitly for restore or offline
inspection. Compose publishes port 8315 on all IPv4 host interfaces by default;
`YEASTCRAFT_BIND_ADDRESS=127.0.0.1` selects loopback.
The runtime uses a glibc allocator setting to release large temporary buffers. This is a smaller disk image, not a
claim that RAM usage falls by the same percentage.

| Platform     | Approximate image size | Verification                            |
| ------------ | ---------------------: | --------------------------------------- |
| linux/amd64  |                  13 MB | Native x86 Docker                       |
| linux/arm64  |                  11 MB | QEMU Docker; native application on Pi 5 |
| linux/arm/v7 |                   9 MB | QEMU Docker                             |

Sizes are rounded Docker image-inspect sizes, not compressed download sizes, and
include dependency notices. Exact candidates have image IDs in their release
manifest. Native ARM Docker, physical ARMv7, USB/Bluetooth and power-loss behavior
remain outside the test evidence. See [validation](VALIDATION.md).

[CI and releasing](RELEASING.md) covers tested image archives, matching source and
the GHCR publication step. A naming example is not an already published version;
check the repository's Releases page for available downloads.

## Build locally

Normal Compose builds select the host's architecture automatically. To build all
three local tags from one Linux machine with Docker Buildx:

```sh
docker buildx create --name rs-builder --driver docker-container
docker buildx inspect rs-builder --bootstrap
docker buildx bake --builder rs-builder --load
```

BuildKit must support target-platform execution for the library assembly stage.
The tested Docker-container BuildKit includes QEMU helpers. The Rust compiler and
frontend build run on BUILDPLATFORM; explicit Rust targets and cross C toolchains
compile the backend and bundled SQLite. No host-wide binfmt change was used.

Bake produces `yeastcraft:local` (amd64), `yeastcraft:arm64` and
`yeastcraft:armv7`. It does not push images. For one target, append its Bake name:

```sh
docker buildx bake --builder rs-builder arm64 --load
```

## Validate

Build the main debug binary, UI and iSpindel CLI as described in CONTRIBUTING.md
before the image acceptance wrapper. On a native Linux Docker host:

```sh
python3 scripts/verify-container.py --image yeastcraft:local
python3 scripts/verify-image.py --image yeastcraft:local
```

The first uses a disposable Compose project and named volume. The second runs the
same standalone/iSpindel/BrewPi/Tilt acceptance suites against container processes,
using host networking for local emulators and temporary bind mounts for test data.
Both clean up their containers; neither connects to physical brewing hardware.

On x86 without host binfmt registration, provide a trusted static QEMU helper:

```sh
python3 scripts/verify-container.py --image yeastcraft:arm64 --platform linux/arm64 --qemu /path/to/qemu-aarch64
python3 scripts/verify-image.py --image yeastcraft:arm64 --platform linux/arm64 --qemu /path/to/qemu-aarch64
python3 scripts/verify-container.py --image yeastcraft:armv7 --platform linux/arm/v7 --qemu /path/to/qemu-arm
python3 scripts/verify-image.py --image yeastcraft:armv7 --platform linux/arm/v7 --qemu /path/to/qemu-arm
```

These scripts mount QEMU only for tests and override entrypoint/healthcheck where
needed. The distributed image contains no emulator. Native ARM needs no override.

## Updates and diagnostics

Rebuild the image to update libraries/certificates; packages cannot be installed
inside it. Update pinned base digests and rescan source and final image together.
Package metadata and copyright files are deliberately retained for the copied
libraries, including GCC runtime provenance, so scanners do not lose visibility.
The final binary is stripped; Rust dependency scanning therefore uses Cargo.lock
in addition to image scanning. See SECURITY_AUDIT.md for remaining findings.

Use Docker logs and the application's diagnostics/healthcheck. `docker exec ... sh`
is intentionally unavailable. Preserve the matching source and third-party notices
when distributing images; a tiny runtime does not remove license obligations.
