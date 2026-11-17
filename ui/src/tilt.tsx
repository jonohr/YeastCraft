// SPDX-License-Identifier: GPL-3.0-only
import { useState } from "react";
import { api, type Entity } from "./api";
import { confirmAction } from "./dialogs";
export const isTilt = (type: string) =>
  type === "tilt" || type === "tiltbridge";
export function TiltNotice() {
  return (
    <p className="alert">
      Experimental — protocol tested, physical hardware unverified. HTTP logging
      only; direct Bluetooth and automatic Tilt-based temperature control are
      not supported.
    </p>
  );
}
export function TiltFields({
  type,
  data,
  set,
}: {
  type: string;
  data: Record<string, any>;
  set: (key: string, value: any) => void;
}) {
  return (
    <>
      <TiltNotice />
      <label>
        Tilt color
        <select
          value={data.tilt_color || ""}
          onChange={(e) => set("tilt_color", e.target.value)}
          required
        >
          <option value="">Choose a color</option>
          {[
            "RED",
            "GREEN",
            "BLACK",
            "PURPLE",
            "ORANGE",
            "BLUE",
            "YELLOW",
            "PINK",
          ].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      {type === "tilt" ? (
        <>
          <label>
            Tilt MAC address (optional)
            <input
              placeholder="aa:bb:cc:dd:ee:ff"
              value={data.tilt_mac || ""}
              onChange={(e) => set("tilt_mac", e.target.value.trim())}
            />
          </label>
          <p className="muted">
            Use the app’s Identify by MAC setting if more than one Tilt has the
            same color.
          </p>
          <label>
            Sender UTC offset (minutes)
            <input
              type="number"
              min="-720"
              max="840"
              step="1"
              value={data.tilt_utc_offset_minutes ?? 0}
              onChange={(e) =>
                set("tilt_utc_offset_minutes", Number(e.target.value))
              }
            />
          </label>
          <p className="muted">
            The sender’s local clock is used to reject old readings. UTC+1 = 60;
            UTC−5 = −300. Update this when the sender changes daylight saving
            time.
          </p>
        </>
      ) : (
        <>
          <label>
            TiltBridge mDNS ID
            <input
              value={data.tilt_bridge_id || ""}
              onChange={(e) => set("tilt_bridge_id", e.target.value.trim())}
              placeholder="tiltbridge"
            />
          </label>
          <p className="muted">
            Use the legacy Local Target JSON setting. One selected Tilt color is
            recorded per receiving URL; other colors are ignored. The
            Fermentrack 2 target is not supported.
          </p>
        </>
      )}
    </>
  );
}
export function TiltConnection({
  sensor,
  initialEndpoint = "",
  refresh,
}: {
  sensor: Entity;
  initialEndpoint?: string;
  refresh: () => void;
}) {
  const [endpoint, setEndpoint] = useState(initialEndpoint),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const bridge = sensor.data.sensor_type === "tiltbridge";
  return (
    <section className="card">
      <h2>{bridge ? "Connect TiltBridge" : "Connect Tilt app / Tilt Pi"}</h2>
      <TiltNotice />
      <p>
        {bridge
          ? "Paste the receiving URL into TiltBridge’s Local Target URL setting. It must send the legacy mdns_id / tilts JSON format."
          : "Paste the receiving URL into the Tilt app, Tilt Pi or Tilt Pico custom Cloud URL setting. The sender must post form data with Timepoint, Temp, SG and Color."}
      </p>
      <p>
        Selected color: <strong>{sensor.data.tilt_color}</strong>
        {bridge && (
          <>
            {" "}
            · Bridge ID: <strong>{sensor.data.tilt_bridge_id}</strong>
          </>
        )}
      </p>
      <p>
        The URL includes a secret receiving token. Copy it now and keep it
        private. It authorizes sensor readings only, not access to your account.
      </p>
      {endpoint && (
        <label>
          Receiving URL
          <input
            readOnly
            value={window.location.origin + endpoint}
            onFocus={(e) => e.target.select()}
          />
        </label>
      )}
      {!endpoint && sensor.data.ingest_hash && (
        <p>
          Your existing receiving URL remains valid. Generate a replacement only
          if you need a new one.
        </p>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      <button
        className="secondary"
        disabled={busy}
        onClick={async () => {
          if (
            (sensor.data.ingest_hash || endpoint) &&
            !(await confirmAction(
              "Replace the receiving URL? The previous URL will stop working.",
            ))
          )
            return;
          setBusy(true);
          setError("");
          try {
            const key = await api(
              `/sensors/${encodeURIComponent(sensor.id)}/key`,
              "POST",
              {},
            );
            setEndpoint(key.path);
            refresh();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Generating…" : "Generate receiving URL"}
      </button>
      <details>
        <summary>Connection troubleshooting</summary>
        <p>
          Enable collection on the server and sensor. The sender must be able to
          reach this address without interactive login. Match the color
          {bridge
            ? " and mDNS ID"
            : ", optional MAC address and sender UTC offset"}
          . Keep token-bearing URLs out of proxy access logs. HTTP packets must
          not be redirected to a sign-in page.
        </p>
      </details>
    </section>
  );
}
