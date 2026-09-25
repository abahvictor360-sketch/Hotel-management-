import { useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
type Tenant = {
  id: string;
  name: string;
  slug: string;
  subscription: {
    plan: string;
    status: string;
    max_devices: number;
    max_rooms: number;
  } | null;
  health: { hub_version: string; device_count: number; seen_at: string } | null;
};
function App() {
  const [token, setToken] = useState(""),
    [rows, setRows] = useState<Tenant[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [issued, setIssued] = useState<{
      tenantId?: string;
      licenseKey: string;
    } | null>(null);
  async function call(path: string, method = "GET", body?: unknown, t = token) {
    const r = await fetch(`/api/provider${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(t ? { Authorization: `Bearer ${t}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) throw new Error((await r.json()).error ?? "Request failed");
    return r.status === 204 ? undefined : r.json();
  }
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const values = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget).entries());
  };
  if (!token)
    return (
      <main className="login">
        <div className="eyebrow">Provider console</div>
        <h1>Hotel Hub control</h1>
        <p className="muted">Private access for the product owner.</p>
        {error ? (
          <p className="error-message" role="alert">
            {error}
          </p>
        ) : null}
        <form
          onSubmit={(e) => {
            const body = values(e);
            void act(async () => {
              const data = await call("/login", "POST", body);
              setRows(
                await call("/tenants", "GET", undefined, data.accessToken),
              );
              setToken(data.accessToken);
            });
          }}
        >
          <label htmlFor="password">Provider password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <button disabled={busy}>Sign in</button>
        </form>
      </main>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          hotel<em>hub.</em>
        </div>
        <p className="mt-2 text-sm">Provider console</p>
        <nav>
          <button className="active">Hotels & subscriptions</button>
        </nav>
        <footer>
          Separate provider access
          <br />
          No guest or payment data
        </footer>
      </aside>
      <div>
        <header className="topbar">
          <span>Product administration</span>
          <button
            className="secondary"
            onClick={() => {
              setToken("");
              setRows([]);
              setIssued(null);
            }}
          >
            Sign out
          </button>
        </header>
        <main className="content">
          <div className="intro">
            <div>
              <div className="eyebrow">Portfolio</div>
              <h1>Your hotels</h1>
              <p>Onboard hotels and manage their access.</p>
            </div>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => setRows(await call("/tenants")))
              }
            >
              Refresh
            </button>
          </div>
          {error ? (
            <p className="error-message" role="alert">
              {error}
            </p>
          ) : null}
          {issued ? (
            <div className="notice">
              <p>Copy this licence key now. It is shown only once.</p>
              {issued.tenantId ? <p>Hotel ID: {issued.tenantId}</p> : null}
              <pre>{issued.licenseKey}</pre>
              <button className="secondary" onClick={() => setIssued(null)}>
                Dismiss
              </button>
            </div>
          ) : null}
          <div className="cards">
            <section className="card">
              <small>Hotels</small>
              <strong>{rows.length}</strong>
              <small>First 100 tenants</small>
            </section>
            <section className="card">
              <small>Active / trial</small>
              <strong>
                {
                  rows.filter((r) =>
                    ["active", "trial"].includes(r.subscription?.status ?? ""),
                  ).length
                }
              </strong>
              <small>Subscriptions in service</small>
            </section>
            <section className="card">
              <small>Need attention</small>
              <strong>
                {
                  rows.filter((r) =>
                    ["past_due", "suspended"].includes(
                      r.subscription?.status ?? "",
                    ),
                  ).length
                }
              </strong>
              <small>Review billing and access</small>
            </section>
          </div>
          <div className="grid">
            <section className="panel table-wrap">
              <h2>Tenant subscriptions</h2>
              <table>
                <thead>
                  <tr>
                    <th>Hotel</th>
                    <th>Plan</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.name}
                        <br />
                        <small>
                          {r.health
                            ? `Hub ${r.health.hub_version} · ${r.health.device_count} devices`
                            : "No telemetry received"}
                        </small>
                      </td>
                      <td>{r.subscription?.plan}</td>
                      <td>
                        <span className="badge">{r.subscription?.status}</span>
                      </td>
                      <td>
                        <div className="row">
                          <button
                            disabled={busy}
                            className="secondary"
                            onClick={() =>
                              void act(async () => {
                                await call(
                                  `/tenants/${r.id}/subscription`,
                                  "PATCH",
                                  {
                                    status:
                                      r.subscription?.status === "suspended"
                                        ? "active"
                                        : "suspended",
                                  },
                                );
                                setRows(await call("/tenants"));
                              })
                            }
                          >
                            {r.subscription?.status === "suspended"
                              ? "Reactivate"
                              : "Suspend"}
                          </button>
                          <button
                            disabled={busy}
                            className="secondary"
                            onClick={() =>
                              void act(async () => {
                                await call(
                                  `/tenants/${r.id}/subscription`,
                                  "PATCH",
                                  {
                                    status: "trial",
                                    trialEndsAt: new Date(
                                      Date.now() + 14 * 86400000,
                                    ).toISOString(),
                                  },
                                );
                                setRows(await call("/tenants"));
                              })
                            }
                          >
                            14-day trial
                          </button>
                          <button
                            disabled={busy}
                            className="secondary"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Replace the licence key for ${r.name}? The previous key will stop renewing.`,
                                )
                              )
                                void act(async () =>
                                  setIssued(
                                    await call(
                                      `/tenants/${r.id}/license`,
                                      "POST",
                                    ),
                                  ),
                                );
                            }}
                          >
                            New licence
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!rows.length ? (
                <p>No hotels yet. Create your first hotel.</p>
              ) : null}
            </section>
            <section className="panel">
              <h2>Onboard a hotel</h2>
              <form
                onSubmit={(e) => {
                  const body = values(e);
                  const form = e.currentTarget;
                  void act(async () => {
                    setIssued(await call("/tenants", "POST", body));
                    setRows(await call("/tenants"));
                    form.reset();
                  });
                }}
              >
                <label htmlFor="name">Hotel name</label>
                <input id="name" name="name" required />
                <label htmlFor="slug">Hotel reference</label>
                <input
                  id="slug"
                  name="slug"
                  pattern="[a-z0-9-]{3,60}"
                  placeholder="example-hotel"
                  required
                />
                <label htmlFor="plan">Plan</label>
                <select id="plan" name="plan">
                  <option value="standard">
                    Standard · 8 devices / 50 rooms
                  </option>
                  <option value="premium">
                    Premium · 25 devices / 200 rooms
                  </option>
                </select>
                <button disabled={busy}>Create hotel & licence</button>
              </form>
              <p>
                New hotels begin with a 14-day trial. Use the hub provisioning
                command to create the hotel administrator.
              </p>
            </section>
          </div>
          <p className="footer-note">
            Phase 1 · Cloud operational reports and fleet telemetry arrive in
            later phases.
          </p>
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
