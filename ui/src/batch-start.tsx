// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, list, save, type Entity } from "./api";
import { Modal } from "./dialogs";
import BrewfatherPicker, { type BrewfatherPlan } from "./brewfather-picker";
import PlanPreview from "./plan-preview";
import { stepCondition } from "./profile-builder";
import { profileSteps } from "./workflow";
export default function BatchStart({
  close,
  initial,
}: {
  close: () => void;
  initial?: Entity;
}) {
  const navigate = useNavigate();
  const submitting = useRef(false);
  const attemptId = useRef(initial?.id);
  const saved = initial?.data.start_plan;
  const [source, setSource] = useState(saved?.source || "manual");
  const [bf, setBf] = useState<BrewfatherPlan | null>(
    saved?.brewfather || null,
  );
  const [manualUnit, setManualUnit] = useState(initial?.data.unit || "C");
  const [end, setEnd] = useState(saved?.end || "hold");
  const [resources, setResources] = useState<Entity[][]>([[], [], [], []]),
    [enabled, setEnabled] = useState(false),
    [collection, setCollection] = useState(false),
    [ready, setReady] = useState(false);
  const [step, setStep] = useState(0),
    [name, setName] = useState(initial?.name || ""),
    [device, setDevice] = useState(initial?.data.device || ""),
    [sensor, setSensor] = useState(initial?.data.sensor || ""),
    [og, setOg] = useState(initial?.data.original_gravity?.toString() || ""),
    [mode, setMode] = useState(saved?.mode || "monitor"),
    [profile, setProfile] = useState(saved?.profile || ""),
    [target, setTarget] = useState(saved?.target || "18"),
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
        if (
          initial?.data.start_profile &&
          a.some(
            (e: Entity) =>
              e.id === initial.data.device &&
              e.data.profile === initial.data.start_profile,
          )
        )
          setApplied(true);
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
  const profileMode = source !== "manual";
  const planReady =
    source === "brewfather"
      ? bf?.candidate.status === "ready"
      : source === "yc"
        ? !!profile
        : true;
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
    : !profileMode && mode === "monitor"
      ? ""
      : !controller
        ? "Choose a temperature controller."
        : !enabled || !collection
          ? "Server collection and temperature control must be enabled by the administrator."
          : !controller.data.collection_enabled
            ? "Enable collection for this temperature controller."
            : !controller.data.control_claimed
              ? "Open the temperature controller and enable control."
              : controller.data.profile
                ? "A profile is already assigned. Stop it or choose Record only to keep it."
                : controller.data.last_error ||
                    !controller.data.last_seen ||
                    Date.now() - Number(controller.data.last_seen) > 120000
                  ? "Wait for a fresh response from this temperature controller."
                  : profileMode && !planReady
                    ? "Choose a fermentation profile."
                    : !profileMode &&
                        (!Number.isFinite(Number(target)) || !target.trim())
                      ? "Enter a valid target temperature."
                      : "";
  async function finish(start: boolean) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      if (!name.trim()) throw Error("Enter a batch name.");
      if (
        og &&
        (!Number.isFinite(Number(og)) || Number(og) < 0.5 || Number(og) > 2)
      )
        throw Error("Original gravity must be between 0.5 and 2 SG.");
      if (!planReady || (source === "yc" && !chosen))
        throw Error("Choose a temperature plan.");
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
      if (start && (profileMode || mode !== "monitor") && !applied) {
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
        if (profileMode && (!planReady || (source === "yc" && !chosen)))
          throw Error("Choose a profile.");
        if (
          !profileMode &&
          (!Number.isFinite(Number(target)) || target.trim() === "")
        )
          throw Error("Enter a valid target temperature.");
      }
      const data: Record<string, any> = {
        ...(draft?.data || {}),
        device: device || null,
        sensor: sensor || null,
        unit: controller?.data.unit || "C",
        status: "planned",
        original_gravity: og ? Number(og) : null,
        start_plan: {
          source,
          mode,
          profile,
          target,
          end,
          brewfather: source === "brewfather" ? bf : null,
        },
        ...(source === "brewfather" && bf
          ? {
              brewfather: {
                id: bf.batch.id,
                number: bf.batch.number,
                name: bf.batch.name,
              },
            }
          : {}),
      };
      // A changed choice must never reuse a profile created for a previous attempt.
      if (
        JSON.stringify(data.start_plan) !==
        JSON.stringify(draft?.data.start_plan)
      )
        data.start_profile = null;
      if (source !== "brewfather") data.brewfather = null;
      if (source === "manual" && !applied) data.start_profile = null;
      let record =
        applied && draft ? draft : await save("batches", name, data, draft?.id);
      setDraft(record);
      attemptId.current = record.id;
      if (start && (profileMode || mode !== "monitor") && !applied) {
        let selectedProfile = profile;
        if (source === "brewfather") {
          if (!bf?.candidate.profile)
            throw Error("Choose a Brewfather profile.");
          selectedProfile = record.data.start_profile;
          if (!selectedProfile) {
            const local = await save("profiles", `${name} · Brewfather`, {
              ...bf.candidate.profile,
              end_behavior: end,
            });
            selectedProfile = local.id;
            data.start_profile = selectedProfile;
            record = await save(
              "batches",
              name,
              { ...data, start_profile: selectedProfile },
              record.id,
            );
            setDraft(record);
          }
        }
        if (profileMode) {
          data.start_profile = selectedProfile;
          record = await save("batches", name, data, record.id);
          setDraft(record);
          await api(
            "/devices/" + encodeURIComponent(device) + "/profile",
            "POST",
            { profile: selectedProfile, confirm_ownership: true },
          );
        } else
          await api(
            "/devices/" + encodeURIComponent(device) + "/command",
            "POST",
            { mode, temperature: Number(target), confirm_ownership: true },
          );
        data.start_profile = selectedProfile || null;
        setDraft({ ...record, data: { ...data } });
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
      // If the assignment response was lost, recover from durable controller state.
      if (start && profileMode && device && attemptId.current) {
        try {
          const [live, savedBatch] = await Promise.all([
            api<Entity>("/resources/devices/" + encodeURIComponent(device)),
            api<Entity>(
              "/resources/batches/" + encodeURIComponent(attemptId.current),
            ),
          ]);
          const pending =
            savedBatch.data.device === device &&
            savedBatch.data.status === "planned" &&
            savedBatch.data.start_profile &&
            savedBatch.data.start_profile === live.data.profile
              ? savedBatch
              : null;
          if (pending) {
            setDraft(pending);
            setApplied(true);
          }
        } catch {
          /* Keep the original error; no repeated assignment. */
        }
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const planData =
    source === "brewfather" ? bf?.candidate.profile : chosen?.data;
  const steps = planData ? profileSteps(planData) : [];
  const planTitle =
    source === "brewfather" ? bf?.batch.recipe || bf?.batch.name : chosen?.name;
  function chooseBrewfather(p: BrewfatherPlan | null) {
    setBf(p);
    if (p) {
      setName(p.batch.name || p.batch.recipe);
      setOg(p.batch.og == null ? "" : String(p.batch.og));
    }
  }
  const summary = (
    <>
      {profileMode && planData ? (
        <section className="batch-plan-summary">
          <p className="eyebrow">
            {source === "brewfather"
              ? "Profile from Brewfather"
              : "YeastCraft profile"}
          </p>
          <h3>{planTitle}</h3>
          {controller && controller.data.unit !== (planData.unit || "C") && (
            <p className="muted">
              Converted automatically to °{controller.data.unit} for this
              controller.
            </p>
          )}
          {steps.some((s: any) => s.until) && (
            <p className="muted">
              Timing depends on gravity. Steps advance when their conditions are
              met.
            </p>
          )}
          <PlanPreview steps={steps} unit={planData.unit || "C"} />
          <details className="batch-step-details">
            <summary>View {steps.length} steps</summary>
            <ol>
              {steps.map((s: any, i: number) => (
                <li key={i}>
                  <strong>{s.name || `Step ${i + 1}`}</strong>
                  <span>
                    {s.transition === "ramp" ? "Ramp to" : "Hold at"}{" "}
                    {s.temperature} °{planData.unit || "C"} · {stepCondition(s)}
                  </span>
                </li>
              ))}
            </ol>
          </details>
          {source === "brewfather" ? (
            <label>
              When finished
              <select
                aria-label="When finished"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              >
                <option value="hold">Keep the final temperature</option>
                <option value="off">Turn temperature control off</option>
              </select>
            </label>
          ) : (
            <p className="muted">
              When finished:{" "}
              {planData.end_behavior === "off"
                ? "turn temperature control off"
                : "keep the final temperature"}
              .
            </p>
          )}
          <p className="muted">
            Starts from the first step when you start this batch.
          </p>
          {source === "brewfather" &&
            bf?.candidate.warnings?.map((w) => (
              <p className="alert" key={w}>
                {w}
              </p>
            ))}
        </section>
      ) : (
        !profileMode && (
          <p className="batch-plan-summary">
            {mode === "monitor"
              ? "Record only. Keep current temperature control unchanged."
              : `Set ${mode === "b" ? "beer" : "chamber"} temperature to ${target} °${controller?.data.unit || "C"}.`}
          </p>
        )
      )}
    </>
  );
  return (
    <Modal
      title={step === 0 ? "Start a batch" : "Ready to start?"}
      onClose={() => {
        if (!busy) close();
      }}
    >
      <div className="batch-start">
        <p className="batch-progress">
          1 · Temperature plan <span>/</span> 2 · Review & start
        </p>
        {error && (
          <p role="alert" className="alert error">
            {error}
          </p>
        )}
        {draft && (!initial || applied) && (
          <p className="alert">
            A planned batch has been saved.{" "}
            {applied
              ? "Control was started; retry to finish recording the batch start."
              : "You can retry, or close and keep the draft."}
          </p>
        )}
        <div className="batch-fields-scroll">
          <fieldset disabled={busy || applied} className="batch-fields">
            {step === 0 ? (
              <>
                <p className="muted">Give this batch a temperature plan.</p>
                <div className="batch-plan-tabs" aria-label="Plan source">
                  {[
                    ["manual", "Manual", "Set a temperature or record only"],
                    ["yc", "YC profile", "Use a saved fermentation plan"],
                    ["brewfather", "Brewfather", "Use a batch’s brewing plan"],
                  ].map(([id, title, desc]) => (
                    <button
                      type="button"
                      key={id}
                      aria-pressed={source === id}
                      onClick={() => {
                        setSource(id);
                        setError("");
                      }}
                    >
                      <strong>{title}</strong>
                      <span>{desc}</span>
                    </button>
                  ))}
                </div>
                {source === "manual" && (
                  <>
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
                      </select>
                    </label>
                    {mode !== "monitor" && (
                      <label>
                        Target °{manualUnit}
                        <input
                          type="number"
                          step="0.1"
                          value={target}
                          onChange={(e) => setTarget(e.target.value)}
                        />
                      </label>
                    )}
                  </>
                )}
                {source === "yc" && (
                  <>
                    <h3>Choose your fermentation plan</h3>
                    <div className="batch-choice-list">
                      {resources[2].map((p) => (
                        <button
                          type="button"
                          key={p.id}
                          className="batch-choice"
                          aria-pressed={p.id === profile}
                          onClick={() => setProfile(p.id)}
                        >
                          <strong>{p.name}</strong>
                          <span>
                            {profileSteps(p.data).length} steps ·{" "}
                            {p.data.control_sensor === "chamber"
                              ? "Chamber"
                              : "Beer"}{" "}
                            temperature
                          </span>
                        </button>
                      ))}
                    </div>
                    {ready && !resources[2].length && (
                      <p>
                        No profiles yet. Create one in Profiles, or choose
                        Manual.
                      </p>
                    )}
                    {summary}
                  </>
                )}
                {source === "brewfather" && (
                  <BrewfatherPicker
                    selected={bf}
                    choose={chooseBrewfather}
                    cancel={() => setSource("manual")}
                  />
                )}
              </>
            ) : (
              <>
                <p className="muted">
                  Check your batch and how temperature will be controlled.
                </p>
                <div className="batch-review-layout">
                  <div className="batch-detail-grid">
                    <label>
                      Name
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
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
                    <label>
                      Temperature controller
                      <select
                        aria-label="Temperature controller"
                        value={device}
                        onChange={(e) => {
                          const unit =
                            resources[0].find((d) => d.id === e.target.value)
                              ?.data.unit || "C";
                          if (
                            unit !== manualUnit &&
                            target.trim() &&
                            Number.isFinite(Number(target))
                          )
                            setTarget(
                              String(
                                Number(
                                  (unit === "F"
                                    ? (Number(target) * 9) / 5 + 32
                                    : ((Number(target) - 32) * 5) / 9
                                  ).toFixed(1),
                                ),
                              ),
                            );
                          setManualUnit(unit);
                          setDevice(e.target.value);
                        }}
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
                  </div>
                  {summary}
                </div>
                {blocked && (
                  <p role="status" className="alert">
                    {blocked}
                  </p>
                )}
                <p className="muted">
                  Saving a draft does not start recording or change temperature
                  control.
                </p>
              </>
            )}
          </fieldset>
        </div>
        <div className="form-actions batch-start-actions">
          <button
            className="secondary"
            disabled={busy || applied}
            onClick={step ? () => setStep(0) : close}
          >
            {step ? "Back" : "Cancel"}
          </button>
          {step === 1 && (
            <button
              className="secondary"
              disabled={busy || applied || !ready || !name.trim() || !planReady}
              onClick={() => finish(false)}
            >
              Save draft
            </button>
          )}
          {step === 0 ? (
            <button
              disabled={!ready || busy || !planReady}
              onClick={() => setStep(1)}
            >
              Continue
            </button>
          ) : (
            <button
              disabled={busy || !name.trim() || (!applied && !!blocked)}
              onClick={() => finish(true)}
            >
              {busy ? "Starting…" : "Start batch"}
            </button>
          )}
        </div>
        <p className="muted">Nothing starts until you choose Start batch.</p>
      </div>
    </Modal>
  );
}
