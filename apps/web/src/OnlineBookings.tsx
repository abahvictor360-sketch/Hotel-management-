import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
// Website bookings synced down from the cloud. Staff confirm each into a real reservation
// (the room, the quoted price, any online payment on the folio) or reject it. Decisions sync
// back, which releases the website allotment and emails the guest.
type Row = {
  id: string;
  reference: string;
  status: "pending" | "confirmed" | "rejected" | "cancelled";
  receivedAt: string;
  guest: { fullName: string; email: string; phone?: string };
  roomType: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  notes: string | null;
  total: string;
  currency: string;
  paymentMode: string;
  payment: "paid" | "unpaid" | "at_hotel";
  paidAmount: string;
  paymentMismatch: boolean;
  expired: boolean;
  refundDue: boolean;
  decision: { reason?: string; roomNumber?: string } | null;
};
type Settings = {
  enabled: boolean;
  paymentMode: "none" | "optional" | "required";
  holdMinutes: number;
  maxAdvanceDays: number;
  policy: string;
  gateway: {
    name: "paystack" | "flutterwave";
    publicKey: string;
    hint: string;
    updatedAt: string;
  } | null;
  planIncludes: boolean;
  sealingAvailable: boolean;
  bookingUrl: string | null;
  webhookUrls: Record<string, string> | null;
  roomTypes: {
    id: string;
    name: string;
    rooms: number;
    onlineAllotment: number;
  }[];
};
const views = ["pending", "confirmed", "rejected", "cancelled"] as const;
const when = (v: string) => new Date(v).toLocaleString("en-NG");
const money = (c: string, v: string) => {
  const [i, f] = v.split(".");
  return `${c} ${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${f ?? "00"}`;
};
function PaymentBadge({ r }: { r: Row }) {
  if (r.refundDue) return <span className="badge error">Paid, refund due</span>;
  if (r.payment === "paid") return <span className="badge">Paid online</span>;
  if (r.expired)
    return <span className="badge error">Hold expired unpaid</span>;
  if (r.paymentMismatch)
    return <span className="badge warn">Payment amount wrong</span>;
  if (r.payment === "at_hotel")
    return <span className="badge warn">Pay at hotel</span>;
  return <span className="badge warn">Awaiting payment</span>;
}
function Decide({
  r,
  writable,
  done,
}: {
  r: Row;
  writable: boolean;
  done: (m: string) => void;
}) {
  const [rooms, setRooms] = useState<
      { id: string; roomNumber: string }[] | null
    >(null),
    [room, setRoom] = useState(""),
    [rejecting, setRejecting] = useState(false),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    void api<{ id: string; roomNumber: string }[]>(
      `/online-bookings/${r.id}/rooms`,
    )
      .then(setRooms)
      .catch(() => setRooms([]));
  }, [r.id]);
  async function act(path: string, body: object, ok: (x: any) => string) {
    setBusy(true);
    setError("");
    try {
      const x = await api(`/online-bookings/${r.id}/${path}`, {
        method: "POST",
        body: JSON.stringify({ requestId: crypto.randomUUID(), ...body }),
      });
      done(ok(x));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="booking-actions">
      {rejecting ? (
        <>
          <input
            aria-label="Reason for the guest"
            placeholder="Reason for the guest"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            className="secondary"
            disabled={busy || !writable || reason.trim().length < 3}
            onClick={() =>
              void act(
                "reject",
                { reason: reason.trim() },
                (x) =>
                  `${r.reference} rejected.${x.refundDue ? " Refund the online payment to the guest." : ""}`,
              )
            }
          >
            Send rejection
          </button>
          <button className="link" onClick={() => setRejecting(false)}>
            Back
          </button>
        </>
      ) : (
        <>
          <select
            aria-label="Room"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            disabled={!rooms?.length}
          >
            <option value="">
              {rooms === null
                ? "Loading rooms…"
                : rooms.length
                  ? "First free room"
                  : "No free room"}
            </option>
            {rooms?.map((x) => (
              <option key={x.id} value={x.id}>
                Room {x.roomNumber}
              </option>
            ))}
          </select>
          <button
            disabled={busy || !writable || !rooms?.length || r.expired}
            onClick={() =>
              void act(
                "confirm",
                room ? { roomId: room } : {},
                (x) =>
                  `${r.reference} confirmed in room ${x.roomNumber}.${x.paymentsApplied ? " Online payment added to the folio." : ""}`,
              )
            }
          >
            Confirm
          </button>
          <button
            className="secondary"
            disabled={busy || !writable}
            onClick={() => setRejecting(true)}
          >
            Reject
          </button>
        </>
      )}
      {error ? <small className="error-text">{error}</small> : null}
    </div>
  );
}
function Setup({ writable }: { writable: boolean }) {
  const [s, setS] = useState<Settings | null>(null),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = () => api<Settings>("/online-booking/settings").then(setS);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  if (!s)
    return error ? (
      <div className="error-message">{error}</div>
    ) : (
      <div className="empty">Loading…</div>
    );
  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("gateway") || "");
    const secretKey = String(f.get("secretKey") || "").trim(),
      webhookHash = String(f.get("webhookHash") || "").trim();
    const gateway = !name
      ? null
      : {
          name,
          publicKey: String(f.get("publicKey") || "").trim(),
          ...(secretKey ? { secretKey } : {}),
          ...(webhookHash ? { webhookHash } : {}),
        };
    const body = {
      enabled: f.get("enabled") === "on",
      paymentMode: f.get("paymentMode"),
      holdMinutes: Number(f.get("holdMinutes")),
      maxAdvanceDays: Number(f.get("maxAdvanceDays")),
      policy: String(f.get("policy") ?? ""),
      allotments: s!.roomTypes.map((t) => ({
        roomTypeId: t.id,
        onlineAllotment: Number(f.get(`allot-${t.id}`)),
      })),
      gateway,
    };
    setBusy(true);
    setError("");
    setMessage("");
    void api("/online-booking/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    })
      .then(async () => {
        await load();
        setMessage("Saved. The website picks this up on the next cloud sync.");
      })
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  }
  return (
    <form
      className="stack"
      onSubmit={save}
      key={s.gateway?.updatedAt ?? "none"}
    >
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
      {!s.planIncludes ? (
        <div className="notice">
          Online booking is part of the Premium plan. Ask your provider to
          enable it.
        </div>
      ) : null}
      <div className="grid">
        <section className="panel">
          <div className="eyebrow">Booking website</div>
          <h2>Take bookings online</h2>
          <label className="inline">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={s.enabled}
              disabled={!s.planIncludes}
            />{" "}
            Show this hotel on the booking website
          </label>
          {s.bookingUrl ? (
            <>
              <label>Your booking page</label>
              <div className="copy-row">
                <code className="secret">{s.bookingUrl}</code>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void navigator.clipboard?.writeText(s.bookingUrl!)
                  }
                >
                  Copy
                </button>
              </div>
            </>
          ) : (
            <p>
              Set CLOUD_PUBLIC_URL on this hub to show the booking page address.
            </p>
          )}
          <div className="form-grid">
            <div>
              <label htmlFor="paymentMode">Payment</label>
              <select
                id="paymentMode"
                name="paymentMode"
                defaultValue={s.paymentMode}
              >
                <option value="none">Guests pay at the hotel</option>
                <option value="optional">Guests may pay online</option>
                <option value="required">Guests must pay online to book</option>
              </select>
            </div>
            <div>
              <label htmlFor="holdMinutes">
                Hold an unpaid room for (minutes)
              </label>
              <input
                id="holdMinutes"
                name="holdMinutes"
                type="number"
                min={10}
                max={1440}
                defaultValue={s.holdMinutes}
              />
            </div>
            <div>
              <label htmlFor="maxAdvanceDays">
                Open for bookings (days ahead)
              </label>
              <input
                id="maxAdvanceDays"
                name="maxAdvanceDays"
                type="number"
                min={1}
                max={730}
                defaultValue={s.maxAdvanceDays}
              />
            </div>
          </div>
          <label htmlFor="policy">Policy shown to guests</label>
          <textarea
            id="policy"
            name="policy"
            rows={3}
            maxLength={2000}
            defaultValue={s.policy}
          />
        </section>
        <section className="panel">
          <div className="eyebrow">Payment provider</div>
          <h2>
            {s.gateway
              ? `${s.gateway.name === "paystack" ? "Paystack" : "Flutterwave"} connected`
              : "Not connected"}
          </h2>
          <p>
            The secret key is sealed on this hub with the cloud's key. Nobody
            can read it back here. Only the cloud, which talks to the provider,
            can use it.
          </p>
          {!s.sealingAvailable ? (
            <div className="notice">
              The cloud sealing key is not installed. Set
              CLOUD_SEALING_PUBLIC_KEY_FILE.
            </div>
          ) : null}
          <label htmlFor="gateway">Provider</label>
          <select
            id="gateway"
            name="gateway"
            defaultValue={s.gateway?.name ?? ""}
          >
            <option value="">None</option>
            <option value="paystack">Paystack</option>
            <option value="flutterwave">Flutterwave</option>
          </select>
          <label htmlFor="publicKey">Public key</label>
          <input
            id="publicKey"
            name="publicKey"
            defaultValue={s.gateway?.publicKey ?? ""}
            placeholder="pk_live_… or FLWPUBK-…"
          />
          <label htmlFor="secretKey">Secret key</label>
          <input
            id="secretKey"
            name="secretKey"
            type="password"
            autoComplete="off"
            placeholder={
              s.gateway
                ? `Stored (${s.gateway.hint}). Leave blank to keep it.`
                : "sk_live_… or FLWSECK-…"
            }
          />
          <label htmlFor="webhookHash">Flutterwave webhook secret hash</label>
          <input
            id="webhookHash"
            name="webhookHash"
            type="password"
            autoComplete="off"
            placeholder="Only for Flutterwave"
          />
          {s.webhookUrls ? (
            <small className="muted block">
              Webhook address for the provider's dashboard:{" "}
              <code>{s.webhookUrls[s.gateway?.name ?? "paystack"]}</code>
            </small>
          ) : null}
        </section>
      </div>
      <section className="panel table-wrap">
        <h2>Rooms the website may sell</h2>
        <small className="muted">
          Per night, for each room type. Keep these rooms for the website: the
          hub confirms each booking into a real room, and the website never
          sells more than this.
        </small>
        <table>
          <thead>
            <tr>
              <th>Room type</th>
              <th className="num">Rooms</th>
              <th>Online allotment</th>
            </tr>
          </thead>
          <tbody>
            {s.roomTypes.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td className="num">{t.rooms}</td>
                <td>
                  <input
                    name={`allot-${t.id}`}
                    type="number"
                    min={0}
                    max={t.rooms}
                    defaultValue={t.onlineAllotment}
                    style={{ maxWidth: 110 }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <div className="row">
        <button disabled={busy || !writable}>
          {busy ? "Saving…" : "Save online booking"}
        </button>
      </div>
    </form>
  );
}
export function OnlineBookings({
  writable,
  canWrite,
  isAdmin,
}: {
  writable: boolean;
  canWrite: boolean;
  isAdmin: boolean;
}) {
  const [view, setView] = useState<(typeof views)[number] | "setup">("pending"),
    [rows, setRows] = useState<Row[]>([]),
    [pending, setPending] = useState(0),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  async function load() {
    if (view === "setup") return;
    const r = await api<{ rows: Row[]; pending: number }>(
      `/online-bookings?status=${view}`,
    );
    setRows(r.rows);
    setPending(r.pending);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    const t = setInterval(() => void load().catch(() => {}), 30000);
    return () => clearInterval(t);
  }, [view]);
  return (
    <div className="stack">
      <div className="row">
        <div className="segmented" role="tablist">
          {views.map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className={view === v ? "active" : ""}
              onClick={() => setView(v)}
            >
              {v[0].toUpperCase() + v.slice(1)}
              {v === "pending" && pending ? ` (${pending})` : ""}
            </button>
          ))}
          {isAdmin ? (
            <button
              role="tab"
              aria-selected={view === "setup"}
              className={view === "setup" ? "active" : ""}
              onClick={() => setView("setup")}
            >
              Setup
            </button>
          ) : null}
        </div>
      </div>
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
      {view === "setup" ? (
        <Setup writable={writable} />
      ) : (
        <section className="panel table-wrap">
          <div className="panel-head">
            <div>
              <h2>
                {view === "pending"
                  ? "Waiting for a decision"
                  : `${view[0].toUpperCase() + view.slice(1)} bookings`}
              </h2>
              <small>
                Website bookings arrive here when the hub syncs with the cloud.
              </small>
            </div>
          </div>
          {rows.length ? (
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Guest</th>
                  <th>Stay</th>
                  <th className="num">Total</th>
                  <th>Payment</th>
                  <th>{view === "pending" ? "Decision" : "Outcome"}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.reference}</strong>
                      <br />
                      <small>{when(r.receivedAt)}</small>
                    </td>
                    <td>
                      {r.guest.fullName}
                      <br />
                      <small>
                        {r.guest.email}
                        {r.guest.phone ? ` · ${r.guest.phone}` : ""}
                      </small>
                    </td>
                    <td>
                      {r.roomType}
                      <br />
                      <small>
                        {r.checkIn} to {r.checkOut} · {r.nights} night
                        {r.nights === 1 ? "" : "s"} · {r.adults + r.children}{" "}
                        guest
                        {r.adults + r.children === 1 ? "" : "s"}
                        {r.notes ? ` · “${r.notes}”` : ""}
                      </small>
                    </td>
                    <td className="num">{money(r.currency, r.total)}</td>
                    <td>
                      <PaymentBadge r={r} />
                    </td>
                    <td>
                      {view === "pending" && canWrite ? (
                        <Decide
                          r={r}
                          writable={writable}
                          done={(m) => {
                            setMessage(m);
                            void load();
                          }}
                        />
                      ) : r.decision?.roomNumber ? (
                        `Room ${r.decision.roomNumber}`
                      ) : (
                        (r.decision?.reason ?? "—")
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">
              {view === "pending"
                ? "No website bookings are waiting."
                : "Nothing here yet."}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
