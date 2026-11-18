# Contributing

You do not need a Rust compiler to help. A confusing screen, a reproducible bug or
results from a controller we have not tried can all make YeastCraft better. This is a small,
early project; thank you for taking a look.

## Start with an issue

- **Something broke?** Tell us what you expected, what happened, your YeastCraft revision,
  installation method and steps to reproduce it. For hardware, include the board,
  firmware and connection type.
- **Have an idea?** Describe the brewing problem you want to solve. A concrete
  example is more useful than a long feature list.
- **Tried new equipment?** Tell us what you physically checked, and what you only
  simulated. Successful tests and awkward surprises are both useful.

[Open an issue](https://github.com/jonohr/fermentrack-rs/issues), or join an existing
one. For larger changes, agree on the scope there before spending a weekend on it.
Keep tokens, receiving URLs, databases and private brewery histories out of reports.
For vulnerabilities, follow [the security reporting guidance](SECURITY.md).

## Working on the code

Use a branch and a pull request rather than pushing directly to `main`. Wait for
CI and release-candidate assembly to pass before merging. See the
[CI and release guide](docs/RELEASING.md) for checks and maintainer steps.

Keep changes focused and explain what changed and how you checked it. Link the
relevant issue in your pull request. Preserve attribution and license notices;
small, reviewable contributions are easier to get over the finish line.

Use the source-build and test commands in README.md. The npm lockfile supplies the
browser test runner; no host-global npm packages or private tooling are required.
The build is served by the Rust process; Node is not a production dependency.

## Test without borrowing the fridge

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

## Check a fresh installation

For a completely fresh container installation (requires Docker Compose):

```sh
docker build -f Dockerfile.rust -t yeastcraft:local .
python3 scripts/verify-container.py
```

This uses a unique Compose project, a random loopback port and a new named volume.
It checks account setup, login/logout, operational defaults and explicit maintenance, UI delivery, non-root execution,
healthcheck and account/profile persistence after restart. Its container and volume
are removed afterward. It never uses an existing installation or proxy credentials.

For all acceptance suites against a built image, run `python3 scripts/verify-image.py`.
See [CONTAINER.md](docs/CONTAINER.md) for ARM builds and optional QEMU testing, and
[SECURITY.md](SECURITY.md) for reproducible scans and private reporting guidance.

On space-constrained development machines, use `CARGO_INCREMENTAL=0` and
`CARGO_PROFILE_DEV_DEBUG=0` for local acceptance builds. Generated Rust `target/`
directories can be rebuilt; runtime databases and backups must be preserved.
