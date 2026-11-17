// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, list, save, type Entity } from "./api";
import { Modal } from "./dialogs";
const services: Record<string, string> = {
  brewfather: "Brewfather",
  brewersfriend: "Brewer’s Friend",
  grainfather: "Grainfather",
  thingspeak: "ThingSpeak",
  generic: "Custom HTTPS destination",
};
export default function IntegrationSetup({
  initial,
  close,
  saved,
}: {
  initial?: Entity;
  close: () => void;
  saved: () => void;
}) {
  const [name, setName] = useState(initial?.name || ""),
    [service, setService] = useState(initial?.data.type || "brewfather"),
    [source, setSource] = useState(
      initial?.data.source || initial?.data.device || "",
    ),
    [url, setUrl] = useState(initial?.data.url || ""),
    [key, setKey] = useState(initial?.data.api_key || ""),
    [interval, setInterval] = useState(initial?.data.interval || 15),
    [resources, setResources] = useState<Entity[]>([]),
    [diag, setDiag] = useState<any>(null),
    [record, setRecord] = useState<Entity | null>(initial || null),
    [preview, setPreview] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [step, setStep] = useState(0);
  useEffect(() => {
    Promise.all([list("devices"), list("sensors"), api("/diagnostics")])
      .then(([d, s, v]) => {
        setResources([...d, ...s]);
        setDiag(v);
      })
      .catch((e) => setError(e.message));
  }, []);
  const chosen = resources.find((e) => e.id === source);
  async function review() {
    setBusy(true);
    setError("");
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:")
        throw Error("Enter the HTTPS destination supplied by your service.");
      if (!chosen) throw Error("Choose a data source.");
      if (
        !Number.isFinite(Number(interval)) ||
        +interval < (service === "brewfather" ? 15 : 1)
      )
        throw Error("Check the sending interval.");
      if (["thingspeak", "brewersfriend"].includes(service) && !key.trim())
        throw Error("Enter the API key supplied by your service.");
      const latest = record
        ? await api<Entity>(
            `/resources/integrations/${encodeURIComponent(record.id)}`,
          )
        : null;
      const e = await save(
        "integrations",
        name.trim() || `${services[service]} · ${chosen.name}`,
        {
          ...latest?.data,
          type: service,
          source,
          url,
          api_key: key,
          interval: Number(interval),
          enabled: false,
        },
        record?.id,
      );
      setRecord(e);
      saved();
      setPreview(
        await api(`/integrations/${encodeURIComponent(e.id)}/preview`),
      );
      setStep(1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Connect an external service"
      onClose={() => {
        if (!busy) close();
      }}
    >
      <p>
        Choose a service and source, check the outgoing measurements, then
        activate delivery.
      </p>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {step === 0 ? (
        <>
          <label>
            Service
            <select
              value={service}
              onChange={(e) => setService(e.target.value)}
            >
              {Object.entries(services).map(([v, t]) => (
                <option value={v} key={v}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name (optional)
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Data source
            <select
              aria-label="Data source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">Choose equipment</option>
              {resources.map((e) => (
                <option value={e.id} key={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {services[service]} HTTPS endpoint
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <p className="muted">
            Use the receiving URL from your service’s device/integration
            settings. Keep URLs containing tokens private.
          </p>
          {["brewersfriend", "thingspeak"].includes(service) && (
            <label>
              API key
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
          )}
          <label>
            Interval (minutes)
            <input
              type="number"
              min={service === "brewfather" ? 15 : 1}
              value={interval}
              onChange={(e) => setInterval(Number(e.target.value))}
            />
          </label>
          <p className="muted">
            Saving these settings pauses this destination until you activate it.
            Preview is local and does not send data.
          </p>
          {diag && !diag.exports_enabled && (
            <p className="alert">
              Server exports are disabled. You can configure and preview, but
              the administrator must enable exports before delivery can be
              activated.
            </p>
          )}
          <div className="form-actions">
            <button className="secondary" disabled={busy} onClick={close}>
              Cancel
            </button>
            <button
              disabled={busy || !diag || !source || !url}
              onClick={review}
            >
              {busy ? "Checking…" : "Save and preview"}
            </button>
          </div>
          {chosen && (
            <Link
              to={`/${chosen.kind}/${encodeURIComponent(chosen.id)}`}
              target="_blank"
            >
              Check source readings in a new tab
            </Link>
          )}
        </>
      ) : (
        <>
          <h3>Review delivery</h3>
          <p>
            {services[service]} · {chosen?.name} · every {interval} minutes
          </p>
          <p>
            This preview uses the selected source’s latest reading. No test
            message has been sent.
          </p>
          <dl>
            {Object.entries(preview || {})
              .filter(
                ([k, v]) =>
                  !["api_key", "token", "values"].includes(k) &&
                  typeof v !== "object",
              )
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{k.replaceAll("_", " ")}</dt>
                  <dd>{String(v ?? "Not available")}</dd>
                </div>
              ))}
          </dl>
          <details>
            <summary>Technical payload (credentials hidden)</summary>
            <pre>
              {JSON.stringify(
                preview,
                (k, v) => (["api_key", "token"].includes(k) ? "[hidden]" : v),
                2,
              )}
            </pre>
          </details>
          <p className="alert">
            Activation permits real delivery on the server’s next export cycle.
            Check the destination’s last successful delivery afterwards.
          </p>
          <div className="form-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setStep(0)}
            >
              Edit settings
            </button>
            <button className="secondary" disabled={busy} onClick={close}>
              Keep disabled
            </button>
            <button
              disabled={busy || !diag?.exports_enabled}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const e = await api<Entity>(
                    `/resources/integrations/${encodeURIComponent(record!.id)}`,
                  );
                  await save(
                    "integrations",
                    e.name,
                    { ...e.data, enabled: true },
                    e.id,
                  );
                  saved();
                  close();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Activate delivery
            </button>
          </div>
          {!diag?.exports_enabled && (
            <p>
              Ask the administrator to enable server exports before activating.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
