import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import {
  buildReport,
  grouped,
  rangeSchema,
  type Query,
} from "../apps/api/src/reports.js";
import { tenantExport } from "../apps/api/src/exports.js";
import { unzip } from "./zip-reader.js";
import { createCloudApp } from "../apps/api/src/cloud-app.js";
import {
  issueToken,
  verifyToken,
  parseToken,
} from "../apps/api/src/remote-access.js";
import {
  csvCell,
  reportCsv,
  reportPdf,
  zip,
  crc32,
} from "../packages/core/src/report-format.js";
const migrations = [
  "202609250001_phase1",
  "202609250002_security",
  "202609250003_frontdesk",
  "202609250004_billing",
  "202609250005_sync",
  "202609250006_reports",
  "202609250007_booking",
  "202609250008_hardening",
];
async function database() {
  const db = new PGlite({ extensions: { btree_gist, pg_trgm } });
  for (const m of migrations)
    await db.exec(
      readFileSync(`packages/db/prisma/migrations/${m}/migration.sql`, "utf8"),
    );
  return db;
}
function writer(db: PGlite, tenant: string) {
  return async (sql: string, role = "hotel_app") => {
    await db.exec(
      `RESET ROLE; SET ROLE ${role}; SELECT set_config('app.tenant_id','${tenant}',false),set_config('app.can_write','true',false),set_config('app.device_id','test',false),set_config('app.user_id','',false),set_config('app.event_id','${randomUUID()}',false),set_config('app.audit_id','${randomUUID()}',false); ${sql}; RESET ROLE;`,
    );
  };
}
// A query function running as a given role for one hotel, like a pooled connection.
function reader(db: PGlite, tenant: string, role = "report_reader"): Query {
  return async (sql, params) => {
    await db.exec(
      `RESET ROLE; SET ROLE ${role}; SELECT set_config('app.tenant_id','${tenant}',false)`,
    );
    try {
      return (await db.query<Record<string, any>>(sql, params)).rows;
    } finally {
      await db.exec("RESET ROLE");
    }
  };
}
const as = (db: PGlite, role: string) => async () => {
  await db.exec(`SET ROLE ${role}`);
  return {
    conn: {
      query: (sql: string, params?: unknown[]) => db.query(sql, params) as any,
    },
    release: () => void db.exec("RESET ROLE"),
  };
};
const find = (rows: Record<string, any>[], key: string, value: string) =>
  rows.find((r) => r[key] === value)!;

