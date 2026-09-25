import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Icon } from "./icons";
// Public booking website, served by the cloud at /book/<hotel>. Guests search dates, pick a
// room type from the hotel's online allotment, book, and pay through the hotel's gateway.
// Status pages need the booking reference and the guest's email.
type RoomType = {
  id: string;
  name: string;
  description: string | null;
  capacity: number;
  amenities: string[];
  fromRate: string;
};
type Hotel = {
  name: string;
  address: string;
  currency: string;
  today: string;
  maxAdvanceDays: number;
  policy: string;
  payment: "none" | "optional" | "required";
  gateway: string | null;
  roomTypes: RoomType[];
};
type Price = {
  nights: number;
  rate: string;
  net: string;
  vat: string;
  service: string;
  total: string;
};
type Offer = {
  type: RoomType;
  available: boolean;
  roomsLeft: number;
  price: Price | null;
  error?: string;
};
type Status = {
  reference: string;
  hotel: string;
  status: "pending" | "confirmed" | "rejected" | "cancelled" | "expired";
  roomType: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  guest: string;
  total: string;
  currency: string;
  payment: "paid" | "unpaid" | "at_hotel";
  canPay: boolean;
  holdUntil: string;
  roomNumber: string | null;
  reason: string | null;
};
const [, , slug = "", view = ""] = location.pathname
  .replace(/\/$/, "")
  .split("/");
