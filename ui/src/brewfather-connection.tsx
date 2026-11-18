// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useState } from "react";
import { api } from "./api";
import { Modal, confirmAction } from "./dialogs";
type Connection = {
  connected: boolean;
  encrypted: boolean;
  needs_reconnect?: boolean;
};
export function BrewfatherConnectionForm({
  onConnected,
  onCancel,
  replace = false,
}: {
  onConnected: () => void;
  onCancel: () => void;
  replace?: boolean;
}) {
  const [user, setUser] = useState(""),
    [key, setKey] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/brewfather/connection", "PUT", {
        user_id: user.trim(),
        api_key: key.trim(),
      });
      setKey("");
      onConnected();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={connect} autoComplete="off">
      <p>
        Use your Brewfather User ID and an API key with{" "}
        <strong>batches.read</strong> access.
      </p>
      <label>
        User ID
        <input
          required
          value={user}
          onChange={(e) => setUser(e.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={256}
        />
      </label>
      <label>
        API key
        <input
          required
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="new-password"
          maxLength={1024}
          spellCheck={false}
        />
      </label>
      <p className="muted">
        The connection is tested before saving. Credentials are encrypted on the
        server.
      </p>
      {replace && (
        <p className="muted">
          Your existing connection stays active unless the new credentials pass
          the test.
        </p>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button disabled={busy || !user.trim() || !key.trim()}>
          {busy
            ? "Connecting…"
            : replace
              ? "Test & replace connection"
              : "Connect Brewfather"}
        </button>
      </div>
    </form>
  );
}
export default function BrewfatherConnection() {
  const [status, setStatus] = useState<Connection | null>(null),
    [edit, setEdit] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  async function refresh() {
    try {
      setStatus(await api("/brewfather/connection"));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function test() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/brewfather/connection/test", "POST", {});
      setMessage("Connection verified · batches.read access works.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    if (
      !(await confirmAction(
        "Disconnect Brewfather? YeastCraft batches and temperature control will stay unchanged.",
      ))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api("/brewfather/connection", "DELETE");
      setMessage("Disconnected");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>Brewfather connection</h2>
      <p>
        {status?.connected
          ? "Connected · credentials stored encrypted"
          : status?.needs_reconnect
            ? "The saved connection cannot be unlocked. Restore the server encryption key, or disconnect and reconnect."
            : "Connect your Brewfather account once to use it in YeastCraft."}
      </p>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="form-actions">
        <button disabled={busy || !status} onClick={() => setEdit(true)}>
          {status?.connected ? "Replace credentials" : "Connect Brewfather"}
        </button>
        {status?.connected && (
          <button className="secondary" disabled={busy} onClick={test}>
            Test connection
          </button>
        )}
        {(status?.connected || status?.needs_reconnect) && (
          <button className="secondary" disabled={busy} onClick={disconnect}>
            Disconnect
          </button>
        )}
      </div>
      {edit && (
        <Modal
          title={
            status?.connected
              ? "Replace Brewfather credentials"
              : "Connect Brewfather"
          }
          onClose={() => setEdit(false)}
        >
          <BrewfatherConnectionForm
            replace={status?.connected}
            onCancel={() => setEdit(false)}
            onConnected={() => {
              setEdit(false);
              setMessage("Connected · credentials stored encrypted");
              void refresh();
            }}
          />
        </Modal>
      )}
    </section>
  );
}
