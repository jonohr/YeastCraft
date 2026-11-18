import { isTilt, TiltConnection } from "./tilt";
import { CalibrationCurve } from "./workspace-ui";
import { confirmAction } from "./dialogs";
// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useState } from "react";
import { api, type Entity } from "./api";
import { formatDate, usePreferences } from "./preferences";

const number = (n: unknown, digits = 4) =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "—";
const errorText = (e: unknown) => (e as Error).message;
function Alert({ error, message }: { error: string; message: string }) {
  return (
    <>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </>
  );
}
export default function SensorTools({
  sensor,
  refresh,
  focus,
}: {
  sensor: Entity;
  refresh: () => void;
  focus?: "reading" | "calibration" | "connection";
}) {
  usePreferences();
  const [tab, setTab] = useState(focus || "reading");
  const ispindel = sensor.data.sensor_type === "ispindel";
  const [token, setToken] = useState(""),
    [error, setError] = useState("");
  return (
    <>
      {!focus && (
        <nav className="view-tabs" aria-label="Sensor tools">
          {[
            ["reading", "Manual reading"],
            ["calibration", "Calibration & source"],
            ["connection", "Connection"],
          ]
            .filter(
              ([key]) =>
                ispindel ||
                key === "reading" ||
                (isTilt(sensor.data.sensor_type) && key === "connection"),
            )
            .map(([key, label]) => (
              <button
                key={key}
                className={tab === key ? "active" : ""}
                onClick={() => setTab(key as typeof tab)}
              >
                {label}
              </button>
            ))}
        </nav>
      )}
      {tab === "reading" && <ManualReading sensor={sensor} refresh={refresh} />}
      {isTilt(sensor.data.sensor_type) && tab === "connection" && (
        <TiltConnection sensor={sensor} refresh={refresh} />
      )}
      {ispindel && (
        <>
          {tab === "calibration" && (
            <>
              <Calibration sensor={sensor} refresh={refresh} />
              <details className="card">
                <summary>Gravity source & advanced settings</summary>
                <DensitySource sensor={sensor} refresh={refresh} />
              </details>
            </>
          )}
          {tab === "connection" && (
            <section className="card">
              <h2>Connect iSpindel</h2>
              <p>
                The sensor uses <code>/iSpindel</code> and a receiving token.
                Collection and network access must be enabled separately.
              </p>
              <label>
                Server URL
                <input
                  readOnly
                  value={window.location.origin}
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <label>
                Receiving endpoint
                <input
                  readOnly
                  value={window.location.origin + "/iSpindel"}
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <Alert error={error} message="" />
              <button
                className="secondary"
                onClick={async () => {
                  if (
                    sensor.data.ingest_hash &&
                    !(await confirmAction(
                      "Replace the token? The previous token will stop working.",
                    ))
                  )
                    return;
                  setError("");
                  try {
                    const v = await api(
                      `/sensors/${encodeURIComponent(sensor.id)}/key`,
                      "POST",
                      {},
                    );
                    setToken(v.token);
                  } catch (e) {
                    setError(errorText(e));
                  }
                }}
              >
                Generate receiving token
              </button>
              {token && (
                <label>
                  Receiving token — copy now; shown only once
                  <input
                    readOnly
                    value={token}
                    onFocus={(e) => e.target.select()}
                  />
                </label>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}
function ManualReading({
  sensor,
  refresh,
  calibrationMode = false,
  saved,
}: {
  sensor: Entity;
  refresh: () => void;
  calibrationMode?: boolean;
  saved?: () => void;
}) {
  const [manualAngle, setManualAngle] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 10000);
    return () => clearInterval(timer);
  }, []);
  const [gravity, setGravity] = useState(""),
    [temperature, setTemperature] = useState(""),
    [angle, setAngle] = useState(""),
    [pairedAt, setPairedAt] = useState<number | null>(null),
    [reference, setReference] = useState(false),
    [estimated, setEstimated] = useState(false),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const ispindel = sensor.data.sensor_type === "ispindel";
  const automatic = sensor.data.last_automatic;
  const recent =
    typeof automatic?.values?.angle === "number" &&
    Date.now() - automatic.time >= 0 &&
    Date.now() - automatic.time <= 300000;
  const unit = sensor.data.unit || sensor.data.temp_format || "C";
  return (
    <section className="card">
      <h2>
        {calibrationMode ? "Add a calibration point" : "Manual gravity reading"}
      </h2>
      <p>
        {calibrationMode
          ? "Measure the liquid with a reference instrument, then enter its known SG. Let the iSpindel settle in the same sample."
          : "Record measured SG in the sensor history and its active gravity log."}
      </p>
      <Alert error={error} message={message} />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          setMessage("");
          try {
            if (calibrationMode && !manualAngle && !recent)
              throw Error(
                "Wait for a fresh angle, or enter the angle for this sample manually.",
              );
            await api(
              `/sensors/${encodeURIComponent(sensor.id)}/measurement`,
              "POST",
              {
                gravity: Number(gravity),
                gravity_temp: temperature === "" ? null : Number(temperature),
                temp_format: unit,
                note,
                temp_is_estimate: estimated,
                calibration_reference: calibrationMode || reference,
                angle:
                  calibrationMode && !manualAngle
                    ? automatic.values.angle
                    : ispindel && angle !== ""
                      ? Number(angle)
                      : null,
                angle_received_at:
                  calibrationMode && !manualAngle ? automatic.time : pairedAt,
              },
            );
            setGravity("");
            setTemperature("");
            setNote("");
            setAngle("");
            setPairedAt(null);
            setMessage(
              calibrationMode || reference
                ? "Calibration point saved."
                : "Manual reading saved.",
            );
            saved?.();
            refresh();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="sensor-fields">
          <label>
            Measured gravity SG
            <input
              required
              type="number"
              min="0.5"
              max="2"
              step="0.0001"
              value={gravity}
              onChange={(e) => setGravity(e.target.value)}
            />
          </label>
          {!calibrationMode && (
            <>
              {" "}
              <label>
                Sample temperature °{unit} (optional)
                <input
                  type="number"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                />
              </label>{" "}
            </>
          )}
        </div>
        {calibrationMode && (
          <p className="muted">
            Use temperature-corrected reference SG. Keep samples near the same
            temperature.
          </p>
        )}
        {!calibrationMode && (
          <>
            {" "}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={estimated}
                onChange={(e) => setEstimated(e.target.checked)}
              />
              Sample temperature is estimated
            </label>{" "}
          </>
        )}
        {ispindel && !calibrationMode && (
          <p className="muted">
            This records an observation, not a recalibration. A new automatic
            packet may become the displayed reading. Use Calibrate sensor for
            calibration points.
          </p>
        )}
        {ispindel && (
          <details open={calibrationMode || undefined}>
            <summary>
              {calibrationMode
                ? "Angle pairing"
                : "Advanced angle & reference options"}
            </summary>
            {calibrationMode && (
              <>
                <div className="calibration-live">
                  <strong>{number(automatic?.values?.angle, 3)}°</strong>
                  <span>
                    {recent
                      ? "Latest received angle"
                      : "Waiting for a fresh angle"}
                  </span>
                  <small>
                    {automatic?.time
                      ? formatDate(automatic.time)
                      : "No automatic readings yet"}
                  </small>
                  <small>
                    Sensor temperature:{" "}
                    {number(automatic?.values?.gravity_temp, 1)} °{unit}
                  </small>
                </div>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={manualAngle}
                    onChange={(e) => {
                      setManualAngle(e.target.checked);
                      setAngle("");
                      setPairedAt(null);
                    }}
                  />
                  Enter the angle manually
                </label>
              </>
            )}
            {!calibrationMode && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={reference}
                  onChange={(e) => setReference(e.target.checked)}
                />
                Use as calibration reference
              </label>
            )}
            {(!calibrationMode || manualAngle) && (
              <>
                {" "}
                <label>
                  iSpindel angle °{" "}
                  {reference || calibrationMode ? "(required)" : "(optional)"}
                  <input
                    required={reference || calibrationMode}
                    type="number"
                    min="0"
                    max="180"
                    step="0.001"
                    value={angle}
                    onChange={(e) => {
                      setAngle(e.target.value);
                      setPairedAt(null);
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  disabled={!recent}
                  onClick={async () => {
                    setAngle(String(automatic.values.angle));
                    setPairedAt(automatic.time);
                  }}
                >
                  Use latest received angle
                </button>
                <p className="muted">
                  {pairedAt
                    ? `Angle paired with packet ${formatDate(pairedAt)}.`
                    : "Enter the angle for the same sample, or select a received packet no older than five minutes."}
                </p>
              </>
            )}
          </details>
        )}
        {calibrationMode ? (
          <details>
            <summary>Sample temperature & note (optional)</summary>
            <label>
              Sample temperature °{unit}
              <input
                type="number"
                step="0.1"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={estimated}
                onChange={(e) => setEstimated(e.target.checked)}
              />
              Sample temperature is estimated
            </label>
            <p className="muted">
              Temperature is recorded for context; this formula uses angle only.
            </p>{" "}
            <label>
              Note
              <textarea
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </details>
        ) : (
          <>
            {" "}
            <label>
              Note
              <textarea
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </>
        )}
        <button disabled={busy || (calibrationMode && !manualAngle && !recent)}>
          {busy
            ? "Saving…"
            : calibrationMode
              ? "Add calibration point"
              : "Save reading"}
        </button>
      </form>
    </section>
  );
}
function DensitySource({
  sensor,
  refresh,
}: {
  sensor: Entity;
  refresh: () => void;
}) {
  const [source, setSource] = useState(sensor.data.gravity_source || "server"),
    [unit, setUnit] = useState(sensor.data.reported_gravity_unit || "unknown"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const last = sensor.data.last_automatic;
  useEffect(() => {
    setSource(sensor.data.gravity_source || "server");
    setUnit(sensor.data.reported_gravity_unit || "unknown");
  }, [sensor.data.gravity_source, sensor.data.reported_gravity_unit]);
  return (
    <section className="card gravity-source">
      <h2>Gravity source</h2>
      <p>
        Choose the gravity source for future readings. History, raw angle and
        device gravity are preserved.
      </p>
      {last && (
        <>
          <p className="muted">
            Last automatic reading: {formatDate(last.time)}
          </p>
          <dl className="sensor-values">
            <div>
              <dt>Angle</dt>
              <dd>{number(last.values.angle, 3)}°</dd>
            </div>
            <div>
              <dt>Raw device value</dt>
              <dd>
                {number(last.values.ispindel_gravity)}{" "}
                {last.values.ispindel_gravity_unit === "unknown"
                  ? "(unknown unit)"
                  : last.values.ispindel_gravity_unit}
              </dd>
            </div>
            <div>
              <dt>Server-calculated SG</dt>
              <dd>{number(last.values.server_gravity)}</dd>
            </div>
          </dl>
        </>
      )}
      <Alert error={error} message={message} />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          setMessage("");
          try {
            await api(
              `/sensors/${encodeURIComponent(sensor.id)}/source`,
              "POST",
              { gravity_source: source, reported_gravity_unit: unit },
            );
            setMessage("Gravity source saved for future readings.");
            refresh();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Gravity source
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="server">Server calibration</option>
            <option value="device">iSpindel device formula</option>
          </select>
        </label>
        <label>
          Device gravity units
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="unknown">
              Unknown — choose units before using device gravity
            </option>
            <option value="SG">SG</option>
            <option value="Plato">°Plato</option>
          </select>
        </label>
        <p className="muted">
          iSpindel does not declare its gravity units. Check the device formula.
          Plato is converted to SG on receipt. If the selected source is
          missing, no gravity is shown.
        </p>
        <button disabled={busy || (source === "device" && unit === "unknown")}>
          {busy ? "Saving…" : "Save gravity source"}
        </button>
      </form>
    </section>
  );
}
type Reference = {
  id: string;
  time: number;
  angle: number;
  gravity: number;
  reported_gravity: number | null;
  reported_unit: string;
};
function Calibration({
  sensor,
  refresh,
}: {
  sensor: Entity;
  refresh: () => void;
}) {
  const path = `/sensors/${encodeURIComponent(sensor.id)}/calibration`;
  const [points, setPoints] = useState<Reference[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [degree, setDegree] = useState(2),
    [preview, setPreview] = useState<any>(null),
    [active, setActive] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [step, setStep] = useState(-1);
  async function read() {
    setBusy(true);
    setError("");
    try {
      const v = await api(path + "/points");
      setPoints(v.points);
      setSelected(v.points.map((p: Reference) => p.id));
      setActive(v.active_id);
      setPreview(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void read();
  }, [sensor.id]);
  async function review() {
    setBusy(true);
    setError("");
    try {
      setPreview(
        await api(path + "/preview", "POST", { degree, points: selected }),
      );
      setStep(1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const last = sensor.data.last_automatic;
  const proposed =
    preview && typeof last?.values?.angle === "number"
      ? preview.fit.coefficients.reduce(
          (sum: number, c: number, i: number) =>
            sum + c * last.values.angle ** i,
          0,
        )
      : null;
  return (
    <section className="card calibration-bench">
      <h2>Calibrate sensor</h2>
      <Alert error={error} message={message} />
      {step === -1 ? (
        <>
          <p>
            Match your iSpindel’s angle to known gravity measurements. We’ll
            guide you through collecting points, checking the curve and using
            the calibration.
          </p>
          <p className="muted">
            {points.length} saved calibration points ·{" "}
            {active
              ? "Calibration active in YeastCraft"
              : "No fitted calibration active"}
          </p>
          <button
            disabled={busy}
            onClick={() => {
              setMessage("");
              setStep(0);
            }}
          >
            Start calibration
          </button>
        </>
      ) : (
        <>
          <ol
            className="calibration-progress"
            aria-label="Calibration progress"
          >
            {["Collect points", "Check curve", "Use calibration"].map(
              (label, i) => (
                <li key={label} aria-current={step === i ? "step" : undefined}>
                  {i + 1} · {label}
                </li>
              ),
            )}
          </ol>
          {step === 0 && (
            <>
              <ManualReading
                sensor={sensor}
                refresh={refresh}
                calibrationMode
                saved={() => {
                  void read();
                }}
              />
              <h3>Your calibration points</h3>
              <p className="muted">
                Use at least {degree + 1} different angles across your brewing
                range. Five or more well-spaced points make it easier to check
                the result.
              </p>
              {!points.length ? (
                <p>No calibration points yet. Add your first known SG above.</p>
              ) : (
                <div className="calibration-points">
                  {points.map((p) => (
                    <label className="calibration-point" key={p.id}>
                      <input
                        aria-label={`Select reference ${p.id}`}
                        type="checkbox"
                        checked={selected.includes(p.id)}
                        onChange={(e) => {
                          setSelected(
                            e.target.checked
                              ? [...selected, p.id]
                              : selected.filter((id) => id !== p.id),
                          );
                          setPreview(null);
                        }}
                      />
                      <span>
                        <strong>{number(p.gravity)} SG</strong>
                        <small>{formatDate(p.time)}</small>
                      </span>
                      <span>{number(p.angle, 3)}°</span>
                    </label>
                  ))}
                </div>
              )}
              <details>
                <summary>Advanced fitting options</summary>
                <label>
                  Polynomial degree
                  <select
                    value={degree}
                    onChange={(e) => {
                      setDegree(Number(e.target.value));
                      setPreview(null);
                    }}
                  >
                    <option value={2}>Quadratic · recommended</option>
                    <option value={3}>
                      Cubic · at least four distinct angles
                    </option>
                  </select>
                </label>
              </details>
              <div className="form-actions">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => setStep(-1)}
                >
                  Close
                </button>
                <button
                  disabled={
                    busy ||
                    new Set(
                      points
                        .filter((p) => selected.includes(p.id))
                        .map((p) => p.angle),
                    ).size <
                      degree + 1
                  }
                  onClick={review}
                >
                  {busy ? "Checking…" : "Check calibration curve"}
                </button>
              </div>
            </>
          )}
          {step === 1 && preview && (
            <>
              <h3>Check your calibration curve</h3>
              <CalibrationCurve fit={preview.fit} />
              <p>
                {preview.fit.count} reference points · typical fitting error{" "}
                {number(preview.fit.rmse, 5)} SG.
              </p>
              <p className="muted">
                Look for points that sit away from the curve. Check their
                measurements before leaving them out. A good fit still needs
                checking with a new sample.
              </p>
              {preview.fit.warnings.map((w: string) => (
                <p className="alert" key={w}>
                  {w}
                </p>
              ))}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Angle</th>
                      <th>Known SG</th>
                      <th>Calculated SG</th>
                      <th>Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.fit.residuals.map((r: any) => (
                      <tr key={r.id}>
                        <td>{number(r.angle, 2)}°</td>
                        <td>{number(r.reference)}</td>
                        <td>{number(r.predicted)}</td>
                        <td>{number(r.error, 5)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details>
                <summary>Formula & technical details</summary>
                <label>
                  Formula producing SG
                  <textarea readOnly value={preview.fit.formula} />
                </label>
                <p>
                  Valid reference angle range:{" "}
                  {number(preview.fit.angle_min, 2)}–
                  {number(preview.fit.angle_max, 2)}°.
                </p>
              </details>
              <div className="form-actions">
                <button className="secondary" onClick={() => setStep(0)}>
                  Edit points
                </button>
                <button onClick={() => setStep(2)}>
                  Continue to activation
                </button>
              </div>
            </>
          )}
          {step === 2 && preview && (
            <>
              <h3>Use this calibration</h3>
              <p>
                YeastCraft will use the new formula for future readings. The
                formula inside your physical iSpindel stays as it is.
              </p>
              <div className="calibration-comparison">
                <div>
                  <small>Current SG</small>
                  <strong>
                    {number(
                      last?.values?.gravity ?? sensor.data.last_values?.gravity,
                    )}
                  </strong>
                </div>
                <div>
                  <small>With this calibration</small>
                  <strong>{number(proposed)}</strong>
                </div>
              </div>
              <p className="muted">
                {last
                  ? "Comparison uses the last received angle from " +
                    formatDate(last.time) +
                    ". It may differ from the current sample."
                  : "A received angle is needed to show a live comparison."}
              </p>
              <div className="form-actions">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => setStep(1)}
                >
                  Back to curve
                </button>
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await api(path + "/apply", "POST", {
                        degree,
                        points: selected,
                        expected_revision: preview.revision,
                        confirm_apply: true,
                      });
                      await read();
                      setStep(-1);
                      setMessage(
                        "Calibration is active in YeastCraft. Check it with a new sample of known SG that was not used for fitting.",
                      );
                      refresh();
                    } catch (e) {
                      setPreview(null);
                      setStep(0);
                      setError(errorText(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Activating…" : "Use this calibration in YeastCraft"}
                </button>
              </div>
            </>
          )}
        </>
      )}
      {active && (
        <details className="calibration-recovery">
          <summary>Previous calibration</summary>
          <p>
            Restore the previous formula and gravity source for future readings.
          </p>
          <button
            className="secondary"
            disabled={busy}
            onClick={async () => {
              if (
                !(await confirmAction(
                  "Restore the previous server calibration and source for future readings?",
                ))
              )
                return;
              setBusy(true);
              setError("");
              try {
                await api(path + "/restore", "POST", {
                  expected_active_id: active,
                  confirm: true,
                });
                await read();
                setStep(-1);
                setMessage("Previous calibration and gravity source restored.");
                refresh();
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Restore previous calibration
          </button>
        </details>
      )}
    </section>
  );
}
