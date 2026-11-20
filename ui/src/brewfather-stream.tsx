// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useState } from "react";
import { api, type Entity } from "./api";
import { Modal, confirmAction } from "./dialogs";
import { formatDate } from "./preferences";
import { Link } from "react-router-dom";
export default function BrewfatherStream() {
  const [status, setStatus] = useState<any>(null),
    [edit, setEdit] = useState(false),
    [url, setUrl] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const refresh = () =>
    api("/brewfather/stream")
      .then(setStatus)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
  }, []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/brewfather/stream", "PUT", { url: url.trim() });
      setUrl("");
      setEdit(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !(await confirmAction(
        "Remove Custom Stream? Sending stops for every batch. Incoming readings and temperature control continue.",
      ))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api("/brewfather/stream", "DELETE");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-label="Brewfather outbound setup">
      <h2>Send measurements to Brewfather</h2>
      <p>
        Custom Stream sends equipment temperatures and automatic iSpindel SG.
        Your API connection handles incoming readings separately.
      </p>
      <p>
        {status?.configured
          ? "Custom Stream URL saved encrypted. Enable sending on each active batch."
          : "Copy the Custom Stream URL from Brewfather → Settings → Power-ups."}
      </p>
      {status?.needs_reconnect && (
        <p role="alert">
          The saved URL cannot be unlocked. Restore the server key or replace
          the URL.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="form-actions brewfather-connection-actions">
        <button disabled={busy} onClick={() => setEdit(true)}>
          {status?.configured ? "Replace stream URL" : "Set up Custom Stream"}
        </button>
        {(status?.configured || status?.needs_reconnect) && (
          <button className="secondary" disabled={busy} onClick={remove}>
            Remove stream URL
          </button>
        )}
      </div>
      {edit && (
        <Modal
          title="Custom Stream URL"
          onClose={() => {
            setEdit(false);
            setUrl("");
          }}
        >
          <form onSubmit={save} autoComplete="off">
            <label>
              Custom Stream URL
              <input
                aria-label="Custom Stream URL"
                type="password"
                autoComplete="new-password"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                maxLength={1024}
              />
            </label>
            <p>
              Stored encrypted and never shown again. Saving or replacing the
              URL pauses sending until you enable it on a batch. No test
              measurement is sent.
            </p>
            {error && <p role="alert">{error}</p>}
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEdit(false);
                  setUrl("");
                }}
              >
                Cancel
              </button>
              <button disabled={busy || !url.trim()}>
                {busy ? "Saving…" : "Save stream URL"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
export function BatchBrewfatherExport({
  batch,
  refresh,
}: {
  batch: Entity;
  refresh: () => void;
}) {
  const [state, setState] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const hasEquipment = !!(batch.data.device || batch.data.sensor);
  useEffect(() => {
    if (!hasEquipment) return;
    let live = true;
    api("/batches/" + encodeURIComponent(batch.id) + "/brewfather-export")
      .then((v) => {
        if (live) {
          setState(v);
          setError("");
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [
    batch.id,
    batch.data.status,
    batch.data.brewfather_export?.last_attempt,
    batch.data.brewfather_export?.last_success,
    batch.data.brewfather_export?.error,
    batch.data.brewfather_export?.enabled,
    hasEquipment,
  ]);
  async function toggle() {
    setBusy(true);
    setError("");
    try {
      setState(
        await api(
          "/batches/" + encodeURIComponent(batch.id) + "/brewfather-export",
          "PUT",
          { enabled: !state.enabled },
        ),
      );
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="brewfather-outbound" aria-label="Send batch measurements">
      <h3>Send measurements</h3>
      {!hasEquipment ? (
        <p>
          Choose a controller or sensor for this batch to send measurements.
        </p>
      ) : (
        <>
          {state?.device_name && (
            <p>
              Device in Brewfather: <strong>{state.device_name}</strong>
            </p>
          )}
          <p>
            Attach this device under Brewfather batch #
            {batch.data.brewfather.number} → Readings → Devices. YeastCraft
            keeps the equipment name when you change batches.
          </p>
          {state?.connection?.configured === false ? (
            <p>
              <Link to="/integrations">Set up Custom Stream in Settings</Link>
            </p>
          ) : (
            <>
              {state?.connection?.exports_enabled === false && (
                <p>Exports are disabled on this server.</p>
              )}
              {batch.data.status === "active" && (
                <button
                  className="secondary"
                  disabled={
                    busy ||
                    !state ||
                    (!state.enabled && !state.connection?.exports_enabled)
                  }
                  onClick={toggle}
                >
                  {busy
                    ? "Saving…"
                    : state?.enabled
                      ? "Stop sending"
                      : "Start sending"}
                </button>
              )}
            </>
          )}
          <p>
            {batch.data.status !== "active"
              ? "Sending stopped with this batch."
              : state?.enabled
                ? "Sending fresh equipment readings every 15 minutes. Manual Brewfather measurements are not sent back."
                : "Sending is off."}
          </p>
          {state?.last_success && (
            <small>
              Last delivery accepted {formatDate(state.last_success)}. Attach in
              Brewfather to record it in the batch.
            </small>
          )}
          {(error || state?.error) && (
            <p role="alert">{error || state.error}</p>
          )}
        </>
      )}
    </div>
  );
}
