import { isTilt } from "./tilt";
import { stepCondition } from "./profile-builder";
import { batchStatus, newestFirst } from "./workflow";
import { duration } from "./duration";
// SPDX-License-Identifier: GPL-3.0-only
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Refrigerator,
  Droplet,
  ChevronRight,
  Clock,
  Activity,
} from "lucide-react";
import { Modal } from "./dialogs";
import { type Entity } from "./api";
import {
  usePreferences,
  temperature,
  density,
  formatDate,
} from "./preferences";
import { activeTarget, operatingState, controllerEvent } from "./controller";
export function Tabs({
  items,
  value,
  onChange,
}: {
  items: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <nav className="view-tabs" aria-label="View sections">
      {items.map((s) => (
        <button
          type="button"
          className={value === s ? "active" : ""}
          key={s}
          aria-current={value === s ? "page" : undefined}
          onClick={() => onChange(s)}
        >
          {s}
        </button>
      ))}
    </nav>
  );
}
export function Metrics({
  entity,
  points,
  device,
}: {
  entity: Entity;
  points: any[];
  device?: Entity;
}) {
  const p = usePreferences(),
    last = points.at(-1),
    live = device?.data.last_values;
  const lastFor = (key: string) =>
    [...points].reverse().find((v) => typeof v.values?.[key] === "number");
  const historicalBeer = lastFor("beer_temp"),
    historicalTarget = lastFor("beer_set") || lastFor("fridge_set"),
    historicalGravity = lastFor("gravity");
  const values =
    entity.kind === "devices"
      ? entity.data.last_values
      : live || {
          ...last?.values,
          beer_temp: historicalBeer?.values.beer_temp,
          gravity: historicalGravity?.values.gravity,
        };
  const sourceUnit =
    (live || entity.kind === "devices"
      ? values?.temp_format
      : historicalBeer?.values.temp_format) ||
    entity.data.unit ||
    "C";
  const target = device
    ? activeTarget(device)
    : entity.kind === "devices"
      ? activeTarget(entity)
      : {
          value:
            historicalTarget?.values.beer_set ??
            historicalTarget?.values.fridge_set,
          unit: historicalTarget?.values.temp_format || entity.data.unit || "C",
        };
  const convert = (v: unknown) =>
    temperature(v, sourceUnit, p.unit)?.toFixed(1) ?? "—";
  const d = device || (entity.kind === "devices" ? entity : undefined),
    fresh =
      d?.data.collection_enabled &&
      Date.now() - Number(d.data.last_seen) < 120000 &&
      !d.data.last_error;
  const start = new Date(entity.data.created || points[0]?.time).getTime(),
    end = new Date(entity.data.finished_at || Date.now()).getTime();
  const gravity = density(
    values?.gravity ?? historicalGravity?.values.gravity,
    p.gravity_unit,
  );
  let cards = [
    [
      "Beer temperature",
      convert(values?.beer_temp ?? values?.temperature),
      `°${p.unit}`,
      fresh ? "Updated automatically" : "Last recorded value",
    ],
    [
      "Target temperature",
      temperature(target.value, target.unit, p.unit)?.toFixed(1) ?? "—",
      `°${p.unit}`,
      target.value == null ? "No target recorded" : "Last confirmed target",
    ],
    [
      entity.kind === "devices" ? "Chamber temperature" : "Specific gravity",
      entity.kind === "devices"
        ? convert(values?.fridge_temp)
        : (gravity?.toFixed(p.gravity_unit === "SG" ? 3 : 1) ?? "—"),
      entity.kind === "devices" ? `°${p.unit}` : p.gravity_unit,
      entity.kind === "devices"
        ? "Latest controller reading"
        : "Selected gravity source",
    ],
    [
      "Fermentation day",
      entity.data.status === "planned" || !Number.isFinite(start)
        ? "—"
        : String(Math.max(0, Math.floor((end - start) / 86400000))),
      "",
      entity.data.status === "completed"
        ? "Batch completed"
        : entity.kind === "devices"
          ? "Controller measurements"
          : "Days since the batch started",
    ],
  ];
  if (entity.kind === "batches" && entity.data.status !== "active")
    cards[3] = [
      "Batch status",
      entity.data.status ? batchStatus(entity) : "Unknown",
      "",
      entity.data.finished_at
        ? "Finished " + formatDate(entity.data.finished_at)
        : entity.data.status === "planned"
          ? "Not started"
          : "Imported history preserved",
    ];
  if (entity.kind === "devices")
    cards[3] = [
      "Operating state",
      fresh ? operatingState(entity).label : "Unknown",
      "",
      fresh ? "Reported by controller" : "No current operating state",
    ];
  if (entity.kind === "sensors") {
    const v = entity.data.last_values || last?.values || {};
    const sg = density(v.gravity, p.gravity_unit);
    cards = [
      [
        "Specific gravity",
        sg?.toFixed(p.gravity_unit === "SG" ? 3 : 1) ?? "—",
        p.gravity_unit,
        entity.data.gravity_source === "device"
          ? "Device formula"
          : "Server calibration",
      ],
      [
        "Tilt angle",
        typeof v.angle === "number" ? v.angle.toFixed(2) : "—",
        "°",
        "Raw sensor reading",
      ],
      [
        "Sensor temperature",
        temperature(
          v.gravity_temp ?? v.temperature,
          v.temp_format || entity.data.unit || "C",
          p.unit,
        )?.toFixed(1) ?? "—",
        `°${p.unit}`,
        "Latest sensor reading",
      ],
      [
        "Battery",
        typeof v.battery === "number" ? v.battery.toFixed(2) : "—",
        "V",
        "Reported by the sensor",
      ],
    ];
    if (isTilt(entity.data.sensor_type)) {
      cards[0] = [
        "Specific gravity",
        sg?.toFixed(p.gravity_unit === "SG" ? 4 : 1) ?? "—",
        p.gravity_unit,
        v.reading_source === "manual"
          ? "Manual measurement"
          : "Reported by Tilt sender",
      ];
      cards = [
        cards[0],
        cards[2],
        [
          "Tilt color",
          entity.data.tilt_color || "—",
          "",
          "Configured sensor identity",
        ],
        typeof v.weeks_on_battery === "number"
          ? [
              "Battery age",
              String(v.weeks_on_battery),
              "weeks",
              "Reported by TiltBridge",
            ]
          : [
              "Connection",
              entity.data.sensor_type === "tiltbridge"
                ? "TiltBridge"
                : "Tilt HTTP",
              "",
              "Experimental receiver",
            ],
      ];
    }
  }
  return (
    <div className="measurement-grid">
      {cards.map(([label, value, unit, sub]) => (
        <section className="measurement-card" key={label}>
          <span>{label}</span>
          <strong>
            {value}
            <small>{unit}</small>
          </strong>
          <p>{sub}</p>
        </section>
      ))}
      {entity.data.last_seen && (
        <p className="reading-age">
          Last received: {formatDate(entity.data.last_seen)}
          {entity.kind === "devices" && !fresh
            ? " · Last known readings; waiting for a fresh controller response"
            : ""}
        </p>
      )}
    </div>
  );
}
export function EquipmentCards({
  devices,
  sensors,
}: {
  devices: Entity[];
  sensors: Entity[];
}) {
  const p = usePreferences();
  return (
    <div className="equipment-workspace">
      <div className="equipment-list">
        {devices.map((d) => (
          <section className="card equipment-card" key={d.id}>
            <div className="equipment-card-title">
              <Refrigerator />
              <div>
                <Link to={"/devices/" + encodeURIComponent(d.id)}>
                  <h2>{d.name}</h2>
                </Link>
                <p>Temperature controller</p>
              </div>
              <span
                className={
                  "status " +
                  (!d.data.last_error &&
                  d.data.last_seen &&
                  Date.now() - d.data.last_seen < 120000
                    ? "online"
                    : "")
                }
              >
                {!d.data.last_error &&
                d.data.last_seen &&
                Date.now() - d.data.last_seen < 120000
                  ? "Connected"
                  : "Disconnected"}
              </span>
            </div>
            <div className="equipment-values">
              <span>
                <small>BEER</small>
                <strong>
                  {temperature(
                    d.data.last_values?.beer_temp,
                    d.data.unit || "C",
                    p.unit,
                  )?.toFixed(1) ?? "—"}{" "}
                  °{p.unit}
                </strong>
              </span>
              <span>
                <small>CHAMBER</small>
                <strong>
                  {temperature(
                    d.data.last_values?.fridge_temp,
                    d.data.unit || "C",
                    p.unit,
                  )?.toFixed(1) ?? "—"}{" "}
                  °{p.unit}
                </strong>
              </span>
            </div>
            <p className="muted">{operatingState(d).label}</p>
            <div className="equipment-actions">
              <Link
                className="button secondary"
                to={"/devices/" + encodeURIComponent(d.id)}
              >
                Open controller
              </Link>
              <Link
                className="button secondary"
                to={"/devices/" + encodeURIComponent(d.id) + "/pins"}
              >
                Temperature probes & outputs
              </Link>
            </div>
          </section>
        ))}
        {sensors.map((s) => (
          <section className="card equipment-card" key={s.id}>
            <div className="equipment-card-title">
              <Droplet />
              <div>
                <Link to={"/sensors/" + encodeURIComponent(s.id)}>
                  <h2>{s.name}</h2>
                </Link>
                <p>
                  {s.data.sensor_type === "ispindel"
                    ? "iSpindel"
                    : "Gravity sensor"}
                </p>
              </div>
            </div>
            <div className="equipment-values">
              <span>
                <small>SPECIFIC GRAVITY</small>
                <strong>
                  {typeof s.data.last_values?.gravity === "number"
                    ? s.data.last_values.gravity.toFixed(3)
                    : "—"}
                </strong>
              </span>
              <span>
                <small>ANGLE</small>
                <strong>
                  {typeof (
                    s.data.last_automatic?.values?.angle ??
                    s.data.last_values?.angle
                  ) === "number"
                    ? (
                        s.data.last_automatic?.values?.angle ??
                        s.data.last_values?.angle
                      ).toFixed(2)
                    : "—"}
                  °
                </strong>
              </span>
            </div>
            <p className="muted">
              {s.data.last_seen
                ? "Last reading " + formatDate(s.data.last_seen)
                : "Waiting for the first reading"}
            </p>
            <Link
              className="button secondary"
              to={"/sensors/" + encodeURIComponent(s.id) + "/calibration"}
            >
              Calibrate sensor
            </Link>
          </section>
        ))}
        {!devices.length && !sensors.length && (
          <section className="card">
            <h2>No equipment yet</h2>
            <p>
              Connect a BrewPi controller, register an iSpindel, or record
              measurements manually.
            </p>
          </section>
        )}
      </div>
      <aside>
        <section className="card">
          <h2>Connection health</h2>
          <p>
            <Activity size={16} /> {devices.length} controllers ·{" "}
            {sensors.length} sensors
          </p>
          <p className="muted">
            Connection state is based on the latest response. Disconnected
            controllers may continue their own control cycle.
          </p>
          <Link to="/diagnostics">
            View diagnostics <ChevronRight size={16} />
          </Link>
        </section>
        <section className="card">
          <h2>Your measurement settings</h2>
          <p>
            Configure pin assignments with each controller. Gravity formulas and
            source selection live with the sensor.
          </p>
        </section>
      </aside>
    </div>
  );
}
export function ToolPanel({
  title,
  summary,
  action,
  children,
}: {
  title: string;
  summary: ReactNode;
  action: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <section className="card">
        <h2>{title}</h2>
        {summary}
        <button className="secondary" onClick={() => setOpen(true)}>
          {action}
        </button>
      </section>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)}>
          {children}
        </Modal>
      )}
    </>
  );
}
export function WorkspaceLinks() {
  return (
    <aside className="card workspace-links">
      <h2>Workspace</h2>
      {[
        [
          "/profiles",
          "Fermentation profiles",
          "Reusable temperature schedules",
        ],
        [
          "/sensors",
          "Gravity sensors & readings",
          "Manual measurements and iSpindel",
        ],
        ["/integrations", "Integrations", "External logging destinations"],
        ["/import", "Import data", "Bring your existing history"],
        ["/backup", "Backup & restore", "Keep a recoverable copy"],
        ["/diagnostics", "Diagnostics", "Service and device health"],
        ["/firmware", "Firmware tools", "Final project phase"],
      ].map(([to, title, sub]) => (
        <Link to={to} key={to}>
          <div>
            <strong>{title}</strong>
            <small>{sub}</small>
          </div>
          <ChevronRight size={18} />
        </Link>
      ))}
    </aside>
  );
}
export function ActivityList({
  notes,
  onAdd,
  all = false,
}: {
  notes: Entity[];
  onAdd: () => void;
  all?: boolean;
}) {
  usePreferences();
  return (
    <section className="card activity-card">
      <div className="section-title">
        <h2>{all ? "Notes" : "Activity"}</h2>
        <button className="secondary" onClick={onAdd}>
          Add note
        </button>
      </div>
      {notes.length ? (
        (all ? newestFirst(notes) : newestFirst(notes).slice(0, 4)).map((n) => (
          <article className="activity-item" key={n.id}>
            <Clock size={18} />
            <div>
              <Link to={"/notes/" + encodeURIComponent(n.id)}>
                <strong>{controllerEvent(n.name)}</strong>
              </Link>
              {n.data.text !== n.name && (
                <p>{controllerEvent(n.data.text || "")}</p>
              )}
              <small>{formatDate(n.data.created)}</small>
            </div>
          </article>
        ))
      ) : (
        <p className="muted">
          No notes yet. Record observations to keep the context with your
          measurements.
        </p>
      )}
    </section>
  );
}
export function ProfileSummary({
  steps,
  unit,
  started,
  run,
}: {
  run?: any;
  steps: any[];
  unit: string;
  started?: number;
}) {
  return (
    <ol className="schedule-summary">
      {steps.map((s, i) => (
        <li key={i}>
          <span className="step-number">{i + 1}</span>
          <div>
            <strong>{s.name || `Step ${i + 1}`}</strong>
            <small>
              {s.transition === "ramp" ? "Ramp" : "Hold"} at {s.temperature} °
              {unit} · {stepCondition(s)}
            </small>
          </div>
          {started !== undefined && (
            <small>
              {Date.now() < started
                ? "Upcoming"
                : run
                  ? run.complete || i < run.step
                    ? "Complete"
                    : i === run.step
                      ? "Current"
                      : "Upcoming"
                  : steps.some((s) => s.until)
                    ? "Waiting"
                    : (Date.now() - started) / 3600000 >=
                        steps.slice(0, i + 1).reduce((a, v) => a + v.hours, 0)
                      ? "Complete"
                      : (Date.now() - started) / 3600000 >=
                          steps.slice(0, i).reduce((a, v) => a + v.hours, 0)
                        ? "Current · " +
                          duration(
                            Math.max(
                              0,
                              steps
                                .slice(0, i + 1)
                                .reduce((a, v) => a + v.hours, 0) -
                                (Date.now() - started) / 3600000,
                            ),
                          ) +
                          " left"
                        : "Upcoming"}
            </small>
          )}
        </li>
      ))}
    </ol>
  );
}
export function MeasurementHistory({ points }: { points: any[] }) {
  const [limit, setLimit] = useState(25),
    p = usePreferences();
  function download() {
    const rows = [
      [
        "Time",
        "Source",
        "Gravity SG",
        "Server SG",
        "Device gravity",
        "Device units",
        "Angle",
        "Temperature",
        "Temperature unit",
      ],
      ...points.map((v) => [
        new Date(v.time).toISOString(),
        v.values.reading_source,
        v.values.gravity,
        v.values.server_gravity,
        v.values.ispindel_gravity,
        v.values.ispindel_gravity_unit,
        v.values.angle,
        v.values.gravity_temp ?? v.values.beer_temp,
        v.values.temp_format,
      ]),
    ];
    const csv = rows
      .map((row) =>
        row
          .map((v) => '"' + String(v ?? "").replaceAll('"', '""') + '"')
          .join(","),
      )
      .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "fermentation-readings.csv";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="card measurement-history">
      <div className="section-title">
        <h2>Measurement history</h2>
        <button className="secondary" onClick={download}>
          Export loaded readings
        </button>
      </div>
      <p className="muted">
        Displayed history · {points.length} samples. Large automatic series may
        be sampled. Manual calibration references remain available with the
        sensor.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Source</th>
              <th>Gravity ({p.gravity_unit})</th>
              <th>Server SG</th>
              <th>Device gravity</th>
              <th>Angle</th>
              <th>Temperature</th>
            </tr>
          </thead>
          <tbody>
            {points
              .slice(-limit)
              .reverse()
              .map((v, i) => (
                <tr key={v.time + ":" + (v.sequence ?? i)}>
                  <td>{formatDate(v.time, p)}</td>
                  <td>
                    {v.values.reading_source === "manual"
                      ? "Manual"
                      : v.values.gravity_source === "device"
                        ? "Device formula"
                        : v.values.gravity_source === "server"
                          ? "Server formula"
                          : "Automatic"}
                  </td>
                  <td>
                    {typeof v.values.gravity === "number"
                      ? density(v.values.gravity, p.gravity_unit)?.toFixed(
                          p.gravity_unit === "SG" ? 3 : 1,
                        )
                      : "—"}
                  </td>
                  <td>
                    {typeof v.values.server_gravity === "number"
                      ? v.values.server_gravity.toFixed(3)
                      : "—"}
                  </td>
                  <td>
                    {typeof v.values.ispindel_gravity === "number"
                      ? v.values.ispindel_gravity.toFixed(3) +
                        " " +
                        (v.values.ispindel_gravity_unit || "")
                      : "—"}
                  </td>
                  <td>
                    {typeof v.values.angle === "number"
                      ? v.values.angle.toFixed(2) + "°"
                      : "—"}
                  </td>
                  <td>
                    {temperature(
                      v.values.gravity_temp ??
                        v.values.temperature ??
                        v.values.beer_temp,
                      v.values.temp_format || "C",
                      p.unit,
                    )?.toFixed(1) ?? "—"}{" "}
                    °{p.unit}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {limit < points.length && (
        <button className="secondary" onClick={() => setLimit(limit + 50)}>
          Show more measurements
        </button>
      )}
    </section>
  );
}
export function CalibrationCurve({ fit }: { fit: any }) {
  const span = Math.max(0.001, fit.angle_max - fit.angle_min),
    sgSpan = Math.max(0.001, fit.sg_max - fit.sg_min),
    lo = fit.sg_min - sgSpan * 0.1,
    hi = fit.sg_max + sgSpan * 0.1;
  const xy = (a: number, g: number) => [
    50 + ((a - fit.angle_min) / span) * 480,
    22 + ((hi - g) / (hi - lo)) * 170,
  ];
  const values = Array.from({ length: 61 }, (_, i) => {
    const angle = fit.angle_min + (span * i) / 60;
    const v = fit.coefficients.reduce(
      (s: number, c: number, j: number) => s + c * angle ** j,
      0,
    );
    return xy(angle, v).join(",");
  });
  return (
    <div className="fit-chart">
      <h3>Fit against reference measurements</h3>
      <svg
        viewBox="0 0 560 240"
        role="img"
        aria-label="Calibration curve against measured references"
      >
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <line
              x1="50"
              x2="530"
              y1={22 + (i * 170) / 3}
              y2={22 + (i * 170) / 3}
              stroke="#e4e5df"
            />
            <text x="2" y={27 + (i * 170) / 3}>
              {(hi - (i * (hi - lo)) / 3).toFixed(3)}
            </text>
          </g>
        ))}
        <polyline
          points={values.join(" ")}
          fill="none"
          stroke="#a65331"
          strokeWidth="2"
        />
        {fit.residuals.map((r: any) => (
          <circle
            key={r.id}
            cx={xy(r.angle, r.reference)[0]}
            cy={xy(r.angle, r.reference)[1]}
            r="4"
            fill="#286b9b"
          />
        ))}
        <text x="50" y="218">
          {fit.angle_min.toFixed(1)}°
        </text>
        <text x="480" y="218">
          {fit.angle_max.toFixed(1)}°
        </text>
      </svg>
      <p className="muted">
        Copper: candidate server formula · Blue points: measured references
      </p>
    </div>
  );
}
