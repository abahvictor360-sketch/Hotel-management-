import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import {
  signLicense,
  GRACE_MS,
  type LicenseClaims,
} from "../packages/core/src/license.js";
import { db } from "../apps/api/src/db.js";
import { acceptLicense, licenseDb } from "../apps/api/src/licensing.js";
import { app } from "../apps/api/src/app.js";
import { poolConnect, tenantTx } from "../apps/api/src/sync-apply.js";
import { priceStay, hotelToday } from "../packages/core/src/stays.js";
import { bookingReference } from "../packages/core/src/booking.js";
// Runs after the other hub integration tests on the same seeded hub. Website bookings are
// written the way sync delivers them: as sync_agent, with no outbox echo.
const tenantId = process.env.HOTEL_ID!,
  key = readFileSync(process.env.LICENSE_PRIVATE_KEY_FILE!, "utf8");
const claims = (features: Record<string, boolean>): LicenseClaims => ({
  tenantId,
  installationId: process.env.INSTALLATION_ID!,
  licenseId: randomUUID(),
  status: "active",
  plan: "premium",
  maxDevices: 20,
  maxRooms: 200,
  features: { provider_credit: false, ...features },
  issuedAt: Date.now(),
  validUntil: Date.now() + GRACE_MS,
  trialEndsAt: null,
  schemaVersion: 1,
});
const addDays = (d: string, n: number) =>
  new Date(Date.parse(d + "T00:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
test("hub online booking: settings, sealed gateway keys, confirm with prepaid folio, reject and cancel", async () => {
  const pool = new pg.Pool({
    connectionString: process.env.SYNC_DATABASE_URL,
    max: 1,
  });
  try {
    await acceptLicense(signLicense(claims({ online_booking: false }), key));
    const login = await request(app)
      .post("/api/auth/login")
      .send({
        email: process.env.SEED_ADMIN_EMAIL,
        password: "Changed-password-2026!",
      });
    assert.equal(login.status, 200);
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };
    const get = (p: string) => request(app).get(`/api${p}`).set(auth);
    const post = (p: string, body: object) =>
      request(app)
        .post(`/api${p}`)
        .set(auth)
        .send({ requestId: randomUUID(), ...body });
    const put = (body: object) =>
      request(app).put("/api/online-booking/settings").set(auth).send(body);
    const before = await get("/online-booking/settings");
    assert.equal(before.status, 200);
    assert.equal(
      before.body.sealingAvailable,
      true,
      "CLOUD_SEALING_PUBLIC_KEY_FILE is configured",
    );
    const type = before.body.roomTypes.find((t: any) => t.rooms >= 2);
    const settings = {
      enabled: true,
      paymentMode: "required",
      holdMinutes: 30,
      maxAdvanceDays: 365,
      policy: "Pay online to secure your room.",
      allotments: [{ roomTypeId: type.id, onlineAllotment: 2 }],
      gateway: {
        name: "paystack",
        publicKey: "pk_test_abcdefghij",
        secretKey: "sk_test_abcdefghijklmnop",
      },
    };
    assert.equal((await put(settings)).status, 403, "plan gate");
    await acceptLicense(signLicense(claims({ online_booking: true }), key));
    assert.equal(
      (
        await put({
          ...settings,
          allotments: [
            { roomTypeId: type.id, onlineAllotment: type.rooms + 1 },
          ],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await put({
          ...settings,
          gateway: { ...settings.gateway, secretKey: "pk_test_wrongwrong" },
        })
      ).status,
      400,
    );
    assert.equal(
      (await put({ ...settings, gateway: null })).status,
      400,
      "payment needs a provider",
    );
    assert.equal((await put(settings)).status, 204);
    const after = await get("/online-booking/settings");
    assert.equal(after.body.gateway.hint, "…mnop");
    assert.equal(
      after.body.roomTypes.find((t: any) => t.id === type.id).onlineAllotment,
      2,
    );
    assert.match(after.body.bookingUrl, /\/book\/[a-z0-9-]+$/);
    assert.ok(!JSON.stringify(after.body).includes("sk_test_abcdefghijklmnop"));
    assert.ok(!JSON.stringify(after.body).includes("sealed"));
    // Keep the stored key when only the public key changes.
    assert.equal(
      (
        await put({
          ...settings,
          gateway: { name: "paystack", publicKey: "pk_test_zzzzzzzzzz" },
        })
      ).status,
      204,
    );
    assert.equal(
      (await get("/online-booking/settings")).body.gateway.hint,
      "…mnop",
    );
    const listed = await get("/settings");
    assert.ok(!listed.body.some((s: any) => s.key === "online_booking"));
    const stored = await request(app).get("/api/settings").set(auth);
    assert.ok(!JSON.stringify(stored.body).includes("sk_test"));

    // Three website bookings arrive by sync: one paid, one to reject, one to cancel.
    const today = hotelToday("Africa/Lagos");
    // The seeded room category: 7.5% VAT and 10% service charge.
    const tax = {
      vat_enabled: true,
      vat_rate: "7.5",
      service_charge_enabled: true,
      service_charge_rate: "10",
    };
    const make = (email: string, offset: number, mode = "required") => {
      const checkIn = addDays(today, offset),
        checkOut = addDays(today, offset + 2);
      const price = priceStay("25000.00", checkIn, checkOut, tax);
      return {
        id: randomUUID(),
        ref: bookingReference(),
        payload: {
          version: 1,
          requestId: randomUUID(),
          roomTypeId: type.id,
          roomTypeName: type.name,
          checkIn,
          checkOut,
          adults: 1,
          children: 0,
          guest: { fullName: "Web Guest", email, phone: "+234" },
          price,
          currency: "NGN",
          paymentMode: mode,
          holdUntil: new Date(Date.now() + 3600_000).toISOString(),
        },
      };
    };
    const paid = make("returning@example.com", 30),
      reject = make("reject@example.com", 31, "none"),
      cancel = make("cancel@example.com", 32, "none");
    await tenantTx(poolConnect(pool), tenantId, async (c) => {
      for (const b of [paid, reject, cancel])
        await c.query(
          "INSERT INTO online_bookings(id,tenant_id,device_id,payload,status,external_reference) VALUES($1,$2,'web',$3::jsonb,'pending',$4)",
          [b.id, tenantId, JSON.stringify(b.payload), b.ref],
        );
      await c.query(
        "INSERT INTO payment_transactions(id,tenant_id,device_id,gateway,reference,amount,status,raw_response,verified_at,online_booking_id) VALUES($1,$2,'web','paystack',$3,$4,'success','{}'::jsonb,now(),$5)",
        [
          randomUUID(),
          tenantId,
          `${paid.ref}-P1`,
          paid.payload.price.total,
          paid.id,
        ],
      );
    });
    // A returning guest is matched by email instead of duplicated.
    const existing = await post("/guests", {
      fullName: "Returning Guest",
      email: "RETURNING@example.com",
    });
    assert.equal(existing.status, 201);

    const pending = await get("/online-bookings?status=pending");
    assert.equal(pending.status, 200);
    const row = pending.body.rows.find((r: any) => r.reference === paid.ref);
    assert.equal(row.payment, "paid");
    assert.equal(row.paidAmount, paid.payload.price.total);
    const rooms = await get(`/online-bookings/${paid.id}/rooms`);
    assert.ok(rooms.body.length >= 1);
    const confirmed = await post(`/online-bookings/${paid.id}/confirm`, {
      roomId: rooms.body[0].id,
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.paymentsApplied, 1);
    assert.equal(confirmed.body.roomNumber, rooms.body[0].roomNumber);
    assert.equal(
      (await post(`/online-bookings/${paid.id}/confirm`, {})).status,
      409,
      "decided once",
    );
    const stay = await get(`/reservations/${confirmed.body.reservationId}`);
    assert.equal(stay.status, 200);
    const folio = await get(`/folios/${confirmed.body.folioId}`);
    assert.equal(
      folio.body.balance,
      `-${paid.payload.price.total}`,
      "prepayment is a credit until check-in charges post",
    );
    const guests = await get("/guests?q=returning");
    assert.equal(guests.body.items.length, 1, "no duplicate guest");
    // Applying again is a no-op: one payment per gateway reference.
    const pays = await tenantTx(
      poolConnect(pool),
      tenantId,
      async (c) =>
        (
          await c.query(
            "SELECT count(*)::int AS n,max(method::text) AS method FROM payments WHERE gateway_reference=$1",
            [`${paid.ref}-P1`],
          )
        ).rows[0],
    );
    assert.deepEqual(pays, { n: 1, method: "online" });

    const rejected = await post(`/online-bookings/${reject.id}/reject`, {
      reason: "Closed for renovation",
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.refundDue, false);
    const toCancel = await post(`/online-bookings/${cancel.id}/confirm`, {});
    assert.equal(toCancel.status, 200, JSON.stringify(toCancel.body));
    const cancelled = await post(
      `/reservations/${toCancel.body.reservationId}/cancel`,
      { status: "cancelled", reason: "Guest changed plans" },
    );
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const byStatus = async (s: string) =>
      (await get(`/online-bookings?status=${s}`)).body.rows.map(
        (r: any) => r.reference,
      );
    assert.ok((await byStatus("confirmed")).includes(paid.ref));
    assert.ok((await byStatus("rejected")).includes(reject.ref));
    assert.ok((await byStatus("cancelled")).includes(cancel.ref));
    // Each decision queued a guest message for the cloud to deliver, and it is in the outbox.
    const msgs = await tenantTx(poolConnect(pool), tenantId, async (c) =>
      (
        await c.query(
          "SELECT payload->>'kind' AS kind FROM notifications WHERE online_booking_id=ANY($1::uuid[]) ORDER BY created_at",
          [[paid.id, reject.id, cancel.id]],
        )
      ).rows.map((r) => r.kind),
    );
    assert.deepEqual(msgs, [
      "booking_confirmed",
      "booking_rejected",
      "booking_confirmed",
      "booking_cancelled",
    ]);
    const queued = await tenantTx(
      poolConnect(pool),
      tenantId,
      async (c) =>
        (
          await c.query(
            "SELECT count(*)::int AS n FROM sync_queue WHERE table_name='online_bookings' AND record_id=ANY($1::uuid[]) AND status='pending'",
            [[paid.id, reject.id, cancel.id]],
          )
        ).rows[0].n,
    );
    assert.ok(queued >= 3, "decisions sync back to the cloud");
  } finally {
    await acceptLicense(signLicense(claims({ online_booking: false }), key));
    await pool.end();
    await Promise.all([db.$disconnect(), licenseDb.$disconnect()]);
  }
});
