import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
type Row = Record<string, any>;
function newRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const values = (e: FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget)) as Record<
    string,
    string
  >;
};
const day = (date: string, n: number) =>
  new Date(new Date(date + "T00:00:00Z").getTime() + n * 86400000)
    .toISOString()
    .slice(0, 10);
function Fields({ names, defaults = {} }: { names: string[]; defaults?: Row }) {
  return (
    <>
      {names.map((name) => (
        <label key={name}>
          {name.replace(/([A-Z])/g, " $1")}
          <input
            name={name}
            defaultValue={defaults[name] ?? ""}
            required={["name", "reason"].includes(name)}
          />
        </label>
      ))}
    </>
  );
}
export function FrontDesk({
  writable,
  permissions,
}: {
  writable: boolean;
  permissions: string[];
}) {
  const [config, setConfig] = useState<Row | null>(null),
    [tab, setTab] = useState("Calendar"),
    [page, setPage] = useState(1),
    [data, setData] = useState<Row>({ items: [] }),
    [date, setDate] = useState(""),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [version, setVersion] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [selected, setSelected] = useState<Row | null>(null),
    [folio, setFolio] = useState<Row | null>(null),
    [guest, setGuest] = useState<Row | null>(null),
    [quote, setQuote] = useState<Row | null>(null),
    [booking, setBooking] = useState<Row>({
      adults: 1,
      children: 0,
      source: "phone",
    });
  const pending = useRef(new Map<string, string>());
  const can = (p: string) => permissions.includes(p),
    write = writable && can("frontdesk.write") && !busy;
  const cash = (amount: string) =>
    new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: config?.currency ?? "NGN",
    }).format(Number(amount));
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function send(path: string, input: Row = {}, method = "POST") {
    const key = JSON.stringify([path, method, input]);
    let requestId = pending.current.get(key);
    if (!requestId) {
      requestId = newRequestId();
      pending.current.set(key, requestId);
    }
    const result = await api<Row>(path, {
      method,
      body: JSON.stringify({ ...input, requestId }),
    });
    pending.current.delete(key);
    setVersion((v) => v + 1);
    setNotice("Confirmed by the hotel hub.");
    return result;
  }
  async function open(id: string) {
    const stay = await api<Row>("/reservations/" + id);
    setSelected(stay);
    setGuest(null);
    setFolio(
      stay.folio_id && can("billing.read")
        ? await api("/folios/" + stay.folio_id)
        : null,
    );
  }
  useEffect(() => {
    let active = true;
    void api<Row>("/frontdesk/config")
      .then((c) => {
        if (active) {
          setConfig(c);
          setDate((d) => d || c.today);
          setBooking((b) => ({
            ...b,
            checkInDate: b.checkInDate ?? c.today,
            checkOutDate: b.checkOutDate ?? day(c.today, 1),
            roomTypeId: b.roomTypeId ?? c.roomTypes[0]?.id,
          }));
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [version]);
  useEffect(() => {
    if (!date) return;
    let active = true;
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    let path = "/rooms";
    if (tab === "Calendar") {
      path = "/calendar";
      params.set("from", date);
      params.set("to", day(date, 14));
    }
    if (tab === "Reservations") {
      path = "/reservations";
      if (status) params.set("status", status);
    }
    if (tab === "Guests") {
      path = "/guests";
      params.set("q", query);
    }
    if (!["Calendar", "Reservations", "Guests", "Rooms"].includes(tab)) return;
    void api<Row>(path + "?" + params)
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [tab, page, date, query, status, version]);
  if (!config) return <p role="status">Loading front desk… {error}</p>;
  const days = Array.from({ length: 14 }, (_, i) =>
    day(date || config.today, i),
  );
  const tabs = [
    "Calendar",
    "Reservations",
    "Guests",
    "Rooms",
    ...(can("frontdesk.write") ? ["New stay"] : []),
    ...(can("settings.write") ? ["Room setup"] : []),
  ];
  return (
    <div className="frontdesk">
      <nav className="row" aria-label="Front desk views">
        {tabs.map((t) => (
          <button
            key={t}
            className={tab === t ? "" : "secondary"}
            onClick={() => {
              setTab(t);
              setPage(1);
              setSelected(null);
              setGuest(null);
              setData({ items: [] });
            }}
          >
            {t}
          </button>
        ))}
      </nav>
      {!writable && (
        <p className="notice">
          Hub confirmation is required to save changes. Restore your hotel
          connection or licence, then retry.
        </p>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}{" "}
          <button
            className="secondary"
            onClick={() => setVersion((v) => v + 1)}
          >
            Refresh
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="success">
          {notice}
        </p>
      )}
      {tab === "Calendar" && (
        <section className="panel table-wrap">
          <label>
            Calendar starts
            <input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <p>
            Departure day is available for the next arrival. Overdue occupied
            rooms remain blocked.
          </p>
          <table>
            <thead>
              <tr>
                <th>Room</th>
                {days.map((d) => (
                  <th key={d}>{d.slice(5)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rooms?.map((r: Row) => (
                <tr key={r.id}>
                  <th>
                    {r.room_number}
                    <br />
                    <small>
                      {r.room_type} · {r.status}
                    </small>
                  </th>
                  {days.map((d) => {
                    const stays = data.reservations?.filter(
                      (s: Row) =>
                        s.room_id === r.id &&
                        s.check_in_date <= d &&
                        (s.check_out_date > d ||
                          (s.status === "checked_in" && d <= config.today)),
                    );
                    return (
                      <td key={d}>
                        {stays?.length
                          ? stays.map((s: Row) => (
                              <button
                                className="calendar-stay"
                                key={s.id}
                                onClick={() => void run(() => open(s.id))}
                              >
                                {s.full_name}
                                <br />
                                {s.status.replaceAll("_", " ")}
                              </button>
                            ))
                          : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {tab === "Reservations" && (
        <section className="panel">
          <label>
            Status
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {[
                "pending",
                "confirmed",
                "checked_in",
                "checked_out",
                "cancelled",
                "no_show",
              ].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <StayTable
            rows={data.items ?? []}
            open={(id) => void run(() => open(id))}
          />
        </section>
      )}
      {tab === "Rooms" && (
        <section className="panel">
          <div className="room-grid">
            {data.items?.map((r: Row) => (
              <article className="card" key={r.id}>
                <h2>{r.room_number}</h2>
                <p>
                  {r.room_type} · Floor {r.floor}
                </p>
                <span className="badge">{r.status}</span>
                {can("frontdesk.write") && r.status !== "occupied" && (
                  <form
                    onSubmit={(e) => {
                      const v = values(e);
                      void run(async () => {
                        await send("/rooms/" + r.id + "/status", v, "PATCH");
                      });
                    }}
                  >
                    <select name="status" defaultValue={r.status}>
                      {["available", "dirty", "maintenance"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                    <Fields names={["reason"]} />
                    <button disabled={!write}>Update room</button>
                  </form>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
      {tab === "Guests" && (
        <section className="panel">
          <label>
            Search by name, phone or email
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <table>
            <thead>
              <tr>
                <th>Guest</th>
                <th>Phone</th>
                <th>Email</th>
              </tr>
            </thead>
            <tbody>
              {data.items?.map((g: Row) => (
                <tr key={g.id}>
                  <td>
                    <button
                      className="secondary"
                      onClick={() =>
                        void run(async () => {
                          setGuest(await api("/guests/" + g.id));
                          setSelected(null);
                        })
                      }
                    >
                      {g.full_name}
                    </button>
                  </td>
                  <td>{g.phone}</td>
                  <td>{g.email}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {can("frontdesk.write") && (
            <details>
              <summary>Add guest</summary>
              <form
                onSubmit={(e) => {
                  const v = values(e);
                  void run(async () => {
                    await send(
                      "/guests",
                      Object.fromEntries(
                        Object.entries(v).filter(([, v]) => v),
                      ),
                    );
                  });
                }}
              >
                <Fields
                  names={[
                    "fullName",
                    "phone",
                    "email",
                    "nationality",
                    "address",
                    "idType",
                    "idNumber",
                    "notes",
                  ]}
                />
                <button disabled={!write}>Save guest</button>
              </form>
            </details>
          )}
        </section>
      )}
      {["Calendar", "Reservations", "Guests", "Rooms"].includes(tab) && (
        <div className="row">
          <button
            className="secondary"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span>
            Page {page} · {data.total ?? 0} records
          </span>
          <button
            className="secondary"
            disabled={page * 20 >= (data.total ?? 0)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
      {guest && (
        <section className="panel">
          <h2>{guest.guest.full_name}</h2>
          <p>
            {guest.guest.phone} · {guest.guest.email}
          </p>
          <StayTable
            rows={guest.history}
            open={(id) => void run(() => open(id))}
          />
          <div className="row">
            <button
              disabled={guest.page <= 1}
              onClick={() =>
                void run(async () =>
                  setGuest(
                    await api(
                      `/guests/${guest.guest.id}?page=${guest.page - 1}`,
                    ),
                  ),
                )
              }
            >
              Previous history
            </button>
            <button
              disabled={guest.page * guest.pageSize >= guest.total}
              onClick={() =>
                void run(async () =>
                  setGuest(
                    await api(
                      `/guests/${guest.guest.id}?page=${guest.page + 1}`,
                    ),
                  ),
                )
              }
            >
              More history
            </button>
          </div>
          {can("frontdesk.write") && (
            <details>
              <summary>Edit guest details</summary>
              <form
                key={guest.guest.id}
                onSubmit={(e) => {
                  const v = values(e);
                  void run(async () => {
                    await send(
                      "/guests/" + guest.guest.id,
                      Object.fromEntries(
                        Object.entries(v).filter(([, v]) => v),
                      ),
                      "PUT",
                    );
                    setGuest(await api("/guests/" + guest.guest.id));
                  });
                }}
              >
                <Fields
                  names={[
                    "fullName",
                    "phone",
                    "email",
                    "nationality",
                    "address",
                    "idType",
                    "idNumber",
                    "notes",
                  ]}
                  defaults={{
                    ...guest.guest,
                    fullName: guest.guest.full_name,
                    idType: guest.guest.id_type,
                    idNumber: guest.guest.id_number,
                  }}
                />
                <button disabled={!write}>Save details</button>
              </form>
            </details>
          )}
        </section>
      )}
      {tab === "New stay" && (
        <section className="panel">
          <h2>Reservation or walk-in</h2>
          <form
            onChange={() => setQuote(null)}
            onSubmit={(e) => {
              const v = values(e);
              const input = {
                roomTypeId: v.roomTypeId,
                checkInDate: v.checkInDate,
                checkOutDate: v.checkOutDate,
                adults: Number(v.adults),
                children: Number(v.children),
                ...(v.ratePlanId ? { ratePlanId: v.ratePlanId } : {}),
                source: v.source,
                ...(v.guestId
                  ? { guestId: v.guestId }
                  : {
                      guest: {
                        fullName: v.fullName,
                        ...(v.phone ? { phone: v.phone } : {}),
                        ...(v.email ? { email: v.email } : {}),
                      },
                    }),
              };
              setBooking(input);
              void run(async () => {
                const p = new URLSearchParams(
                  Object.fromEntries(
                    Object.entries(input)
                      .filter(([k]) =>
                        [
                          "roomTypeId",
                          "checkInDate",
                          "checkOutDate",
                          "adults",
                          "children",
                          "ratePlanId",
                        ].includes(k),
                      )
                      .map(([k, v]) => [k, String(v)]),
                  ),
                );
                setQuote(await api("/availability?" + p));
              });
            }}
          >
            <label>
              Stay type
              <select name="source">
                <option value="phone">Advance reservation</option>
                <option value="walk_in">Walk-in and check in now</option>
              </select>
            </label>
            <label>
              Room type
              <select name="roomTypeId" required>
                {config.roomTypes.map((r: Row) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {cash(r.base_rate)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Rate plan
              <select name="ratePlanId">
                <option value="">Standard rate</option>
                {config.ratePlans.map((r: Row) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {cash(r.rate)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Arrival
              <input
                name="checkInDate"
                type="date"
                required
                min={config.today}
                defaultValue={config.today}
              />
            </label>
            <label>
              Departure
              <input
                name="checkOutDate"
                type="date"
                required
                defaultValue={day(config.today, 1)}
              />
            </label>
            <label>
              Adults
              <input
                name="adults"
                type="number"
                min="1"
                max="20"
                defaultValue="1"
                required
              />
            </label>
            <label>
              Children
              <input
                name="children"
                type="number"
                min="0"
                max="20"
                defaultValue="0"
                required
              />
            </label>
            <GuestPicker />
            <p>Or enter a new guest below.</p>
            <Fields names={["fullName", "phone", "email"]} />
            <button disabled={!write}>Check availability and price</button>
          </form>
          {quote && (
            <form
              onSubmit={(e) => {
                const v = values(e);
                void run(async () => {
                  const result = await send(
                    booking.source === "walk_in"
                      ? "/walk-ins"
                      : "/reservations",
                    { ...booking, roomId: v.roomId },
                  );
                  setQuote(null);
                  setTab("Reservations");
                  await open(result.id ?? result.reservationId);
                });
              }}
            >
              <p>
                {quote.price.nights} nights · Room {cash(quote.price.net)} · VAT{" "}
                {cash(quote.price.vat)} · Service {cash(quote.price.service)}
              </p>
              <h3>Total {cash(quote.price.total)}</h3>
              <label>
                Available room
                <select name="roomId" required>
                  {quote.rooms.map((r: Row) => (
                    <option key={r.id} value={r.id}>
                      {r.room_number}
                    </option>
                  ))}
                </select>
              </label>
              {!quote.rooms.length && <p>No available rooms for this stay.</p>}
              <button disabled={!write || !quote.rooms.length}>
                {booking.source === "walk_in"
                  ? "Confirm walk-in and check in"
                  : "Confirm reservation"}
              </button>
            </form>
          )}
        </section>
      )}
      {selected && (
        <section className="panel">
          <div className="row">
            <h2>
              {selected.full_name} · Room {selected.room_number}
            </h2>
            <button
              className="secondary"
              onClick={() => {
                setSelected(null);
                setFolio(null);
              }}
            >
              Close details
            </button>
          </div>
          <p>
            Reference: {selected.id}
            <br />
            {selected.check_in_date} to {selected.check_out_date} ·{" "}
            {selected.status}
          </p>
          <p>
            Nightly rate {cash(selected.rate)} · Agreed total{" "}
            {selected.price_snapshot
              ? cash(selected.price_snapshot.total)
              : "Quote unavailable"}
          </p>
          {can("frontdesk.write") &&
            ["pending", "confirmed"].includes(selected.status) && (
              <>
                <button
                  disabled={!write}
                  onClick={() =>
                    void run(async () => {
                      await send("/reservations/" + selected.id + "/check-in");
                      await open(selected.id);
                    })
                  }
                >
                  Check in
                </button>
                <details>
                  <summary>Change dates or room</summary>
                  <form
                    key={selected.id}
                    onSubmit={(e) => {
                      const v = values(e);
                      void run(async () => {
                        await send(
                          "/reservations/" + selected.id,
                          {
                            ...v,
                            adults: Number(v.adults),
                            children: Number(v.children),
                          },
                          "PATCH",
                        );
                        await open(selected.id);
                      });
                    }}
                  >
                    <label>
                      Arrival
                      <input
                        type="date"
                        name="checkInDate"
                        defaultValue={selected.check_in_date}
                        required
                      />
                    </label>
                    <label>
                      Departure
                      <input
                        type="date"
                        name="checkOutDate"
                        defaultValue={selected.check_out_date}
                        required
                      />
                    </label>
                    <RoomPicker selected={selected.room_id} />
                    <label>
                      Adults
                      <input
                        name="adults"
                        type="number"
                        defaultValue={selected.adults}
                        required
                      />
                    </label>
                    <label>
                      Children
                      <input
                        name="children"
                        type="number"
                        defaultValue={selected.children}
                        required
                      />
                    </label>
                    <p>
                      Changing the stay recalculates the standard room rate.
                    </p>
                    <button disabled={!write}>Confirm amendment</button>
                  </form>
                </details>
                <form
                  onSubmit={(e) => {
                    const v = values(e);
                    void run(async () => {
                      await send("/reservations/" + selected.id + "/cancel", v);
                      await open(selected.id);
                    });
                  }}
                >
                  <select name="status">
                    <option value="cancelled">Cancel reservation</option>
                    <option value="no_show">Mark no-show</option>
                  </select>
                  <Fields names={["reason"]} />
                  <button disabled={!write}>Confirm cancellation</button>
                </form>
              </>
            )}
          {can("frontdesk.write") && selected.status === "checked_in" && (
            <form
              onSubmit={(e) => {
                const v = values(e);
                void run(async () => {
                  await send("/reservations/" + selected.id + "/extend", v);
                  await open(selected.id);
                });
              }}
            >
              <label>
                Extend departure
                <input
                  name="checkOutDate"
                  type="date"
                  min={day(selected.check_out_date, 1)}
                  required
                />
              </label>
              <button disabled={!write}>Extend stay and post charges</button>
            </form>
          )}
          {can("frontdesk.write") && (
            <form
              key={selected.id + selected.notes}
              onSubmit={(e) => {
                const v = values(e);
                void run(async () => {
                  await send(
                    "/reservations/" + selected.id + "/notes",
                    v,
                    "PATCH",
                  );
                  await open(selected.id);
                });
              }}
            >
              <label>
                Stay notes
                <textarea
                  name="notes"
                  maxLength={2000}
                  defaultValue={selected.notes ?? ""}
                />
              </label>
              <button disabled={!write}>Save notes</button>
            </form>
          )}
          {folio && (
            <>
              <h3>Folio · {folio.folio.status}</h3>
              <table>
                <thead>
                  <tr>
                    <th>Entry</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {folio.charges.map((r: Row) => (
                    <tr key={r.id}>
                      <td>{r.description}</td>
                      <td>{cash(r.amount)}</td>
                    </tr>
                  ))}
                  {folio.payments.map((r: Row) => (
                    <tr key={r.id}>
                      <td>Payment · {r.method}</td>
                      <td>{cash(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row">
                <span>
                  Ledger page {folio.page} · {folio.chargeCount} charges,{" "}
                  {folio.paymentCount} payments
                </span>
                <button
                  disabled={folio.page <= 1}
                  onClick={() =>
                    void run(async () =>
                      setFolio(
                        await api(
                          `/folios/${folio.folio.id}?page=${folio.page - 1}`,
                        ),
                      ),
                    )
                  }
                >
                  Previous entries
                </button>
                <button
                  disabled={
                    folio.page * folio.pageSize >=
                    Math.max(folio.chargeCount, folio.paymentCount)
                  }
                  onClick={() =>
                    void run(async () =>
                      setFolio(
                        await api(
                          `/folios/${folio.folio.id}?page=${folio.page + 1}`,
                        ),
                      ),
                    )
                  }
                >
                  More entries
                </button>
              </div>
              <h3>Balance {cash(folio.balance)}</h3>
              <p>
                Open Billing to collect payment or print a receipt. Check-out
                requires a zero balance.
              </p>
              {can("billing.write") && selected.status === "checked_in" && (
                <button
                  disabled={!writable || busy || folio.balance !== "0.00"}
                  onClick={() =>
                    void run(async () => {
                      await send("/reservations/" + selected.id + "/check-out");
                      await open(selected.id);
                    })
                  }
                >
                  Confirm check-out
                </button>
              )}
              <button
                className="secondary"
                onClick={() => void run(() => open(selected.id))}
              >
                Refresh folio
              </button>
            </>
          )}
        </section>
      )}
      {tab === "Room setup" && (
        <div className="grid">
          <section className="panel">
            <h2>Add room type</h2>
            <form
              onSubmit={(e) => {
                const v = values(e);
                void run(async () => {
                  await send("/room-types", {
                    ...v,
                    capacity: Number(v.capacity),
                  });
                });
              }}
            >
              <Fields names={["name", "description"]} />
              <label>
                Nightly rate
                <input
                  name="baseRate"
                  pattern="[0-9]+(\.[0-9]{1,2})?"
                  required
                />
              </label>
              <label>
                Capacity
                <input
                  name="capacity"
                  type="number"
                  min="1"
                  max="20"
                  required
                />
              </label>
              <button disabled={!writable || busy}>Create room type</button>
            </form>
          </section>
          <section className="panel">
            <h2>Add rooms in bulk</h2>
            <form
              onSubmit={(e) => {
                const v = values(e);
                void run(async () => {
                  await send("/rooms/bulk", {
                    roomTypeId: v.roomTypeId,
                    floor: Number(v.floor),
                    numbers: v.numbers
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  });
                });
              }}
            >
              <label>
                Room type
                <select name="roomTypeId">
                  {config.roomTypes.map((r: Row) => (
                    <option value={r.id} key={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Floor
                <input type="number" name="floor" defaultValue="1" required />
              </label>
              <label>
                Room numbers, comma separated
                <input name="numbers" placeholder="105, 106, 107" required />
              </label>
              <button disabled={!writable || busy}>Create rooms</button>
            </form>
          </section>
          <section className="panel">
            <h2>Add rate plan</h2>
            <form
              onSubmit={(e) => {
                const v = values(e);
                void run(async () => {
                  await send("/rate-plans", v);
                });
              }}
            >
              <Fields names={["name"]} />
              <label>
                Room type
                <select name="roomTypeId">
                  {config.roomTypes.map((r: Row) => (
                    <option value={r.id} key={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Rate
                <input name="rate" required />
              </label>
              <label>
                Valid from
                <input name="validFrom" type="date" required />
              </label>
              <label>
                Valid through
                <input name="validTo" type="date" required />
              </label>
              <button disabled={!writable || busy}>Create rate plan</button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
function StayTable({
  rows,
  open,
}: {
  rows: Row[];
  open: (id: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Guest</th>
            <th>Dates</th>
            <th>Room</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <button className="secondary" onClick={() => open(r.id)}>
                  {r.full_name}
                </button>
              </td>
              <td>
                {r.check_in_date} → {r.check_out_date}
              </td>
              <td>{r.room_number ?? r.room_type}</td>
              <td>{r.status.replaceAll("_", " ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p>No stays found.</p>}
    </div>
  );
}
function GuestPicker() {
  const [q, setQ] = useState(""),
    [rows, setRows] = useState<Row[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void api<Row>("/guests?q=" + encodeURIComponent(q))
        .then((d) => {
          if (active) {
            setRows(d.items);
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [q]);
  return (
    <>
      <label>
        Find existing guest
        <input value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <label>
        Existing guest
        <select name="guestId">
          <option value="">Create a new guest</option>
          {rows.map((r) => (
            <option key={r.id} value={r.id}>
              {r.full_name} · {r.phone}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
function RoomPicker({ selected }: { selected: string }) {
  const [rows, setRows] = useState<Row[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void (async () => {
      const result: Row[] = [];
      let page = 1,
        total = 1;
      while (result.length < total) {
        const d = await api<Row>("/rooms?pageSize=100&page=" + page++);
        result.push(...d.items);
        total = d.total;
        if (!d.items.length) break;
      }
      if (active) setRows(result);
    })().catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
    };
  }, []);
  return (
    <label>
      Room
      <select name="roomId" defaultValue={selected} key={rows.length} required>
        {rows.map((r) => (
          <option key={r.id} value={r.id}>
            {r.room_number} · {r.room_type}
          </option>
        ))}
      </select>
      {error}
    </label>
  );
}