async function seedHotel(
  db: PGlite,
  tenant: string,
  plan: "standard" | "premium" = "premium",
) {
  const w = writer(db, tenant);
  const id = () => randomUUID();
  const ids = {
    role: id(),
    user: id(),
    type: id(),
    r101: id(),
    r102: id(),
    r103: id(),
    g1: id(),
    g2: id(),
    g3: id(),
    res1: id(),
    res2: id(),
    res3: id(),
    f1: id(),
    f2: id(),
    restaurant: id(),
    bar: id(),
    o1: id(),
    o2: id(),
    o3: id(),
    shift: id(),
    rice: id(),
    beer: id(),
  };
  await w(
    `INSERT INTO tenants(id,tenant_id,name,slug,branding,timezone,currency) VALUES('${tenant}','${tenant}','Lagoon Hotel','lagoon-${tenant.slice(0, 8)}','{}','Africa/Lagos','NGN')`,
    "provider_app",
  );
  await w(
    `INSERT INTO subscriptions(id,tenant_id,plan,status,features) VALUES('${id()}','${tenant}','${plan}','active','{"mobile_dashboard":${plan === "premium"}}')`,
    "provider_app",
  );
  await w(
    `INSERT INTO roles(id,tenant_id,name,permissions) VALUES('${ids.role}','${tenant}','admin','[]')`,
  );
  await w(
    `INSERT INTO users(id,tenant_id,name,email,password_hash,role_id) VALUES('${ids.user}','${tenant}','Ada Cashier','ada@h.test','$2a$12$never-exported','${ids.role}')`,
  );
  await w(
    `INSERT INTO room_types(id,tenant_id,name,base_rate,capacity,amenities) VALUES('${ids.type}','${tenant}','Standard',25000,2,'[]')`,
  );
  for (const [room, n] of [
    [ids.r101, "101"],
    [ids.r102, "102"],
    [ids.r103, "103"],
  ])
    await w(
      `INSERT INTO rooms(id,tenant_id,room_number,room_type_id) VALUES('${room}','${tenant}','${n}','${ids.type}')`,
    );
  for (const [g, n] of [
    [ids.g1, "Chidi Okafor"],
    [ids.g2, "=HYPERLINK(evil)"],
    [ids.g3, "Bola Ade"],
  ])
    await w(
      `INSERT INTO guests(id,tenant_id,full_name) VALUES('${g}','${tenant}','${n}')`,
    );
  await w(
    `INSERT INTO reservations(id,tenant_id,guest_id,room_id,room_type_id,check_in_date,check_out_date,rate,status) VALUES('${ids.res1}','${tenant}','${ids.g1}','${ids.r101}','${ids.type}','2026-03-01','2026-03-03',25000,'checked_in')`,
  );
  await w(
    `INSERT INTO reservations(id,tenant_id,guest_id,room_id,room_type_id,check_in_date,check_out_date,rate,status) VALUES('${ids.res2}','${tenant}','${ids.g2}','${ids.r102}','${ids.type}','2026-03-02','2026-03-03',30000,'checked_out')`,
  );
  await w(
    `INSERT INTO reservations(id,tenant_id,guest_id,room_id,room_type_id,check_in_date,check_out_date,rate,status) VALUES('${ids.res3}','${tenant}','${ids.g3}','${ids.r103}','${ids.type}','2026-03-01','2026-03-02',99999,'cancelled')`,
  );
  await w(
    `INSERT INTO folios(id,tenant_id,reservation_id,guest_id,opened_at) VALUES('${ids.f1}','${tenant}','${ids.res1}','${ids.g1}','2026-03-01 10:00+01')`,
  );
  await w(
    `INSERT INTO folios(id,tenant_id,reservation_id,guest_id,opened_at) VALUES('${ids.f2}','${tenant}','${ids.res2}','${ids.g2}','2026-03-02 12:00+01')`,
  );
  const charge = (
    folio: string,
    type: string,
    amount: string,
    at: string,
    source: string | null = null,
  ) =>
    w(
      `INSERT INTO folio_charges(id,tenant_id,folio_id,source_type,source_id,description,amount,charged_at) VALUES('${id()}','${tenant}','${folio}','${type}',${source ? `'${source}'` : "NULL"},'${type}',${amount},'${at}')`,
    );
  await charge(ids.f1, "room", "50000.00", "2026-03-01 10:00+01", ids.res1);
  await charge(ids.f1, "room_vat", "3750.00", "2026-03-01 10:00+01", ids.res1);
  await charge(
    ids.f1,
    "room_service_charge",
    "5000.00",
    "2026-03-01 10:00+01",
    ids.res1,
  );
  await charge(ids.f2, "room", "30000.00", "2026-03-02 12:00+01", ids.res2);
  await charge(ids.f2, "room_vat", "2250.00", "2026-03-02 12:00+01", ids.res2);
  await charge(
    ids.f2,
    "room_service_charge",
    "3000.00",
    "2026-03-02 12:00+01",
    ids.res2,
  );
  await charge(ids.f1, "manual", "1500.00", "2026-03-02 09:00+01");
  await charge(ids.f1, "discount", "-500.00", "2026-03-02 09:05+01");
  await w(
    `INSERT INTO service_categories(id,tenant_id,name) VALUES('${ids.restaurant}','${tenant}','restaurant')`,
  );
  await w(
    `INSERT INTO service_categories(id,tenant_id,name) VALUES('${ids.bar}','${tenant}','bar')`,
  );
  const order = (
    o: string,
    cat: string,
    folio: string | null,
    net: string,
    vat: string,
    svc: string,
    total: string,
    at: string,
  ) =>
    w(
      `INSERT INTO service_orders(id,tenant_id,category_id,folio_id,ordered_by,status,total,idempotency_key,price_snapshot,created_at) VALUES('${o}','${tenant}','${cat}',${folio ? `'${folio}'` : "NULL"},'${ids.user}','served',${total},'${o}','{"version":1,"net":"${net}","vat":"${vat}","service":"${svc}","total":"${total}"}','${at}')`,
    );
  await order(
    ids.o1,
    ids.restaurant,
    ids.f1,
    "10000.00",
    "750.00",
    "1000.00",
    "11750.00",
    "2026-03-01 20:00+01",
  );
  await charge(
    ids.f1,
    "service_order",
    "11750.00",
    "2026-03-01 20:00+01",
    ids.o1,
  );
  await order(
    ids.o2,
    ids.bar,
    null,
    "2000.00",
    "150.00",
    "200.00",
    "2350.00",
    "2026-03-02 21:00+01",
  );
  await order(
    ids.o3,
    ids.restaurant,
    null,
    "4000.00",
    "300.00",
    "400.00",
    "4700.00",
    "2026-03-03 13:00+01",
  );
  await w(`UPDATE service_orders SET status='cancelled' WHERE id='${ids.o3}'`);
  await w(
    `INSERT INTO shifts(id,tenant_id,user_id,opened_at,opening_float,closed_at,closing_cash,variance) VALUES('${ids.shift}','${tenant}','${ids.user}','2026-03-01 08:00+01',10000,'2026-03-03 20:00+01',29000,-1000)`,
  );
  const pay = (
    target: string,
    method: string,
    amount: string,
    at: string,
    ref = "NULL",
    pid = id(),
    reversal = "NULL",
  ) =>
    w(
      `INSERT INTO payments(id,tenant_id,${target.split("=")[0]},amount,method,reference,received_by,paid_at,idempotency_key,shift_id,reversal_of_id) VALUES('${pid}','${tenant}','${target.split("=")[1]}',${amount},'${method}',${ref},'${ids.user}','${at}','${id()}','${ids.shift}',${reversal})`,
    );
  const barPayment = id();
  // 23:30 UTC on 1 March is 00:30 on 2 March in Lagos: it belongs to the 2nd.
  await pay(`folio_id=${ids.f1}`, "cash", "20000.00", "2026-03-01 23:30+00");
  await pay(
    `folio_id=${ids.f1}`,
    "pos",
    "30000.00",
    "2026-03-02 10:00+01",
    "'POS-1'",
  );
  await pay(
    `folio_id=${ids.f2}`,
    "transfer",
    "35250.00",
    "2026-03-02 12:30+01",
    "'TRF-1'",
  );
  await pay(
    `order_id=${ids.o2}`,
    "cash",
    "2350.00",
    "2026-03-02 21:05+01",
    "NULL",
    barPayment,
  );
  await pay(
    `order_id=${ids.o2}`,
    "cash",
    "-2350.00",
    "2026-03-03 09:00+01",
    "NULL",
    id(),
    `'${barPayment}'`,
  );
  await w(
    `INSERT INTO inventory_items(id,tenant_id,name,unit,quantity_on_hand,reorder_level,category) VALUES('${ids.rice}','${tenant}','Rice','kg',5,10,'Kitchen')`,
  );
  await w(
    `INSERT INTO inventory_items(id,tenant_id,name,unit,quantity_on_hand,reorder_level,category) VALUES('${ids.beer}','${tenant}','Beer','bottle',50,12,'Bar')`,
  );
  const move = (item: string, qty: string, at: string) =>
    w(
      `INSERT INTO inventory_movements(id,tenant_id,item_id,change_qty,reason,moved_by,created_at) VALUES('${id()}','${tenant}','${item}',${qty},'test','${ids.user}','${at}')`,
    );
  await move(ids.rice, "20", "2026-03-01 09:00+01");
  await move(ids.rice, "-15", "2026-03-02 09:00+01");
  await move(ids.beer, "-6", "2026-03-02 22:00+01");
  return ids;
}

