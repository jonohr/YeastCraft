import { BatchBrewfatherExport } from "./brewfather-stream";
// SPDX-License-Identifier: GPL-3.0-only
import { useState } from "react";
import { api, type Entity } from "./api";
import { formatDate } from "./preferences";

export default function BrewfatherSync({
  batch,
  refresh,
}: {
  batch: Entity;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sync = batch.data.brewfather_sync || {};
  const active = batch.data.status === "active";
  async function update() {
    setBusy(true);
    setError("");
    try {
      const result = await api<any>(
        "/batches/" + encodeURIComponent(batch.id) + "/brewfather-sync",
        "POST",
        {},
      );
      if (result.error) setError(result.error);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card brewfather-sync" aria-label="Brewfather readings">
      <div className="section-title">
        <h2>Brewfather · #{batch.data.brewfather.number}</h2>
        {active && (
          <button className="secondary" disabled={busy} onClick={update}>
            {busy ? "Syncing…" : "Sync readings"}
          </button>
        )}
      </div>
      <p>
        {active
          ? "Manual SG readings sync every 15 minutes while this batch is active."
          : "Sync stopped. Readings recorded during this batch are kept."}
      </p>
      {sync.latest && (
        <p>
          <strong>{Number(sync.latest.sg).toFixed(3)} SG</strong> · Manual ·
          Brewfather · {formatDate(sync.latest.time)}
        </p>
      )}
      <small>
        {sync.last_success
          ? "Last synced " + formatDate(sync.last_success)
          : "No readings synced yet."}
      </small>
      {(error || sync.error) && <p role="alert">{error || sync.error}</p>}
      {sync.warning && <p role="status">{sync.warning}</p>}
      <BatchBrewfatherExport batch={batch} refresh={refresh} />
    </section>
  );
}
