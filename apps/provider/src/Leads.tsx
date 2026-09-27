import { useEffect, useState } from "react";
type Lead = {
  id: string;
  created_at: string;
  name: string;
  email: string;
  phone: string | null;
  hotel_name: string;
  city: string | null;
  rooms: number | null;
  plan: string | null;
  message: string;
  status: "new" | "contacted" | "won" | "lost";
  notes: string | null;
};
type Call = (path: string, method?: string, body?: unknown) => Promise<any>;
const statuses = [
  ["new", "New"],
  ["contacted", "Contacted"],
  ["won", "Won"],
  ["lost", "Lost"],
] as const;
// Enquiries from the website's contact form, newest first, with simple follow-up.
export function Leads({
  call,
  onCounts,
}: {
  call: Call;
  onCounts: (counts: Record<string, number>) => void;
}) {
  const [filter, setFilter] = useState<string>("");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  async function load(f = filter) {
    try {
      const data = await call(`/leads${f ? `?status=${f}` : ""}`);
      setLeads(data.leads);
      setCounts(data.counts);
      onCounts(data.counts);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load(filter);
  }, [filter]);
  async function update(id: string, body: Record<string, string>) {
    try {
      await call(`/leads/${id}`, "PATCH", body);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const whatsapp = (phone: string) => {
    const digits = phone.replace(/\D/g, "");
    // Local Nigerian numbers (0803...) become international (234803...).
    return `https://wa.me/${digits.startsWith("0") ? "234" + digits.slice(1) : digits}`;
  };
  return (
    <>
      <div className="intro">
        <div>
          <div className="eyebrow">Sales</div>
          <h1>Enquiries</h1>
          <p>Messages from the contact form on your website.</p>
        </div>
        <button className="secondary" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error ? (
        <p className="error-message" role="alert">
          {error}
        </p>
      ) : null}
      <div className="lead-filters" role="tablist">
        <button
          role="tab"
          aria-selected={filter === ""}
          className={filter === "" ? "" : "secondary"}
          onClick={() => setFilter("")}
        >
          All · {total}
        </button>
        {statuses.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={filter === id}
            className={filter === id ? "" : "secondary"}
            onClick={() => setFilter(id)}
          >
            {label} · {counts[id] ?? 0}
          </button>
        ))}
      </div>
      {leads.length === 0 ? (
        <section className="panel">
          <p>
            {filter
              ? "No enquiries with this status."
              : "No enquiries yet. They appear here as soon as someone sends the contact form."}
          </p>
        </section>
      ) : null}
      <div className="leads">
        {leads.map((l) => (
          <article key={l.id} className={`panel lead lead-${l.status}`}>
            <header className="lead-head">
              <div>
                <h2>{l.hotel_name}</h2>
                <p className="muted">
                  {l.name}
                  {l.city ? ` · ${l.city}` : ""}
                  {l.rooms ? ` · ${l.rooms} rooms` : ""}
                  {l.plan && l.plan !== "unsure" ? ` · ${l.plan} plan` : ""}
                </p>
              </div>
              <div className="lead-meta">
                <span className={`pill pill-${l.status}`}>{l.status}</span>
                <small>{new Date(l.created_at).toLocaleString()}</small>
              </div>
            </header>
            <p className="lead-message">{l.message}</p>
            <div className="lead-actions">
              <a
                className="button"
                href={`mailto:${l.email}?subject=${encodeURIComponent(`Hotel Hub for ${l.hotel_name}`)}`}
              >
                Email {l.email}
              </a>
              {l.phone ? (
                <>
                  <a className="button secondary" href={`tel:${l.phone}`}>
                    Call {l.phone}
                  </a>
                  <a
                    className="button secondary"
                    href={whatsapp(l.phone)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    WhatsApp
                  </a>
                </>
              ) : null}
              <select
                aria-label="Status"
                value={l.status}
                onChange={(e) => void update(l.id, { status: e.target.value })}
              >
                {statuses.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <form
              className="lead-notes"
              onSubmit={(e) => {
                e.preventDefault();
                void update(l.id, { notes: notes[l.id] ?? l.notes ?? "" });
              }}
            >
              <label htmlFor={`notes-${l.id}`}>Private notes</label>
              <textarea
                id={`notes-${l.id}`}
                value={notes[l.id] ?? l.notes ?? ""}
                maxLength={3000}
                placeholder="Called Tuesday, demo booked for Friday…"
                onChange={(e) =>
                  setNotes((n) => ({ ...n, [l.id]: e.target.value }))
                }
              />
              <button
                className="secondary"
                disabled={(notes[l.id] ?? l.notes ?? "") === (l.notes ?? "")}
              >
                Save notes
              </button>
            </form>
          </article>
        ))}
      </div>
    </>
  );
}