test("reports: exact revenue, payments, occupancy, shifts, balances and stock per hotel-local day", async () => {
  const db = await database();
  const a = randomUUID(),
    b = randomUUID();
  try {
    await seedHotel(db, a);
    // A second hotel whose rows must never appear in hotel A's figures.
    const other = await seedHotel(db, b);
    await writer(
      db,
      b,
    )(
      `INSERT INTO rooms(id,tenant_id,room_number,room_type_id) VALUES('${randomUUID()}','${b}','999','${other.type}')`,
    );
    const range = rangeSchema.parse({ from: "2026-03-01", to: "2026-03-03" });
    for (const role of ["report_reader", "hotel_app"]) {
      const q = reader(db, a, role);
      const rev = await buildReport(q, "revenue", range, "cloud");
      const dept = rev.tables[0];
      assert.deepEqual(
        dept.rows.map((r) => [r.department, r.net, r.vat, r.service, r.total]),
        [
          ["Bar", "2000.00", "150.00", "200.00", "2350.00"],
          ["Restaurant", "14000.00", "1050.00", "1400.00", "16450.00"],
          ["Rooms", "80000.00", "6000.00", "8000.00", "94000.00"],
          ["Folio adjustments", "1000.00", "0.00", "0.00", "1000.00"],
        ],
        role,
      );
      assert.equal(dept.totals!.total, "113800.00");
      assert.deepEqual(
        rev.tables[1].rows.map((r) => [
          r.date,
          r.rooms,
          r.services,
          r.adjustments,
          r.total,
        ]),
        [
          ["2026-03-01", "58750.00", "11750.00", "0.00", "70500.00"],
          ["2026-03-02", "35250.00", "2350.00", "1000.00", "38600.00"],
          ["2026-03-03", "0.00", "4700.00", "0.00", "4700.00"],
        ],
      );
      const pay = await buildReport(q, "payments", range, "hub");
      assert.deepEqual(
        pay.tables[0].rows.map((r) => [
          r.method,
          r.count,
          r.received,
          r.refunded,
          r.net,
        ]),
        [
          ["Cash", 3, "22350.00", "2350.00", "20000.00"],
          ["POS card", 1, "30000.00", "0.00", "30000.00"],
          ["Bank transfer", 1, "35250.00", "0.00", "35250.00"],
          ["Online", 0, "0.00", "0.00", "0.00"],
        ],
      );
      assert.equal(pay.tables[0].totals!.net, "85250.00");
      assert.deepEqual(
        pay.tables[1].rows.map((r) => [r.date, r.cash, r.total]),
        [
          ["2026-03-01", "0.00", "0.00"],
          ["2026-03-02", "22350.00", "87600.00"],
          ["2026-03-03", "-2350.00", "-2350.00"],
        ],
      );
      const occ = await buildReport(q, "occupancy", range, "hub");
      assert.deepEqual(
        occ.tables[0].rows.map((r) => [
          r.date,
          r.rooms,
          r.sold,
          r.occupancy,
          r.adr,
          r.arrivals,
          r.departures,
        ]),
        [
          ["2026-03-01", 3, 1, "33.3", "25000.00", 1, 0],
          ["2026-03-02", 3, 2, "66.7", "27500.00", 1, 0],
          ["2026-03-03", 3, 0, "0.0", "0.00", 0, 2],
        ],
      );
      const t = occ.tables[0].totals!;
      assert.deepEqual(
        [
          t.rooms,
          t.sold,
          t.occupancy,
          t.adr,
          t.revpar,
          t.room_revenue,
          t.arrivals,
          t.departures,
        ],
        [9, 3, "33.3", "26666.67", "8888.89", "80000.00", 2, 2],
      );
      const shifts = await buildReport(q, "shifts", range, "hub");
      assert.deepEqual(
        shifts.tables[0].rows.map((r) => [
          r.cashier,
          r.opened,
          r.float,
          r.cash,
          r.pos,
          r.expected,
          r.counted,
          r.variance,
        ]),
        [
          [
            "Ada Cashier",
            "2026-03-01 08:00",
            "10000.00",
            "20000.00",
            "30000.00",
            "30000.00",
            "29000.00",
            "-1000.00",
          ],
        ],
      );
      const owed = await buildReport(q, "outstanding", range, "hub");
      assert.deepEqual(
        owed.tables[0].rows.map((r) => [
          r.guest,
          r.room,
          r.charges,
          r.paid,
          r.balance,
        ]),
        [["Chidi Okafor", "101", "71500.00", "50000.00", "21500.00"]],
      );
      assert.equal(owed.tables[0].totals!.balance, "21500.00");
      const stock = await buildReport(q, "inventory", range, "hub");
      assert.deepEqual(
        stock.tables[0].rows.map((r) => [
          r.name,
          r.status,
          r.on_hand,
          r.received,
          r.used,
        ]),
        [
          ["Rice", "Reorder", "5.000", "20.000", "15.000"],
          ["Beer", "OK", "50.000", "0.000", "6.000"],
        ],
      );
      const summary = await buildReport(q, "summary", range, "cloud");
      assert.equal(
        find(summary.metrics, "label", "Revenue").value,
        "NGN 113,800.00",
      );
      assert.equal(find(summary.metrics, "label", "Occupancy").value, "33.3%");
      assert.equal(
        find(summary.metrics, "label", "Open folio balances").value,
        "NGN 21,500.00",
      );
      assert.equal(find(summary.metrics, "label", "In house now").value, "1");
      assert.deepEqual(
        summary.series!.map((s) => s.revenue),
        ["70500.00", "38600.00", "4700.00"],
      );
    }
    // A sale voided today is a negative line today, not a rewrite of March.
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Africa/Lagos",
    });
    const voids = await buildReport(
      reader(db, a),
      "revenue",
      rangeSchema.parse({ from: today, to: today }),
      "hub",
    );
    assert.equal(
      find(voids.tables[0].rows, "department", "Restaurant").total,
      "-4700.00",
    );
  } finally {
    await db.close();
  }
});

