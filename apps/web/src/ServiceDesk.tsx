import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
type Row = Record<string, any>;
export function uuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const s = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
const values = (e: FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget)) as Record<
    string,
    string
  >;
};
function Field({
  name,
  label,
  type = "text",
  value,
  required = true,
}: {
  name: string;
  label: string;
  type?: string;
  value?: string;
  required?: boolean;
}) {
  return (
    <label>
      {label}
      <input name={name} type={type} defaultValue={value} required={required} />
    </label>
  );
}
export function ServiceDesk({
  permissions,
  writable,
  view,
}: {
  permissions: string[];
  writable: boolean;
  view: string;
}) {
  const [catalog, setCatalog] = useState<Row>({ categories: [], items: [] }),
    [category, setCategory] = useState(""),
    [items, setItems] = useState<Row[]>([]),
    [rooms, setRooms] = useState<Row[]>([]),
    [cart, setCart] = useState<Record<string, string>>({}),
    [target, setTarget] = useState(""),
    [parts, setParts] = useState<Row[]>([
      { method: "cash", amount: "", reference: "" },
    ]),
    [folio, setFolio] = useState<Row | null>(null),
    [receipt, setReceipt] = useState<Row | null>(null),
    [shift, setShift] = useState<Row>({}),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [version, setVersion] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [printer, setPrinter] = useState<Row | null>(null),
    [jobs, setJobs] = useState<Row[]>([]),
    [hk, setHk] = useState<Row>({ rooms: [], staff: [], tasks: [] }),
    [stock, setStock] = useState<Row[]>([]);
  const [quote, setQuote] = useState<Row | null>(null);
  useEffect(() => setQuote(null), [cart, category, target]);
  const pending = useRef(new Map<string, string>()),
    can = (p: string) => permissions.includes(p),
    cashier =
      can("billing.write") ||
      permissions.some((p) => p.startsWith("services."));
  const money = (v: string) =>
    new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: receipt?.payload?.hotel?.currency ?? "NGN",
    }).format(Number(v));
  async function run(fn: () => Promise<void>) {
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
  async function send(path: string, data: Row = {}, method = "POST") {
    const key = JSON.stringify([path, method, data]);
    let id = pending.current.get(key);
    if (!id) {
      id = uuid();
      pending.current.set(key, id);
    }
    const result = await api<Row>(path, {
      method,
      body: JSON.stringify({ ...data, requestId: id }),
    });
    pending.current.delete(key);
    setVersion((v) => v + 1);
    setMessage("Confirmed by the hotel hub.");
    return result;
  }
  async function showReceipt(id: string) {
    setReceipt(await api("/billing/receipts/" + id));
  }
  async function showFolio(id: string, p = 1) {
    setFolio(await api(`/folios/${id}?page=${p}`));
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      if (["Services", "Menu setup"].includes(view)) {
        const c = await api<Row>(
          "/services/catalog" +
            (view === "Menu setup" ? "?includeInactive=true" : ""),
        );
        if (active) {
          setCatalog(c);
          setCategory(
            (old) =>
              old ||
              c.categories.find((c: Row) => c.name !== "room")?.id ||
              c.categories[0]?.id ||
              "",
          );
        }
        if (view === "Services") {
          const r = await api<Row[]>("/services/room-folios");
          if (active) setRooms(r);
        }
      }
      if (view === "Printer") {
        const [p, j] = await Promise.all([
          api<Row>("/printing/config"),
          api<Row[]>("/printing/jobs"),
        ]);
        if (active) {
          setPrinter(p);
          setJobs(j);
        }
      }
      if (view === "Housekeeping") {
        const h = await api<Row>("/housekeeping");
        if (active) setHk(h);
      }
      if (view === "Menu setup" && can("inventory.read")) {
        const i = await api<Row>("/inventory?pageSize=100");
        if (active) setStock(i.items);
      }
      if (cashier && ["Services", "Billing", "Receipts"].includes(view)) {
        const s = await api<Row>("/billing/shift");
        if (active) setShift(s);
      }
    })().catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
    };
  }, [view, version]);
  useEffect(() => {
    let active = true;
    let path = "";
    if (view === "Services" && category)
      path = "/services/orders?categoryId=" + category;
    if (view === "Billing") path = "/billing/folios?";
    if (view === "Receipts") path = "/billing/receipts?";
    if (view === "Inventory") path = "/inventory?";
    if (!path) return;
    void api<Row>(path + "&page=" + page)
      .then((d) => {
        if (active) {
          setItems(d.items);
          setTotal(d.total);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [view, category, page, version]);
  const blocked = busy || !writable;
  const payments = () =>
    parts
      .filter((p) => p.amount)
      .map((p) => ({
        method: p.method,
        amount: p.amount,
        ...(p.reference ? { reference: p.reference } : {}),
      }));
  const tenderForm = (
    <fieldset>
      <legend>Split payment</legend>
      {parts.map((p, i) => (
        <div className="row" key={i}>
          <label>
            Method
            <select
              value={p.method}
              onChange={(e) =>
                setParts(
                  parts.map((v, j) =>
                    j === i ? { ...v, method: e.target.value } : v,
                  ),
                )
              }
            >
              {["cash", "pos", "transfer"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            Amount
            <input
              inputMode="decimal"
              value={p.amount}
              onChange={(e) =>
                setParts(
                  parts.map((v, j) =>
                    j === i ? { ...v, amount: e.target.value } : v,
                  ),
                )
              }
            />
          </label>
          <label>
            Reference
            <input
              value={p.reference}
              onChange={(e) =>
                setParts(
                  parts.map((v, j) =>
                    j === i ? { ...v, reference: e.target.value } : v,
                  ),
                )
              }
            />
          </label>
          {i > 0 && (
            <button
              type="button"
              className="secondary"
              onClick={() => setParts(parts.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className="secondary"
        disabled={parts.length >= 8}
        onClick={() =>
          setParts([...parts, { method: "cash", amount: "", reference: "" }])
        }
      >
        Add payment method
      </button>
    </fieldset>
  );
  return (
    <div className="service-desk">
      <div className="row">
        <button className="secondary" onClick={() => setVersion((v) => v + 1)}>
          Refresh
        </button>
      </div>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="success">
          {message}
        </p>
      )}
      {!writable && (
        <p className="notice">
          Hub confirmation is required. Restore the hotel connection or licence
          before completing sales or payments.
        </p>
      )}
      {cashier && ["Services", "Billing", "Receipts"].includes(view) && (
        <details className="panel">
          <summary>
            {shift.shift ? "Cashier shift open" : "Open your cashier shift"}
          </summary>
          {shift.shift ? (
            <>
              <p>
                Opening cash {money(shift.shift.opening_float)} · Expected cash{" "}
                {money(shift.expected)}
              </p>
              <form
                onSubmit={(e) => {
                  const v = values(e);
                  void run(async () => {
                    const s = await send("/billing/shift/close", v);
                    setMessage(
                      `Shift closed. Cash variance: ${money(s.variance)}.`,
                    );
                  });
                }}
              >
                <Field name="closingCash" label="Counted closing cash" />
                <button disabled={blocked}>Close shift</button>
              </form>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                const v = values(e);
                void run(async () => {
                  await send("/billing/shift/open", v);
                });
              }}
            >
              <Field
                name="openingFloat"
                label="Opening cash float"
                value="0.00"
              />
              <button disabled={blocked}>Open shift</button>
            </form>
          )}
        </details>
      )}
      {view === "Services" && (
        <>
          <section className="panel">
            <label>
              Department
              <select
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setCart({});
                  setPage(1);
                }}
              >
                {catalog.categories
                  .filter(
                    (c: Row) =>
                      can("billing.write") || can("services." + c.name),
                  )
                  .map((c: Row) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
            <div className="room-grid">
              {catalog.items
                .filter((i: Row) => i.category_id === category)
                .map((item: Row) => (
                  <label className="card" key={item.id}>
                    {item.name}
                    <small>
                      {money(item.price)} per {item.unit}
                    </small>
                    <input
                      aria-label={item.name + " quantity"}
                      type="number"
                      min="0"
                      step="0.001"
                      value={cart[item.id] ?? ""}
                      onChange={(e) =>
                        setCart({ ...cart, [item.id]: e.target.value })
                      }
                    />
                  </label>
                ))}
            </div>
            <p>
              VAT{" "}
              {catalog.categories.find((c: Row) => c.id === category)
                ?.vat_enabled
                ? catalog.categories.find((c: Row) => c.id === category)
                    ?.vat_rate
                : 0}
              % · Service{" "}
              {catalog.categories.find((c: Row) => c.id === category)
                ?.service_charge_enabled
                ? catalog.categories.find((c: Row) => c.id === category)
                    ?.service_charge_rate
                : 0}
              %
            </p>
            <label>
              Charge destination
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Walk-in sale, collect now</option>
                {rooms
                  .filter((r) => r.folioId)
                  .map((r) => (
                    <option key={r.folioId} value={r.folioId}>
                      Room {r.room}
                    </option>
                  ))}
              </select>
            </label>
            <button
              className="secondary"
              disabled={blocked}
              onClick={() =>
                void run(async () =>
                  setQuote(
                    await api("/services/quote", {
                      method: "POST",
                      body: JSON.stringify({
                        categoryId: category,
                        items: Object.entries(cart)
                          .filter(([, q]) => Number(q) > 0)
                          .map(([itemId, quantity]) => ({ itemId, quantity })),
                      }),
                    }),
                  ),
                )
              }
            >
              Calculate total
            </button>
            {quote && (
              <p>
                Net {money(quote.net)} · VAT {money(quote.vat)} · Service{" "}
                {money(quote.service)} · Total {money(quote.total)}
              </p>
            )}
            {!target && tenderForm}
            <button
              disabled={blocked || !category || !quote}
              onClick={() =>
                void run(async () => {
                  const result = await send("/services/orders", {
                    categoryId: category,
                    expectedTotal: quote?.total,
                    ...(target ? { folioId: target } : {}),
                    items: Object.entries(cart)
                      .filter(([, q]) => Number(q) > 0)
                      .map(([itemId, quantity]) => ({ itemId, quantity })),
                    payments: target ? [] : payments(),
                  });
                  setCart({});
                  setParts([{ method: "cash", amount: "", reference: "" }]);
                  if (result.receipt) await showReceipt(result.receipt.id);
                })
              }
            >
              {target
                ? "Confirm order and post to room"
                : "Confirm sale and collect payment"}
            </button>
          </section>
          <section className="panel table-wrap">
            <h2>Department orders</h2>
            <table>
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Total</th>
                  <th>Status</th>
                  <th>Correction</th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id}>
                    <td>{new Date(o.created_at).toLocaleString()}</td>
                    <td>{money(o.total)}</td>
                    <td>{o.status}</td>
                    <td>
                      {can("billing.write") && o.status === "served" && (
                        <form
                          onSubmit={(e) => {
                            const v = values(e);
                            void run(async () => {
                              const result = await send(
                                "/services/orders/" + o.id + "/void",
                                {
                                  reason: v.reason,
                                  restock: v.restock === "on",
                                },
                              );
                              if (result.refunds?.[0])
                                await showReceipt(result.refunds[0].id);
                            });
                          }}
                        >
                          <Field name="reason" label="Void reason" />
                          <label>
                            <input type="checkbox" name="restock" />
                            Return unused stock
                          </label>
                          <button disabled={blocked}>Void and refund</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
      {view === "Billing" && (
        <section className="panel">
          <h2>Open guest folios</h2>
          <table>
            <thead>
              <tr>
                <th>Guest</th>
                <th>Room</th>
                <th>Stay</th>
              </tr>
            </thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id}>
                  <td>
                    <button
                      className="secondary"
                      onClick={() => void run(() => showFolio(f.id))}
                    >
                      {f.rel_guest_id.full_name}
                    </button>
                  </td>
                  <td>{f.rel_reservation_id?.rel_room_id?.room_number}</td>
                  <td>{f.rel_reservation_id?.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {folio && view === "Billing" && (
        <section className="panel">
          <h2>{folio.folio.rel_guest_id.full_name}</h2>
          <table>
            <thead>
              <tr>
                <th>Charge</th>
                <th>Amount</th>
                <th>Correction</th>
              </tr>
            </thead>
            <tbody>
              {folio.charges.map((c: Row) => (
                <tr key={c.id}>
                  <td>{c.description}</td>
                  <td>{money(c.amount)}</td>
                  <td>
                    {can("billing.write") &&
                      ["manual", "discount"].includes(c.source_type) && (
                        <form
                          onSubmit={(e) => {
                            const v = values(e);
                            void run(async () => {
                              await send(
                                "/billing/charges/" + c.id + "/reverse",
                                v,
                              );
                              await showFolio(folio.folio.id);
                            });
                          }}
                        >
                          <Field name="reason" label="Correction reason" />
                          <button disabled={blocked}>Reverse entry</button>
                        </form>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Payments on this page:{" "}
            {folio.payments
              .map((p: Row) => `${p.method} ${money(p.amount)}`)
              .join(", ") || "None"}
          </p>
          <div className="row">
            <button
              disabled={folio.page <= 1}
              onClick={() =>
                void run(() => showFolio(folio.folio.id, folio.page - 1))
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
                void run(() => showFolio(folio.folio.id, folio.page + 1))
              }
            >
              More entries
            </button>
            <button onClick={() => void run(() => showFolio(folio.folio.id))}>
              Refresh folio
            </button>
            <button
              onClick={() =>
                void run(async () => {
                  const invoice = await api<Row>(
                    "/billing/folios/" + folio.folio.id + "/invoice",
                  );
                  setReceipt({ payload: invoice, invoice: true });
                })
              }
            >
              View invoice
            </button>
          </div>
          <h3>Balance {money(folio.balance)}</h3>
          {can("billing.write") && folio.folio.status === "open" && (
            <>
              <details>
                <summary>Add charge or discount</summary>
                <form
                  onSubmit={(e) => {
                    const v = values(e);
                    void run(async () => {
                      await send(
                        "/billing/folios/" + folio.folio.id + "/charge",
                        {
                          description: v.description,
                          amount: v.amount,
                          discount: v.kind === "discount",
                        },
                      );
                      await showFolio(folio.folio.id);
                    });
                  }}
                >
                  <select name="kind">
                    <option value="charge">Additional charge</option>
                    <option value="discount">
                      After-tax goodwill discount
                    </option>
                  </select>
                  <Field name="description" label="Description or reason" />
                  <Field name="amount" label="Amount" />
                  <button disabled={blocked}>Post entry</button>
                </form>
              </details>
              <form
                onSubmit={(e) => {
                  const v = values(e);
                  void run(async () => {
                    const r = await send(
                      "/billing/folios/" + folio.folio.id + "/pay",
                      { payments: payments(), checkout: v.checkout === "on" },
                    );
                    await showReceipt(r.receipt.id);
                    await showFolio(folio.folio.id);
                    setParts([{ method: "cash", amount: "", reference: "" }]);
                  });
                }}
              >
                {tenderForm}
                <label>
                  <input name="checkout" type="checkbox" />
                  Check out and close the folio after settlement
                </label>
                <button disabled={blocked}>Confirm payment</button>
              </form>
              <button
                className="secondary"
                disabled={blocked || folio.balance !== "0.00"}
                onClick={() =>
                  void run(async () => {
                    await send("/billing/folios/" + folio.folio.id + "/close");
                    await showFolio(folio.folio.id);
                  })
                }
              >
                Close settled folio and check out
              </button>
            </>
          )}
        </section>
      )}
      {view === "Receipts" && (
        <section className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Guest</th>
                <th>Collected</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button
                      className="secondary"
                      onClick={() => void run(() => showReceipt(r.id))}
                    >
                      {r.receipt_number}
                    </button>
                  </td>
                  <td>{r.payload.customer}</td>
                  <td>{money(r.payload.paid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {receipt && (
        <section className="panel receipt-panel">
          <div className="print-controls row">
            <button className="secondary" onClick={() => setReceipt(null)}>
              Close document
            </button>
            {receipt.invoice && (
              <button className="secondary" onClick={() => window.print()}>
                Print invoice / Save PDF
              </button>
            )}
          </div>
          <ReceiptDocument data={receipt.payload} invoice={receipt.invoice} />
          {!receipt.invoice && (
            <div className="print-controls">
              <p>Confirmed reprints: {receipt.reprint_count ?? 0}</p>
              {receipt.print_jobs?.map((j: Row) => (
                <p key={j.id}>
                  {j.kind}: {j.status}
                  {j.error ? " · " + j.error : ""}
                </p>
              ))}
              <p>
                A sent job means the printer connection accepted the data. Check
                the paper before requesting another copy.
              </p>
              <form
                onSubmit={(e) => {
                  const v = values(e);
                  void run(async () => {
                    await send("/printing/receipts/" + receipt.id, {
                      reason: v.reason,
                      reprint: v.kind === "reprint",
                    });
                    await showReceipt(receipt.id);
                  });
                }}
              >
                <select name="kind">
                  <option value="original">Print original</option>
                  <option value="reprint">Request reprint</option>
                </select>
                <Field
                  name="reason"
                  label="Print reason"
                  value="Customer copy"
                />
                <button disabled={blocked}>Send to receipt printer</button>
              </form>
              <button
                className="secondary"
                onClick={() => void run(() => showReceipt(receipt.id))}
              >
                Refresh print status
              </button>
              {can("billing.write") &&
                receipt.folio_id &&
                !receipt.reversal_of_id && (
                  <details>
                    <summary>Reverse this payment receipt</summary>
                    <p>
                      Confirm the money has been refunded using the original
                      payment methods. The folio must remain open.
                    </p>
                    <form
                      onSubmit={(e) => {
                        const v = values(e);
                        void run(async () => {
                          const r = await send(
                            "/billing/receipts/" + receipt.id + "/reverse",
                            v,
                          );
                          await showReceipt(r.id);
                        });
                      }}
                    >
                      <Field name="reason" label="Refund reason" />
                      <button disabled={blocked}>Record full refund</button>
                    </form>
                  </details>
                )}
            </div>
          )}
        </section>
      )}
      {view === "Inventory" && (
        <>
          <section className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Stock</th>
                  <th>Available</th>
                  <th>Reorder at</th>
                  <th>Adjustment</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.name}{" "}
                      {i.lowStock && (
                        <span className="badge warn">Low stock</span>
                      )}
                    </td>
                    <td>
                      {i.quantity_on_hand} {i.unit}
                    </td>
                    <td>{i.reorder_level}</td>
                    <td>
                      {can("inventory.write") && (
                        <form
                          onSubmit={(e) => {
                            const v = values(e);
                            void run(async () => {
                              await send("/inventory/" + i.id + "/adjust", v);
                            });
                          }}
                        >
                          <Field
                            name="change"
                            label="Quantity change, negative to deduct"
                          />
                          <Field name="reason" label="Reason" />
                          <button disabled={blocked}>Record movement</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {can("inventory.write") && (
            <section className="panel">
              <h2>Add stock item</h2>
              <form
                onSubmit={(e) => {
                  const v = values(e);
                  void run(async () => {
                    await send("/inventory", v);
                  });
                }}
              >
                <Field name="name" label="Name" />
                <Field name="unit" label="Unit" />
                <Field name="category" label="Department" />
                <Field name="reorderLevel" label="Reorder level" value="0" />
                <button disabled={blocked}>Create stock item</button>
              </form>
            </section>
          )}
        </>
      )}
      {view === "Housekeeping" && (
        <>
          <section className="panel">
            <h2>Room tasks</h2>
            {hk.tasks.map((t: Row) => (
              <article className="card" key={t.id}>
                <h3>
                  Room {t.rel_room_id.room_number} · {t.type}
                </h3>
                <p>
                  {t.rel_assigned_to?.name} · {t.notes} · Reference: {t.id}
                </p>
                {can("housekeeping.write") && (
                  <form
                    onSubmit={(e) => {
                      const v = values(e);
                      void run(async () => {
                        await send("/housekeeping/" + t.id + "/complete", v);
                      });
                    }}
                  >
                    <select name="status">
                      <option value="available">Clean and available</option>
                      <option value="maintenance">Under maintenance</option>
                    </select>
                    <Field name="notes" label="Completion notes" />
                    <button disabled={blocked}>Complete task</button>
                  </form>
                )}
              </article>
            ))}
          </section>
          {can("housekeeping.write") && (
            <section className="panel">
              <h2>Assign a task</h2>
              <form
                onSubmit={(e) => {
                  const v = values(e);
                  void run(async () => {
                    await send("/housekeeping", v);
                  });
                }}
              >
                <label>
                  Room
                  <select name="roomId">
                    {hk.rooms.map((r: Row) => (
                      <option key={r.id} value={r.id}>
                        {r.room_number} · {r.status}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Assigned staff
                  <select name="assignedTo">
                    {hk.staff.map((u: Row) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </label>
                <select name="type">
                  <option value="cleaning">Cleaning</option>
                  <option value="maintenance">Maintenance</option>
                </select>
                <Field name="notes" label="Notes" required={false} />
                <button disabled={blocked}>Assign task</button>
              </form>
            </section>
          )}
        </>
      )}
      {view === "Printer" && can("settings.write") && (
        <>
          <section className="panel">
            <h2>Receipt printer</h2>
            <form
              key={JSON.stringify(printer)}
              onSubmit={(e) => {
                const v = values(e);
                void run(async () => {
                  await send(
                    "/printing/config",
                    {
                      config: {
                        type: v.type,
                        interface: v.interface,
                        width: v.width,
                        characterSet: v.characterSet,
                        baudRate: Number(v.baudRate),
                        cut: v.cut === "on",
                      },
                    },
                    "PUT",
                  );
                });
              }}
            >
              <label>
                Connection
                <select name="type" defaultValue={printer?.type ?? "network"}>
                  {["network", "usb", "serial"].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <Field
                name="interface"
                label="Network: tcp://192.168.1.50:9100 · USB: printer:Queue name · Serial: COM3"
                value={printer?.interface ?? ""}
              />
              <label>
                Paper width
                <select name="width" defaultValue={printer?.width ?? "80"}>
                  <option value="80">80 mm</option>
                  <option value="58">58 mm</option>
                </select>
              </label>
              <label>
                Character set
                <select
                  name="characterSet"
                  defaultValue={printer?.characterSet ?? "PC437_USA"}
                >
                  {[
                    "PC437_USA",
                    "PC850_MULTILINGUAL",
                    "WPC1252",
                    "PC858_EURO",
                    "PC852_LATIN2",
                  ].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                Serial baud rate
                <select
                  name="baudRate"
                  defaultValue={printer?.baudRate ?? 9600}
                >
                  {[9600, 19200, 38400, 57600, 115200].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  name="cut"
                  type="checkbox"
                  defaultChecked={printer?.cut !== false}
                />
                Cut paper after receipt
              </label>
              <div className="row form-actions">
                <button disabled={blocked}>Save printer settings</button>
                <button
                  type="button"
                  className="secondary"
                  disabled={blocked}
                  onClick={() =>
                    void run(async () => {
                      await send("/printing/test");
                    })
                  }
                >
                  Print test receipt
                </button>
              </div>
            </form>
          </section>
          <section className="panel">
            <h2>Recent print jobs</h2>
            {jobs.map((j) => (
              <p key={j.id}>
                {new Date(j.created_at).toLocaleString()} · {j.kind} ·{" "}
                {j.status} {j.error}
              </p>
            ))}
          </section>
        </>
      )}
      {view === "Menu setup" && can("settings.write") && (
        <>
          <section className="panel">
            <h2>Create menu item</h2>
            <form
              onSubmit={(e) => {
                const v = values(e);
                void run(async () => {
                  await send("/services/items", {
                    ...v,
                    ...(!v.inventoryItemId
                      ? { inventoryItemId: undefined }
                      : {}),
                  });
                });
              }}
            >
              <label>
                Category
                <select name="categoryId">
                  {catalog.categories.map((c: Row) => (
                    <option value={c.id} key={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <Field name="name" label="Item name" />
              <Field name="price" label="Unit price" />
              <Field name="unit" label="Unit" value="each" />
              <label>
                Deduct inventory
                <select name="inventoryItemId">
                  <option value="">No stock tracking</option>
                  {stock.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} · {i.unit}
                    </option>
                  ))}
                </select>
              </label>
              <Field
                name="stockPerUnit"
                label="Stock units per sale unit"
                value="1"
              />
              <button disabled={blocked}>Create menu item</button>
            </form>
          </section>
          <section className="panel">
            <h2>Category taxes</h2>
            {catalog.categories.map((c: Row) => (
              <form
                key={c.id}
                onSubmit={(e) => {
                  const v = values(e);
                  void run(async () => {
                    await send(
                      "/services/categories/" + c.id + "/tax",
                      {
                        vatEnabled: v.vatEnabled === "on",
                        serviceEnabled: v.serviceEnabled === "on",
                        vatRate: v.vatRate,
                        serviceRate: v.serviceRate,
                      },
                      "PATCH",
                    );
                  });
                }}
              >
                <h3>{c.name}</h3>
                <label>
                  <input
                    name="vatEnabled"
                    type="checkbox"
                    defaultChecked={c.vat_enabled}
                  />
                  Apply VAT
                </label>
                <Field name="vatRate" label="VAT percent" value={c.vat_rate} />
                <label>
                  <input
                    name="serviceEnabled"
                    type="checkbox"
                    defaultChecked={c.service_charge_enabled}
                  />
                  Apply service charge
                </label>
                <Field
                  name="serviceRate"
                  label="Service charge percent"
                  value={c.service_charge_rate}
                />
                <button disabled={blocked}>Save category taxes</button>
              </form>
            ))}
          </section>
          <section className="panel">
            <h2>Menu prices</h2>
            {catalog.items.map((i: Row) => (
              <form
                key={i.id}
                onSubmit={(e) => {
                  const v = values(e);
                  void run(async () => {
                    await send(
                      "/services/items/" + i.id,
                      { price: v.price, isActive: v.isActive === "on" },
                      "PATCH",
                    );
                  });
                }}
              >
                <h3>{i.name}</h3>
                <Field name="price" label="Price" value={i.price} />
                <label>
                  <input
                    name="isActive"
                    type="checkbox"
                    defaultChecked={i.is_active}
                  />
                  Available for sale
                </label>
                <button disabled={blocked}>Update item</button>
              </form>
            ))}
          </section>
        </>
      )}
      {["Services", "Billing", "Receipts", "Inventory"].includes(view) && (
        <div className="row">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span>
            Page {page} · {total} records
          </span>
          <button
            disabled={page * 30 >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
function ReceiptDocument({ data, invoice }: { data: Row; invoice?: boolean }) {
  return (
    <article className="print-document">
      {data.hotel.logoUrl && (
        <img className="logo" src={data.hotel.logoUrl} alt="Hotel logo" />
      )}
      <h2>{data.hotel.name}</h2>
      <p>{data.hotel.address}</p>
      <h3>
        {invoice
          ? "Invoice · Not proof of payment"
          : data.kind === "refund"
            ? "Refund receipt"
            : "Payment receipt"}
      </h3>
      <p>
        {data.number}
        <br />
        {new Date(data.issuedAt).toLocaleString()}
      </p>
      <p>
        Cashier: {data.cashier} · Guest: {data.customer}
      </p>
      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th>{data.hotel.currency}</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l: Row, i: number) => (
            <tr key={i}>
              <td>{l.description}</td>
              <td>{l.amount}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Total: {data.total}</p>
      <p>
        {invoice ? "Paid to date" : "Paid this receipt"}: {data.paid}
      </p>
      <p>Balance: {data.balance}</p>
      {data.payments.map((p: Row) => (
        <p key={p.id}>
          {p.method} · {p.amount} · {p.reference}
        </p>
      ))}
      <p>{data.hotel.footer}</p>
      {data.hotel.providerCredit && <small>Powered by Hotel Hub</small>}
    </article>
  );
}
