import { z } from "zod";
import type {
  Report,
  ReportTable,
  Column,
} from "../../../packages/core/src/report-format.js";
// Phase 5 reports. The same SQL runs on the hub (hotel_app through Prisma) and in the cloud
// (report_reader through pg), always inside one hotel's tenant context, so RLS decides what
// is visible. Money is summed by PostgreSQL and returned as text: Node never adds amounts.
export type Query = (
  sql: string,
  params?: unknown[],
) => Promise<Record<string, any>[]>;
export const reportKinds = [
  "summary",
  "revenue",
  "payments",
  "occupancy",
  "shifts",
  "outstanding",
  "inventory",
] as const;
export type ReportKind = (typeof reportKinds)[number];
export const reportTitles: Record<ReportKind, string> = {
  summary: "Management summary",
  revenue: "Revenue by department",
  payments: "Payments collected",
  occupancy: "Room occupancy",
  shifts: "Cashier shifts",
  outstanding: "Open folio balances",
  inventory: "Inventory and stock use",
};
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const rangeSchema = z
  .object({ from: day, to: day })
  .strict()
  .refine(
    (v) => v.from <= v.to,
    "The start date must be on or before the end date.",
  )
  .refine(
    (v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366,
    "Reports cover at most 366 days.",
  )
  .refine(
    (v) => !Number.isNaN(Date.parse(v.from)) && !Number.isNaN(Date.parse(v.to)),
    "Invalid date.",
  );
export type Range = z.infer<typeof rangeSchema>;

// $1 = from, $2 = to (inclusive hotel-local dates), $3 = hotel time zone.
const lo = "(($1::date)::timestamp AT TIME ZONE $3)",
  hi = "((($2::date)+1)::timestamp AT TIME ZONE $3)",
  inRange = (col: string) => `${col}>=${lo} AND ${col}<${hi}`,
  local = (col: string) => `(${col} AT TIME ZONE $3)::date`,
  m = (expr: string) => `coalesce(${expr},0)::numeric(14,2)::text`;
const roomNet = "('room','room_extension')",
  roomVat = "('room_vat','room_vat_extension')",
  roomService = "('room_service_charge','room_service_charge_extension')";

async function hotel(q: Query) {
  const [t] = await q(
    `SELECT t.name,t.currency,t.timezone,(SELECT s.value->>'name' FROM settings s WHERE s.key='branding' AND s.deleted_at IS NULL LIMIT 1) AS brand
     FROM tenants t WHERE t.id=public.context_tenant()`,
  );
  if (!t) throw new Error("Hotel profile is not available in this database.");
  return {
    name: (t.brand as string) || t.name,
    currency: t.currency as string,
    timezone: t.timezone as string,
  };
}
const money = (key: string, label: string): Column => ({
  key,
  label,
  align: "right",
});
const text = (key: string, label: string): Column => ({ key, label });

// Every revenue line: room charges and folio adjustments by charge time, service sales when
// sold, and voided sales as a negative line on the day they were voided. Folio charges that
// mirror a service sale (service_order/order_reversal) are skipped so nothing counts twice.
const revenueLines = `
  SELECT ${local("c.charged_at")} AS day,
    CASE WHEN c.source_type IN ${roomNet} OR c.source_type IN ${roomVat} OR c.source_type IN ${roomService} THEN 'Rooms' ELSE 'Folio adjustments' END AS department,
    CASE WHEN c.source_type IN ${roomVat} OR c.source_type IN ${roomService} THEN 0 ELSE c.amount END AS net,
    CASE WHEN c.source_type IN ${roomVat} THEN c.amount ELSE 0 END AS vat,
    CASE WHEN c.source_type IN ${roomService} THEN c.amount ELSE 0 END AS service
  FROM folio_charges c
  WHERE c.deleted_at IS NULL AND c.source_type NOT IN ('service_order','order_reversal') AND ${inRange("c.charged_at")}
  UNION ALL
  SELECT ${local("o.created_at")}, initcap(replace(sc.name,'_',' ')),
    coalesce((o.price_snapshot->>'net')::numeric,o.total),coalesce((o.price_snapshot->>'vat')::numeric,0),coalesce((o.price_snapshot->>'service')::numeric,0)
  FROM service_orders o JOIN service_categories sc ON sc.id=o.category_id
  WHERE o.deleted_at IS NULL AND o.status IN ('served','cancelled') AND ${inRange("o.created_at")}
  UNION ALL
  SELECT ${local("o.updated_at")}, initcap(replace(sc.name,'_',' ')),
    -coalesce((o.price_snapshot->>'net')::numeric,o.total),-coalesce((o.price_snapshot->>'vat')::numeric,0),-coalesce((o.price_snapshot->>'service')::numeric,0)
  FROM service_orders o JOIN service_categories sc ON sc.id=o.category_id
  WHERE o.deleted_at IS NULL AND o.status='cancelled' AND ${inRange("o.updated_at")}`;

async function revenueTables(q: Query, p: unknown[]) {
  const byDept = await q(
    `WITH l AS (${revenueLines})
     SELECT department,${m("sum(net)")} AS net,${m("sum(vat)")} AS vat,${m("sum(service)")} AS service,${m("sum(net+vat+service)")} AS total
     FROM l GROUP BY department ORDER BY department='Folio adjustments',department`,
    p,
  );
  const byDay = await q(
    `WITH l AS (${revenueLines}), d AS (SELECT generate_series($1::date,$2::date,interval '1 day')::date AS day)
     SELECT to_char(d.day,'YYYY-MM-DD') AS date,
       ${m("sum(l.net+l.vat+l.service) FILTER (WHERE l.department='Rooms')")} AS rooms,
       ${m("sum(l.net+l.vat+l.service) FILTER (WHERE l.department NOT IN ('Rooms','Folio adjustments'))")} AS services,
       ${m("sum(l.net+l.vat+l.service) FILTER (WHERE l.department='Folio adjustments')")} AS adjustments,
       ${m("sum(l.vat)")} AS vat,${m("sum(l.service)")} AS service,${m("sum(l.net+l.vat+l.service)")} AS total
     FROM d LEFT JOIN l ON l.day=d.day GROUP BY d.day ORDER BY d.day`,
    p,
  );
  const [totals] = await q(
    `WITH l AS (${revenueLines}) SELECT 'Total' AS department,${m("sum(net)")} AS net,${m("sum(vat)")} AS vat,${m("sum(service)")} AS service,${m("sum(net+vat+service)")} AS total,
       ${m("sum(net+vat+service) FILTER (WHERE department='Rooms')")} AS rooms,
       ${m("sum(net+vat+service) FILTER (WHERE department NOT IN ('Rooms','Folio adjustments'))")} AS services,
       ${m("sum(net+vat+service) FILTER (WHERE department='Folio adjustments')")} AS adjustments FROM l`,
    p,
  );
  return { byDept, byDay, totals };
}
const methods = ["cash", "pos", "transfer", "online"] as const;
async function paymentTables(q: Query, p: unknown[]) {
  const byMethod = await q(
    `SELECT m.method::text AS method,count(py.id)::int AS count,${m("sum(py.amount) FILTER (WHERE py.amount>0)")} AS received,
       ${m("-sum(py.amount) FILTER (WHERE py.amount<0)")} AS refunded,${m("sum(py.amount)")} AS net
     FROM unnest(ARRAY['cash','pos','transfer','online']::"PaymentMethod"[]) AS m(method)
     LEFT JOIN payments py ON py.method=m.method AND py.deleted_at IS NULL AND ${inRange("py.paid_at")}
     GROUP BY m.method ORDER BY array_position(ARRAY['cash','pos','transfer','online'],m.method::text)`,
    p,
  );
  const byDay = await q(
    `WITH d AS (SELECT generate_series($1::date,$2::date,interval '1 day')::date AS day)
     SELECT to_char(d.day,'YYYY-MM-DD') AS date,${methods.map((x) => `${m(`sum(py.amount) FILTER (WHERE py.method='${x}')`)} AS ${x}`).join(",")},${m("sum(py.amount)")} AS total
     FROM d LEFT JOIN payments py ON ${local("py.paid_at")}=d.day AND py.deleted_at IS NULL AND ${inRange("py.paid_at")}
     GROUP BY d.day ORDER BY d.day`,
    p,
  );
  const [totals] = await q(
    `SELECT 'Total' AS method,count(*)::int AS count,${m("sum(amount) FILTER (WHERE amount>0)")} AS received,${m("-sum(amount) FILTER (WHERE amount<0)")} AS refunded,${m("sum(amount)")} AS net,
       ${methods.map((x) => `${m(`sum(amount) FILTER (WHERE method='${x}')`)} AS ${x}`).join(",")},${m("sum(amount)")} AS total
     FROM payments WHERE deleted_at IS NULL AND ${inRange("paid_at")}`,
    p,
  );
  return { byMethod, byDay, totals };
}
// A sold night is a night between check-in and check-out of a stay that actually checked in.
// Room count is today's configured rooms: room history is not versioned.
async function occupancyTables(q: Query, range: unknown[]) {
  const p = range.slice(0, 2);
  const nights = await q(
    `WITH d AS (SELECT generate_series($1::date,$2::date,interval '1 day')::date AS day),
     r AS (SELECT count(*)::int AS n FROM rooms WHERE deleted_at IS NULL),
     s AS (SELECT d.day,count(v.id)::int AS sold,sum(v.rate) AS revenue FROM d
       LEFT JOIN reservations v ON v.deleted_at IS NULL AND v.status IN ('checked_in','checked_out') AND v.check_in_date<=d.day AND v.check_out_date>d.day
       GROUP BY d.day),
     a AS (SELECT d.day,count(v.id) FILTER (WHERE v.check_in_date=d.day)::int AS arrivals,count(v.id) FILTER (WHERE v.check_out_date=d.day)::int AS departures FROM d
       LEFT JOIN reservations v ON v.deleted_at IS NULL AND v.status IN ('checked_in','checked_out') AND (v.check_in_date=d.day OR v.check_out_date=d.day)
       GROUP BY d.day)
     SELECT to_char(s.day,'YYYY-MM-DD') AS date,r.n AS rooms,s.sold,
       CASE WHEN r.n=0 THEN '0.0' ELSE round(100.0*s.sold/r.n,1)::text END AS occupancy,
       ${m("round(s.revenue/nullif(s.sold,0),2)")} AS adr,${m("round(s.revenue/nullif(r.n,0),2)")} AS revpar,
       ${m("s.revenue")} AS room_revenue,a.arrivals,a.departures
     FROM s JOIN a ON a.day=s.day CROSS JOIN r ORDER BY s.day`,
    p,
  );
  const [t] = await q(
    `WITH d AS (SELECT generate_series($1::date,$2::date,interval '1 day')::date AS day),
     r AS (SELECT count(*)::int AS n FROM rooms WHERE deleted_at IS NULL),
     s AS (SELECT count(v.id)::int AS sold,sum(v.rate) AS revenue FROM d
       JOIN reservations v ON v.deleted_at IS NULL AND v.status IN ('checked_in','checked_out') AND v.check_in_date<=d.day AND v.check_out_date>d.day)
     SELECT 'Total' AS date,(r.n*(SELECT count(*) FROM d))::int AS rooms,s.sold,
       CASE WHEN r.n=0 THEN '0.0' ELSE round(100.0*s.sold/(r.n*(SELECT count(*) FROM d)),1)::text END AS occupancy,
       ${m("round(s.revenue/nullif(s.sold,0),2)")} AS adr,${m("round(s.revenue/nullif(r.n*(SELECT count(*) FROM d),0),2)")} AS revpar,
       ${m("s.revenue")} AS room_revenue,
       (SELECT count(*) FROM reservations v WHERE v.deleted_at IS NULL AND v.status IN ('checked_in','checked_out') AND v.check_in_date BETWEEN $1::date AND $2::date)::int AS arrivals,
       (SELECT count(*) FROM reservations v WHERE v.deleted_at IS NULL AND v.status IN ('checked_in','checked_out') AND v.check_out_date BETWEEN $1::date AND $2::date)::int AS departures
     FROM r,s`,
    p,
  );
  return { nights, totals: t };
}
async function shiftRows(q: Query, p: unknown[]) {
  return q(
    `SELECT u.name AS cashier,to_char(s.opened_at AT TIME ZONE $3,'YYYY-MM-DD HH24:MI') AS opened,
       coalesce(to_char(s.closed_at AT TIME ZONE $3,'YYYY-MM-DD HH24:MI'),'Open') AS closed,
       ${m("s.opening_float")} AS float,${m("sum(py.amount) FILTER (WHERE py.method='cash')")} AS cash,
       ${m("sum(py.amount) FILTER (WHERE py.method='pos')")} AS pos,${m("sum(py.amount) FILTER (WHERE py.method='transfer')")} AS transfer,
       ${m("s.opening_float+coalesce(sum(py.amount) FILTER (WHERE py.method='cash'),0)")} AS expected,
       CASE WHEN s.closing_cash IS NULL THEN '' ELSE s.closing_cash::numeric(14,2)::text END AS counted,
       CASE WHEN s.variance IS NULL THEN '' ELSE s.variance::numeric(14,2)::text END AS variance
     FROM shifts s JOIN users u ON u.id=s.user_id
     LEFT JOIN payments py ON py.shift_id=s.id AND py.deleted_at IS NULL
     WHERE s.deleted_at IS NULL AND ${inRange("s.opened_at")}
     GROUP BY s.id,u.name ORDER BY s.opened_at`,
    p,
  );
}
// Balance now, not for the period: an open folio is money still owed today.
async function outstandingRows(q: Query, tz: string) {
  return q(
    `WITH c AS (SELECT folio_id,sum(amount) AS total FROM folio_charges WHERE deleted_at IS NULL GROUP BY folio_id),
     py AS (SELECT folio_id,sum(amount) AS total FROM payments WHERE deleted_at IS NULL AND folio_id IS NOT NULL GROUP BY folio_id)
     SELECT g.full_name AS guest,coalesce(rm.room_number,'') AS room,to_char(f.opened_at AT TIME ZONE $1,'YYYY-MM-DD') AS opened,
       coalesce(v.status::text,'') AS stay,${m("c.total")} AS charges,${m("py.total")} AS paid,${m("coalesce(c.total,0)-coalesce(py.total,0)")} AS balance
     FROM folios f JOIN guests g ON g.id=f.guest_id
     LEFT JOIN reservations v ON v.id=f.reservation_id LEFT JOIN rooms rm ON rm.id=v.room_id
     LEFT JOIN c ON c.folio_id=f.id LEFT JOIN py ON py.folio_id=f.id
     WHERE f.deleted_at IS NULL AND f.status='open' AND coalesce(c.total,0)-coalesce(py.total,0)<>0
     ORDER BY coalesce(c.total,0)-coalesce(py.total,0) DESC,f.opened_at`,
    [tz],
  );
}
async function outstandingTotal(q: Query) {
  const [t] = await q(
    `WITH c AS (SELECT folio_id,sum(amount) AS total FROM folio_charges WHERE deleted_at IS NULL GROUP BY folio_id),
     py AS (SELECT folio_id,sum(amount) AS total FROM payments WHERE deleted_at IS NULL AND folio_id IS NOT NULL GROUP BY folio_id)
     SELECT 'Total' AS guest,${m("sum(c.total)")} AS charges,${m("sum(py.total)")} AS paid,${m("sum(coalesce(c.total,0)-coalesce(py.total,0))")} AS balance
     FROM folios f LEFT JOIN c ON c.folio_id=f.id LEFT JOIN py ON py.folio_id=f.id
     WHERE f.deleted_at IS NULL AND f.status='open' AND coalesce(c.total,0)-coalesce(py.total,0)<>0`,
  );
  return t;
}
async function inventoryRows(q: Query, p: unknown[]) {
  return q(
    `SELECT i.name,i.category,i.unit,i.quantity_on_hand::numeric(14,3)::text AS on_hand,i.reorder_level::numeric(14,3)::text AS reorder,
       CASE WHEN i.quantity_on_hand<=i.reorder_level THEN 'Reorder' ELSE 'OK' END AS status,
       coalesce(sum(mv.change_qty) FILTER (WHERE mv.change_qty>0),0)::numeric(14,3)::text AS received,
       coalesce(-sum(mv.change_qty) FILTER (WHERE mv.change_qty<0),0)::numeric(14,3)::text AS used
     FROM inventory_items i LEFT JOIN inventory_movements mv ON mv.item_id=i.id AND mv.deleted_at IS NULL AND ${inRange("mv.created_at")}
     WHERE i.deleted_at IS NULL GROUP BY i.id ORDER BY i.quantity_on_hand<=i.reorder_level DESC,i.category,i.name`,
    p,
  );
}

const revenueDeptTable = (
  rows: Record<string, any>[],
  totals: Record<string, any>,
): ReportTable => ({
  title: "Revenue by department",
  columns: [
    text("department", "Department"),
    money("net", "Net"),
    money("vat", "VAT"),
    money("service", "Service charge"),
    money("total", "Total"),
  ],
  rows,
  totals,
  note: "Service sales count when sold; a voided sale is a negative line on the day it was voided.",
});
const paymentMethodTable = (
  rows: Record<string, any>[],
  totals: Record<string, any>,
): ReportTable => ({
  title: "Payments by method",
  columns: [
    text("method", "Method"),
    money("count", "Payments"),
    money("received", "Received"),
    money("refunded", "Refunded"),
    money("net", "Net"),
  ],
  rows: rows.map((r) => ({ ...r, method: labelMethod(r.method) })),
  totals,
});
const labelMethod = (v: string) =>
  ({
    cash: "Cash",
    pos: "POS card",
    transfer: "Bank transfer",
    online: "Online",
  })[v] ?? v;

// Thousands separators on the exact decimal text. No float conversion.
export function grouped(v: string | null | undefined) {
  const s = String(v ?? "0"),
    neg = s.startsWith("-"),
    [int, frac] = (neg ? s.slice(1) : s).split(".");
  return `${neg ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac !== undefined ? `.${frac}` : ""}`;
}
export async function buildReport(
  q: Query,
  kind: ReportKind,
  range: Range,
  source: "hub" | "cloud",
): Promise<Report> {
  const h = await hotel(q);
  const p = [range.from, range.to, h.timezone];
  const r: Report = {
    kind,
    title: reportTitles[kind],
    hotel: h,
    from: range.from,
    to: range.to,
    generatedAt: new Date().toISOString(),
    source,
    metrics: [],
    tables: [],
  };
  const cur = (v: string) => `${h.currency} ${grouped(v)}`;
  if (kind === "summary") {
    const rev = await revenueTables(q, p),
      pay = await paymentTables(q, p),
      occ = await occupancyTables(q, p);
    const [now] = await q(
      `SELECT (SELECT count(*) FROM reservations WHERE deleted_at IS NULL AND status='checked_in')::int AS in_house,
         (SELECT count(*) FROM rooms WHERE deleted_at IS NULL)::int AS rooms,
         (SELECT count(*) FROM rooms WHERE deleted_at IS NULL AND status='dirty')::int AS dirty,
         (SELECT count(*) FROM rooms WHERE deleted_at IS NULL AND status='maintenance')::int AS maintenance,
         (SELECT count(*) FROM inventory_items WHERE deleted_at IS NULL AND quantity_on_hand<=reorder_level)::int AS low_stock`,
    );
    const owed = await outstandingRows(q, h.timezone),
      owedTotal = await outstandingTotal(q);
    r.metrics = [
      {
        label: "Revenue",
        value: cur(rev.totals.total),
        hint: "Rooms, services and adjustments",
      },
      {
        label: "Payments received",
        value: cur(pay.totals.net),
        hint: "After refunds",
      },
      {
        label: "Occupancy",
        value: `${occ.totals.occupancy}%`,
        hint: `${occ.totals.sold} of ${occ.totals.rooms} room nights`,
      },
      {
        label: "Average daily rate",
        value: cur(occ.totals.adr),
        hint: `RevPAR ${cur(occ.totals.revpar)}`,
      },
      {
        label: "In house now",
        value: String(now.in_house),
        hint: `${now.rooms} rooms configured`,
      },
      {
        label: "Open folio balances",
        value: cur(owedTotal.balance),
        hint: `${owed.length} open folios`,
      },
      {
        label: "Rooms to clean",
        value: String(now.dirty),
        hint: `${now.maintenance} in maintenance`,
      },
      {
        label: "Stock to reorder",
        value: String(now.low_stock),
        hint: "At or below reorder level",
      },
    ];
    r.series = rev.byDay.map((d, i) => ({
      date: d.date,
      revenue: d.total,
      occupancy: occ.nights[i]?.occupancy ?? "0.0",
    }));
    r.tables = [
      revenueDeptTable(rev.byDept, rev.totals),
      paymentMethodTable(pay.byMethod, pay.totals),
    ];
  }
  if (kind === "revenue") {
    const rev = await revenueTables(q, p);
    r.metrics = [
      { label: "Total revenue", value: cur(rev.totals.total) },
      { label: "Rooms", value: cur(rev.totals.rooms) },
      { label: "Services", value: cur(rev.totals.services) },
      { label: "VAT collected", value: cur(rev.totals.vat) },
    ];
    r.tables = [
      revenueDeptTable(rev.byDept, rev.totals),
      {
        title: "Revenue by day",
        columns: [
          text("date", "Date"),
          money("rooms", "Rooms"),
          money("services", "Services"),
          money("adjustments", "Adjustments"),
          money("vat", "VAT"),
          money("service", "Service charge"),
          money("total", "Total"),
        ],
        rows: rev.byDay,
        totals: { ...rev.totals, date: "Total" },
      },
    ];
  }
  if (kind === "payments") {
    const pay = await paymentTables(q, p);
    r.metrics = [
      { label: "Net received", value: cur(pay.totals.net) },
      { label: "Refunded", value: cur(pay.totals.refunded) },
      { label: "Cash", value: cur(pay.totals.cash) },
      { label: "Payments", value: String(pay.totals.count) },
    ];
    r.tables = [
      paymentMethodTable(pay.byMethod, pay.totals),
      {
        title: "Payments by day",
        columns: [
          text("date", "Date"),
          money("cash", "Cash"),
          money("pos", "POS card"),
          money("transfer", "Transfer"),
          money("online", "Online"),
          money("total", "Total"),
        ],
        rows: pay.byDay,
        totals: { ...pay.totals, date: "Total" },
      },
    ];
  }
  if (kind === "occupancy") {
    const occ = await occupancyTables(q, p);
    r.metrics = [
      { label: "Occupancy", value: `${occ.totals.occupancy}%` },
      { label: "Room nights sold", value: String(occ.totals.sold) },
      { label: "Average daily rate", value: cur(occ.totals.adr) },
      { label: "RevPAR", value: cur(occ.totals.revpar) },
    ];
    r.tables = [
      {
        title: "Occupancy by night",
        columns: [
          text("date", "Night"),
          money("rooms", "Rooms"),
          money("sold", "Sold"),
          money("occupancy", "Occupancy %"),
          money("adr", "ADR"),
          money("revpar", "RevPAR"),
          money("room_revenue", "Room revenue"),
          money("arrivals", "Arrivals"),
          money("departures", "Departures"),
        ],
        rows: occ.nights,
        totals: occ.totals,
        note: "Sold nights count stays that checked in. ADR and RevPAR use the booked nightly rate before VAT and service charge.",
      },
    ];
  }
  if (kind === "shifts") {
    const rows = await shiftRows(q, p);
    const [v] = await q(
      `SELECT ${m("sum(variance)")} AS variance FROM shifts WHERE deleted_at IS NULL AND ${inRange("opened_at")}`,
      p,
    );
    r.metrics = [
      { label: "Shifts", value: String(rows.length) },
      {
        label: "Still open",
        value: String(rows.filter((x) => x.closed === "Open").length),
      },
      { label: "Net cash variance", value: cur(v.variance) },
    ];
    r.tables = [
      {
        title: "Shifts opened in the period",
        columns: [
          text("cashier", "Cashier"),
          text("opened", "Opened"),
          text("closed", "Closed"),
          money("float", "Float"),
          money("cash", "Cash"),
          money("pos", "POS"),
          money("transfer", "Transfer"),
          money("expected", "Expected cash"),
          money("counted", "Counted"),
          money("variance", "Variance"),
        ],
        rows,
        note: "Expected cash is the opening float plus cash taken, less cash refunds, on that shift.",
      },
    ];
  }
  if (kind === "outstanding") {
    const rows = await outstandingRows(q, h.timezone);
    const t = await outstandingTotal(q);
    r.metrics = [
      { label: "Balance owed", value: cur(t.balance) },
      { label: "Open folios with a balance", value: String(rows.length) },
    ];
    r.tables = [
      {
        title: "Open folios",
        columns: [
          text("guest", "Guest"),
          text("room", "Room"),
          text("opened", "Opened"),
          text("stay", "Stay"),
          money("charges", "Charges"),
          money("paid", "Paid"),
          money("balance", "Balance"),
        ],
        rows,
        totals: t,
        note: "Balances are as of now. A negative balance is a credit owed to the guest.",
      },
    ];
  }
  if (kind === "inventory") {
    const rows = await inventoryRows(q, p);
    r.metrics = [
      { label: "Items tracked", value: String(rows.length) },
      {
        label: "To reorder",
        value: String(rows.filter((x) => x.status === "Reorder").length),
      },
    ];
    r.tables = [
      {
        title: "Stock",
        columns: [
          text("name", "Item"),
          text("category", "Category"),
          text("unit", "Unit"),
          money("on_hand", "On hand"),
          money("reorder", "Reorder at"),
          text("status", "Status"),
          money("received", "Received"),
          money("used", "Used"),
        ],
        rows,
        note: "On hand is the current count. Received and used cover the selected period.",
      },
    ];
  }
  return r;
}
