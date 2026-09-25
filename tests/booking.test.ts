import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { createCloudApp } from "../apps/api/src/cloud-app.js";
import { SyncWorker, type Transport } from "../apps/api/src/sync-worker.js";
import { deliverPending } from "../apps/api/src/notifier.js";
import { gatewayClient, assess } from "../apps/api/src/gateways.js";
import {
  hashToken,
  sealForCloud,
  openSealed,
  gatewayAad,
} from "../packages/core/src/crypto.js";
import {
  toMinor,
  fromMinor,
  bookingReference,
  renderMessage,
} from "../packages/core/src/booking.js";
import { hotelToday } from "../packages/core/src/stays.js";
const migrations = [
  "202609250001_phase1",
  "202609250002_security",
  "202609250003_frontdesk",
  "202609250004_billing",
  "202609250005_sync",
  "202609250006_reports",
  "202609250007_booking",
];
async function database() {
  const db = new PGlite({ extensions: { btree_gist, pg_trgm } });
  for (const m of migrations)
    await db.exec(
      readFileSync(`packages/db/prisma/migrations/${m}/migration.sql`, "utf8"),
    );
  return db;
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
function writer(db: PGlite, tenant: string) {
  return async (sql: string, role = "hotel_app") => {
    await db.exec(
      `RESET ROLE; SET ROLE ${role}; SELECT set_config('app.tenant_id','${tenant}',false),set_config('app.can_write','true',false),set_config('app.device_id','test',false),set_config('app.user_id','',false),set_config('app.event_id','${randomUUID()}',false),set_config('app.audit_id','${randomUUID()}',false); ${sql}; RESET ROLE;`,
    );
  };
}
async function rows(
  db: PGlite,
  tenant: string,
  sql: string,
  role = "postgres",
) {
  await db.exec(
    `RESET ROLE; SET ROLE ${role}; SELECT set_config('app.tenant_id','${tenant}',false)`,
  );
  try {
    return (await db.query<any>(sql)).rows;
  } finally {
    await db.exec("RESET ROLE");
  }
}
// A stand-in for Paystack's API: records initialisations and answers verification from
// state the test controls. The client under test builds the real request shapes.
function fakePaystack(secretKey: string) {
  const paid = new Map<
    string,
    { status: string; amount: number; currency: string }
  >();
  const inits: any[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    assert.equal(u.host, "api.paystack.co");
    assert.equal((init?.headers as any).Authorization, `Bearer ${secretKey}`);
    if (u.pathname === "/transaction/initialize") {
      const b = JSON.parse(String(init!.body));
      inits.push(b);
      return Response.json({
        status: true,
        data: {
          authorization_url: `https://checkout.paystack.test/${b.reference}`,
        },
      });
    }
    const ref = decodeURIComponent(u.pathname.split("/").pop()!);
    const s = paid.get(ref);
    if (!s)
      return Response.json(
        { status: false, message: "Transaction reference not found" },
        { status: 404 },
      );
    return Response.json({
      status: true,
      data: {
        reference: ref,
        status: s.status,
        amount: s.amount,
        currency: s.currency,
        paid_at: new Date().toISOString(),
        id: 991,
        channel: "card",
      },
    });
  }) as typeof fetch;
  return { fetcher, paid, inits };
}
const addDays = (d: string, n: number) =>
  new Date(Date.parse(d + "T00:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);

test("online booking: allotment, gateway verification, webhooks, sync to the hub and guest messages", async () => {
  const hub = await database(),
    cloud = await database();
  const tenant = randomUUID(),
    installation = randomUUID(),
    licenseKey = "k".repeat(43);
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
  });
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const secretKey = "sk_test_" + "s".repeat(32);
  const gw = fakePaystack(secretKey);
  const hubWrite = writer(hub, tenant),
    cloudWrite = writer(cloud, tenant);
  try {
    for (const w of [hubWrite, cloudWrite])
      await w(
        `INSERT INTO tenants(id,tenant_id,name,slug,branding,timezone,currency) VALUES('${tenant}','${tenant}','Lagoon Hotel','lagoon','{}','Africa/Lagos','NGN')`,
        "provider_app",
      );
    await cloudWrite(
      `INSERT INTO subscriptions(id,tenant_id,plan,status,features) VALUES('${randomUUID()}','${tenant}','premium','active','{"online_booking":true}')`,
      "provider_app",
    );
    await cloudWrite(
      `INSERT INTO licenses(id,tenant_id,key_hash,installation_id,issued_at) VALUES('${randomUUID()}','${tenant}','${hashToken(licenseKey)}','${installation}',now())`,
      "provider_app",
    );
    // Hub setup: room tax category, a room type with 2 of its 3 rooms on the website.
    const type = randomUUID(),
      hidden = randomUUID();
    await hubWrite(
      `INSERT INTO service_categories(id,tenant_id,name) VALUES('${randomUUID()}','${tenant}','room')`,
    );
    await hubWrite(
      `INSERT INTO room_types(id,tenant_id,name,base_rate,capacity,amenities,online_allotment) VALUES('${type}','${tenant}','Deluxe',40000,2,'[]',2)`,
    );
    await hubWrite(
      `INSERT INTO room_types(id,tenant_id,name,base_rate,capacity,amenities,online_allotment) VALUES('${hidden}','${tenant}','Staff room',1000,1,'[]',0)`,
    );
    for (const n of ["201", "202", "203"])
      await hubWrite(
        `INSERT INTO rooms(id,tenant_id,room_number,room_type_id) VALUES('${randomUUID()}','${tenant}','${n}','${type}')`,
      );
    const sealed = sealForCloud(
      pub,
      { secretKey },
      gatewayAad(tenant, "paystack"),
    );
    const settings = {
      enabled: true,
      paymentMode: "required",
      holdMinutes: 30,
      maxAdvanceDays: 365,
      policy: "Free cancellation up to 24 hours before arrival.",
      gateway: {
        name: "paystack",
        publicKey: "pk_test_x",
        hint: "…ssss",
        sealed,
        updatedAt: new Date().toISOString(),
      },
    };
    await hubWrite(
      `INSERT INTO settings(id,tenant_id,key,value) VALUES('${randomUUID()}','${tenant}','online_booking','${JSON.stringify(settings)}')`,
    );

    const deps = {
      connect: as(cloud, "booking_agent"),
      publicUrl: "https://cloud.test",
      sealingKey: priv,
      fetcher: gw.fetcher,
    };
    const app = createCloudApp(as(cloud, "sync_agent"), { booking: deps });
    const transport: Transport = async (path, body) => {
      const res = await request(app)
        .post(path)
        .set("Authorization", `Bearer ${licenseKey}`)
        .set("X-Hotel-Id", tenant)
        .set("X-Installation-Id", installation)
        .send(body as object);
      return { status: res.status, body: res.body };
    };
    const worker = new SyncWorker(
      as(hub, "sync_agent"),
      tenant,
      transport,
      "test",
    );
    await worker.runNow();
    // The sealed secret reached the cloud, and no readable key is stored anywhere.
    const cloudSettings = await rows(
      cloud,
      tenant,
      "SELECT value::text AS v FROM settings WHERE key='online_booking'",
    );
    assert.equal(cloudSettings.length, 1);
    assert.ok(!cloudSettings[0].v.includes(secretKey));

    const info = await request(app).get("/api/public/hotels/lagoon");
    assert.equal(info.status, 200, JSON.stringify(info.body));
    assert.equal(info.body.payment, "required");
    assert.deepEqual(
      info.body.roomTypes.map((t: any) => t.name),
      ["Deluxe"],
    );
    assert.equal(
      (await request(app).get("/api/public/hotels/nowhere")).status,
      404,
    );

    const today = hotelToday("Africa/Lagos");
    const stay = {
      roomTypeId: type,
      checkIn: addDays(today, 10),
      checkOut: addDays(today, 12),
      adults: 2,
      children: 0,
    };
    const quote = await request(app)
      .post("/api/public/hotels/lagoon/quote")
      .send(stay);
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    assert.equal(quote.body.price.total, "94000.00"); // 2 x 40000 + 7.5% VAT + 10% service
    assert.equal(quote.body.roomsLeft, 2);
    assert.equal(
      (
        await request(app)
          .post("/api/public/hotels/lagoon/quote")
          .send({ ...stay, adults: 3 })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(app)
          .post("/api/public/hotels/lagoon/quote")
          .send({ ...stay, roomTypeId: hidden })
      ).status,
      404,
    );
    assert.equal(
      (
        await request(app)
          .post("/api/public/hotels/lagoon/quote")
          .send({ ...stay, checkIn: addDays(today, -1) })
      ).status,
      400,
    );

    const book = (email: string, requestId = randomUUID(), s = stay) =>
      request(app)
        .post("/api/public/hotels/lagoon/bookings")
        .send({
          ...s,
          requestId,
          guest: { fullName: "Ngozi Eze", email, phone: "+2348000000000" },
          expectedTotal: "94000.00",
        });
    const firstId = randomUUID();
    const a = await book("NGOZI@example.com", firstId);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.match(a.body.reference, /^WB-[2-9A-Z]{8}$/);
    assert.equal(
      a.body.paymentUrl,
      `https://checkout.paystack.test/${a.body.reference}-P1`,
    );
    assert.equal(gw.inits[0].amount, 9400000, "kobo, exact");
    assert.equal(gw.inits[0].currency, "NGN");
    assert.equal(
      gw.inits[0].callback_url,
      `https://cloud.test/book/lagoon/return?booking=${a.body.reference}`,
    );
    const again = await book("ngozi@example.com", firstId);
    assert.equal(again.status, 200);
    assert.equal(
      again.body.reference,
      a.body.reference,
      "a retried request never books twice",
    );
    const b = await book("tunde@example.com");
    assert.equal(b.status, 201);
    const soldOut = await book("late@example.com");
    assert.equal(
      soldOut.status,
      409,
      "the website never sells past its allotment",
    );
    const wrongPrice = await request(app)
      .post("/api/public/hotels/lagoon/bookings")
      .send({
        ...stay,
        checkIn: addDays(today, 40),
        checkOut: addDays(today, 42),
        requestId: randomUUID(),
        guest: { fullName: "X Y", email: "x@example.com" },
        expectedTotal: "1.00",
      });
    assert.equal(wrongPrice.status, 409);

    // The browser's return proves nothing until the gateway confirms the exact amount.
    const verify = (reference: string) =>
      request(app)
        .post("/api/public/hotels/lagoon/payments/verify")
        .send({ reference });
    assert.equal(
      (await verify(`${a.body.reference}-P1`)).body.status,
      "pending",
    );
    gw.paid.set(`${a.body.reference}-P1`, {
      status: "success",
      amount: 9400000,
      currency: "NGN",
    });
    gw.paid.set(`${b.body.reference}-P1`, {
      status: "success",
      amount: 100,
      currency: "NGN",
    });
    assert.equal(
      (await verify(`${a.body.reference}-P1`)).body.status,
      "success",
    );
    assert.equal(
      (await verify(`${a.body.reference}-P1`)).body.status,
      "success",
      "repeat is harmless",
    );
    assert.equal(
      (await verify(`${b.body.reference}-P1`)).body.status,
      "mismatch",
      "an underpayment is not a payment",
    );

    // Webhook: signature over the exact bytes, then the verify API decides.
    const retry = await request(app)
      .post(`/api/public/hotels/lagoon/bookings/${b.body.reference}/pay`)
      .send({ email: "tunde@example.com" });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    const bRef = retry.body.paymentReference;
    gw.paid.set(bRef, { status: "success", amount: 9400000, currency: "NGN" });
    const hook = JSON.stringify({
      event: "charge.success",
      data: { reference: bRef, amount: 9400000 },
    });
    const sign = (body: string) =>
      createHmac("sha512", secretKey).update(body).digest("hex");
    assert.equal(
      (
        await request(app)
          .post("/api/public/webhooks/paystack/lagoon")
          .set("Content-Type", "application/json")
          .set("x-paystack-signature", "0".repeat(128))
          .send(hook)
      ).status,
      401,
    );
    const forged = JSON.stringify({
      event: "charge.success",
      data: { reference: bRef, amount: 1 },
    });
    assert.equal(
      (
        await request(app)
          .post("/api/public/webhooks/paystack/lagoon")
          .set("Content-Type", "application/json")
          .set("x-paystack-signature", sign(hook))
          .send(forged)
      ).status,
      401,
      "signature covers the body",
    );
    assert.equal(
      (
        await request(app)
          .post("/api/public/webhooks/paystack/lagoon")
          .set("Content-Type", "application/json")
          .set("x-paystack-signature", sign(hook))
          .send(hook)
      ).status,
      200,
    );
    const txs = await rows(
      cloud,
      tenant,
      "SELECT reference,status,amount::text AS amount FROM payment_transactions ORDER BY reference",
    );
    assert.deepEqual(
      txs.map((t) => [t.reference, t.status]),
      [
        [`${a.body.reference}-P1`, "success"],
        [`${b.body.reference}-P1`, "mismatch"],
        [bRef, "success"],
      ].sort((x, y) => (x[0] < y[0] ? -1 : 1)),
    );

    // Guest status lookup needs the reference and the matching email.
    const status = (ref: string, email: string) =>
      request(app)
        .post(`/api/public/hotels/lagoon/bookings/${ref}/status`)
        .send({ email });
    assert.equal(
      (await status(a.body.reference, "someone@else.com")).status,
      404,
    );
    const st = await status(a.body.reference, "ngozi@example.com");
    assert.equal(st.body.payment, "paid");
    assert.equal(st.body.status, "pending");

    // An unpaid hold expires and gives its room back to the website.
    const past = createCloudApp(as(cloud, "sync_agent"), {
      booking: { ...deps, now: () => new Date(Date.now() - 2 * 3600_000) },
    });
    const later = {
      ...stay,
      checkIn: addDays(today, 20),
      checkOut: addDays(today, 22),
    };
    const stale = await request(past)
      .post("/api/public/hotels/lagoon/bookings")
      .send({
        ...later,
        requestId: randomUUID(),
        guest: { fullName: "Old Hold", email: "old@example.com" },
        expectedTotal: "94000.00",
      });
    assert.equal(stale.status, 201, JSON.stringify(stale.body));
    assert.equal(
      (await request(app).post("/api/public/hotels/lagoon/quote").send(later))
        .body.roomsLeft,
      2,
    );
    assert.equal(
      (await status(stale.body.reference, "old@example.com")).body.status,
      "expired",
    );
    assert.equal(
      (
        await request(app)
          .post(
            `/api/public/hotels/lagoon/bookings/${stale.body.reference}/pay`,
          )
          .send({ email: "old@example.com" })
      ).status,
      409,
    );

    // Everything the website wrote reaches the hub by pull.
    await worker.runNow();
    const onHub = await rows(
      hub,
      tenant,
      "SELECT external_reference,status::text AS status FROM online_bookings ORDER BY created_at",
    );
    assert.equal(onHub.length, 3);
    assert.equal(
      (
        await rows(
          hub,
          tenant,
          "SELECT count(*)::int AS n FROM payment_transactions WHERE status='success'",
        )
      )[0].n,
      2,
    );
    assert.ok(
      (
        await rows(hub, tenant, "SELECT count(*)::int AS n FROM notifications")
      )[0].n >= 5,
    );
    // The cloud marks what the hub now holds, and its outbox for these tables is drained.
    assert.equal(
      (
        await rows(
          cloud,
          tenant,
          "SELECT count(*)::int AS n FROM online_bookings WHERE NOT processed",
        )
      )[0].n,
      0,
    );
    assert.equal(
      (
        await rows(
          cloud,
          tenant,
          "SELECT count(*)::int AS n FROM sync_queue WHERE status='pending'",
        )
      )[0].n,
      0,
    );

    // The hub owns the decision. A rejection releases the allotment in the cloud.
    const [bRow] = await rows(
      hub,
      tenant,
      `SELECT id FROM online_bookings WHERE external_reference='${b.body.reference}'`,
    );
    await hubWrite(
      `UPDATE online_bookings SET status='rejected',payload=payload||'{"decision":{"at":"2026-01-01T00:00:00Z","by":null,"reason":"Fully booked for a group"}}' WHERE id='${bRow.id}'`,
    );
    await worker.runNow();
    const rejected = await status(b.body.reference, "tunde@example.com");
    assert.equal(rejected.body.status, "rejected");
    assert.equal(rejected.body.reason, "Fully booked for a group");
    assert.equal(
      (await request(app).post("/api/public/hotels/lagoon/quote").send(stay))
        .body.roomsLeft,
      1,
    );

    // Guest messages: delivered by the cloud, retried on failure, status synced to the hub.
    const outbox: any[] = [];
    let fail = true;
    const first = await deliverPending(
      as(cloud, "booking_agent"),
      async (m) => {
        if (fail) {
          fail = false;
          throw new Error("smtp relay down");
        }
        outbox.push(m);
      },
    );
    assert.equal(first.failed, 0);
    assert.ok(outbox.length >= 4);
    assert.ok(
      outbox.every((m) => m.hotel === "Lagoon Hotel" && m.to.includes("@")),
    );
    assert.ok(outbox.some((m) => m.subject.includes("payment received")));
    const retrying = await rows(
      cloud,
      tenant,
      "SELECT attempts,payload->>'lastError' AS e FROM notifications WHERE status='pending'",
    );
    assert.deepEqual(
      retrying.map((r) => [r.attempts, r.e]),
      [[1, "smtp relay down"]],
    );
    await worker.runNow();
    const hubSent = await rows(
      hub,
      tenant,
      "SELECT count(*)::int AS n FROM notifications WHERE status='sent'",
    );
    assert.equal(hubSent[0].n, outbox.length, "delivery status syncs down");
  } finally {
    await hub.close();
    await cloud.close();
  }
});

