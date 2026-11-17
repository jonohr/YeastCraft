# Contributing

This project is an early preview. Small fixes, reproducible bug reports and hardware
test results are welcome. Include controller board/firmware and distinguish simulator
results from physical-device behavior. Do not attach credentials or brewery histories.

Use the source-build and test commands in README.md. The npm lockfile supplies the
browser test runner; no host-global npm packages or private tooling are required.
The build is served by the Rust process; Node is not a production dependency.

For isolated controller/gravity testing:

```sh
cargo build --locked --manifest-path tools/ispindel-emulator/Cargo.toml
python3 tools/ispindel-emulator/verify.py
python3 tools/brewpi-emulator/verify.py
python3 tools/tilt-emulator/verify.py
python3 scripts/verify-standalone.py
```

Build the main debug server and UI first. These checks use temporary databases and
loopback listeners. The standalone check uses first-run local account setup/login,
not the proxy-auth bypass. The chamber tests accelerate history timestamps only in
a disposable stopped test instance, never by changing the production clock.

Keep GPL-3.0-only headers on new source and preserve third-party notices. Test UI
changes on desktop and mobile. Firmware and Tilt contributions require explicit
hardware evidence before being described as supported.

For a completely fresh container installation (requires Docker Compose):

```sh
docker build -f Dockerfile.rust -t fermentrack-rs:local .
python3 scripts/verify-container.py
```

This uses a unique Compose project, a random loopback port and a new named volume.
It checks account setup, login/logout, safe defaults, UI delivery, non-root execution,
healthcheck and account/profile persistence after restart. Its container and volume
are removed afterward. It never uses an existing installation or proxy credentials.
