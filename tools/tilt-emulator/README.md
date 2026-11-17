# Tilt HTTP emulator

Python 3 standard library only. Generates synthetic cloud form or legacy TiltBridge
JSON packets; it does not emulate BLE. Protocol references and limitations are in
[docs/TILT.md](../../docs/TILT.md). Fixtures come from the manufacturer's documented
example and a synthetic packet matching pinned upstream serialization, not hardware.

Dry run (prints a synthetic packet, sends nothing):

```sh
python3 tools/tilt-emulator/emulator.py --protocol cloud --color PINK --gravity 1.050
python3 tools/tilt-emulator/emulator.py --protocol bridge --bridge-id test-bridge
```

For an isolated test installation, create a separate experimental Tilt sensor in
the app and save its receiving URL in an owner-only file outside this repository.
Match its color, optional MAC, bridge ID or UTC offset as appropriate:

```sh
python3 tools/tilt-emulator/emulator.py --protocol cloud \
  --url-file /path/to/private-receiving-url --utc-offset 60 --count 3 --interval 30
```

`--temperature` is Celsius; cloud packets convert it to Fahrenheit. SG is sent
without integer scaling. URL files and destination URLs are never printed. Redirects
are rejected. Do not use a production sensor URL for synthetic measurements.

Run isolated full acceptance, after building the server and UI:

```sh
python3 tools/tilt-emulator/verify.py
```

This creates a temporary database/account and random loopback listener, runs real
HTTP requests and the CLI emulator, restarts the server and removes the temporary
state afterward. It does not connect to hardware or use production credentials.