test("booking_agent can only read what a guest may book and write web records", async () => {
  const db = await database();
  const a = randomUUID(),
    b = randomUUID();
  try {
    for (const t of [a, b])
      await writer(db, t)(
        `INSERT INTO tenants(id,tenant_id,name,slug,branding) VALUES('${t}','${t}','H ${t.slice(0, 4)}','h-${t.slice(0, 8)}','{"secret":1}')`,
        "provider_app",
      );
    await writer(
      db,
      a,
    )(
      `INSERT INTO guests(id,tenant_id,full_name) VALUES('${randomUUID()}','${a}','Private Guest')`,
    );
    const q = async (sql: string, tenant = a) => {
      await db.exec(
        `RESET ROLE; SET ROLE booking_agent; SELECT set_config('app.tenant_id','${tenant}',false)`,
      );
      try {
        return (await db.query<any>(sql)).rows;
      } finally {
        await db.exec("RESET ROLE");
      }
    };
    assert.equal(
      (await q("SELECT id,slug FROM tenants")).length,
      2,
      "hotel directory by slug",
    );
    await assert.rejects(
      q("SELECT branding FROM tenants"),
      /permission denied/,
    );
    for (const t of [
      "guests",
      "reservations",
      "payments",
      "folios",
      "users",
      "gateway_credentials",
      "licenses",
      "audit_log",
    ])
      await assert.rejects(q(`SELECT * FROM ${t}`), /permission denied/, t);
    await assert.rejects(
      q("UPDATE online_bookings SET status='confirmed'"),
      /permission denied/,
      "decisions are the hub's",
    );
    await assert.rejects(
      q(
        `INSERT INTO online_bookings(id,tenant_id,payload,external_reference) VALUES('${randomUUID()}','${b}','{}','WB-X')`,
      ),
      /row-level security|mutation context/,
    );
  } finally {
    await db.close();
  }
});

