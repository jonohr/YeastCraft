// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, save, type Entity } from "./api";
import { Modal } from "./dialogs";
import { isTilt, TiltFields, TiltConnection } from "./tilt";
import { formatDate } from "./preferences";
export default function EquipmentSetup({
  kind,
  initial,
  close,
  saved,
}: {
  kind: string;
  initial?: Entity;
  close: () => void;
  saved: () => void;
}) {
  const [name, setName] = useState(initial?.name || ""),
    [type, setType] = useState(
      initial?.data.connection_type ||
        initial?.data.sensor_type ||
        (kind === "devices" ? "wifi" : "ispindel"),
    ),
    [host, setHost] = useState(initial?.data.host || ""),
    [port, setPort] = useState(String(initial?.data.port || 23)),
    [serial, setSerial] = useState(initial?.data.serial_port || ""),
    [unit, setUnit] = useState(initial?.data.unit || "C"),
    [sgUnit, setSgUnit] = useState(
      initial?.data.reported_gravity_unit || "unknown",
    ),
    [diag, setDiag] = useState<any>(null),
    [entity, setEntity] = useState<Entity | null>(null),
    [token, setToken] = useState(""),
    [endpoint, setEndpoint] = useState(""),
    [tiltConfig, setTiltConfig] = useState<Record<string, any>>({
      tilt_color: initial?.data.tilt_color || "",
      tilt_mac: initial?.data.tilt_mac || "",
      tilt_bridge_id: initial?.data.tilt_bridge_id || "",
      tilt_utc_offset_minutes:
        initial?.data.tilt_utc_offset_minutes ??
        -new Date().getTimezoneOffset(),
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const record = useRef<Entity | null>(null);
  const started = useRef(Date.now());
  const controller = kind === "devices",
    manual = type === "manual";
  useEffect(() => {
    api("/diagnostics")
      .then(setDiag)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!entity) return;
    let alive = true;
    const poll = async () => {
      try {
        const next = await api<Entity>(
          `/resources/${kind}/${encodeURIComponent(entity.id)}`,
        );
        if (alive) setEntity(next);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    const timer = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [entity?.id, kind]);
  const connected =
    entity && (manual || Number(entity.data.last_seen) >= started.current);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      if (!name.trim()) throw Error("Enter an equipment name.");
      if (
        controller &&
        type === "wifi" &&
        (!host.trim() ||
          !Number.isInteger(Number(port)) ||
          +port < 1 ||
          +port > 65535)
      )
        throw Error("Enter an address and a TCP port from 1 to 65535.");
      if (controller && type === "serial" && !serial.trim())
        throw Error("Enter a serial port.");
      if (!manual && !diag?.collection_enabled)
        throw Error(
          "Collection is disabled on this server. An administrator must enable it before connecting equipment.",
        );
      if (isTilt(type) && !tiltConfig.tilt_color)
        throw Error("Choose a Tilt color.");
      if (type === "tiltbridge" && !tiltConfig.tilt_bridge_id)
        throw Error("Enter the TiltBridge mDNS ID.");
      const data = controller
        ? {
            connection_type: type,
            host: host.trim(),
            port: Number(port),
            serial_port: serial.trim(),
            unit,
            collection_enabled: true,
            control_claimed:
              !!diag?.control_enabled &&
              (!initial?.data.profile ||
                initial?.data.control_claimed === true),
          }
        : {
            ...(isTilt(type)
              ? {
                  ...tiltConfig,
                  tilt_mac: type === "tiltbridge" ? "" : tiltConfig.tilt_mac,
                }
              : {}),
            sensor_type: type,
            unit,
            collection_enabled: !manual,
            gravity_source: isTilt(type)
              ? "device"
              : initial?.data.gravity_source ||
                (sgUnit === "unknown" ? "server" : "device"),
            reported_gravity_unit: isTilt(type) ? "SG" : sgUnit,
          };
      const latest = initial
        ? await api<Entity>(
            `/resources/${kind}/${encodeURIComponent(initial.id)}`,
          )
        : null;
      const e =
        record.current ||
        (await save(kind, name, { ...latest?.data, ...data }, initial?.id));
      record.current = e;
      // Retain the created ID if token generation fails, so retry cannot duplicate equipment.
      if (!controller && !manual && !token && !initial?.data.ingest_hash) {
        const key = await api(
          `/sensors/${encodeURIComponent(e.id)}/key`,
          "POST",
          {},
        );
        setToken(key.token);
        setEndpoint(key.path || "");
      }
      setEntity(e);
      saved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        controller
          ? "Connect a temperature controller"
          : "Connect a gravity sensor"
      }
      onClose={() => {
        if (!busy) close();
      }}
    >
      {!entity && (
        <p>
          {controller
            ? "The temperature controller operates your cooling and heating. Saving connects it for readings; it does not send a new target."
            : "Connect an iSpindel or experimental Tilt HTTP receiver, or create a sensor for manual readings."}
        </p>
      )}
      {initial?.data.profile && !initial.data.control_claimed && (
        <p className="alert">
          A previously assigned profile is suspended. Reconnecting restores
          readings only. Review the controller and deliberately choose a new
          target or profile before taking control.
        </p>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {!entity ? (
        <>
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!!record.current}
            />
          </label>
          <label>
            {controller ? "Connection method" : "Sensor type"}
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              disabled={!!record.current}
            >
              {controller ? (
                <>
                  <option value="wifi">Wi-Fi / TCP</option>
                  <option value="serial">USB / serial</option>
                </>
              ) : (
                <>
                  <option value="ispindel">iSpindel</option>
                  <option value="tilt">
                    Tilt app / Tilt Pi · Experimental
                  </option>
                  <option value="tiltbridge">
                    TiltBridge legacy HTTP · Experimental
                  </option>
                  <option value="manual">Manual measurements</option>
                </>
              )}
            </select>
          </label>
          {controller &&
            (type === "wifi" ? (
              <>
                <label>
                  Host / IP address
                  <input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                  />
                </label>
                <label>
                  TCP port
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <label>
                Serial port
                <input
                  placeholder="/dev/serial/by-id/…"
                  value={serial}
                  onChange={(e) => setSerial(e.target.value)}
                />
              </label>
            ))}
          <label>
            Temperature unit
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option>C</option>
              <option>F</option>
            </select>
          </label>
          {!controller && isTilt(type) && (
            <TiltFields
              type={type}
              data={tiltConfig}
              set={(k, v) => setTiltConfig((d) => ({ ...d, [k]: v }))}
            />
          )}
          {!controller && type === "ispindel" && (
            <label>
              Units used by your iSpindel formula
              <select
                value={sgUnit}
                onChange={(e) => setSgUnit(e.target.value)}
              >
                <option value="unknown">
                  Not sure · calibrate in Fermentrack RS
                </option>
                <option value="SG">SG</option>
                <option value="Plato">°Plato</option>
              </select>
            </label>
          )}

          {!manual && diag && !diag.collection_enabled && (
            <p className="alert">
              Collection is disabled on this server. Ask the administrator to
              enable collection; this page cannot change server startup options.
            </p>
          )}
          <div className="form-actions">
            <button className="secondary" disabled={busy} onClick={close}>
              Cancel
            </button>
            <button
              disabled={
                busy ||
                !diag ||
                !name.trim() ||
                (!manual && !diag.collection_enabled)
              }
              onClick={connect}
            >
              {busy
                ? "Connecting…"
                : manual
                  ? "Create manual sensor"
                  : "Connect equipment"}
            </button>
          </div>
        </>
      ) : (
        <>
          <h3>
            {connected
              ? manual
                ? "Ready for manual measurements"
                : "First reading received"
              : "Waiting for the first reading"}
          </h3>
          {entity.data.last_error && (
            <p className="alert error">{entity.data.last_error}</p>
          )}
          {entity.data.last_seen && (
            <p>Last reading: {formatDate(entity.data.last_seen)}</p>
          )}
          {!controller && isTilt(type) && (
            <TiltConnection
              sensor={entity}
              initialEndpoint={endpoint}
              refresh={saved}
            />
          )}
          {!controller && type === "ispindel" && (
            <>
              <p>
                Enter this endpoint and token in your iSpindel’s HTTP
                configuration. Copy the token now; it is shown only here.
              </p>
              <label>
                Receiving endpoint
                <input
                  readOnly
                  value={window.location.origin + "/iSpindel"}
                  onFocus={(e) => e.target.select()}
                />
              </label>
              {token ? (
                <label>
                  Receiving token
                  <input
                    readOnly
                    value={token}
                    onFocus={(e) => e.target.select()}
                  />
                </label>
              ) : (
                <p>
                  Your previously configured receiving token remains valid. Keep
                  using it in the physical sensor.
                </p>
              )}
              <details>
                <summary>Connection troubleshooting</summary>
                <p>
                  If the address opens an interactive sign-in page, use a
                  reachable direct ingest address supplied by your
                  administrator. Check power, network, destination, token and
                  sending interval.
                </p>
              </details>
              <p>
                {connected
                  ? sgUnit === "unknown"
                    ? "Packet received. Calibrate to turn the received angle into SG."
                    : "Packet received. Check its SG against a known sample."
                  : "Waiting for a packet. This page checks automatically every three seconds."}
              </p>
            </>
          )}
          {controller && (
            <p>
              {connected
                ? "The controller is sending readings. Review temperature probes and outputs before changing a target."
                : "Check the address/port, power and network. Only one application may use the controller connection."}
            </p>
          )}
          {controller && !diag?.control_enabled && (
            <p className="alert">
              Readings can be collected, but temperature control is disabled on
              this server.
            </p>
          )}
          <div className="form-actions">
            <button className="secondary" onClick={close}>
              Close setup
            </button>
            <Link
              className="button"
              to={`/${kind}/${encodeURIComponent(entity.id)}`}
              onClick={close}
            >
              {controller
                ? "Open temperature controller"
                : "Open gravity sensor"}
            </Link>
            {!controller && type === "ispindel" && connected && (
              <Link
                className="button secondary"
                to={`/sensors/${encodeURIComponent(entity.id)}/calibration`}
                onClick={close}
              >
                Calibrate sensor
              </Link>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
