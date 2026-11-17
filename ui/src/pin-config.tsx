import { confirmAction } from "./dialogs";
// SPDX-License-Identifier: GPL-3.0-only
import { useState, useEffect } from "react";
import { api, type Entity } from "./api";
import { activeTarget } from "./controller";

const functions: Record<number, string> = {
  0: "Unassigned / remove role",
  1: "Door switch",
  2: "Heating relay",
  3: "Cooling relay",
  4: "Chamber light",
  5: "Chamber sensor",
  6: "Room sensor",
  7: "Fan",
  9: "Beer sensor",
};
type Inventory = {
  revision: string;
  version: { v?: string; b?: string };
  installed: any[];
  available: any[];
};
const identity = (r: any) => `${r.h}:${r.p}:${r.a || ""}:${r.n || ""}`;
const title = (r: any) =>
  r.h === 1
    ? `Pin ${r.p}`
    : r.a
      ? `Probe ${r.a}`
      : `Hardware ${r.h}, pin ${r.p}`;

export default function PinConfiguration({ device }: { device: Entity }) {
  useEffect(() => {
    if (window.location.hash !== "#pin-config") return;
    const frame = requestAnimationFrame(() =>
      document.getElementById("pin-config")?.scrollIntoView(),
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  const [data, setData] = useState<Inventory | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [functionId, setFunctionId] = useState<number | null>(null);
  const [editing, setEditing] = useState<any>(null),
    [role, setRole] = useState(0),
    [inverted, setInverted] = useState(false),
    [calibration, setCalibration] = useState(0),
    [confirmed, setConfirmed] = useState(false);
  const path = "/devices/" + encodeURIComponent(device.id) + "/pins";
  const off = activeTarget(device).value === null && !device.data.profile;
  async function read() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setData(await api<Inventory>(path));
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void read();
  }, [device.id]);
  const installed = data?.installed || [];
  const rows = [
    ...installed,
    ...(data?.available || []).filter(
      (r) => !installed.some((x) => identity(r) === identity(x)),
    ),
  ];
  return (
    <section id="pin-config" className="card pin-config">
      <div className="section-title">
        <h2>Temperature probes & outputs</h2>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={read}
        >
          {busy ? "Reading…" : "Refresh inventory"}
        </button>
      </div>
      {busy && !data && (
        <p role="status">Reading temperature probes and outputs…</p>
      )}
      <p className="muted">
        Assignments are read from the controller. Turn control off and stop any
        active profile before saving changes.
      </p>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {data && (
        <>
          <p className="muted">
            Firmware {data.version.v || "unknown"} · {installed.length}{" "}
            installed assignments
          </p>
          <h3>Function assignments</h3>
          <p>
            Choose the pin or temperature sensor used for each function. To move
            a function to another pin, unassign its current pin and save first.
          </p>
          <div className="pin-grid">
            {[9, 5, 6, 3, 2, 7, 1, 4].map((f) => {
              const assigned = installed.find((r) => Number(r.f) === f);
              const pending = functionId === f && editing;
              return (
                <article className="pin-row" key={f}>
                  <h3>{functions[f]}</h3>
                  <p>Current: {assigned ? title(assigned) : "Unassigned"}</p>
                  {assigned?.v !== undefined && (
                    <p>Reading: {String(assigned.v)}</p>
                  )}
                  <label>
                    Pin or sensor
                    <select
                      aria-label={"Pin or sensor for " + functions[f]}
                      disabled={busy}
                      value={
                        pending
                          ? role === 0
                            ? ""
                            : identity(editing)
                          : assigned
                            ? identity(assigned)
                            : ""
                      }
                      onChange={(e) => {
                        const row = e.target.value
                          ? rows.find((r) => identity(r) === e.target.value)
                          : assigned;
                        if (!row) {
                          setEditing(null);
                          return;
                        }
                        setFunctionId(f);
                        setEditing(row);
                        setRole(e.target.value ? f : 0);
                        setInverted(row.x === true || Number(row.x) === 1);
                        setCalibration(Number(row.j || 0));
                        setConfirmed(false);
                        setError("");
                        setMessage("");
                      }}
                    >
                      <option value="">Unassigned</option>
                      {rows
                        .filter(
                          (row) => row.h === ([5, 6, 9].includes(f) ? 2 : 1),
                        )
                        .map((row) => (
                          <option key={identity(row)} value={identity(row)}>
                            {title(row)} · {functions[row.f] || "Unassigned"}
                          </option>
                        ))}
                    </select>
                  </label>
                  {assigned && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setFunctionId(f);
                        setEditing(assigned);
                        setRole(f);
                        setInverted(
                          assigned.x === true || Number(assigned.x) === 1,
                        );
                        setCalibration(Number(assigned.j || 0));
                        setConfirmed(false);
                      }}
                    >
                      Pin settings for {functions[f]}
                    </button>
                  )}
                </article>
              );
            })}
          </div>
          <details>
            <summary>Pin and sensor inventory (read-only)</summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Pin / sensor</th>
                    <th>Function</th>
                    <th>Reading</th>
                    <th>Inverted / offset</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={identity(row)}>
                      <td>{title(row)}</td>
                      <td>{functions[row.f] || "Unassigned"}</td>
                      <td>{row.v ?? "—"}</td>
                      <td>
                        {row.h === 1
                          ? row.x
                            ? "Inverted"
                            : "Normal"
                          : Number(row.j || 0).toFixed(2) +
                            " °" +
                            (device.data.unit || "C")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          {!rows.length && <p>The controller reported no sensors or pins.</p>}
        </>
      )}
      {editing && data && (
        <form
          className="pin-editor"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              !(await confirmAction(
                `Write to ${title(editing)}: ${functions[role]}? Temperature control must be off.`,
              ))
            )
              return;
            setBusy(true);
            setError("");
            try {
              const result = await api<{
                confirmed: boolean;
                configuration: Inventory;
              }>(path, "PUT", {
                expected_revision: data.revision,
                index: Number(editing.i ?? -1),
                hardware: editing.h,
                pin: editing.p,
                address: editing.a || "",
                function: role,
                inverted,
                calibration: editing.h === 2 ? calibration : null,
                confirm_ownership: confirmed,
              });
              if (!result.confirmed)
                throw Error("The controller did not confirm the change.");
              setData(result.configuration);
              setEditing(null);
              setMessage("Controller readback confirmed the assignment.");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h3>
            {role === 0 ? "Unassign" : "Assign"} {title(editing)}{" "}
            {role === 0 ? "from" : "to"} {functions[functionId!]}
          </h3>
          <label>
            Function
            <input aria-label="Pin function" readOnly value={functions[role]} />
          </label>
          {role > 0 &&
            installed.some(
              (r) => Number(r.f) === role && Number(r.i) !== Number(editing.i),
            ) && (
              <p className="alert">
                This function already has a pin or sensor. Choose Unassigned for
                this function and save before choosing a replacement.
              </p>
            )}
          {editing.h === 1 ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={inverted}
                onChange={(e) => setInverted(e.target.checked)}
              />
              Inverted output / input
            </label>
          ) : (
            <label>
              Calibration offset °{device.data.unit || "C"}
              <input
                aria-label="Pin calibration"
                type="number"
                min="-10"
                max="10"
                step="0.01"
                required
                value={calibration}
                onChange={(e) => setCalibration(Number(e.target.value))}
              />
            </label>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              required
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I have checked the assignment.
          </label>
          {!off && (
            <p className="alert">
              Turn temperature control off and stop any running profile before
              saving.{" "}
              <a
                href={"/devices/" + encodeURIComponent(device.id)}
                target="_blank"
                rel="noreferrer"
              >
                Review temperature control in a new tab
              </a>
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="secondary"
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
            <button
              disabled={
                busy ||
                !confirmed ||
                !off ||
                (role > 0 &&
                  installed.some(
                    (r) =>
                      Number(r.f) === role && Number(r.i) !== Number(editing.i),
                  )) ||
                (Number(editing.i ?? -1) < 0 && role === 0)
              }
            >
              Save and verify
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
