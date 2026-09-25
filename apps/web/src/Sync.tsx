import { useEffect, useState } from "react";
import { api } from "./api";
export type SyncStatus = {
  state: "synced" | "syncing" | "offline" | "error" | "disabled";
  pending: number;
  failed: number;
  configured: boolean;
  online: boolean | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};
type QueueRow = {
  id: string;
  table_name: string;
  record_id: string;
  operation: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  next_attempt_at: string | null;
  device_id: string;
};
const when = (v: string | null) =>
  v ? new Date(v).toLocaleString("en-NG") : "Never";
export function syncLabel(s: SyncStatus | null) {
  if (!s) return { text: "Checking sync", tone: "neutral" };
  switch (s.state) {
    case "synced":
      return { text: "Online and synced", tone: "ok" };
    case "syncing":
      return { text: `Syncing (${s.pending} pending)`, tone: "info" };
    case "offline":
      return { text: `Offline (${s.pending} records pending)`, tone: "warn" };
    case "error":
      return {
        text: s.failed ? `Sync error (${s.failed} failed)` : "Sync error",
        tone: "error",
      };
    default:
      return { text: `Cloud sync off (${s.pending} queued)`, tone: "neutral" };
  }
}
export function SyncPage({
  status,
  refresh,
  canManage,
}: {
  status: SyncStatus | null;
  refresh: () => Promise<void>;
  canManage: boolean;
}) {
  const [view, setView] = useState<"failed" | "pending">("failed");
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    if (canManage) {
      const q = await api<{ rows: QueueRow[]; total: number }>(
        `/sync/queue?status=${view}`,
      );
      setRows(q.rows);
      setTotal(q.total);
      setSelected([]);
    }
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [view, status?.pending, status?.failed]);
  async function perform(fn: () => Promise<string>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setMessage(await fn());
      await refresh();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const label = syncLabel(status);
  return (
    <div className="stack">
      {status?.failed ? (
        <div className="error-message" role="alert">
          {status.failed} record{status.failed === 1 ? "" : "s"} stopped
          syncing after 10 attempts. Review the error below, fix the cause, then
          retry.
        </div>
      ) : null}
      {error ? (
        <div className="error-message" role="alert">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="success" role="status">
          {message}
        </div>
      ) : null}
      <div className="cards four">
        {[
          ["Connection", label.text, `Last check ${when(status?.lastAttemptAt ?? null)}`, "blue"],
          ["Pending", String(status?.pending ?? "—"), "Waiting to reach the cloud", "yellow"],
          ["Failed", String(status?.failed ?? "—"), "Need an administrator", "pink"],
          ["Last full sync", when(status?.lastSuccessAt ?? null), "Every 30 seconds when online", "green"],
        ].map(([title, value, hint, tint]) => (
          <section className={`stat tint-${tint}`} key={title}>
            <header>{title}</header>
            <div>
              <strong className={title === "Connection" || title === "Last full sync" ? "small-value" : ""}>
                {value}
              </strong>
              <small>{hint}</small>
            </div>
          </section>
        ))}
      </div>
      {status?.lastError ? (
        <div className="notice">Last error: {status.lastError}</div>
      ) : null}
      {status && !status.configured ? (
        <div className="notice">
          Cloud sync is not configured on this hub. Set SYNC_DATABASE_URL,
          CLOUD_SYNC_URL and HUB_LICENSE_KEY, then restart. Every change is
          still recorded and will upload once sync is enabled.
        </div>
      ) : null}
      {canManage ? (
        <section className="panel table-wrap">
          <div className="panel-head">
            <div>
              <h2>Outbox</h2>
              <small>
                {total} {view} record{total === 1 ? "" : "s"}, oldest first
              </small>
            </div>
            <div className="row">
              <div className="segmented" role="tablist">
                {(["failed", "pending"] as const).map((v) => (
                  <button
                    key={v}
                    role="tab"
                    aria-selected={view === v}
                    className={view === v ? "active" : ""}
                    onClick={() => setView(v)}
                  >
                    {v === "failed" ? "Failed" : "Pending"}
                  </button>
                ))}
              </div>
              <button
                className="secondary"
                disabled={busy || !status?.configured}
                onClick={() =>
                  void perform(async () => {
                    await api("/sync/run", { method: "POST", body: "{}" });
                    return "Sync started.";
                  })
                }
              >
                Sync now
              </button>
              {view === "failed" ? (
                <>
                  <button
                    className="secondary"
                    disabled={busy || !selected.length}
                    onClick={() =>
                      void perform(async () => {
                        const r = await api<{ retried: number }>("/sync/retry", {
                          method: "POST",
                          body: JSON.stringify({ ids: selected }),
                        });
                        return `${r.retried} record(s) queued again.`;
                      })
                    }
                  >
                    Retry selected
                  </button>
                  <button
                    disabled={busy || !total}
                    onClick={() =>
                      void perform(async () => {
                        const r = await api<{ retried: number }>("/sync/retry", {
                          method: "POST",
                          body: JSON.stringify({ allFailed: true }),
                        });
                        return `${r.retried} record(s) queued again.`;
                      })
                    }
                  >
                    Retry all failed
                  </button>
                </>
              ) : null}
            </div>
          </div>
          {rows.length ? (
            <table>
              <thead>
                <tr>
                  {view === "failed" ? <th aria-label="Select" /> : null}
                  <th>Recorded</th>
                  <th>Record</th>
                  <th>Change</th>
                  <th>Attempts</th>
                  <th>{view === "failed" ? "Error" : "Next try"}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    {view === "failed" ? (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.table_name} ${r.record_id}`}
                          checked={selected.includes(r.id)}
                          onChange={(e) =>
                            setSelected((s) =>
                              e.target.checked
                                ? [...s, r.id]
                                : s.filter((x) => x !== r.id),
                            )
                          }
                        />
                      </td>
                    ) : null}
                    <td>{when(r.created_at)}</td>
                    <td>
                      {r.table_name.replace(/_/g, " ")}
                      <br />
                      <small className="mono">{r.record_id.slice(0, 8)}</small>
                    </td>
                    <td>
                      <span className="badge">{r.operation}</span>
                    </td>
                    <td>{r.attempts}/10</td>
                    <td className="wrap">
                      {view === "failed"
                        ? r.last_error
                        : r.next_attempt_at
                          ? `${when(r.next_attempt_at)} · ${r.last_error ?? ""}`
                          : "Next cycle"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty">
              {view === "failed"
                ? "Nothing has failed. Every change is either uploaded or waiting its turn."
                : "Nothing is waiting. The cloud copy is up to date."}
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