test("report_reader is read-only, tenant-scoped and never sees login secrets", async () => {
  const db = await database();
  const a = randomUUID(),
    b = randomUUID();
  try {
    await seedHotel(db, a);
    await seedHotel(db, b);
    const q = reader(db, a);
    assert.equal((await q("SELECT count(*)::int AS n FROM rooms"))[0].n, 3);
    assert.equal((await q("SELECT count(*)::int AS n FROM payments"))[0].n, 5);
    assert.equal(
      (
        await q(
          `SELECT count(*)::int AS n FROM payments WHERE tenant_id='${b}'`,
        )
      )[0].n,
      0,
    );
    await assert.rejects(
      q("SELECT password_hash FROM users"),
      /permission denied/,
    );
    await assert.rejects(
      q("SELECT key_hash FROM licenses"),
      /permission denied/,
    );
    await assert.rejects(
      q("SELECT * FROM gateway_credentials"),
      /permission denied/,
    );
    await assert.rejects(q("SELECT * FROM sync_queue"), /permission denied/);
    await assert.rejects(q("SELECT * FROM audit_log"), /permission denied/);
    await assert.rejects(q(`UPDATE rooms SET floor=2`), /permission denied/);
    await assert.rejects(
      q(
        `INSERT INTO guests(id,tenant_id,full_name) VALUES('${randomUUID()}','${a}','x')`,
      ),
      /permission denied/,
    );
    // Without a tenant context nothing is visible at all.
    await db.exec(
      "SET ROLE report_reader; SELECT set_config('app.tenant_id','',false)",
    );
    assert.equal(
      (await db.query<any>("SELECT count(*)::int AS n FROM rooms")).rows[0].n,
      0,
    );
    await db.exec("RESET ROLE");
  } finally {
    await db.close();
  }
});