const params = new URLSearchParams(location.search);
async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/public/hotels/${slug}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error(
      "We could not reach the booking service. Check your connection and try again.",
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(data.error ?? "Something went wrong. Please try again.");
  return data as T;
}
// Remembers which email booked which reference on this device, for the status page.
const remember = (ref: string, email: string) => {
  try {
    localStorage.setItem(`hotel-booking:${ref}`, email);
  } catch {}
};
const recall = (ref: string) => {
  try {
    return localStorage.getItem(`hotel-booking:${ref}`) ?? "";
  } catch {
    return "";
  }
};
const addDays = (d: string, n: number) =>
  new Date(Date.parse(d + "T00:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
const money = (currency: string, v: string) => {
  const [i, f] = v.split(".");
  return `${currency} ${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${f ?? "00"}`;
};
const nice = (d: string) =>
  new Date(d + "T12:00:00Z").toLocaleDateString("en-NG", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
function Book() {
  const [hotel, setHotel] = useState<Hotel | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [search, setSearch] = useState({
      checkIn: "",
      checkOut: "",
      adults: 2,
      children: 0,
    }),
    [offers, setOffers] = useState<Offer[] | null>(null),
    [chosen, setChosen] = useState<Offer | null>(null),
    [status, setStatus] = useState<Status | null>(null),
    [lookup, setLookup] = useState({
      ref: params.get("ref") ?? params.get("booking") ?? "",
      email: "",
    });
  useEffect(() => {
    call<Hotel>("")
      .then((h) => {
        setHotel(h);
        setSearch((s) => ({
          ...s,
          checkIn: addDays(h.today, 1),
          checkOut: addDays(h.today, 2),
        }));
      })
      .catch((e) => setError(e.message));
  }, []);
  // Returning from the payment page: ask the cloud to verify with the gateway.
  useEffect(() => {
    if (!hotel || (view !== "return" && view !== "status") || !lookup.ref)
      return;
    const email = recall(lookup.ref);
    setLookup((l) => ({ ...l, email }));
    const paymentRef =
      params.get("reference") ?? params.get("tx_ref") ?? params.get("trxref");
    void (async () => {
      setBusy(true);
      try {
        if (view === "return" && paymentRef)
          await call("/payments/verify", { reference: paymentRef });
        if (email)
          setStatus(
            await call<Status>(`/bookings/${lookup.ref}/status`, { email }),
          );
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [hotel]);
  async function run(fn: () => Promise<void>) {
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
  function find(e: FormEvent) {
    e.preventDefault();
    if (!hotel) return;
    void run(async () => {
      setChosen(null);
      setOffers(
        await Promise.all(
          hotel.roomTypes.map(async (type) => {
            try {
              const q = await call<{
                available: boolean;
                roomsLeft: number;
                price: Price;
              }>("/quote", { roomTypeId: type.id, ...search });
              return { type, ...q };
            } catch (err) {
              return {
                type,
                available: false,
                roomsLeft: 0,
                price: null,
                error: (err as Error).message,
              };
            }
          }),
        ),
      );
    });
  }
  function book(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!chosen?.price) return;
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email")).trim().toLowerCase();
    const payNow = hotel?.payment === "required" || f.get("payNow") === "now";
    // The request id makes a double-tap or a retried submit land on the same booking.
    const requestId =
      sessionStorage.getItem("hotel-booking-request") ?? crypto.randomUUID();
    sessionStorage.setItem("hotel-booking-request", requestId);
    void run(async () => {
      const r = await call<{
        reference: string;
        paymentUrl?: string;
        paymentError?: string;
      }>("/bookings", {
        roomTypeId: chosen.type.id,
        ...search,
        requestId,
        guest: {
          fullName: String(f.get("fullName")),
          email,
          phone: String(f.get("phone") || "") || undefined,
        },
        notes: String(f.get("notes") || "") || undefined,
        expectedTotal: chosen.price!.total,
        payNow,
      });
      sessionStorage.removeItem("hotel-booking-request");
      remember(r.reference, email);
      if (r.paymentUrl) {
        location.assign(r.paymentUrl);
        return;
      }
      history.replaceState(null, "", `/book/${slug}/status?ref=${r.reference}`);
      setLookup({ ref: r.reference, email });
      setStatus(
        await call<Status>(`/bookings/${r.reference}/status`, { email }),
      );
      if (r.paymentError)
        setError(
          `Your booking is saved, but payment could not start: ${r.paymentError}`,
        );
    });
  }
  const statusText: Record<Status["status"], string> = {
    pending: "Waiting for the hotel to confirm",
    confirmed: "Confirmed",
    rejected: "Not confirmed",
    cancelled: "Cancelled",
    expired: "Expired: payment was not completed in time",
  };
  if (!hotel)
    return (
      <main className="login">
        {error ? (
          <div className="error-message" role="alert">
            {error}
          </div>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </main>
    );
  return (
    <div className="remote book">
      <header className="topbar">
        <div className="crumb">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="building" />
          </span>
          <div>
            <strong>{hotel.name}</strong>
            {hotel.address ? (
              <small className="muted"> · {hotel.address}</small>
            ) : null}
          </div>
        </div>
        <a className="link-button" href={`/book/${slug}/status`}>
          Find my booking
        </a>
      </header>
      <main className="content">
        {error ? (
          <div className="error-message" role="alert">
            {error}
          </div>
        ) : null}
        {view === "status" || view === "return" || status ? (
          <section className="panel booking-status">
            {status ? (
              <>
                <div className="eyebrow">Booking {status.reference}</div>
                <h1>{statusText[status.status]}</h1>
                <div className="summary-grid">
                  <div>
                    <small>Room</small>
                    <strong>
                      {status.roomType}
                      {status.roomNumber ? `, room ${status.roomNumber}` : ""}
                    </strong>
                  </div>
                  <div>
                    <small>Arrive</small>
                    <strong>{nice(status.checkIn)}</strong>
                  </div>
                  <div>
                    <small>Leave</small>
                    <strong>{nice(status.checkOut)}</strong>
                  </div>
                  <div>
                    <small>Guests</small>
                    <strong>{status.adults + status.children}</strong>
                  </div>
                  <div>
                    <small>Total</small>
                    <strong>{money(status.currency, status.total)}</strong>
                  </div>
                  <div>
                    <small>Payment</small>
                    <strong>
                      {status.payment === "paid"
                        ? "Paid online"
                        : status.payment === "at_hotel"
                          ? "Pay at the hotel"
                          : "Not paid yet"}
                    </strong>
                  </div>
                </div>
                {status.reason ? (
                  <p className="notice">Reason: {status.reason}</p>
                ) : null}
                {status.status === "pending" ? (
                  <p className="muted">
                    The hotel confirms online bookings and emails you. Keep your
                    reference, {status.reference}.
                  </p>
                ) : null}
                {status.canPay ? (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const r = await call<{ paymentUrl: string }>(
                          `/bookings/${status.reference}/pay`,
                          { email: lookup.email },
                        );
                        location.assign(r.paymentUrl);
                      })
                    }
                  >
                    Pay {money(status.currency, status.total)} now
                  </button>
                ) : null}
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    remember(lookup.ref, lookup.email);
                    setStatus(
                      await call<Status>(
                        `/bookings/${lookup.ref.trim().toUpperCase()}/status`,
                        { email: lookup.email },
                      ),
                    );
                  });
                }}
              >
                <h1>Find your booking</h1>
                <label htmlFor="ref">Booking reference</label>
                <input
                  id="ref"
                  value={lookup.ref}
                  placeholder="WB-XXXXXXXX"
                  onChange={(e) =>
                    setLookup({ ...lookup, ref: e.target.value })
                  }
                  required
                />
                <label htmlFor="lookup-email">Email used to book</label>
                <input
                  id="lookup-email"
                  type="email"
                  value={lookup.email}
                  onChange={(e) =>
                    setLookup({ ...lookup, email: e.target.value })
                  }
                  required
                />
                <button disabled={busy}>
                  {busy ? "Checking…" : "Show booking"}
                </button>
              </form>
            )}
            <p>
              <a href={`/book/${slug}`}>Make another booking</a>
            </p>
          </section>
        ) : (
          <>
            <div className="intro">
              <div>
                <h1>
                  Book your stay, <span className="soft">{hotel.name}</span>
                </h1>
                <p>Choose your dates to see available rooms and prices.</p>
              </div>
            </div>
            <form className="panel search-bar" onSubmit={find}>
              <label>
                Arrive
                <input
                  type="date"
                  value={search.checkIn}
                  min={hotel.today}
                  max={addDays(hotel.today, hotel.maxAdvanceDays)}
                  required
                  onChange={(e) =>
                    setSearch({
                      ...search,
                      checkIn: e.target.value,
                      checkOut:
                        e.target.value >= search.checkOut
                          ? addDays(e.target.value, 1)
                          : search.checkOut,
                    })
                  }
                />
              </label>
              <label>
                Leave
                <input
                  type="date"
                  value={search.checkOut}
                  min={addDays(search.checkIn || hotel.today, 1)}
                  required
                  onChange={(e) =>
                    setSearch({ ...search, checkOut: e.target.value })
                  }
                />
              </label>
              <label>
                Adults
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={search.adults}
                  onChange={(e) =>
                    setSearch({ ...search, adults: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                Children
                <input
                  type="number"
                  min={0}
                  max={20}
                  value={search.children}
                  onChange={(e) =>
                    setSearch({ ...search, children: Number(e.target.value) })
                  }
                />
              </label>
              <button disabled={busy}>
                {busy && !offers ? "Searching…" : "Check availability"}
              </button>
            </form>
            {offers ? (
              <div className="offers">
                {offers.length === 0 ? (
                  <div className="empty">
                    No rooms are offered online right now.
                  </div>
                ) : null}
                {offers.map((o) => (
                  <section
                    key={o.type.id}
                    className={`panel offer ${chosen?.type.id === o.type.id ? "chosen" : ""}`}
                  >
                    <div>
                      <h2>{o.type.name}</h2>
                      <small className="muted">Sleeps {o.type.capacity}</small>
                      {o.type.description ? <p>{o.type.description}</p> : null}
                    </div>
                    <div className="offer-price">
                      {o.price ? (
                        <>
                          <strong>
                            {money(hotel.currency, o.price.total)}
                          </strong>
                          <small className="muted">
                            {o.price.nights} night
                            {o.price.nights === 1 ? "" : "s"} · includes VAT and
                            service charge
                          </small>
                        </>
                      ) : null}
                      {o.available && o.price ? (
                        <>
                          {o.roomsLeft === 1 ? (
                            <span className="badge warn">
                              Last room for these dates
                            </span>
                          ) : null}
                          <button onClick={() => setChosen(o)}>
                            {chosen?.type.id === o.type.id
                              ? "Selected"
                              : "Select"}
                          </button>
                        </>
                      ) : (
                        <span className="badge error">
                          {o.error ?? "Sold out for these dates"}
                        </span>
                      )}
                    </div>
                  </section>
                ))}
              </div>
            ) : null}
            {chosen?.price ? (
              <form className="panel" onSubmit={book}>
                <h2>Your details</h2>
                <small className="muted">
                  {chosen.type.name} · {nice(search.checkIn)} to{" "}
                  {nice(search.checkOut)} ·{" "}
                  {money(hotel.currency, chosen.price.total)}
                </small>
                <div className="form-grid">
                  <div>
                    <label htmlFor="fullName">Full name</label>
                    <input
                      id="fullName"
                      name="fullName"
                      required
                      minLength={2}
                      maxLength={150}
                      autoComplete="name"
                    />
                  </div>
                  <div>
                    <label htmlFor="email">Email</label>
                    <input
                      id="email"
                      name="email"
                      type="email"
                      required
                      autoComplete="email"
                    />
                  </div>
                  <div>
                    <label htmlFor="phone">Phone</label>
                    <input
                      id="phone"
                      name="phone"
                      type="tel"
                      maxLength={40}
                      autoComplete="tel"
                    />
                  </div>
                  <div>
                    <label htmlFor="notes">Requests (optional)</label>
                    <input id="notes" name="notes" maxLength={500} />
                  </div>
                </div>
                {hotel.payment === "optional" ? (
                  <fieldset className="checks">
                    <legend>Payment</legend>
                    <label className="inline">
                      <input
                        type="radio"
                        name="payNow"
                        value="now"
                        defaultChecked
                      />{" "}
                      Pay now online
                    </label>
                    <label className="inline">
                      <input type="radio" name="payNow" value="later" /> Pay at
                      the hotel
                    </label>
                  </fieldset>
                ) : null}
                {hotel.policy ? (
                  <p className="muted policy">{hotel.policy}</p>
                ) : null}
                <button disabled={busy}>
                  {busy
                    ? "Booking…"
                    : hotel.payment === "required"
                      ? `Book and pay ${money(hotel.currency, chosen.price.total)}`
                      : "Request booking"}
                </button>
                {hotel.payment === "required" ? (
                  <small className="muted block">
                    You pay securely with{" "}
                    {hotel.gateway === "flutterwave"
                      ? "Flutterwave"
                      : "Paystack"}
                    . Your room is held while you pay.
                  </small>
                ) : null}
              </form>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Book />);
