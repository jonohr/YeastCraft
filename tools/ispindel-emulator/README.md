# iSpindel emulator

Standalone Rust CLI, independent of the Fermentrack RS server. Sends HTTP JSON using
the iSpindel field names accepted by the Rust receiver. No daemon, Docker or Node
required. Without `--url`, it prints redacted sample packets and sends nothing.
The default is one sample; `--count 0` runs until Ctrl+C.

From this directory (Cargo must be on PATH):

```sh
./run.sh --help
./run.sh --angle 45 --gravity 1.050 --temperature 20
./run.sh --scenario fermentation.json --speed 3600 --interval 1 --count 10
```

For actual sending, register a **separate test iSpindel sensor**, enable its
collection, select device gravity with SG units (or configure a server formula),
and generate its ingest token. Put that token in an owner-only file, then:

```sh
./run.sh --url http://127.0.0.1:8315/iSpindel \
  --token-file /path/to/emulator.token --name 'iSpindel Emulator' \
  --scenario fermentation.json --interval 30 --speed 3600 --count 0
```

This command really writes measurements to the selected receiver. Use the new
sensor's token, never the real sensor's. Alternatively set `ISPINDEL_TOKEN` in the
environment. Tokens, response bodies and destination URLs are not logged. HTTP
redirects are rejected; an authentication redirect is a failed send. Use a direct
reachable ingest endpoint, not an interactive login URL. TLS verification stays on.
No proxy-proof or administrator credential is needed by the ingest endpoint.

`--interval` is real seconds between requests, after the previous request completes;
`--speed` advances scenario time by interval × speed per sample. One real second
at speed 3600 represents one scenario hour. Scenario time starts at zero each run;
receiver timestamps remain real arrival times. Fast-forward does not advance the
app's profile clock or turn minutes of SG data into 48 hours of stable history.

JSON scenarios contain strictly increasing `hours` beginning at zero, with `angle`
(degrees), `gravity` (SG) and `temperature` (C). Values interpolate linearly; after
the last point they remain constant. A one-point scenario gives fixed readings.
The bundled curve is synthetic test data, not a physical model or real calibration.
Angle and device SG can deliberately disagree to test source/calibration selection.
Battery 4.1 V, RSSI -55 and device ID 900001 are fixed synthetic fields. Sensor tokens
select the destination sensor in Fermentrack RS; name/ID do not create one.

Requests time out after 10 seconds; any HTTP/network error exits nonzero without
retries. No controller commands, profile assignments, or export calls are made by
this tool. The receiver can still run its own configured downstream processing.

Checks:

```sh
cargo test --locked
cargo build --locked
python3 verify.py
```

`verify.py` uses a temporary database and an isolated loopback Fermentrack RS process
with collection enabled and no physical controller or external export destination configured. It checks ingest, angle/SG/source,
history, unknown-token rejection, preview redaction and redirect/error handling.
It never reads production state or credentials. Build the parent Rust server first
(`cargo build --locked --manifest-path ../../rust/Cargo.toml`).

## Calibrate the emulated sensor

Use two independent files:

- `sensor-model.json`: the synthetic sensor's fixed SG-versus-angle relation.
  It produces the angle for the true liquid SG; leave it unchanged during calibration.
- `uncalibrated.json` or your fitted calibration: the sensor's configurable
  angle-to-reported-SG polynomial. Changing this affects reported SG only.

Both contain `{"coefficients": [d, c, b, a]}` for
`SG = d + c*angle + b*angle² + a*angle³`. Trailing terms are optional.
The sensor model must increase throughout 0..180 degrees. A calibration may use
linear, quadratic or cubic terms. SG is always specific gravity, not Plato.

Example calibration exercise, from this directory:

```sh
# A liquid with known SG 1.050, using a deliberately wrong calibration:
./run.sh --model sensor-model.json --calibration uncalibrated.json --gravity 1.050

# Fit your measured pairs of angle and known SG:
./run.sh --fit references.json --degree 2 --output calibrated.json

# Same liquid and same angle, now using the fitted calibration:
./run.sh --model sensor-model.json --calibration calibrated.json --gravity 1.050
```

`references.json` is a supplied synthetic example: a JSON array of
`{"angle": 40, "sg": 1.028}` pairs. To perform your own calibration, repeat the
first command at several known SG values, record the returned angle with the
**known** SG (not the incorrectly reported SG), and fit those pairs. Degree 1/2/3
requires at least 2/3/4 independent angles; more points allow least-squares fitting.
The fitter reports RMSE on the reference points, not independent accuracy.
`--output` replaces the named calibration file; omit it to print the coefficients.

In modeled mode `--gravity` and scenario `gravity` mean true liquid SG. The scenario's
angle is ignored; the independent sensor model computes it. Explicit `--angle`
is rejected in this mode. With neither model nor calibration supplied, independent angle/SG packet mode is used. Add `--url` and `--token-file` to send
modeled readings to the test sensor. Restart with the new calibration file to apply
it. Calibration files are not reloaded while running.

The Fermentrack RS calibration view can also use these angles and manual known SG
values as references. Its coefficient fields map as follows: constant_term=d,
first_degree_coefficient=c, second_degree_coefficient=b, third_degree_coefficient=a.
Copy those coefficients into the emulator calibration file to test the same formula
on the emulated device. There is no automatic firmware/config writeback from the app.
