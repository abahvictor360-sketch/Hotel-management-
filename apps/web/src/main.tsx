import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { api, restoreSession, setToken } from "./api";
import "./styles.css";
import { Drafts } from "./Drafts";
import { ServiceDesk } from "./ServiceDesk";
import { FrontDesk } from "./FrontDesk";
import { SyncPage, syncLabel, type SyncStatus } from "./Sync";
import { ReportsView, type ReportSource } from "./Reports";
import { DataExport } from "./DataExport";
import { OnlineBookings } from "./OnlineBookings";
import { download } from "./api";
import { Icon, type IconName } from "./icons";
import { restoreBrand, setBrand, useBrand } from "./brand";
import { BrandingSettings } from "./BrandingSettings";
import { SetupCard, SetupWizard, type OnboardingStatus } from "./SetupWizard";
import { ImportData } from "./ImportData";
type Theme = "light" | "dark" | "system";
const reportPath = (kind: string, from: string, to: string) =>
  `/reports/${kind}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
// Reports read the hub's own database, so they work during an internet outage.
const hubReports: ReportSource = {
  load: (kind, from, to) => api(reportPath(kind, from, to)),
  download: (kind, from, to, format) =>
    download(`${reportPath(kind, from, to)}&format=${format}`),
};
function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
const savedTheme = (() => {
  try {
    return (localStorage.getItem("hotel-theme") as Theme) || "system";
  } catch {
    return "system" as Theme;
  }
})();
applyTheme(savedTheme);
restoreBrand();
// Enrolment link: an administrator opens /?device=<registered device ID> once on a
// terminal, and that browser remembers which device it is.
(() => {
  const params = new URLSearchParams(location.search);
  const device = params.get("device");
  if (!device || !/^[0-9a-f-]{36}$/i.test(device)) return;
  try {
    localStorage.setItem("hotel-device-id", device);
  } catch {
    /* storage blocked: the device ID can still be typed at sign-in */
  }
  params.delete("device");
  const query = params.toString();
  history.replaceState(
    null,
    "",
    location.pathname + (query ? `?${query}` : ""),
  );
})();
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
const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
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
  const branding = useBrand();
  const [data, setData] = useState<Dashboard | null>(null),
    [reachable, setReachable] = useState(true),
    [staff, setStaff] = useState<Staff[]>([]),
    [roles, setRoles] = useState<Role[]>([]),
    [devices, setDevices] = useState<Device[]>([]),
    [audit, setAudit] = useState<any[]>([]),
    [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null),
    [theme, setTheme] = useState<Theme>(savedTheme),
    [setup, setSetup] = useState<OnboardingStatus | null>(null);
  async function refreshSync() {
    setSyncStatus(await api<SyncStatus>("/sync/status"));
  }
  function cycleTheme() {
    const next: Theme =
      theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
    setTheme(next);
    applyTheme(next);
    try {
      localStorage.setItem("hotel-theme", next);
    } catch {}
  }
  const can = (permission: string) =>
    who?.permissions.includes(permission) ?? false;
  async function refreshSetup() {
    setSetup(await api<OnboardingStatus>("/onboarding"));
  }
  async function load() {
    const profile = await api<Identity>("/auth/me");
    setWho(profile);
    if (!profile.forcePasswordChange) setData(await api("/dashboard"));
    if (
      !profile.forcePasswordChange &&
      profile.permissions.includes("settings.read")
    ) {
      const status = await api<OnboardingStatus>("/onboarding");
      setSetup(status);
      // A new hotel's administrator lands on the setup guide until it is finished.
      if (!status.completedAt && profile.permissions.includes("settings.write"))
        setTab((t) => (t === "Overview" ? "Setup guide" : t));
    }
  }
  useEffect(() => {
    let cancelled = false;
    void api<typeof branding>("/branding")
      .then((v) => {
        if (!cancelled) setBrand(v, { remember: true });
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
    // Sync status doubles as the hub reachability check.
    const poll = () =>
      void api<SyncStatus>("/sync/status")
        .then((v) => {
          if (!active) return;
          setReachable(true);
          setSyncStatus(v);
        })
        .catch(() => {
          if (active) setReachable(false);
        });
    poll();
    const timer = setInterval(poll, 15000);
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
        <p className="muted">
          {branding.tagline || "Sign in on your hotel network."}
        </p>
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
  const allTabs: [string, string, IconName, string][] = [
    ["Overview", "", "home", "Operations"],
    ["Front desk", "frontdesk.read", "bed", "Operations"],
    ["Online bookings", "frontdesk.read", "globe", "Operations"],
    ["Services", "services", "utensils", "Operations"],
    ["Drafts", "drafts", "draft", "Operations"],
    ["Housekeeping", "housekeeping.read", "sparkle", "Operations"],
    ["Billing", "billing.read", "wallet", "Finance"],
    ["Receipts", "billing.read", "receipt", "Finance"],
    ["Inventory", "inventory.read", "box", "Finance"],
    ["Reports", "reports.read", "chart", "Finance"],
    ["Setup guide", "settings.read", "flag", "Setup"],
    ["Data import", "import", "upload", "Setup"],
    ["Menu setup", "settings.write", "list", "Setup"],
    ["Printer", "settings.write", "printer", "Setup"],
    ["Staff", "staff.read", "users", "Admin"],
    ["Roles", "roles.read", "shield", "Admin"],
    ["Devices", "devices.read", "monitor", "Admin"],
    ["Settings", "settings.read", "settings", "Admin"],
    ["Cloud sync", "sync.manage", "cloud", "Admin"],
    ["Audit trail", "audit.read", "history", "Admin"],
    ["Data export", "admin", "download", "Admin"],
  ];
  const tabs = allTabs.filter(
    ([, p]) =>
      !p ||
      can(p) ||
      (p === "admin" && who.roleName === "admin" && can("settings.write")) ||
      (p === "import" && (can("settings.write") || can("frontdesk.write"))) ||
      (p === "drafts" &&
        who.permissions.some(
          (x) =>
            ["frontdesk.write", "housekeeping.write", "billing.write"].includes(
              x,
            ) || x.startsWith("services."),
        )) ||
      (p === "services" &&
        (can("billing.write") ||
          who.permissions.some((x) => x.startsWith("services.")))),
  );
  const sync = syncLabel(syncStatus);
  const groups = [...new Set(tabs.map((t) => t[3]))];
  const subtitle: Record<string, string> = {
    Overview: "Today at a glance across the hotel.",
    "Data import": "Bring rooms, menu items and guests in from a spreadsheet.",
    "Setup guide":
      "Everything your hotel needs before its first guest. Progress saves as you go.",
    "Front desk": "Arrivals, departures, rooms and guests.",
    "Cloud sync": "What has reached the cloud, and what is still waiting.",
    "Audit trail": "Every change, who made it and from which device.",
    Reports: "Revenue, payments, occupancy and balances, from this hub.",
    "Online bookings":
      "Requests from your booking website. Confirm each into a room.",
    "Data export":
      "Take all hotel records away, and share reports with owners.",
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span
            className={`brand-mark${branding.logoUrl ? " has-logo" : ""}`}
            aria-hidden="true"
          >
            {branding.logoUrl ? (
              <img src={branding.logoUrl} alt="" />
            ) : (
              <Icon name="building" />
            )}
          </span>
          <div>
            <strong>{branding.name}</strong>
            <small>Hotel Hub</small>
          </div>
        </div>
        <nav aria-label="Main navigation">
          {groups.map((g) => (
            <div className="nav-group" key={g}>
              <div className="nav-label">{g}</div>
              {tabs
                .filter((t) => t[3] === g)
                .map(([name, , icon]) => (
                  <button
                    key={name}
                    className={name === tab ? "active" : ""}
                    aria-current={name === tab ? "page" : undefined}
                    onClick={() => {
                      setTab(name);
                      setMessage("");
                    }}
                  >
                    <Icon name={icon} />
                    <span>{name}</span>
                    {name === "Cloud sync" && syncStatus?.failed ? (
                      <em className="nav-count">{syncStatus.failed}</em>
                    ) : null}
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <footer>
          <strong>Runs on your hotel network</strong>
          <span>Works without internet. Hub version 0.6.0.</span>
        </footer>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="crumb">
            <span
              className={`dot ${!reachable ? "error" : sync.tone === "ok" ? "ok" : ""}`}
              aria-hidden="true"
            />
            {branding.name}
          </div>
          <div className="row">
            <button
              role="status"
              className={`sync-pill ${!reachable ? "error" : sync.tone}`}
              title={syncStatus?.lastError ?? undefined}
              onClick={() => {
                if (can("sync.manage")) setTab("Cloud sync");
              }}
            >
              <Icon
                name={
                  !reachable || sync.tone === "warn" ? "cloud-off" : "cloud"
                }
              />
              {!reachable ? "Hub unreachable" : sync.text}
            </button>
            <button
              className="icon-button"
              onClick={cycleTheme}
              aria-label={`Theme: ${theme}. Switch theme`}
              title={`Theme: ${theme}`}
            >
              <Icon
                name={
                  theme === "dark"
                    ? "moon"
                    : theme === "light"
                      ? "sun"
                      : "contrast"
                }
              />
            </button>
            <span className="avatar" aria-hidden="true">
              {who.roleName.slice(0, 2).toUpperCase()}
            </span>
            <span className="muted role-name">{who.roleName}</span>
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
              {tab === "Overview" ? (
                <h1>
                  {greeting()}, <span className="soft">{who.roleName}</span>
                </h1>
              ) : (
                <h1>{tab}</h1>
              )}
              <p>
                {subtitle[tab] ?? "Manage hotel operations and configuration."}
              </p>
            </div>
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
          {tab === "Overview" && setup && can("settings.write") ? (
            <SetupCard status={setup} open={() => setTab("Setup guide")} />
          ) : null}
          {tab === "Data import" ? (
            <ImportData permissions={who.permissions} writable={writable} />
          ) : null}
          {tab === "Setup guide" && setup ? (
            <SetupWizard
              status={setup}
              refresh={refreshSetup}
              canWrite={writable && !busy && can("settings.write")}
              perform={perform}
              notify={setMessage}
              openTab={setTab}
            />
          ) : null}
          {tab === "Overview" ? (
            <>
              {can("sync.manage") && syncStatus?.failed ? (
                <div className="error-message" role="alert">
                  {syncStatus.failed} record(s) stopped syncing to the cloud.{" "}
                  <button className="link" onClick={() => setTab("Cloud sync")}>
                    Review and retry
                  </button>
                </div>
              ) : null}
              <div className="cards four">
                {(
                  [
                    [
                      "Configured rooms",
                      data?.rooms ?? "—",
                      `Plan limit: ${data?.license.claims?.maxRooms ?? "not activated"}`,
                      "blue",
                      "bed",
                    ],
                    [
                      "Staff accounts",
                      data?.staff ?? "—",
                      "Access controlled by roles",
                      "green",
                      "users",
                    ],
                    [
                      "Registered devices",
                      data?.devices ?? "—",
                      `Plan limit: ${data?.license.claims?.maxDevices ?? "not activated"}`,
                      "pink",
                      "monitor",
                    ],
                    [
                      "Waiting to sync",
                      syncStatus?.pending ?? data?.pending ?? "—",
                      reachable ? sync.text : "Hub unreachable",
                      "yellow",
                      "cloud",
                    ],
                  ] as [string, string | number, string, string, IconName][]
                ).map(([label, value, hint, tint, icon]) => (
                  <section className={`stat tint-${tint}`} key={label}>
                    <header>{label}</header>
                    <div className="stat-body">
                      <span className="stat-icon" aria-hidden="true">
                        <Icon name={icon} />
                      </span>
                      <div>
                        <strong>{value}</strong>
                        <small>{hint}</small>
                      </div>
                    </div>
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
                  <div className="eyebrow">Cloud copy</div>
                  <h2>{reachable ? sync.text : "Hub unreachable"}</h2>
                  <p>
                    Every change is saved on this hub first. It uploads to the
                    cloud every 30 seconds when the internet is available, so
                    management reports stay current and online bookings arrive
                    here.
                  </p>
                  <div className="row">
                    <span
                      className={`badge ${syncStatus?.failed ? "error" : ""}`}
                    >
                      {syncStatus?.failed ?? 0} failed
                    </span>
                    <span className="muted">
                      Last full sync:{" "}
                      {syncStatus?.lastSuccessAt
                        ? new Date(syncStatus.lastSuccessAt).toLocaleString(
                            "en-NG",
                          )
                        : "not yet"}
                    </span>
                  </div>
                </section>
              </div>
            </>
          ) : null}
          {[
            "Services",
            "Billing",
            "Receipts",
            "Inventory",
            "Housekeeping",
            "Menu setup",
            "Printer",
          ].includes(tab) ? (
            <ServiceDesk
              key={tab}
              view={tab}
              permissions={who.permissions}
              writable={writable}
            />
          ) : null}
          {tab === "Drafts" ? (
            <Drafts
              key={who.userId}
              userId={who.userId}
              permissions={who.permissions}
            />
          ) : null}
          {tab === "Cloud sync" ? (
            <SyncPage
              status={syncStatus}
              refresh={refreshSync}
              canManage={can("sync.manage")}
            />
          ) : null}
          {tab === "Reports" ? <ReportsView source={hubReports} /> : null}
          {tab === "Data export" ? <DataExport writable={writable} /> : null}
          {tab === "Online bookings" ? (
            <OnlineBookings
              writable={writable}
              canWrite={can("frontdesk.write")}
              isAdmin={who.roleName === "admin" && can("settings.write")}
            />
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
            <BrandingSettings
              canWrite={writable && !busy && can("settings.write")}
              perform={perform}
              notify={setMessage}
            />
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
