# Experimental Tilt HTTP receivers

**Protocol tested, physical hardware unverified.** No Bluetooth adapter is needed
by RS for these receivers. The sender still needs access to a real Tilt over BLE.
Only logging, charts, batch history and manual reference readings are supported;
automatic Tilt-based profile conditions, Tilt calibration inside RS, direct BLE,
firmware flashing and the TiltBridge 2 Fermentrack target are not implemented.

## Tilt app, Tilt Pi and Tilt Pico: custom Cloud URL

1. Start RS normally; collection is available by default. See [installation](INSTALLATION.md) if you use maintenance mode.
2. Open Equipment → Gravity sensors → Add. Choose **Tilt app / Tilt Pi · Experimental**.
3. Name the sensor, select its color and the temperature unit for display in RS.
4. Optionally enter its MAC address. If set, enable Identify by MAC on the sender;
   a color-only packet will then be rejected. Without a MAC filter, do not send
   two different physical Tilts of the same color to this receiving URL.
5. Set the **sender's** UTC offset in minutes (UTC+1 = 60, UTC−5 = −300). The
   browser's current offset is suggested, but the sender may be somewhere else.
   Update the setting when the sender changes daylight saving time.
6. Connect equipment. Copy the secret receiving URL into the sender's **custom
   Cloud URL** setting. Wait for “First reading received”; RS polls automatically.
7. Open the sensor to check its SG, temperature and history; link it to a batch
   when you want its measurements included in that batch's history.

The endpoint is POST `/ingest/tilt/{token}` with
`Content-Type: application/x-www-form-urlencoded`. Required fields are `Timepoint`,
`Temp`, `SG` and `Color`. `Beer`, `Comment` and other sender metadata are ignored;
they never create or rename batches and are not retained. Temperature is always
Fahrenheit and gravity is always SG, regardless of sender display settings.
Standard and Pro precision are preserved, including four-decimal gravity.

Timepoint is the sender's local Excel/Sheets serial date. RS applies the configured
UTC offset for validation, rejects readings older than two hours or more than five
minutes in the future, and retains the source timestamp alongside receipt time.
Charts use receipt time; this endpoint is not a historical import API. A persisted
UTC watermark acknowledges duplicate/out-of-order readings without adding points
or refreshing sensor freshness. Valid replies are `{"result":"success"}`.

## TiltBridge: legacy Local Target JSON

Choose **TiltBridge legacy HTTP · Experimental**, select a color and enter the
bridge's exact configured mDNS ID. Copy the secret receiving URL into the bridge's
**Local Target URL** setting. Select a compatible legacy JSON sender, not the
Fermentrack 2 target. No discovery or automatic bridge reconfiguration is performed.

The endpoint is POST `/ingest/tiltbridge/{token}` with `application/json`. The
supported envelope is `mdns_id` and a `tilts` object keyed by color, containing
`color`, `temp`, `tempUnit` and `gravity`. Temperature accepts explicit C/F;
measurements may be numeric strings or numbers. Already converted SG is used as
sent. RS does not apply an additional Tilt calibration or temperature correction.
The pinned Local Target sender requests raw gravity from its serializer.

**Current limitation: one selected color per receiving URL.** Other colors in a
bridge packet are ignored. A bridge with only one Local Target URL can therefore
feed one RS sensor through this integration. Multiple-color fan-out is not yet
implemented. Color and mDNS ID must match; this legacy format has no per-Tilt MAC.

There is no measurement timestamp or unique packet ID in this format. RS uses
receipt time and suppresses identical selected readings retried within ten seconds,
including after restart. Identical readings after that window are valid observations.
RS cannot distinguish a stale cached sensor sample from a newly sampled unchanged
value. This is one reason this initial integration is logging-only. Battery weeks
are kept as weeks and are never presented as voltage.

## Credentials and operational behavior

Each receiving URL carries a randomly generated secret scoped to that sensor and
protocol. Only its hash is stored. Use HTTPS when crossing untrusted networks and
redact/exclude these paths from proxy access logs. Do not publish receiving URLs.
The sender must reach the ingest endpoint without an interactive authentication
redirect; do not bypass authentication for the whole application.

The Connection tab can generate a replacement URL; the previous URL immediately
stops working. Global collection and sensor collection must both be enabled.
Rejected packets do not change the last successful measurement. Disabling collection
preserves history. Backup restore leaves restored sensors disabled until reconnected.
Disabled imported legacy Tilt records can be retained without connection settings;
complete the HTTP setup before enabling collection.

## Protocol evidence and tests

Reference sources inspected on 2026-11-17:

- [Manufacturer cloud logging API](https://tilthydrometer.com/pages/tilt-cloud-logging-api):
  required form fields, units, local serial timestamp, optional color/MAC suffix,
  precision and success response. The literal example form is retained as a test
  fixture, not claimed to be a captured physical packet.
- TiltBridge revision `7a5d7e8e017ccb500fa38fad500d7ffc66c4621e`:
  [sendData.cpp](https://github.com/thorrak/tiltbridge/blob/7a5d7e8e017ccb500fa38fad500d7ffc66c4621e/src/sendData.cpp)
  and [tiltHydrometer.cpp](https://github.com/thorrak/tiltbridge/blob/7a5d7e8e017ccb500fa38fad500d7ffc66c4621e/src/tilt/tiltHydrometer.cpp)
  define the Local Target envelope and sensor serialization. Bridge fixtures are
  synthetic measurements following that code, not radio captures. No upstream
  implementation code was copied into the receiver.

Rust tests independently check the manufacturer's example and upstream bridge
shape, conversions, precision, identity, clock windows and malformed values.
The standalone Python emulator sends real HTTP requests to a disposable local-auth
RS process. Acceptance checks token isolation/rotation, content types, payload size,
replay across restart, source freshness, manual measurements, batch history and
rejection of automatic Tilt profile conditions. Browser tests cover setup and
connection tools on desktop and mobile. See tools/tilt-emulator/README.md.

Actual sender compatibility, firmware-specific differences, Wi-Fi/BLE behavior and
physical standard/Pro hardware remain unverified. Please report sender software and
version, Tilt model, observed units and a redacted packet when testing hardware.
