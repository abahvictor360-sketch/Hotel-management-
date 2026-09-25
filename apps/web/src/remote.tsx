import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { ReportsView, type ReportSource } from "./Reports";
import { saveResponse } from "./api";
import { Icon } from "./icons";
// Read-only management dashboard, served by the cloud sync API from the cloud copy.
// The access code comes from a hotel administrator. It is kept for this browser tab only.
type Session = {
  hotel: string;
  label: string;
  scopes: string[];
  expiresAt: string;
  dashboard: boolean;
  subscription: string | null;
  lastSyncAt: string | null;
};
const KEY = "hotel-remote-access";
const read = () => {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
};
const keep = (v: string) => {
  try {
    if (v) sessionStorage.setItem(KEY, v);
    else sessionStorage.removeItem(KEY);
  } catch {}
};
// A shared link carries the code after "#", which browsers never send to a server.
const fromLink = location.hash.startsWith("#hh1.")
  ? location.hash.slice(1)
  : "";
if (fromLink) {
  keep(fromLink);
  history.replaceState(null, "", location.pathname);
}
async function call(token: string, path: string) {
  let res: Response;
  try {
    res = await fetch(`/api/remote${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new Error(
      "The dashboard could not be reached. Check your internet connection.",
    );
  }
  return res;
}
async function json<T>(token: string, path: string): Promise<T> {
  const res = await call(token, path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(new Error(body.error ?? "Request failed."), {
      status: res.status,
    });
  return body as T;
}
const q = (kind: string, from: string, to: string) =>
  `/reports/${kind}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
function Remote() {
  const [token, setToken] = useState(read()),
    [session, setSession] = useState<Session | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!token) return;
    setBusy(true);
    json<Session>(token, "/session")
      .then((s) => {
        setSession(s);
        setError("");
      })
      .catch((e) => {
        setSession(null);
        setError(e.message);
        if (e.status === 401) {
          keep("");
          setToken("");
        }
      })
      .finally(() => setBusy(false));
  }, [token]);
  function signIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = String(new FormData(e.currentTarget).get("code") ?? "")
      .trim()
      .replace(/^.*#/, "");
    keep(v);
    setToken(v);
  }
  if (!session)
    return (
      <main className="login">
        <span className="brand-mark" aria-hidden="true">
          <Icon name="chart" />
        </span>
        <h1>Hotel management dashboard</h1>
        <p className="muted">
          Read-only reports from your hotel's cloud copy. Paste the access link
          or code your hotel administrator created for you.
        </p>
        {error ? (
          <div className="error-message" role="alert">
            {error}
          </div>
        ) : null}
        <form onSubmit={signIn}>
          <label htmlFor="code">Access link or code</label>
          <input
            id="code"
            name="code"
            type="password"
            autoComplete="off"
            required
          />
          <button disabled={busy}>
            {busy ? "Checking…" : "Open dashboard"}
          </button>
        </form>
      </main>
    );
  const source: ReportSource = {
    load: (kind, from, to) => json(token, q(kind, from, to)),
    download: async (kind, from, to, format) =>
      saveResponse(await call(token, `${q(kind, from, to)}&format=${format}`)),
  };
  const synced = session.lastSyncAt
    ? `Data as of ${new Date(session.lastSyncAt).toLocaleString("en-NG")}`
    : "The hotel has not synced yet";
  return (
    <div className="remote">
      <header className="topbar">
        <div className="crumb">
          <span className="dot" aria-hidden="true" />
          {session.hotel}
        </div>
        <div className="row">
          <span className="sync-pill info">
            <Icon name="cloud" />
            {synced}
          </span>
          {session.scopes.includes("export") ? (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void call(token, "/export")
                  .then(saveResponse)
                  .catch((e) => setError((e as Error).message))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Preparing…" : "Download data export"}
            </button>
          ) : null}
          <button
            className="secondary"
            onClick={() => {
              keep("");
              setToken("");
              setSession(null);
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="content">
        <div className="intro">
          <div>
            <h1>Management dashboard</h1>
            <p>
              Read-only. Figures reach the cloud when the hotel hub syncs, every
              30 seconds while it is online. Access for {session.label} until{" "}
              {new Date(session.expiresAt).toLocaleDateString("en-NG")}.
            </p>
          </div>
        </div>
        {error ? (
          <div className="error-message" role="alert">
            {error}
          </div>
        ) : null}
        {session.dashboard && session.scopes.includes("reports") ? (
          <ReportsView source={source} />
        ) : (
          <div className="notice">
            {session.scopes.includes("reports")
              ? session.subscription &&
                !["trial", "active", "past_due"].includes(session.subscription)
                ? "The hotel's subscription is not active, so reports are closed. The data export is still available."
                : "The reports dashboard is not part of this hotel's plan."
              : "This link is for downloading the hotel's data export."}
          </div>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Remote />);
