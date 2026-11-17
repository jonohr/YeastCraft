// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api";
type Entry = {
  time: number;
  direction: string;
  line: string;
  truncated: boolean;
};
export default function ProtocolLog({ device }: { device: string }) {
  const [open, setOpen] = useState(false),
    [rows, setRows] = useState<Entry[]>([]),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const data = await api<Entry[]>(
          `/devices/${encodeURIComponent(device)}/protocol-log`,
        );
        if (active) {
          setRows(data);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    const timer = setInterval(load, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open, device, refresh]);
  return (
    <details
      className="card protocol-log"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>BrewPi raw log</summary>
      {open && (
        <>
          <p className="muted">
            Recent raw traffic: RX is received from BrewPi, TX is sent to it.
            Reading this log sends no commands. Refreshes every 30 seconds.
          </p>
          <p className="muted">
            Up to 200 recent lines per controller from a shared 500-line memory
            buffer. Cleared when the app restarts. Long lines are marked as
            truncated.
          </p>
          <button
            className="secondary"
            disabled={loading}
            onClick={() => setRefresh((n) => n + 1)}
          >
            {loading ? "Loading…" : "Refresh log"}
          </button>
          {error && <p role="alert">{error}</p>}
          {!error && !rows.length && !loading && (
            <p>
              No traffic captured yet. Connect the controller and wait for its
              next reading.
            </p>
          )}
          <pre aria-label="Raw BrewPi traffic" tabIndex={0}>
            {rows.map((r, i) => (
              <div key={i}>
                {new Date(r.time).toISOString()} {r.direction} {r.line}
                {r.truncated ? " … [truncated]" : ""}
              </div>
            ))}
          </pre>
        </>
      )}
    </details>
  );
}