test("tenant departure export: every table, checksummed, no password hashes, exact money", async () => {
  const db = await database();
  const a = randomUUID(),
    b = randomUUID();
  try {
    await seedHotel(db, a);
    await seedHotel(db, b);
    for (const [role, source] of [
      ["hotel_app", "hub"],
      ["report_reader", "cloud"],
    ] as const) {
      const out = await tenantExport(reader(db, a, role), source);
      const files = unzip(out.zip);
      const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
      assert.equal(manifest.tenantId, a);
      assert.equal(manifest.source, source);
      for (const t of manifest.tables) {
        const data = files.get(t.file)!;
        assert.equal(
          createHash("sha256").update(data).digest("hex"),
          t.sha256,
          t.file,
        );
        assert.equal(
          data.toString("utf8").trim().split("\r\n").length - 1,
          t.rows,
          t.file,
        );
      }
      const count = (table: string) =>
        manifest.tables.find((t: any) => t.table === table)?.rows;
      assert.equal(count("rooms"), 3);
      assert.equal(count("payments"), 5);
      assert.equal(count("tenants"), 1);
      if (source === "hub") assert.ok(count("audit_log") > 0);
      else assert.deepEqual(manifest.unavailable, ["audit_log"]);
      const users = files.get("data/users.csv")!.toString("utf8");
      assert.ok(
        !users.includes("password_hash") && !users.includes("never-exported"),
      );
      const payments = files.get("data/payments.csv")!.toString("utf8");
      assert.ok(payments.includes("35250.00") && payments.includes("-2350.00"));
      assert.ok(!payments.includes(b), "other hotel rows leaked");
      // Formula-looking guest names are neutralised for spreadsheets.
      assert.ok(
        files
          .get("data/guests.csv")!
          .toString("utf8")
          .includes("'=HYPERLINK(evil)"),
      );
    }
  } finally {
    await db.close();
  }
});

