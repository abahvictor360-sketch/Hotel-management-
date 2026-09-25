import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { api, restoreSession, setToken } from "./api";
import "./styles.css";
import { FrontDesk } from "./FrontDesk";
type Identity = {
  userId: string;
  permissions: string[];
  forcePasswordChange: boolean;
  roleName: string;
};
type Role = { id: string; name: string; permissions: string[] };
type Staff = {
  id: string;
  name: string;
  email: string;
  role_id: string;
  is_active: boolean;
  force_password_change: boolean;
};
type Device = { id: string; label: string; assigned_department: string | null };
type License = {
  writable: boolean;
  reason: string;
  claims: null | {
    plan: string;
    maxDevices: number;
    maxRooms: number;
    validUntil: number;
    status: string;
    features: Record<string, boolean>;
  };
};
type Dashboard = {
  staff: number | null;
  rooms: number;
  devices: number | null;
  pending: number;
  failed: number;
  license: License;
};
const formValues = (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  return Object.fromEntries(
    new FormData(event.currentTarget).entries(),
  ) as Record<string, string>;
};
function App() {
  const [who, setWho] = useState<Identity | null>(null),
    [loading, setLoading] = useState(true),
    [tab, setTab] = useState("Overview"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [branding, setBranding] = useState({ name: "Hotel Hub", logoUrl: "" }),
    [data, setData] = useState<Dashboard | null>(null),
    [reachable, setReachable] = useState(true),
    [staff, setStaff] = useState<Staff[]>([]),
    [roles, setRoles] = useState<Role[]>([]),
    [devices, setDevices] = useState<Device[]>([]),
    [audit, setAudit] = useState<any[]>([]);
  const can = (permission: string) =>
    who?.permissions.includes(permission) ?? false;
  async function load() {
    const profile = await api<Identity>("/auth/me");
    setWho(profile);
    if (!profile.forcePasswordChange) setData(await api("/dashboard"));
  }
  useEffect(() => {
    let cancelled = false;
    void api<typeof branding>("/branding")
      .then((v) => {
        if (!cancelled) setBranding(v);
      })
      .catch(() => {});
    void restoreSession()
      .then(async (ok) => {
        if (ok && !cancelled) await load();
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!who) return;
    let active = true;
    const timer = setInterval(() => {
      void api("/health")
        .then(() => {
          if (active) setReachable(true);
        })
        .catch(() => {
          if (active) setReachable(false);
        });
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [who?.userId]);
  useEffect(() => {
    if (!who || who.forcePasswordChange) return;
    let active = true;
    setError("");
    void (async () => {
      if (tab === "Staff") {
        const [s, r] = await Promise.all([
          api<Staff[]>("/users"),
          api<Role[]>("/roles"),
        ]);
        if (active) {
          setStaff(s);
          setRoles(r);
        }
      }
      if (tab === "Roles") {
        const r = await api<Role[]>("/roles");
        if (active) setRoles(r);
      }
      if (tab === "Devices") {
        const d = await api<Device[]>("/devices");
        if (active) setDevices(d);
      }
      if (tab === "Audit trail") {
        const a = await api<any[]>("/audit");
        if (active) setAudit(a);
      }
    })().catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
    };
  }, [tab, who?.userId, who?.forcePasswordChange]);
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const writable = reachable && !!data?.license.writable;
  if (loading)
    return (
      <main className="login">
        <p>Connecting to your hotel hub…</p>
      </main>
    );
  if (!who)
    return (
      <main className="login">
        <div className="eyebrow">Hotel management</div>
        {branding.logoUrl ? (
          <img className="logo" src={branding.logoUrl} alt="Hotel logo" />
        ) : null}
        <h1>{branding.name}</h1>
        <p className="muted">Sign in on your hotel network.</p>
        {error ? (
          <p className="error-message" role="alert">
            {error}
          </p>
        ) : null}
        <form
          onSubmit={(e) => {
            const v = formValues(e);
            void perform(async () => {
              const result = await api<{ accessToken: string }>("/auth/login", {
                method: "POST",
                body: JSON.stringify({
                  email: v.email,
                  password: v.password,
                  ...(v.deviceId ? { deviceId: v.deviceId } : {}),
                }),
              });
              setToken(result.accessToken);
              await load();
            });
          }}
        >
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <label htmlFor="deviceId">Registered device ID</label>
          <input
            id="deviceId"
            name="deviceId"
            defaultValue={localStorage.getItem("hotel-device-id") ?? ""}
            onChange={(e) =>
              localStorage.setItem("hotel-device-id", e.target.value)
            }
            placeholder="Required for production hubs"
          />
          <button className="w-full" disabled={busy}>
            Sign in
          </button>
        </form>
        <p className="footer-note">
          Your hotel data stays on the hub. Internet is not required to sign in.
        </p>
      </main>
    );
  if (who.forcePasswordChange)
    return (
      <main className="login">
        <h1>Set your password</h1>
        <p className="muted">
          Replace your temporary password before continuing.
        </p>
        {error ? (
          <p role="alert" className="error-message">
            {error}
          </p>
        ) : null}
        <form
          onSubmit={(e) => {
            const v = formValues(e);
            void perform(async () => {
              await api("/auth/password", {
                method: "POST",
                body: JSON.stringify(v),
              });
              setToken("");
              setWho(null);
              setMessage("Password changed. Sign in again.");
            });
          }}
        >
          <label htmlFor="current">Temporary password</label>
          <input
            id="current"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
          />
          <label htmlFor="new">New password, at least 12 characters</label>
          <input
            id="new"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={72}
            required
          />
          <button disabled={busy}>Save password and sign out</button>
        </form>
      </main>
    );
  const tabs = [
    ["Overview", ""],
    ["Front desk", "frontdesk.read"],
    ["Staff", "staff.read"],
    ["Roles", "roles.read"],
    ["Devices", "devices.read"],
    ["Settings", "settings.read"],
    ["Audit trail", "audit.read"],
  ].filter(([, p]) => !p || can(p));
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          hotel<em>hub.</em>
        </div>
        <small style={{ color: "#aac5b7", marginTop: 6 }}>
          Your hotel, connected locally
        </small>
        <nav aria-label="Main navigation">
          {tabs.map(([name]) => (
            <button
              key={name}
              className={name === tab ? "active" : ""}
              onClick={() => {
                setTab(name);
                setMessage("");
              }}
            >
              {name}
            </button>
          ))}
        </nav>
        <footer>
          Phase 2 · Front desk
          <br />
          Hub version 0.2.0
        </footer>
      </aside>
      <div>
        <header className="topbar">
          <span>{branding.name}</span>
          <div className="row">
            <span
              role="status"
              className={`badge ${!reachable ? "error" : "warn"}`}
            >
              {!reachable
                ? "Hub unreachable"
                : `Cloud sync not enabled · ${data?.pending ?? 0} queued`}
            </span>
            <span className="muted">{who.roleName}</span>
            <button
              className="secondary"
              onClick={() =>
                void perform(async () => {
                  await api("/auth/logout", { method: "POST" });
                  setToken("");
                  setWho(null);
                  setData(null);
                })
              }
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="content">
          <div className="intro">
            <div>
              <div className="eyebrow">Hotel workspace</div>
              <h1>{tab}</h1>
              <p>
                {tab === "Overview"
                  ? "Your operational foundation, in one place."
                  : "Manage access and hotel configuration."}
              </p>
            </div>
            <span className="badge">Phase 2</span>
          </div>
          {!reachable ? (
            <div className="notice" role="alert">
              Reconnect to the hotel LAN before making changes.{" "}
              <button
                className="secondary"
                onClick={() =>
                  void perform(async () => {
                    await load();
                    setReachable(true);
                  })
                }
              >
                Retry connection
              </button>
            </div>
          ) : null}
          {data && !data.license.writable ? (
            <div className="notice">Read-only: {data.license.reason}</div>
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
          {tab === "Overview" ? (
            <>
              <div className="cards">
                {[
                  [
                    "Configured rooms",
                    data?.rooms ?? "—",
                    "Configured hotel inventory",
                  ],
                  [
                    "Staff accounts",
                    data?.staff ?? "—",
                    "Access controlled by hotel roles",
                  ],
                  [
                    "Registered devices",
                    data?.devices ?? "—",
                    `Plan limit: ${data?.license.claims?.maxDevices ?? "not activated"}`,
                  ],
                ].map(([label, value, hint]) => (
                  <section className="card" key={label}>
                    <small>{label}</small>
                    <strong>{value}</strong>
                    <small>{hint}</small>
                  </section>
                ))}
              </div>
              <div className="grid">
                <section className="panel">
                  <div className="eyebrow">Subscription</div>
                  <h2>{data?.license.claims?.plan ?? "Awaiting activation"}</h2>
                  <p>{data?.license.reason}</p>
                  <div className="row">
                    <span className="badge">
                      {data?.license.claims?.status ?? "Unlicensed"}
                    </span>
                    <span className="muted">
                      {data?.license.claims
                        ? `Offline lease until ${new Date(data.license.claims.validUntil).toLocaleDateString("en-NG")}`
                        : "Activate with your provider key"}
                    </span>
                  </div>
                  {can("settings.write") ? (
                    <form
                      onSubmit={(e) => {
                        const v = formValues(e);
                        void perform(async () => {
                          await api("/license/activate", {
                            method: "POST",
                            body: JSON.stringify(v),
                          });
                          await load();
                          setMessage("Licence validated.");
                        });
                      }}
                    >
                      <label htmlFor="key">Licence key</label>
                      <input id="key" name="key" type="password" required />
                      <button disabled={busy || !reachable}>
                        Activate or validate
                      </button>
                    </form>
                  ) : null}
                </section>
                <section className="panel">
                  <div className="eyebrow">Build progress</div>
                  <h2>Front desk ready for review</h2>
                  <p>
                    Tenant isolation, staff access, roles, signed licences and
                    the complete data model.
                  </p>
                  <p>
                    Payment collection starts in Phase 3. Cloud mirroring starts
                    in Phase 4.
                  </p>
                  <span className="badge warn">
                    {data?.failed ?? 0} failed outbox records
                  </span>
                </section>
              </div>
            </>
          ) : null}
          {tab === "Front desk" ? (
            <FrontDesk writable={writable} permissions={who.permissions} />
          ) : null}
          {tab === "Staff" ? (
            <div className="grid">
              <section className="panel table-wrap">
                <h2>Hotel team</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Role</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staff.map((s) => (
                      <tr key={s.id}>
                        <td>
                          {s.name}
                          <br />
                          <small>{s.email}</small>
                        </td>
                        <td>{roles.find((r) => r.id === s.role_id)?.name}</td>
                        <td>
                          {s.is_active ? "Active" : "Disabled"}
                          {can("staff.write") && s.id !== who.userId ? (
                            <button
                              className="secondary"
                              disabled={!writable || busy}
                              onClick={() =>
                                void perform(async () => {
                                  await api(`/users/${s.id}`, {
                                    method: "PATCH",
                                    body: JSON.stringify({
                                      isActive: !s.is_active,
                                    }),
                                  });
                                  setStaff(await api("/users"));
                                })
                              }
                            >
                              {s.is_active ? "Disable" : "Enable"}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              {can("staff.write") ? (
                <section className="panel">
                  <h2>Add a staff member</h2>
                  <form
                    onSubmit={(e) => {
                      const v = formValues(e);
                      const form = e.currentTarget;
                      void perform(async () => {
                        await api("/users", {
                          method: "POST",
                          body: JSON.stringify(v),
                        });
                        form.reset();
                        setStaff(await api("/users"));
                        await load();
                        setMessage(
                          "Staff member created. A password change is required at first login.",
                        );
                      });
                    }}
                  >
                    {[
                      ["name", "Full name", "text"],
                      ["email", "Email", "email"],
                      ["password", "Temporary password", "password"],
                    ].map(([name, label, type]) => (
                      <div key={name}>
                        <label htmlFor={name}>{label}</label>
                        <input
                          id={name}
                          name={name}
                          type={type}
                          minLength={name === "password" ? 12 : undefined}
                          required
                        />
                      </div>
                    ))}
                    <label htmlFor="roleId">Role</label>
                    <select id="roleId" name="roleId">
                      {roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    <button disabled={busy || !writable}>
                      Create staff account
                    </button>
                  </form>
                </section>
              ) : null}
            </div>
          ) : null}
          {tab === "Roles" ? (
            <div className="grid">
              {roles.map((role) => (
                <section className="panel" key={role.id}>
                  <h2>{role.name}</h2>
                  <div className="permissions">
                    {role.permissions.map((p) => (
                      <span key={p}>{p}</span>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : null}
          {tab === "Devices" ? (
            <div className="grid">
              <section className="panel">
                <h2>Connected workstations</h2>
                {devices.map((d) => (
                  <div className="py-4 border-b" key={d.id}>
                    <p>
                      {d.label} · {d.assigned_department}
                    </p>
                    <small className="break-all">Device ID: {d.id}</small>
                  </div>
                ))}
              </section>
              {can("devices.write") ? (
                <section className="panel">
                  <h2>Register device</h2>
                  <form
                    onSubmit={(e) => {
                      const v = formValues(e);
                      void perform(async () => {
                        await api("/devices", {
                          method: "POST",
                          body: JSON.stringify(v),
                        });
                        setDevices(await api("/devices"));
                        await load();
                        setMessage(
                          "Device registered. Copy its ID to the device login screen.",
                        );
                      });
                    }}
                  >
                    <label htmlFor="label">Device label</label>
                    <input
                      id="label"
                      name="label"
                      placeholder="Reception tablet"
                      required
                    />
                    <label htmlFor="department">Department</label>
                    <input id="department" name="assigned_department" />
                    <button disabled={!writable || busy}>
                      Register device
                    </button>
                  </form>
                </section>
              ) : null}
            </div>
          ) : null}
          {tab === "Settings" ? (
            <section className="panel">
              <h2>Hotel branding</h2>
              <form
                className="form-grid"
                onSubmit={(e) => {
                  const value = formValues(e);
                  void perform(async () => {
                    await api("/settings", {
                      method: "PUT",
                      body: JSON.stringify({ key: "branding", value }),
                    });
                    setBranding(await api("/branding"));
                    setMessage("Branding saved.");
                  });
                }}
              >
                <div>
                  <label htmlFor="hotelName">Hotel name</label>
                  <input
                    id="hotelName"
                    name="name"
                    defaultValue={branding.name}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="logo">Local logo path</label>
                  <input
                    id="logo"
                    name="logoUrl"
                    defaultValue={branding.logoUrl}
                    placeholder="/assets/hotel-logo.png"
                  />
                </div>
                <div className="wide">
                  <label htmlFor="address">Address</label>
                  <textarea id="address" name="address" required />
                </div>
                <button disabled={!writable || busy || !can("settings.write")}>
                  Save hotel branding
                </button>
              </form>
              <p>
                Tax rules, room setup, printer testing and the full onboarding
                wizard follow with their operational modules.
              </p>
            </section>
          ) : null}
          {tab === "Audit trail" ? (
            <section className="panel table-wrap">
              <h2>Latest 100 changes</h2>
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>Device</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id}>
                      <td>{new Date(a.occurred_at).toLocaleString("en-NG")}</td>
                      <td>{a.action}</td>
                      <td>{a.entity}</td>
                      <td>{a.device_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
          {data?.license.claims?.features.provider_credit !== false ? (
            <p className="footer-note">Powered by Hotel Hub</p>
          ) : null}
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
