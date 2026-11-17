// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, list, save, type Entity } from "./api";
import { Modal } from "./dialogs";
export default function BatchStart({
  close,
  initial,
}: {
  close: () => void;
  initial?: Entity;
}) {
  const navigate = useNavigate();
  const [resources, setResources] = useState<Entity[][]>([[], [], [], []]),
    [enabled, setEnabled] = useState(false),
    [collection, setCollection] = useState(false),
    [ready, setReady] = useState(false);
  const [step, setStep] = useState(0),
    [name, setName] = useState(initial?.name || ""),
    [device, setDevice] = useState(initial?.data.device || ""),
    [sensor, setSensor] = useState(initial?.data.sensor || ""),
    [og, setOg] = useState(initial?.data.original_gravity?.toString() || ""),
    [mode, setMode] = useState("monitor"),
    [profile, setProfile] = useState(""),
    [target, setTarget] = useState("18"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [draft, setDraft] = useState<Entity | null>(initial || null),
    [applied, setApplied] = useState(false);
  useEffect(() => {
    Promise.all([
      list("devices"),
      list("sensors"),
      list("profiles"),
      list("batches"),
      api("/diagnostics"),
    ])
      .then(([a, b, c, d, e]) => {
        setResources([a, b, c, d]);
        setEnabled(e.control_enabled);
        setCollection(e.collection_enabled);
        setReady(true);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const [d, b, status] = await Promise.all([
          list("devices"),
          list("batches"),
          api("/diagnostics"),
        ]);
        if (active) {
          setResources((old) => [d, old[1], old[2], b]);
          setEnabled(status.control_enabled);
          setCollection(status.collection_enabled);
        }
      } catch {
        /* Preserve the last known readiness; final submit rechecks the device. */
      }
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [ready]);
  const controller = resources[0].find((e) => e.id === device),
    chosen = resources[2].find((e) => e.id === profile);
  const occupied =
    device &&
    resources[3].some(
      (e) =>
        e.id !== draft?.id &&
        e.data.device === device &&
        e.data.status === "active",
    );
  const blocked = occupied
    ? "This temperature controller already has an active batch. Finish that batch first."
    : mode === "monitor"
      ? ""
      : !controller
        ? "Choose a temperature controller."
        : !enabled || !collection
          ? "Server collection and temperature control must be enabled by the administrator."
          : !controller.data.collection_enabled
            ? "Enable collection for this temperature controller."
            : !controller.data.control_claimed
              ? "Open the temperature controller and confirm this app is its only owner."
              : controller.data.profile
                ? "A profile is already assigned. Stop it or choose Record only to keep it."
                : controller.data.last_error ||
                    !controller.data.last_seen ||
                    Date.now() - Number(controller.data.last_seen) > 120000
                  ? "Wait for a fresh response from this temperature controller."
                  : mode === "profile" && !chosen
                    ? "Choose a fermentation profile."
                    : mode !== "profile" &&
                        (!Number.isFinite(Number(target)) || !target.trim())
                      ? "Enter a valid target temperature."
                      : "";
  async function finish(start: boolean) {
    setBusy(true);
    setError("");
    try {
      if (!name.trim()) throw Error("Enter a batch name.");
      if (
        og &&
        (!Number.isFinite(Number(og)) || Number(og) < 0.5 || Number(og) > 2)
      )
        throw Error("Original gravity must be between 0.5 and 2 SG.");
      if (start && blocked && !applied) throw Error(blocked);
      if (start && device) {
        const batches = await list("batches");
        if (
          batches.some(
            (e) =>
              e.id !== draft?.id &&
              e.data.device === device &&
              e.data.status === "active",
          )
        )
          throw Error(
            "This controller already has an active batch. Finish it first.",
          );
      }
      if (start && mode !== "monitor" && !applied) {
        if (!controller || !enabled)
          throw Error("Select a ready controller before starting control.");
        const live = await api<Entity>(
          "/resources/devices/" + encodeURIComponent(device),
        );
        if (
          !live.data.collection_enabled ||
          !live.data.control_claimed ||
          live.data.profile
        )
          throw Error(
            "The controller must be collecting, claimed by this app, and have no assigned profile. Review its current control first.",
          );
        if (mode === "profile" && !chosen) throw Error("Choose a profile.");
        if (
          mode !== "profile" &&
          (!Number.isFinite(Number(target)) || target.trim() === "")
        )
          throw Error("Enter a valid target temperature.");
      }
      const data = {
        ...(draft?.data || {}),
        device: device || null,
        sensor: sensor || null,
        unit: controller?.data.unit || "C",
        status: "planned",
        original_gravity: og ? Number(og) : null,
      };
      let record =
        applied && draft ? draft : await save("batches", name, data, draft?.id);
      setDraft(record);
      if (start && mode !== "monitor" && !applied) {
        if (mode === "profile")
          await api(
            "/devices/" + encodeURIComponent(device) + "/profile",
            "POST",
            { profile, confirm_ownership: true },
          );
        else
          await api(
            "/devices/" + encodeURIComponent(device) + "/command",
            "POST",
            { mode, temperature: Number(target), confirm_ownership: true },
          );
        setApplied(true);
      }
      if (start)
        record = await save(
          "batches",
          name,
          { ...data, status: "active", created: new Date().toISOString() },
          record.id,
        );
      close();
      navigate("/batches/" + encodeURIComponent(record.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={initial ? "Start planned batch" : "New batch"}
      onClose={() => {
        if (!busy) close();
      }}
    >
      <p className="muted">
        {
          [
            "1 · Batch details",
            "2 · Equipment & temperature",
            "3 · Review & start",
          ][step]
        }
      </p>
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
      {draft && (
        <p className="alert">
          A planned batch has been saved.{" "}
          {applied
            ? "Control was started; retry to finish recording the batch start."
            : "You can retry, or close and keep the draft."}
        </p>
      )}
      {step === 0 && (
        <>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Original gravity SG · optional
            <input
              type="number"
              step="0.001"
              value={og}
              onChange={(e) => setOg(e.target.value)}
            />
          </label>
        </>
      )}
      {step === 1 && (
        <>
          <label>
            Temperature controller
            <select
              aria-label="Temperature controller"
              value={device}
              onChange={(e) => setDevice(e.target.value)}
            >
              <option value="">No controller</option>
              {resources[0].map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Gravity sensor
            <select
              aria-label="Gravity sensor"
              value={sensor}
              onChange={(e) => setSensor(e.target.value)}
            >
              <option value="">No sensor</option>
              {resources[1].map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Temperature plan
            <select
              aria-label="Temperature plan"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="monitor">
                Record only · keep current control
              </option>
              <option value="b">Fixed beer temperature</option>
              <option value="f">Fixed chamber temperature</option>
              <option value="profile">Fermentation profile</option>
            </select>
          </label>
          {blocked && (
            <p role="status" className="alert">
              {blocked}
            </p>
          )}
          {controller && (
            <a
              className="button secondary"
              href={"/devices/" + encodeURIComponent(controller.id)}
              target="_blank"
              rel="noreferrer"
            >
              Review temperature controller in a new tab
            </a>
          )}
          {mode === "profile" ? (
            <label>
              Profile
              <select
                aria-label="Profile"
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
              >
                <option value="">Choose a profile</option>
                {resources[2].map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            mode !== "monitor" && (
              <label>
                Target °{controller?.data.unit || "C"}
                <input
                  type="number"
                  step="0.1"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
              </label>
            )
          )}
        </>
      )}
      {step === 2 && (
        <>
          <h3>{name}</h3>
          <p>
            {controller?.name || "No controller"} ·{" "}
            {resources[1].find((e) => e.id === sensor)?.name ||
              "No gravity sensor"}
          </p>
          <p>
            Original gravity:{" "}
            {og ? Number(og).toFixed(3) + " SG" : "Not recorded"}
          </p>
          <p>
            {mode === "monitor"
              ? controller
                ? "Log this batch while keeping the temperature controller’s current settings."
                : sensor
                  ? "Log this batch using the selected gravity sensor. No temperature controller is linked."
                  : "Create a batch for manual readings and notes. No equipment is linked."
              : mode === "profile"
                ? `Start ${chosen?.name || "a profile"} from the beginning.`
                : `Set ${mode === "b" ? "beer" : "chamber"} temperature to ${target} °${controller?.data.unit || "C"}.`}
          </p>

          <p className="muted">
            Saving a draft does not start recording or change temperature
            control.
          </p>
        </>
      )}
      <div className="form-actions">
        <button
          className="secondary"
          disabled={busy || applied}
          onClick={step ? () => setStep(step - 1) : close}
        >
          {step ? "Back" : "Cancel"}
        </button>
        <button
          className="secondary"
          disabled={busy || !ready || !name.trim() || !!draft}
          onClick={() => finish(false)}
        >
          Save draft
        </button>
        {step < 2 ? (
          <button
            disabled={
              !ready ||
              !name.trim() ||
              busy ||
              applied ||
              (step === 1 && !!blocked) ||
              (!!og && (!Number.isFinite(Number(og)) || +og < 0.5 || +og > 2))
            }
            onClick={() => setStep(step + 1)}
          >
            Continue
          </button>
        ) : (
          <button
            disabled={busy || (!applied && !!blocked)}
            onClick={() => finish(true)}
          >
            {busy ? "Starting…" : "Start batch"}
          </button>
        )}
      </div>
    </Modal>
  );
}
