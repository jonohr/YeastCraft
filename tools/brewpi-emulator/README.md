# Emulated fermentation chamber

Development-only Python standard-library tool. Listens **only on loopback**;
no Docker service, production dependency or physical device connection.

```sh
python3 tools/brewpi-emulator/emulator.py --port 18323 --speed 60
```

In an isolated YeastCraft instance, add a Wi-Fi/TCP temperature controller at
`127.0.0.1:18323`, Celsius. Do not use this loopback address for a server running
inside Docker: it refers to the container itself. Stop with Ctrl+C. The process
starts in Off mode and loses its synthetic state on exit.

Implements BrewPi `c`, `s`, `t`, `j` and `n` replies: unit check, readings,
settings, target writes and readback. Temperature moves toward a synthetic
ambient with separate chamber/liquid time constants. Status is idle, heating or
cooling. `--speed` accelerates **only this illustrative thermal model**, not the
app's wall clock or gravity confirmation periods. It does not model a particular
fridge, compressor protection, PID tuning, fermentation heat or actual beer.
Pins and firmware operations are deliberately unsupported.

## End-to-end SG profile verification

Build the app and the Rust iSpindel emulator first:

```sh
cargo build --locked --manifest-path rust/Cargo.toml
cargo build --locked --manifest-path tools/ispindel-emulator/Cargo.toml
python3 tools/brewpi-emulator/verify.py
```

This starts a disposable loopback app, a separate synthetic sensor and a
BrewPi chamber. The iSpindel CLI sends real HTTP packets to that test app; the
app sends real TCP protocol commands to the mock and verifies replies.
The test creates profiles through the API, restarts the app to exercise persisted
step state and verifies manual and automatic sources independently.

Long durations are tested by moving timestamps **only in the temporary test
SQLite database while its app is stopped**. The production application has no
clock override or confirmation bypass. This is accelerated history verification,
not an overnight real-time thermal test. No production database, tokens, histories,
controller or export destination are read or changed. All processes stop afterward.
