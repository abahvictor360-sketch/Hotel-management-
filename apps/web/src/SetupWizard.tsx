import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, newRequestId } from "./api";
import { BrandingSettings } from "./BrandingSettings";
import { Icon } from "./icons";
import {
  parseRoomNumbers,
  type StepId,
} from "../../../packages/core/src/onboarding";
type Row = Record<string, any>;
export type OnboardingStatus = {
  steps: { id: StepId; title: string; required: boolean; done: boolean }[];
  done: number;
  total: number;
  ready: boolean;
  completedAt: string | null;
};
type Perform = (fn: () => Promise<void>) => Promise<void>;
const blurb: Record<StepId, string> = {
  profile:
    "Your hotel's name, address, contact details, logo and colour. Guests see these on receipts and the booking website.",
  roomTypes:
    "The kinds of room you sell and their nightly rate, for example Standard, Deluxe and Suite.",
  rooms: "Every room number, grouped by type and floor.",
  taxes:
    "VAT and service charge added to bills. Check the rates match your tax registration.",
  staff:
    "Give each team member their own sign-in so every action is recorded under their name.",
  devices:
    "Each computer or tablet that signs in must be registered. Open the enrolment link once on each one.",
  printer: "Set up the receipt printer at the front desk and print a test.",
  booking:
    "Let guests book rooms from your own website, with or without online payment.",
};
// First-run setup: walks a new hotel's administrator through everything the hotel needs
// before its first guest. Each step saves straight to the hub, so it can be left and
// resumed at any time.
export function SetupWizard({
  status,
  refresh,
  canWrite,
  perform,
  notify,
  openTab,
}: {
  status: OnboardingStatus;
  refresh: () => Promise<void>;
  canWrite: boolean;
  perform: Perform;
  notify: (message: string) => void;
  openTab: (tab: string) => void;
}) {
  const firstOpen = status.steps.findIndex((s) => !s.done);
  const [index, setIndex] = useState(firstOpen < 0 ? status.total : firstOpen);
  const finishing = index >= status.total;
  const step = status.steps[index];
  async function markReviewed(id: StepId) {
    await api("/onboarding", {
      method: "POST",
      body: JSON.stringify({ review: id }),
    });
    await refresh();
  }
  const review = (id: StepId) => perform(() => markReviewed(id));
  const next = () => setIndex((i) => Math.min(i + 1, status.total));
  const saved = (message: string) => {
    notify(message);
    void refresh();
  };
  return (
    <div className="setup">
      <section className="panel setup-steps">
        <div className="setup-progress">
          <strong>
            {status.done} of {status.total} done
          </strong>
          <div className="meter" aria-hidden="true">
            <span style={{ width: `${(status.done / status.total) * 100}%` }} />
          </div>
        </div>
        <ol>
          {status.steps.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                className={`setup-step${i === index ? " active" : ""}${s.done ? " done" : ""}`}
                aria-current={i === index ? "step" : undefined}
                onClick={() => setIndex(i)}
              >
                <span className="setup-check" aria-hidden="true">
                  {s.done ? <Icon name="check" /> : i + 1}
                </span>
                <span>
                  {s.title}
                  {!s.required ? <small> · optional</small> : null}
                </span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className={`setup-step${finishing ? " active" : ""}${status.completedAt ? " done" : ""}`}
              onClick={() => setIndex(status.total)}
            >
              <span className="setup-check" aria-hidden="true">
                <Icon name={status.completedAt ? "check" : "flag"} />
              </span>
              <span>Finish</span>
            </button>
          </li>
        </ol>
      </section>
      <div className="setup-body">
        {finishing ? (
          <Finish
            status={status}
            canWrite={canWrite}
            perform={perform}
            refresh={refresh}
            goTo={setIndex}
            openTab={openTab}
          />
        ) : (
          <>
            <section className="panel setup-intro">
              <div className="eyebrow">
                Step {index + 1} of {status.total}
                {step.required ? "" : " · optional"}
              </div>
              <h2>{step.title}</h2>
              <p className="muted">{blurb[step.id]}</p>
              {step.done ? <p className="success">This step is done.</p> : null}
            </section>
            {step.id === "profile" ? (
              <BrandingSettings
                canWrite={canWrite}
                perform={perform}
                notify={saved}
              />
            ) : step.id === "roomTypes" || step.id === "rooms" ? (
              <>
                {step.id === "roomTypes" ? (
                  <RoomTypes
                    canWrite={canWrite}
                    perform={perform}
                    saved={saved}
                  />
                ) : (
                  <Rooms canWrite={canWrite} perform={perform} saved={saved} />
                )}
                <p className="muted small">
                  Have your rooms in a spreadsheet?{" "}
                  <button
                    type="button"
                    className="link"
                    onClick={() => openTab("Data import")}
                  >
                    Import them from a CSV file
                  </button>
                  , room types included.
                </p>
              </>
            ) : step.id === "taxes" ? (
              <Taxes
                canWrite={canWrite}
                perform={perform}
                saved={saved}
                confirm={() => markReviewed("taxes")}
              />
            ) : step.id === "staff" ? (
              <StaffStep canWrite={canWrite} perform={perform} saved={saved} />
            ) : step.id === "devices" ? (
              <Devices canWrite={canWrite} perform={perform} saved={saved} />
            ) : (
              <section className="panel">
                <p>
                  {step.id === "printer"
                    ? "Choose the printer connection, paper width and print a test receipt on the Printer page."
                    : "Turn on online booking, choose how many rooms of each type to offer and whether guests pay online, on the Online bookings page."}
                </p>
                <div className="row form-actions">
                  <button
                    type="button"
                    onClick={() =>
                      openTab(
                        step.id === "printer" ? "Printer" : "Online bookings",
                      )
                    }
                  >
                    {step.id === "printer"
                      ? "Open printer settings"
                      : "Open online booking"}
                  </button>
                  {!step.done ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={!canWrite}
                      onClick={() => void review(step.id)}
                    >
                      {step.id === "printer" ? "Printer is ready" : "Not now"}
                    </button>
                  ) : null}
                </div>
              </section>
            )}
            <div className="row setup-nav">
              <button
                type="button"
                className="secondary"
                disabled={index === 0}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
              >
                Back
              </button>
              {!step.done && !step.required && step.id === "staff" ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={!canWrite}
                  onClick={() => void review("staff").then(next)}
                >
                  Skip for now
                </button>
              ) : null}
              <button type="button" onClick={next}>
                {index === status.total - 1 ? "Review and finish" : "Next step"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
function Finish({
  status,
  canWrite,
  perform,
  refresh,
  goTo,
  openTab,
}: {
  status: OnboardingStatus;
  canWrite: boolean;
  perform: Perform;
  refresh: () => Promise<void>;
  goTo: (i: number) => void;
  openTab: (tab: string) => void;
}) {
  const missing = status.steps
    .map((s, i) => ({ ...s, i }))
    .filter((s) => s.required && !s.done);
  if (status.completedAt)
    return (
      <section className="panel setup-intro">
        <div className="eyebrow">All set</div>
        <h2>Your hotel is ready for guests</h2>
        <p className="muted">
          Setup finished on {new Date(status.completedAt).toLocaleDateString()}.
          You can come back here any time to review a step.
        </p>
        <div className="row form-actions">
          <button type="button" onClick={() => openTab("Front desk")}>
            Go to the front desk
          </button>
        </div>
      </section>
    );
  return (
    <section className="panel setup-intro">
      <div className="eyebrow">Last step</div>
      <h2>{status.ready ? "Ready to open" : "Almost there"}</h2>
      {missing.length ? (
        <>
          <p className="muted">These required steps still need attention:</p>
          <ul className="setup-missing">
            {missing.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="link"
                  onClick={() => goTo(s.i)}
                >
                  {s.title}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">
          Everything required is in place. Optional steps can be done later from
          here.
        </p>
      )}
      <div className="row form-actions">
        <button
          type="button"
          disabled={!canWrite || !status.ready}
          onClick={() =>
            void perform(async () => {
              await api("/onboarding", {
                method: "POST",
                body: JSON.stringify({ finish: true }),
              });
              await refresh();
            })
          }
        >
          Finish setup
        </button>
      </div>
    </section>
  );
}
// Posts a hub command with an idempotency key, like the front desk does.
function command(path: string, body: Row, method = "POST") {
  return api<Row>(path, {
    method,
    body: JSON.stringify({ ...body, requestId: newRequestId() }),
  });
}
function useLoad<T>(load: () => Promise<T>, version: number) {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    void load()
      .then((v) => live && setValue(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [version]);
  return value;
}
type StepProps = {
  canWrite: boolean;
  perform: Perform;
  saved: (message: string) => void;
};
const roomPresets = [
  { name: "Standard", baseRate: "35000.00", capacity: 2 },
  { name: "Deluxe", baseRate: "55000.00", capacity: 2 },
  { name: "Executive Suite", baseRate: "95000.00", capacity: 3 },
  { name: "Family Room", baseRate: "70000.00", capacity: 4 },
];
function RoomTypes({ canWrite, perform, saved }: StepProps) {
  const [version, setVersion] = useState(0);
  const config = useLoad(() => api<Row>("/frontdesk/config"), version);
  const [form, setForm] = useState({ name: "", baseRate: "", capacity: "2" });
  const types: Row[] = config?.roomTypes ?? [];
  const money = (v: string) =>
    new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: config?.currency ?? "NGN",
      maximumFractionDigits: 0,
    }).format(Number(v));
  async function add(input: {
    name: string;
    baseRate: string;
    capacity: number;
  }) {
    await perform(async () => {
      await command("/room-types", input);
      setVersion((v) => v + 1);
      setForm({ name: "", baseRate: "", capacity: "2" });
      saved(`Room type ${input.name} added.`);
    });
  }
  return (
    <div className="grid">
      <section className="panel">
        <h2>Your room types</h2>
        {types.length ? (
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Nightly rate</th>
                <th>Guests</th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{money(t.base_rate)}</td>
                  <td>{t.capacity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No room types yet. Add your first one.</p>
        )}
      </section>
      <section className="panel">
        <h2>Add a room type</h2>
        <p className="muted">Quick start:</p>
        <div className="row chips">
          {roomPresets
            .filter((p) => !types.some((t) => t.name === p.name))
            .map((p) => (
              <button
                key={p.name}
                type="button"
                className="secondary"
                disabled={!canWrite}
                onClick={() =>
                  setForm({
                    name: p.name,
                    baseRate: p.baseRate.replace(/\.00$/, ""),
                    capacity: String(p.capacity),
                  })
                }
              >
                {p.name}
              </button>
            ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void add({
              name: form.name.trim(),
              baseRate: Number(form.baseRate).toFixed(2),
              capacity: Number(form.capacity),
            });
          }}
        >
          <label htmlFor="rt-name">Name</label>
          <input
            id="rt-name"
            value={form.name}
            minLength={2}
            maxLength={100}
            required
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <label htmlFor="rt-rate">Nightly rate</label>
          <input
            id="rt-rate"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={form.baseRate}
            required
            onChange={(e) => setForm({ ...form, baseRate: e.target.value })}
          />
          <label htmlFor="rt-cap">Maximum guests</label>
          <input
            id="rt-cap"
            type="number"
            min="1"
            max="20"
            value={form.capacity}
            required
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
          />
          <button disabled={!canWrite}>Add room type</button>
        </form>
      </section>
    </div>
  );
}
function Rooms({ canWrite, perform, saved }: StepProps) {
  const [version, setVersion] = useState(0);
  const config = useLoad(() => api<Row>("/frontdesk/config"), version);
  const rooms = useLoad(() => api<Row>("/rooms?pageSize=100"), version);
  const types: Row[] = config?.roomTypes ?? [];
  const [typeId, setTypeId] = useState("");
  const [floor, setFloor] = useState("1");
  const [numbers, setNumbers] = useState("");
  const parsed = useMemo(() => {
    try {
      return { list: parseRoomNumbers(numbers), error: "" };
    } catch (e) {
      return { list: [], error: (e as Error).message };
    }
  }, [numbers]);
  const chosen = typeId || types[0]?.id || "";
  const byType = (id: string) =>
    (rooms?.items ?? []).filter((r: Row) => r.room_type_id === id);
  return (
    <div className="grid">
      <section className="panel">
        <h2>Rooms so far · {rooms?.total ?? 0}</h2>
        {types.length === 0 ? (
          <p className="muted">Add a room type first.</p>
        ) : (
          types.map((t) => (
            <div key={t.id} className="setup-roomlist">
              <strong>{t.name}</strong>
              <span className="muted">
                {byType(t.id)
                  .map((r: Row) => r.room_number)
                  .join(", ") || "No rooms yet"}
              </span>
            </div>
          ))
        )}
      </section>
      <section className="panel">
        <h2>Add rooms</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              await command("/rooms/bulk", {
                roomTypeId: chosen,
                floor: Number(floor),
                numbers: parsed.list,
              });
              setNumbers("");
              setVersion((v) => v + 1);
              saved(`${parsed.list.length} rooms added.`);
            });
          }}
        >
          <label htmlFor="rm-type">Room type</label>
          <select
            id="rm-type"
            value={chosen}
            onChange={(e) => setTypeId(e.target.value)}
          >
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <label htmlFor="rm-floor">Floor</label>
          <input
            id="rm-floor"
            type="number"
            min="-5"
            max="150"
            value={floor}
            onChange={(e) => setFloor(e.target.value)}
          />
          <label htmlFor="rm-numbers">Room numbers</label>
          <textarea
            id="rm-numbers"
            value={numbers}
            placeholder="101-110, 115"
            onChange={(e) => setNumbers(e.target.value)}
          />
          <small
            className={`field-hint ${parsed.error ? "error-text" : "muted"}`}
          >
            {parsed.error ||
              (parsed.list.length
                ? `${parsed.list.length} rooms: ${parsed.list.slice(0, 8).join(", ")}${parsed.list.length > 8 ? "…" : ""}`
                : "Use ranges like 101-110 and commas between groups.")}
          </small>
          <button
            disabled={
              !canWrite || !chosen || !parsed.list.length || !!parsed.error
            }
          >
            Add {parsed.list.length || ""} rooms
          </button>
        </form>
      </section>
    </div>
  );
}
function Taxes({
  canWrite,
  perform,
  saved,
  confirm,
}: StepProps & { confirm: () => Promise<void> }) {
  const [version, setVersion] = useState(0);
  const catalog = useLoad(() => api<Row>("/services/catalog"), version);
  const categories: Row[] = catalog?.categories ?? [];
  const [form, setForm] = useState<Row | null>(null);
  useEffect(() => {
    if (form || !categories.length) return;
    const c = categories[0];
    setForm({
      vatEnabled: c.vat_enabled,
      vatRate: String(Number(c.vat_rate)),
      serviceEnabled: c.service_charge_enabled,
      serviceRate: String(Number(c.service_charge_rate)),
    });
  }, [categories.length]);
  const label = (name: string) =>
    name.replace("_", " ").replace(/^./, (c) => c.toUpperCase());
  const pct = (v: string) => Number(v).toFixed(3);
  return (
    <div className="grid">
      <section className="panel">
        <h2>Rates for every department</h2>
        {form ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                for (const c of categories)
                  await command(
                    `/services/categories/${c.id}/tax`,
                    {
                      vatEnabled: form.vatEnabled,
                      serviceEnabled: form.serviceEnabled,
                      vatRate: pct(form.vatRate),
                      serviceRate: pct(form.serviceRate),
                    },
                    "PATCH",
                  );
                setVersion((v) => v + 1);
                await confirm();
                saved("Tax rates applied to every department.");
              });
            }}
          >
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.vatEnabled}
                onChange={(e) =>
                  setForm({ ...form, vatEnabled: e.target.checked })
                }
              />
              Charge VAT
            </label>
            <label htmlFor="tx-vat">VAT rate (%)</label>
            <input
              id="tx-vat"
              type="number"
              min="0"
              max="100"
              step="0.001"
              value={form.vatRate}
              disabled={!form.vatEnabled}
              onChange={(e) => setForm({ ...form, vatRate: e.target.value })}
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.serviceEnabled}
                onChange={(e) =>
                  setForm({ ...form, serviceEnabled: e.target.checked })
                }
              />
              Add a service charge
            </label>
            <label htmlFor="tx-svc">Service charge (%)</label>
            <input
              id="tx-svc"
              type="number"
              min="0"
              max="100"
              step="0.001"
              value={form.serviceRate}
              disabled={!form.serviceEnabled}
              onChange={(e) =>
                setForm({ ...form, serviceRate: e.target.value })
              }
            />
            <div className="row form-actions">
              <button disabled={!canWrite}>Apply to all departments</button>
              <button
                type="button"
                className="secondary"
                disabled={!canWrite}
                onClick={() =>
                  void perform(async () => {
                    await confirm();
                    saved("Tax rates confirmed.");
                  })
                }
              >
                Current rates are correct
              </button>
            </div>
          </form>
        ) : (
          <p className="muted">Loading departments…</p>
        )}
      </section>
      <section className="panel">
        <h2>Current rates</h2>
        <table>
          <thead>
            <tr>
              <th>Department</th>
              <th>VAT</th>
              <th>Service</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <td>{label(c.name)}</td>
                <td>{c.vat_enabled ? `${Number(c.vat_rate)}%` : "Off"}</td>
                <td>
                  {c.service_charge_enabled
                    ? `${Number(c.service_charge_rate)}%`
                    : "Off"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
// A readable temporary password; the hub makes the person change it at first sign-in.
function temporaryPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
function StaffStep({ canWrite, perform, saved }: StepProps) {
  const [version, setVersion] = useState(0);
  const staff = useLoad(() => api<Row[]>("/users"), version);
  const roles = useLoad(() => api<Row[]>("/roles"), 0);
  const [form, setForm] = useState({ name: "", email: "", roleId: "" });
  const [created, setCreated] = useState<{
    email: string;
    password: string;
  } | null>(null);
  const roleName = (id: string) => roles?.find((r) => r.id === id)?.name ?? "";
  const assignable = (roles ?? []).filter((r) => r.name !== "admin");
  const roleId = form.roleId || assignable[0]?.id || "";
  return (
    <div className="grid">
      <section className="panel">
        <h2>Team · {staff?.length ?? 0}</h2>
        {(staff ?? []).map((s) => (
          <div key={s.id} className="setup-roomlist">
            <strong>{s.name}</strong>
            <span className="muted">
              {s.email} · {roleName(s.role_id)}
            </span>
          </div>
        ))}
      </section>
      <section className="panel">
        <h2>Add a team member</h2>
        {created ? (
          <div className="notice" role="status">
            <p>
              <strong>{created.email}</strong> can sign in with this temporary
              password. Share it privately; it is not shown again.
            </p>
            <p className="mono">{created.password}</p>
            <button
              type="button"
              className="secondary"
              onClick={() => setCreated(null)}
            >
              Done
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const password = temporaryPassword();
              void perform(async () => {
                await api("/users", {
                  method: "POST",
                  body: JSON.stringify({
                    name: form.name.trim(),
                    email: form.email.trim(),
                    roleId,
                    password,
                  }),
                });
                setCreated({ email: form.email.trim(), password });
                setForm({ name: "", email: "", roleId: "" });
                setVersion((v) => v + 1);
                saved(`${form.name.trim()} added.`);
              });
            }}
          >
            <label htmlFor="st-name">Full name</label>
            <input
              id="st-name"
              value={form.name}
              required
              maxLength={150}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <label htmlFor="st-email">Email</label>
            <input
              id="st-email"
              type="email"
              value={form.email}
              required
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <label htmlFor="st-role">Role</label>
            <select
              id="st-role"
              value={roleId}
              onChange={(e) => setForm({ ...form, roleId: e.target.value })}
            >
              {assignable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name.replace(/^./, (c: string) => c.toUpperCase())}
                </option>
              ))}
            </select>
            <button disabled={!canWrite || !roleId}>Add team member</button>
          </form>
        )}
      </section>
    </div>
  );
}
function Devices({ canWrite, perform, saved }: StepProps) {
  const [version, setVersion] = useState(0);
  const devices = useLoad(() => api<Row[]>("/devices"), version);
  const [form, setForm] = useState({ label: "", department: "frontdesk" });
  const [copied, setCopied] = useState("");
  const link = (id: string) => `${location.origin}/?device=${id}`;
  return (
    <div className="grid">
      <section className="panel">
        <h2>Registered devices</h2>
        {(devices ?? [])
          .filter((d) => !d.revoked_at)
          .map((d) => (
            <div key={d.id} className="setup-device">
              <div>
                <strong>{d.label}</strong>
                <small className="muted">
                  {d.assigned_department ?? "Any department"}
                </small>
              </div>
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(link(d.id))
                    .then(() => setCopied(d.id))
                }
              >
                {copied === d.id ? "Link copied" : "Copy enrolment link"}
              </button>
            </div>
          ))}
        <p className="muted small">
          Open the enrolment link once in the browser of that device. It then
          remembers which device it is.
        </p>
      </section>
      <section className="panel">
        <h2>Register a device</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              await api("/devices", {
                method: "POST",
                body: JSON.stringify({
                  label: form.label.trim(),
                  assigned_department: form.department,
                }),
              });
              setForm({ label: "", department: form.department });
              setVersion((v) => v + 1);
              saved(`${form.label.trim()} registered.`);
            });
          }}
        >
          <label htmlFor="dv-label">Name</label>
          <input
            id="dv-label"
            value={form.label}
            required
            maxLength={100}
            placeholder="Reception tablet"
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
          <label htmlFor="dv-dept">Used by</label>
          <select
            id="dv-dept"
            value={form.department}
            onChange={(e) => setForm({ ...form, department: e.target.value })}
          >
            {[
              ["frontdesk", "Front desk"],
              ["restaurant", "Restaurant"],
              ["bar", "Bar"],
              ["laundry", "Laundry"],
              ["housekeeping", "Housekeeping"],
              ["management", "Management"],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <button disabled={!canWrite}>Register device</button>
        </form>
      </section>
    </div>
  );
}
export function SetupCard({
  status,
  open,
}: {
  status: OnboardingStatus;
  open: () => void;
}): ReactNode {
  if (status.completedAt) return null;
  const nextStep = status.steps.find((s) => !s.done);
  return (
    <section className="panel setup-card">
      <div>
        <div className="eyebrow">Set up your hotel</div>
        <h2>
          {status.done} of {status.total} steps done
        </h2>
        <div className="meter" aria-hidden="true">
          <span style={{ width: `${(status.done / status.total) * 100}%` }} />
        </div>
        <p className="muted">
          {nextStep ? `Next: ${nextStep.title}.` : "Everything is in place."}
        </p>
      </div>
      <button type="button" onClick={open}>
        {status.done ? "Continue setup" : "Start setup"}
      </button>
    </section>
  );
}
