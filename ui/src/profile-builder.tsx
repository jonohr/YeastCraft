import { duration } from "./duration";
import { confirmAction, Modal } from "./dialogs";
// SPDX-License-Identifier: GPL-3.0-only
import { useState, type ReactNode } from "react";
import { Plus, Copy, ArrowUp, ArrowDown, Trash2 } from "lucide-react";
export type Step = {
  name?: string;
  hours: number;
  temperature: number;
  transition: string;
  until?: { kind: string; sg?: number; hours?: number; tolerance?: number };
};
export function stepCondition(s: Step) {
  return s.until?.kind === "sg"
    ? `Until SG ≤ ${s.until.sg?.toFixed(3)}`
    : s.until?.kind === "stable"
      ? `Until SG is stable for ${duration(s.until.hours || 0)} (range ≤ ${s.until.tolerance?.toFixed(4)})`
      : duration(s.hours);
}
export default function ProfileBuilder({
  steps,
  onChange,
  unit,
  endBehavior,
  readOnly = false,
  header,
  footer,
  gravityFields,
  gravityRules,
}: {
  steps: Step[];
  onChange: (s: Step[]) => void;
  unit: string;
  endBehavior: string;
  readOnly?: boolean;
  header?: ReactNode;
  footer?: ReactNode;
  gravityFields?: ReactNode;
  gravityRules?: ReactNode;
}) {
  const [selected, select] = useState(0),
    [adding, setAdding] = useState(false);
  const conditional = steps.some((s) => s.until);
  const total = steps.reduce((a, s) => a + Math.max(0, s.hours || 0), 0);
  const temperatures = steps.map((s) => s.temperature).filter(Number.isFinite);
  const low = Math.min(6, ...temperatures) - 1,
    high = Math.max(22, ...temperatures) + 1;
  let elapsed = 0;
  const points: string[] = [];
  const ranges: { x: number; width: number }[] = [];
  steps.forEach((s, i) => {
    const x =
      48 +
      ((conditional ? i : elapsed) /
        ((conditional ? steps.length : total) || 1)) *
        504;
    const from = i ? steps[i - 1].temperature : s.temperature;
    const y = (v: number) => 24 + ((high - v) / (high - low)) * 176;
    if (!i) points.push(`${x},${y(s.temperature)}`);
    else
      points.push(`${x},${y(s.transition === "ramp" ? from : s.temperature)}`);
    const width =
      ((conditional ? 1 : Math.max(0, s.hours || 0)) /
        ((conditional ? steps.length : total) || 1)) *
      504;
    ranges.push({ x, width });
    elapsed += Math.max(0, s.hours || 0);
    points.push(`${x + width},${y(s.temperature)}`);
  });
  function update(i: number, patch: Partial<Step>) {
    onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }
  function move(i: number, delta: number) {
    const a = [...steps];
    [a[i], a[i + delta]] = [a[i + delta], a[i]];
    onChange(a);
    select(i + delta);
  }
  const preview = (
    <aside className="profile-preview">
      <h3>Temperature preview</h3>
      <p className="muted">
        {conditional
          ? "Timing depends on gravity · step order preview"
          : duration(total)}{" "}
        · {steps.length} steps
      </p>
      <svg
        viewBox="0 0 576 248"
        role="img"
        aria-label="Temperature schedule preview"
      >
        {ranges[selected] && (
          <rect
            x={ranges[selected].x}
            y="24"
            width={ranges[selected].width}
            height="176"
            fill="#f6e9e0"
          />
        )}
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line
              x1="48"
              x2="552"
              y1={24 + i * 44}
              y2={24 + i * 44}
              stroke="#e4e5df"
            />
            <text x="3" y={29 + i * 44}>
              {(high - (i * (high - low)) / 4).toFixed(0)}°
            </text>
          </g>
        ))}
        <polyline
          points={points.join(" ")}
          fill="none"
          stroke="#a65331"
          strokeWidth="2.5"
        />
        {ranges.map((r, i) => (
          <g
            key={i}
            role="button"
            tabIndex={0}
            aria-label={`Select step ${i + 1}`}
            onClick={() => select(i)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                select(i);
              }
            }}
          >
            <rect
              x={r.x + 1}
              y="210"
              width={Math.max(0, r.width - 2)}
              height="25"
              rx="4"
              fill={i === selected ? "#a65331" : "#f0efeb"}
            />
            <text
              x={r.x + r.width / 2}
              y="227"
              textAnchor="middle"
              fill={i === selected ? "white" : "#626b63"}
            >
              {i + 1}
            </text>
          </g>
        ))}
      </svg>
      <div className="profile-summary">
        <span>
          <small>First target</small>
          <strong>
            {steps[0]?.temperature ?? "—"} °{unit}
          </strong>
        </span>
        <span>
          <small>After completion</small>
          <strong>
            {endBehavior === "off"
              ? "Control off"
              : `${steps.at(-1)?.temperature ?? "—"} °${unit}`}
          </strong>
        </span>
      </div>
      <p className="muted">
        {endBehavior === "off"
          ? "After the final step, temperature control switches off."
          : "After the final step, the controller keeps the last target."}{" "}
        Saving a template does not start temperature control.
      </p>
    </aside>
  );
  if (readOnly) return preview;
  return (
    <div className="profile-builder">
      <aside className="profile-right">
        {preview}
        {footer}
      </aside>
      <div className="profile-step-list">
        {header}
        <div className="section-title">
          <h3>Schedule</h3>
          <span className="muted">Select a step to edit</span>
        </div>
        {steps.map((s, i) => (
          <section
            className={"profile-step " + (selected === i ? "selected" : "")}
            key={i}
          >
            <button
              className="step-heading secondary"
              type="button"
              aria-expanded={selected === i}
              onClick={() => select(i)}
            >
              <span className="step-number">{i + 1}</span>
              <span>
                <strong>{s.name || `Step ${i + 1}`}</strong>
                <small>
                  {s.transition === "ramp" ? "Ramp to" : "Hold at"}{" "}
                  {s.temperature} °{unit}{" "}
                  {s.until
                    ? stepCondition(s)
                        .replace("Until", "until")
                        .split(" (range")[0]
                    : `for ${duration(s.hours)}`}
                </small>
              </span>
            </button>
            {selected === i && (
              <div className="step-fields">
                <label>
                  Step name
                  <input
                    value={s.name || ""}
                    placeholder={`Step ${i + 1}`}
                    onChange={(e) => update(i, { name: e.target.value })}
                  />
                </label>
                <div className="segmented" role="group" aria-label="Transition">
                  {["hold", "ramp"].map((t) => (
                    <button
                      type="button"
                      key={t}
                      disabled={(i === 0 || !!s.until) && t === "ramp"}
                      className={s.transition === t ? "" : "secondary"}
                      aria-pressed={s.transition === t}
                      onClick={() => update(i, { transition: t })}
                    >
                      {t === "hold" ? "Hold" : "Ramp"}
                    </button>
                  ))}
                </div>
                <label>
                  Target temperature °{unit}
                  <input
                    type="number"
                    step="0.1"
                    min={unit === "F" ? -4 : -20}
                    max={unit === "F" ? 122 : 50}
                    required
                    value={s.temperature}
                    onChange={(e) =>
                      update(i, { temperature: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  {i === steps.length - 1
                    ? "Finish this step"
                    : "Move to next step"}
                  <select
                    aria-label="Step ends"
                    value={s.until?.kind || "time"}
                    onChange={(e) =>
                      update(i, {
                        transition:
                          e.target.value === "time" ? s.transition : "hold",
                        until:
                          e.target.value === "time"
                            ? undefined
                            : e.target.value === "sg"
                              ? { kind: "sg", sg: 1.02 }
                              : { kind: "stable", hours: 48, tolerance: 0.001 },
                      })
                    }
                  >
                    <option value="time">After a duration</option>
                    <option value="sg">When SG reaches a value</option>
                    <option value="stable">When SG stays stable</option>
                  </select>
                </label>
                {s.until?.kind === "sg" && (
                  <label>
                    SG at or below
                    <input
                      aria-label="SG at or below"
                      type="number"
                      required
                      min="0.5"
                      max="2"
                      step="0.001"
                      value={s.until.sg}
                      onChange={(e) =>
                        update(i, {
                          until: { ...s.until!, sg: Number(e.target.value) },
                        })
                      }
                    />
                  </label>
                )}
                {s.until?.kind === "stable" && (
                  <div className="step-values gravity-condition-values">
                    <label>
                      Stable for (hours)
                      <input
                        aria-label="Stable for (hours)"
                        type="number"
                        required
                        min="0.016666667"
                        max="8760"
                        step="any"
                        value={s.until.hours}
                        onChange={(e) =>
                          update(i, {
                            until: {
                              ...s.until!,
                              hours: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                )}
                {s.until && (
                  <>
                    {gravityFields}
                    <details className="profile-advanced">
                      <summary>Advanced</summary>
                      {s.until.kind === "stable" && (
                        <>
                          {" "}
                          <label>
                            Maximum SG range
                            <input
                              aria-label="Maximum SG range"
                              type="number"
                              required
                              min="0.0001"
                              max="0.01"
                              step="0.0001"
                              value={s.until.tolerance}
                              onChange={(e) =>
                                update(i, {
                                  until: {
                                    ...s.until!,
                                    tolerance: Number(e.target.value),
                                  },
                                })
                              }
                            />
                          </label>
                          <p className="muted">
                            The highest and lowest SG must differ by no more
                            than this amount.
                          </p>
                        </>
                      )}
                      <h4>Reading confirmation</h4>
                      {gravityRules}
                      <p className="muted">
                        Missing or stale readings keep this step waiting at its
                        current target.
                      </p>
                    </details>
                  </>
                )}
                <div className="step-values profile-duration">
                  {!s.until && (
                    <>
                      <label>
                        Days
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={Math.floor(s.hours / 24)}
                          onChange={(e) =>
                            update(i, {
                              hours:
                                Number(e.target.value) * 24 + (s.hours % 24),
                            })
                          }
                        />
                      </label>
                      <label>
                        Hours
                        <input
                          type="number"
                          min="0"
                          max="23"
                          step="1"
                          value={Math.floor(s.hours % 24)}
                          onChange={(e) =>
                            update(i, {
                              hours:
                                Math.floor(s.hours / 24) * 24 +
                                Number(e.target.value) +
                                (Math.round(s.hours * 60) % 60) / 60,
                            })
                          }
                        />
                      </label>
                      <label>
                        Minutes
                        <input
                          type="number"
                          min="0"
                          max="59"
                          step="1"
                          value={Math.round(s.hours * 60) % 60}
                          onChange={(e) =>
                            update(i, {
                              hours:
                                Math.floor(s.hours) * 1 +
                                Number(e.target.value) / 60,
                            })
                          }
                        />
                      </label>
                    </>
                  )}{" "}
                </div>
                {!s.until && (
                  <>
                    {s.hours <= 0 ? (
                      <p className="alert error" role="alert">
                        Duration must be greater than zero.
                      </p>
                    ) : (
                      <p className="muted">
                        {s.transition === "ramp" && i > 0
                          ? `${steps[i - 1].temperature} → ${s.temperature} °${unit} · ${((s.temperature - steps[i - 1].temperature) / (s.hours / 24)).toFixed(2)} °${unit} / day`
                          : "Keeps a fixed target for the full duration."}
                      </p>
                    )}
                    <p className="muted">
                      Time starts when the step begins, even if the liquid has
                      not reached the target.
                    </p>
                  </>
                )}
                <p className="profile-next-action">
                  {i < steps.length - 1
                    ? `Then ${steps[i + 1].transition === "ramp" ? "ramp to" : "hold at"} ${steps[i + 1].temperature} °${unit} in step ${i + 2}.`
                    : endBehavior === "off"
                      ? "Then finish the profile and turn temperature control off."
                      : `Then finish the profile and keep holding ${s.temperature} °${unit}.`}
                </p>
                <div className="step-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={i === 0}
                    aria-label="Move step up"
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp size={16} />
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={i === steps.length - 1}
                    aria-label="Move step down"
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown size={16} />
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={async () => {
                      const a = [...steps];
                      a.splice(i + 1, 0, {
                        ...s,
                        name: (s.name || "Step") + " copy",
                      });
                      onChange(a);
                      select(i + 1);
                    }}
                  >
                    <Copy size={16} />
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-label="Remove step"
                    onClick={async () => {
                      if (
                        await confirmAction(
                          "Remove this step? The remaining steps will run in the new order.",
                        )
                      ) {
                        onChange(steps.filter((_, j) => j !== i));
                        select(Math.max(0, i - 1));
                      }
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            )}
          </section>
        ))}
        <button
          type="button"
          className="secondary add-step"
          onClick={() => setAdding(true)}
        >
          <Plus size={16} />
          Add step
        </button>
      </div>
      {adding && (
        <Modal title="Add a step" onClose={() => setAdding(false)}>
          <p>Choose how this step changes the temperature target.</p>
          <div className="equipment-choices">
            {["hold", "ramp"].map((type) => (
              <button
                type="button"
                className="secondary"
                disabled={type === "ramp" && !steps.length}
                key={type}
                onClick={() => {
                  onChange([
                    ...steps,
                    {
                      name:
                        type === "hold" ? "Hold temperature" : "Ramp gradually",
                      temperature: steps.at(-1)?.temperature ?? 18.5,
                      hours: 24,
                      transition: type,
                    },
                  ]);
                  select(steps.length);
                  setAdding(false);
                }}
              >
                <strong>
                  {type === "hold" ? "Hold temperature" : "Ramp gradually"}
                </strong>
                <small>
                  {type === "hold"
                    ? "Keep a fixed target for a set duration."
                    : "Move gradually from the previous target to a new one."}
                </small>
              </button>
            ))}
          </div>
          <button
            className="secondary"
            type="button"
            onClick={() => setAdding(false)}
          >
            Cancel
          </button>
        </Modal>
      )}
    </div>
  );
}
