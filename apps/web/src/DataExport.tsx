import { useEffect, useState, type FormEvent } from "react";
import { api, download } from "./api";
type Access = {
  id: string;
  label: string;
  scopes: ("reports" | "export")[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  active: boolean;
};
type AccessList = {
  dashboardIncluded: boolean;
  dashboardUrl: string | null;
  syncConfigured: boolean;
  tokens: Access[];
};
const day = (v: string) => new Date(v).toLocaleDateString("en-NG");
export function DataExport({ writable }: { writable: boolean }) {
  const [list, setList] = useState<AccessList | null>(null),
    [issued, setIssued] = useState<{ token: string; label: string } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => setList(await api<AccessList>("/remote-access"));
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function perform(fn: () => Promise<string | void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const m = await fn();
      if (m) setMessage(m);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const scopes = ["reports", "export"].filter((s) => f.get(s) === "on");
    const label = String(f.get("label"));
    void perform(async () => {
      if (!scopes.length) throw new Error("Choose what the link may open.");
      const r = await api<{ token: string }>("/remote-access", {
        method: "POST",
        body: JSON.stringify({ label, days: Number(f.get("days")), scopes }),
      });
      setIssued({ token: r.token, label });
      (e.target as HTMLFormElement).reset();
    });
  }
  const link =
    issued && list?.dashboardUrl
      ? `${list.dashboardUrl}#${issued.token}`
      : null;
  return (
    <div className="stack">
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
      <div className="grid">
        <section className="panel">
          <div className="eyebrow">Departure export</div>
          <h2>Download all hotel data</h2>
          <p>
            One ZIP file with every guest, stay, folio, charge, payment,
            receipt, sale, stock movement, staff record and the full audit
            trail, each as a CSV file. A manifest lists row counts and
            checksums. Passwords and payment gateway keys are never included.
          </p>
          <p>
            This works without internet and while the hotel is read-only, so
            records can always be taken away. Each export is recorded in the
            audit trail.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await download("/exports/tenant");
                return "Export downloaded. Keep it somewhere safe: it contains guest records.";
              })
            }
          >
            {busy ? "Preparing export…" : "Download full export (.zip)"}
          </button>
        </section>
        <section className="panel">
          <div className="eyebrow">Remote access</div>
          <h2>Management dashboard</h2>
          <p>
            Owners and managers can read reports from anywhere through the cloud
            copy, without a staff login.{" "}
            {list?.dashboardIncluded
              ? ""
              : "The dashboard is part of the Premium plan; export-only links work on every plan."}
          </p>
          {list && !list.syncConfigured ? (
            <div className="notice">
              Cloud sync is off on this hub. Links only work once the hub has
              synced to the cloud.
            </div>
          ) : null}
          {/* Remounts once the plan is known, so the default scopes match it. */}
          <form onSubmit={create} key={String(list?.dashboardIncluded)}>
            <label htmlFor="label">Who is this link for?</label>
            <input
              id="label"
              name="label"
              required
              minLength={2}
              maxLength={80}
              placeholder="Owner's phone"
            />
            <label htmlFor="days">Valid for</label>
            <select id="days" name="days" defaultValue="30">
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
            </select>
            <fieldset className="checks">
              <legend>The link may open</legend>
              <label className="inline">
                <input
                  type="checkbox"
                  name="reports"
                  defaultChecked={list?.dashboardIncluded}
                  disabled={!list?.dashboardIncluded}
                />
                Reports dashboard
              </label>
              <label className="inline">
                <input type="checkbox" name="export" />
                Data export download
              </label>
            </fieldset>
            <button disabled={busy || !writable}>Create access link</button>
          </form>
        </section>
      </div>
      {issued ? (
        <section className="panel issued" role="status">
          <h2>Access link for {issued.label}</h2>
          <p>
            Copy it now. It is shown only once and works after the next cloud
            sync. Anyone with the link can read these reports, so send it
            privately.
          </p>
          <code className="secret">{link ?? issued.token}</code>
          <div className="row">
            <button
              className="secondary"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(link ?? issued.token)
                  .then(() => setMessage("Copied."))
                  .catch(() =>
                    setError("Copy failed. Select the text and copy it."),
                  )
              }
            >
              Copy
            </button>
            <button className="link" onClick={() => setIssued(null)}>
              I have saved it
            </button>
          </div>
          {!list?.dashboardUrl ? (
            <small className="muted">
              Open the dashboard address your provider gave you and paste this
              access code.
            </small>
          ) : null}
        </section>
      ) : null}
      <section className="panel table-wrap">
        <div className="panel-head">
          <div>
            <h2>Access links</h2>
            <small>Revoking takes effect in the cloud on the next sync.</small>
          </div>
        </div>
        {list?.tokens.length ? (
          <table>
            <thead>
              <tr>
                <th>For</th>
                <th>Opens</th>
                <th>Created</th>
                <th>Expires</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.label}</td>
                  <td>
                    {t.scopes
                      .map((s) => (s === "reports" ? "Reports" : "Export"))
                      .join(", ")}
                  </td>
                  <td>{day(t.createdAt)}</td>
                  <td>{day(t.expiresAt)}</td>
                  <td>
                    <span className={`badge ${t.active ? "" : "warn"}`}>
                      {t.revokedAt
                        ? "Revoked"
                        : t.active
                          ? "Active"
                          : "Expired"}
                    </span>
                  </td>
                  <td>
                    {t.active ? (
                      <button
                        className="secondary"
                        disabled={busy || !writable}
                        onClick={() =>
                          void perform(async () => {
                            await api(`/remote-access/${t.id}`, {
                              method: "DELETE",
                            });
                            return `Link for ${t.label} revoked.`;
                          })
                        }
                      >
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No access links yet.</div>
        )}
      </section>
    </div>
  );
}
