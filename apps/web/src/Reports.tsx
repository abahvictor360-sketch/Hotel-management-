import { useEffect, useState } from "react";
// Shared by the staff app (hub copy, works offline) and the remote management dashboard
// (cloud copy). Each passes its own loader, so the screens and files are identical.
export type Column = { key: string; label: string; align?: "left" | "right" };
export type ReportTable = {
  title: string;
  columns: Column[];
  rows: Record<string, string | number | null>[];
  totals?: Record<string, string | number | null>;
  note?: string;
};
export type ReportData = {
  kind: string;
  title: string;
  hotel: { name: string; currency: string; timezone: string };
  from: string;
  to: string;
  generatedAt: string;
  source: "hub" | "cloud";
  metrics: { label: string; value: string; hint?: string }[];
  tables: ReportTable[];
  series?: { date: string; revenue: string; occupancy: string }[];
};
export type ReportSource = {
  load: (kind: string, from: string, to: string) => Promise<ReportData>;
  download: (
    kind: string,
    from: string,
    to: string,
    format: "csv" | "pdf",
  ) => Promise<void>;
};
export const kinds: [string, string][] = [
  ["summary", "Summary"],
  ["revenue", "Revenue"],
  ["payments", "Payments"],
  ["occupancy", "Occupancy"],
  ["shifts", "Shifts"],
  ["outstanding", "Balances"],
  ["inventory", "Stock"],
];
const iso = (d: Date) => d.toLocaleDateString("en-CA");
function preset(name: string): [string, string] {
  const now = new Date(),
    y = now.getFullYear(),
    m = now.getMonth();
  const back = (days: number) => iso(new Date(y, m, now.getDate() - days));
  switch (name) {
    case "yesterday":
      return [back(1), back(1)];
    case "7d":
      return [back(6), back(0)];
    case "month":
      return [iso(new Date(y, m, 1)), back(0)];
    case "last-month":
      return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    default:
      return [back(0), back(0)];
  }
}
const presets: [string, string][] = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["7d", "Last 7 days"],
  ["month", "This month"],
  ["last-month", "Last month"],
];
const tints = ["blue", "green", "pink", "yellow"];
function Bars({
  title,
  points,
  max,
  format,
}: {
  title: string;
  points: { label: string; value: number; text: string }[];
  max: number;
  format: string;
}) {
  const w = 640,
    h = 150,
    gap = 2,
    bw = Math.max(2, (w - gap * points.length) / Math.max(points.length, 1));
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        <small className="muted">{format}</small>
      </div>
      <svg
        className="bars"
        viewBox={`0 0 ${w} ${h + 18}`}
        role="img"
        aria-label={`${title}: ${points.map((p) => `${p.label} ${p.text}`).join(", ")}`}
      >
        <line x1="0" x2={w} y1={h} y2={h} className="axis" />
        {points.map((p, i) => {
          const bh = max > 0 ? Math.max(0, (p.value / max) * (h - 6)) : 0;
          return (
            <g key={p.label}>
              <rect x={i * (bw + gap)} y={h - bh} width={bw} height={bh} rx="2">
                <title>{`${p.label}: ${p.text}`}</title>
              </rect>
              {points.length <= 16 || i % Math.ceil(points.length / 8) === 0 ? (
                <text
                  x={i * (bw + gap) + bw / 2}
                  y={h + 13}
                  textAnchor="middle"
                >
                  {p.label.slice(5)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </section>
  );
}
export function ReportsView({
  source,
  note,
}: {
  source: ReportSource;
  note?: string;
}) {
  const [kind, setKind] = useState("summary"),
    [[from, to], setRange] = useState<[string, string]>(preset("7d")),
    [report, setReport] = useState<ReportData | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!from || !to) return;
    let live = true;
    setBusy(true);
    setError("");
    source
      .load(kind, from, to)
      .then((r) => live && setReport(r))
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [kind, from, to]);
  async function save(format: "csv" | "pdf") {
    setError("");
    try {
      await source.download(kind, from, to, format);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const series = report?.kind === "summary" ? (report.series ?? []) : [];
  return (
    <div className="stack">
      <section className="panel report-controls">
        <div className="segmented" role="tablist" aria-label="Report">
          {kinds.map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={kind === k}
              className={kind === k ? "active" : ""}
              onClick={() => setKind(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="row report-range">
          <select
            aria-label="Period"
            value=""
            onChange={(e) => e.target.value && setRange(preset(e.target.value))}
          >
            <option value="">Quick period…</option>
            {presets.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <label className="inline">
            From
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setRange([e.target.value, to])}
            />
          </label>
          <label className="inline">
            To
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => setRange([from, e.target.value])}
            />
          </label>
          <button
            className="secondary"
            disabled={busy || !report}
            onClick={() => void save("csv")}
          >
            Download CSV
          </button>
          <button
            className="secondary"
            disabled={busy || !report}
            onClick={() => void save("pdf")}
          >
            Download PDF
          </button>
        </div>
      </section>
      {note ? <div className="notice">{note}</div> : null}
      {error ? (
        <div className="error-message" role="alert">
          {error}
        </div>
      ) : null}
      {report ? (
        <>
          <div className="report-meta muted" aria-live="polite">
            {busy ? "Updating… " : ""}
            {report.title} · {report.from} to {report.to} ·{" "}
            {report.hotel.timezone} · amounts in {report.hotel.currency} · from
            the {report.source === "hub" ? "hotel hub" : "cloud copy"}
          </div>
          {report.metrics.length ? (
            <div className="cards four">
              {report.metrics.map((m, i) => (
                <section className={`stat tint-${tints[i % 4]}`} key={m.label}>
                  <header>{m.label}</header>
                  <div>
                    <strong
                      className={m.value.length > 14 ? "small-value" : ""}
                    >
                      {m.value}
                    </strong>
                    {m.hint ? <small>{m.hint}</small> : null}
                  </div>
                </section>
              ))}
            </div>
          ) : null}
          {series.length > 1 ? (
            <div className="grid even">
              <Bars
                title="Revenue by day"
                format={report.hotel.currency}
                max={Math.max(...series.map((s) => Number(s.revenue)))}
                points={series.map((s) => ({
                  label: s.date,
                  value: Number(s.revenue),
                  text: `${report.hotel.currency} ${s.revenue}`,
                }))}
              />
              <Bars
                title="Occupancy by night"
                format="% of rooms"
                max={100}
                points={series.map((s) => ({
                  label: s.date,
                  value: Number(s.occupancy),
                  text: `${s.occupancy}%`,
                }))}
              />
            </div>
          ) : null}
          {report.tables.map((t) => (
            <section className="panel table-wrap" key={t.title}>
              <h2>{t.title}</h2>
              {t.note ? <small className="muted">{t.note}</small> : null}
              <table className="report-table">
                <thead>
                  <tr>
                    {t.columns.map((c) => (
                      <th
                        key={c.key}
                        className={c.align === "right" ? "num" : ""}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.length ? (
                    t.rows.map((r, i) => (
                      <tr key={i}>
                        {t.columns.map((c) => (
                          <td
                            key={c.key}
                            className={c.align === "right" ? "num" : ""}
                          >
                            {r[c.key] ?? ""}
                          </td>
                        ))}
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={t.columns.length} className="empty">
                        No records in this period.
                      </td>
                    </tr>
                  )}
                </tbody>
                {t.totals ? (
                  <tfoot>
                    <tr>
                      {t.columns.map((c) => (
                        <td
                          key={c.key}
                          className={c.align === "right" ? "num" : ""}
                        >
                          {t.totals![c.key] ?? ""}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </section>
          ))}
        </>
      ) : busy ? (
        <div className="empty">Loading report…</div>
      ) : null}
    </div>
  );
}
