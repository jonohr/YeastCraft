// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, list, type Entity } from "./api";
import { formatDate } from "./preferences";
export default function Troubleshooting() {
  const [devices, setDevices] = useState<Entity[]>([]),
    [sensors, setSensors] = useState<Entity[]>([]),
    [diag, setDiag] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const [d, s, v] = await Promise.all([
          list("devices"),
          list("sensors"),
          api("/diagnostics"),
        ]);
        if (alive) {
          setDevices(d);
          setSensors(s);
          setDiag(v);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void read();
    const t = setInterval(read, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return (
    <div className="workflow-health">
      {error && <p role="alert">{error}</p>}
      <section className="card">
        <h2>No new readings?</h2>
        <p>
          Check power, network and the last received packet before changing
          measurement settings.
        </p>
        {diag && !diag.collection_enabled && (
          <p className="alert">
            Collection is disabled on this server. Ask the administrator to
            enable it.
          </p>
        )}
        {[...devices, ...sensors].map((e) => (
          <article key={e.id}>
            <h3>{e.name}</h3>
            <p>
              {e.data.last_seen
                ? "Last received: " + formatDate(e.data.last_seen)
                : "No readings received yet"}{" "}
              ·{" "}
              {e.data.collection_enabled
                ? "Collection enabled"
                : "Collection disabled"}
            </p>
            {e.data.last_error && (
              <p className="alert error">{e.data.last_error}</p>
            )}
            <Link
              className="button secondary"
              to={`/${e.kind}/${encodeURIComponent(e.id)}/connect`}
            >
              Review connection
            </Link>
          </article>
        ))}
        {!devices.length && !sensors.length && (
          <Link to="/devices">Connect your first equipment</Link>
        )}
      </section>
      <section className="card">
        <h2>Gravity is missing or looks wrong?</h2>
        <p>
          First check that a packet contains an angle. Then check whether the
          selected source is the device formula or a calibration in Fermentrack RS.
        </p>
        {sensors.map((s) => (
          <article key={s.id}>
            <h3>{s.name}</h3>
            <p>
              Selected source:{" "}
              {s.data.sensor_type === "manual"
                ? "Manual readings"
                : s.data.gravity_source === "device"
                  ? "iSpindel device formula"
                  : "Fermentrack RS calibration"}
              .{" "}
              {s.data.last_values?.gravity_status &&
              s.data.last_values.gravity_status !== "ok"
                ? "A valid SG value is not available for this source."
                : ""}
            </p>
            <Link
              className="button secondary"
              to={`/sensors/${encodeURIComponent(s.id)}${s.data.sensor_type === "ispindel" ? "/calibration" : ""}`}
            >
              {s.data.sensor_type === "ispindel"
                ? "Check calibration & source"
                : "Add a manual reading"}
            </Link>
          </article>
        ))}
      </section>
      <section className="card">
        <h2>Temperature is not changing?</h2>
        <p>
          The controller operates cooling and heating; Fermentrack RS sends the
          target. Check the confirmed target, output state, probe roles and
          whether a profile is still running.
        </p>
        {diag && !diag.control_enabled && (
          <p className="alert">
            Temperature control is disabled on this server.
          </p>
        )}
        {devices.map((d) => (
          <article key={d.id}>
            <h3>{d.name}</h3>
            <p>
              {d.data.profile
                ? "A profile is assigned."
                : "No profile is assigned."}{" "}
              {d.data.control_claimed
                ? "This app has controller ownership."
                : "Controller ownership has not been confirmed."}
            </p>
            <Link
              className="button secondary"
              to={`/devices/${encodeURIComponent(d.id)}`}
            >
              Review temperature control
            </Link>
            <Link
              className="button secondary"
              to={`/devices/${encodeURIComponent(d.id)}/pins`}
            >
              Review probes & outputs
            </Link>
          </article>
        ))}
      </section>
    </div>
  );
}