test("remote dashboard: access links, plan and subscription gates, downloads and read-only export", async () => {
  const db = await database();
  const tenant = randomUUID(),
    standard = randomUUID();
  try {
    const ids = await seedHotel(db, tenant);
    await seedHotel(db, standard, "standard");
    const full = issueToken(
      tenant,
      { label: "Owner phone", days: 30, scopes: ["reports", "export"] },
      ids.user,
    );
    const exportOnly = issueToken(
      tenant,
      { label: "Accountant", days: 30, scopes: ["export"] },
      ids.user,
    );
    const expired = issueToken(
      tenant,
      { label: "Old", days: 1, scopes: ["reports"] },
      ids.user,
      new Date(Date.now() - 3 * 86_400_000),
    );
    const revoked = issueToken(
      tenant,
      { label: "Lost phone", days: 30, scopes: ["reports"] },
      ids.user,
    );
    revoked.record.revokedAt = new Date().toISOString();
    const value = JSON.stringify({
      tokens: [full.record, exportOnly.record, expired.record, revoked.record],
    });
    await writer(
      db,
      tenant,
    )(
      `INSERT INTO settings(id,tenant_id,key,value) VALUES('${randomUUID()}','${tenant}','remote_access','${value}')`,
    );
    const std = issueToken(
      standard,
      { label: "Std", days: 30, scopes: ["reports", "export"] },
      null,
    );
    await writer(
      db,
      standard,
    )(
      `INSERT INTO settings(id,tenant_id,key,value) VALUES('${randomUUID()}','${standard}','remote_access','${JSON.stringify({ tokens: [std.record] })}')`,
    );
    const app = createCloudApp(as(db, "sync_agent"), {
      reports: as(db, "report_reader"),
    });
    const get = (path: string, token?: string) => {
      const r = request(app).get(path);
      return token ? r.set("Authorization", `Bearer ${token}`) : r;
    };
    assert.equal((await get("/api/remote/session")).status, 401);
    assert.equal(
      (await get("/api/remote/session", "hh1.not.a.token")).status,
      401,
    );
    const tampered =
      full.token.slice(0, -2) + (full.token.endsWith("AA") ? "BB" : "AA");
    assert.equal((await get("/api/remote/session", tampered)).status, 401);
    assert.equal((await get("/api/remote/session", expired.token)).status, 401);
    assert.equal((await get("/api/remote/session", revoked.token)).status, 401);
    // A token cannot be replayed against another hotel by editing its hotel id.
    assert.equal(
      (await get("/api/remote/session", full.token.replace(tenant, standard)))
        .status,
      401,
    );
    const session = await get("/api/remote/session", full.token);
    assert.equal(session.status, 200);
    assert.equal(session.body.hotel, "Lagoon Hotel");
    assert.equal(session.body.dashboard, true);
    assert.ok(!JSON.stringify(session.body).includes(full.record.hash));
    const q = "from=2026-03-01&to=2026-03-03";
    const json = await get(`/api/remote/reports/revenue?${q}`, full.token);
    assert.equal(json.status, 200);
    assert.equal(json.body.source, "cloud");
    assert.equal(json.body.tables[0].totals.total, "113800.00");
    const csv = await get(
      `/api/remote/reports/payments?${q}&format=csv`,
      full.token,
    );
    assert.equal(csv.status, 200);
    assert.match(csv.headers["content-type"], /text\/csv/);
    assert.match(
      csv.headers["content-disposition"],
      /lagoon-hotel-payments-2026-03-01-to-2026-03-03\.csv/,
    );
    assert.ok(csv.text.includes("85250.00"));
    const pdf = await get(
      `/api/remote/reports/summary?${q}&format=pdf`,
      full.token,
    )
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    assert.equal(pdf.status, 200);
    assert.equal(
      (pdf.body as Buffer).subarray(0, 8).toString("latin1"),
      "%PDF-1.4",
    );
    assert.equal(
      (
        await get(
          `/api/remote/reports/revenue?from=2026-03-03&to=2026-03-01`,
          full.token,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await get(
          `/api/remote/reports/revenue?from=2025-01-01&to=2026-03-01`,
          full.token,
        )
      ).status,
      400,
    );
    assert.equal(
      (await get(`/api/remote/reports/secrets?${q}`, full.token)).status,
      400,
    );
    // Scopes and plan gates.
    assert.equal(
      (await get(`/api/remote/reports/revenue?${q}`, exportOnly.token)).status,
      403,
    );
    assert.equal(
      (await get(`/api/remote/reports/revenue?${q}`, std.token)).status,
      403,
    );
    assert.equal((await get("/api/remote/export", std.token)).status, 200);
    // A cancelled hotel loses the dashboard but keeps its departure export.
    await writer(db, tenant)(
      `UPDATE subscriptions SET status='cancelled' WHERE tenant_id='${tenant}'`,
      "provider_app",
    );
    const closed = await get(`/api/remote/reports/revenue?${q}`, full.token);
    assert.equal(closed.status, 403);
    assert.match(closed.body.error, /Data export stays available/);
    const exp = await get("/api/remote/export", exportOnly.token)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    assert.equal(exp.status, 200);
    assert.equal(exp.headers["content-type"], "application/zip");
    const manifest = JSON.parse(
      unzip(exp.body as Buffer)
        .get("manifest.json")!
        .toString("utf8"),
    );
    assert.equal(manifest.tenantId, tenant);
    assert.equal(manifest.source, "cloud");
    // Nothing the dashboard did reached the outbox or changed a row.
    await db.exec("RESET ROLE");
    assert.equal(
      (
        await db.query<any>(
          "SELECT count(*)::int AS n FROM sync_queue WHERE device_id='sync'",
        )
      ).rows[0].n,
      0,
    );
    // Without a report connection the cloud does not serve the dashboard at all.
    const syncOnly = createCloudApp(as(db, "sync_agent"));
    assert.equal(
      (
        await request(syncOnly)
          .get("/api/remote/session")
          .set("Authorization", `Bearer ${full.token}`)
      ).status,
      404,
    );
  } finally {
    await db.close();
  }
});

test("export formats: CSV injection guard, grouping, PDF structure, ZIP checksums, token parsing", () => {
  assert.equal(csvCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(csvCell("+234 801"), "'+234 801");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell("-1500.00"), "-1500.00");
  assert.equal(
    csvCell('He said "hi", then left'),
    '"He said ""hi"", then left"',
  );
  assert.equal(csvCell(null), "");
  assert.equal(grouped("1234567890.12"), "1,234,567,890.12");
  assert.equal(grouped("-1000.00"), "-1,000.00");
  assert.equal(grouped("999.5"), "999.5");
  const report = {
    kind: "revenue",
    title: "Revenue (test)",
    hotel: { name: "Hôtel ₦ Café", currency: "NGN", timezone: "Africa/Lagos" },
    from: "2026-03-01",
    to: "2026-03-02",
    generatedAt: "2026-03-03T00:00:00.000Z",
    source: "hub" as const,
    metrics: [{ label: "Total", value: "₦ 1,000.00" }],
    tables: [
      {
        title: "Lines (a) \\ b",
        columns: [
          { key: "d", label: "Date" },
          { key: "v", label: "Value", align: "right" as const },
        ],
        rows: Array.from({ length: 120 }, (_, i) => ({
          d: `2026-03-${i}`,
          v: `${i}.00`,
        })),
        totals: { d: "Total", v: "7140.00" },
      },
    ],
  };
  const csv = reportCsv(report);
  assert.ok(csv.startsWith("﻿Revenue (test)"));
  assert.ok(csv.includes("Total,7140.00"));
  const pdf = reportPdf(report);
  const text = pdf.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.endsWith("%%EOF\n"));
  // Every xref offset must point at its object header, or readers refuse the file.
  const start = Number(text.match(/startxref\n(\d+)/)![1]);
  assert.ok(text.slice(start).startsWith("xref"));
  const offsets = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map(
    (m) => Number(m[1]),
  );
  offsets.forEach((o, i) =>
    assert.ok(text.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`),
  );
  for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const from = m.index! + m[0].length;
    assert.equal(
      text.slice(from + Number(m[1]), from + Number(m[1]) + 10),
      "\nendstream",
    );
  }
  assert.ok(
    Number(text.match(/\/Count (\d+)/)![1]) >= 2,
    "long tables paginate",
  );
  assert.ok(
    text.includes("(Lines \\(a\\) \\\\ b) Tj"),
    "PDF strings are escaped",
  );
  assert.ok(
    text.includes("NGN"),
    "the naira sign is written as the currency code",
  );
  const z = zip([
    { name: "a.txt", data: Buffer.from("hello") },
    { name: "ñ/b.csv", data: Buffer.alloc(10000, 65) },
  ]);
  const files = unzip(z);
  assert.equal(files.get("a.txt")!.toString(), "hello");
  assert.equal(files.get("ñ/b.csv")!.length, 10000);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const t = issueToken(
    randomUUID(),
    { label: "x", days: 1, scopes: ["reports"] },
    null,
  );
  const parsed = parseToken(`Bearer ${t.token}`)!;
  assert.ok(verifyToken([t.record], parsed.id, parsed.secret));
  assert.equal(
    verifyToken([t.record], parsed.id, parsed.secret.replace(/.$/, "x")),
    null,
  );
  assert.equal(parseToken("hh1.a.b.c"), null);
  assert.ok(
    !JSON.stringify(t.record).includes(parsed.secret),
    "only the hash is stored",
  );
});