test("gateway clients, exact amounts, sealing and guest messages", async () => {
  assert.equal(toMinor("94000.00"), "9400000");
  assert.equal(toMinor("0.5"), "50");
  assert.equal(toMinor("9999999999.99"), "999999999999");
  assert.throws(() => toMinor("1.234"));
  assert.throws(() => toMinor("-1"));
  assert.equal(fromMinor(9400000), "94000.00");
  assert.equal(fromMinor(5), "0.05");
  const good = {
    status: "success" as const,
    amount: "94000.00",
    currency: "NGN",
    paidAt: null,
    gatewayId: "1",
    channel: null,
  };
  assert.equal(
    assess({ amount: "94000.00", currency: "NGN" }, good),
    "success",
  );
  assert.equal(
    assess(
      { amount: "94000.00", currency: "NGN" },
      { ...good, amount: "93999.99" },
    ),
    "mismatch",
  );
  assert.equal(
    assess(
      { amount: "94000.00", currency: "NGN" },
      { ...good, currency: "USD" },
    ),
    "mismatch",
  );
  assert.equal(
    assess(
      { amount: "94000.00", currency: "NGN" },
      { ...good, status: "failed" },
    ),
    "failed",
  );
  // Flutterwave: request shapes, verification mapping and the shared webhook hash.
  const calls: any[] = [];
  const flw = gatewayClient(
    "flutterwave",
    { secretKey: "FLWSECK_TEST-abc", webhookHash: "hash-123456" },
    (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("/v3/payments"))
        return Response.json({
          status: "success",
          data: { link: "https://checkout.flutterwave.test/x" },
        });
      return Response.json({
        status: "success",
        data: {
          tx_ref: "WB-ABCDEFGH-P1",
          status: "successful",
          amount: 94000,
          currency: "NGN",
          id: 7,
        },
      });
    }) as typeof fetch,
  );
  assert.equal(
    (
      await flw.initialize({
        reference: "WB-ABCDEFGH-P1",
        amount: "94000.00",
        currency: "NGN",
        email: "a@b.co",
        name: "A",
        callbackUrl: "https://c/r",
        metadata: {},
      })
    ).url,
    "https://checkout.flutterwave.test/x",
  );
  assert.equal(calls[0].body.tx_ref, "WB-ABCDEFGH-P1");
  assert.equal(calls[0].body.redirect_url, "https://c/r");
  const v = await flw.verify("WB-ABCDEFGH-P1");
  assert.equal(assess({ amount: "94000.00", currency: "NGN" }, v), "success");
  assert.match(calls[1].url, /verify_by_reference\?tx_ref=WB-ABCDEFGH-P1$/);
  assert.equal(
    flw.webhookValid({ "verif-hash": "hash-123456" }, Buffer.from("{}")),
    true,
  );
  assert.equal(
    flw.webhookValid({ "verif-hash": "hash-12345" }, Buffer.from("{}")),
    false,
  );
  assert.equal(flw.webhookValid({}, Buffer.from("{}")), false);
  // A provider answering for a different reference is refused.
  const liar = gatewayClient(
    "paystack",
    { secretKey: "sk_test_x" },
    (async () =>
      Response.json({
        status: true,
        data: {
          reference: "OTHER",
          status: "success",
          amount: 1,
          currency: "NGN",
        },
      })) as typeof fetch,
  );
  await assert.rejects(liar.verify("WB-ABCDEFGH-P1"), /different payment/);
  // Sealing: only the private key opens it, and only for the same hotel and gateway.
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const s = sealForCloud(
    pub,
    { secretKey: "sk_live_abc" },
    gatewayAad("t1", "paystack"),
  );
  assert.deepEqual(openSealed(priv, s, gatewayAad("t1", "paystack")), {
    secretKey: "sk_live_abc",
  });
  assert.throws(() => openSealed(priv, s, gatewayAad("t2", "paystack")));
  assert.throws(() => openSealed(priv, s, gatewayAad("t1", "flutterwave")));
  assert.ok(!JSON.stringify(s).includes("sk_live_abc"));
  assert.match(bookingReference(), /^WB-[2-9A-Z]{8}$/);
  const m = renderMessage("booking_rejected", {
    hotel: "H",
    reference: "WB-1",
    guest: "G",
    checkIn: "a",
    checkOut: "b",
    roomType: "R",
    total: "1.00",
    currency: "NGN",
    reason: "Full",
    paid: true,
  });
  assert.match(m.text, /refunded in full/);
});
