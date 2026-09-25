import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  signLicense,
  GRACE_MS,
  type LicenseClaims,
} from "../packages/core/src/license.js";
import { base, scope, mutation, db } from "../apps/api/src/db.js";
import { acceptLicense, licenseDb } from "../apps/api/src/licensing.js";
import { app } from "../apps/api/src/app.js";
const owner = new PrismaClient({
  datasourceUrl: process.env.MIGRATION_DATABASE_URL,
});
const tenantId = process.env.HOTEL_ID!;
const key = readFileSync(process.env.LICENSE_PRIVATE_KEY_FILE!, "utf8");
const addDay = (d: string, n: number) =>
  new Date(new Date(d + "T00:00:00Z").getTime() + n * 86400000)
    .toISOString()
    .slice(0, 10);
test("front desk HTTP: concurrency, retries, cross-tenant references, charges, checkout and licensing", async () => {
  try {
    const claims: LicenseClaims = {
      tenantId,
      installationId: process.env.INSTALLATION_ID!,
      licenseId: randomUUID(),
      status: "active",
      plan: "standard",
      maxDevices: 20,
      maxRooms: 14,
      features: {},
      issuedAt: Date.now(),
      validUntil: Date.now() + GRACE_MS,
      trialEndsAt: null,
      schemaVersion: 1,
    };
    await acceptLicense(signLicense(claims, key));
    const login = await request(app)
      .post("/api/auth/login")
      .send({
        email: process.env.SEED_ADMIN_EMAIL,
        password: "Changed-password-2026!",
      });
    assert.equal(login.status, 200);
    const headers = { Authorization: `Bearer ${login.body.accessToken}` };
    const get = (path: string) =>
      request(app)
        .get("/api" + path)
        .set(headers);
    const post = (path: string, body: Record<string, unknown> = {}) =>
      request(app)
        .post("/api" + path)
        .set(headers)
        .send({ requestId: randomUUID(), ...body });
    const config = await get("/frontdesk/config");
    assert.equal(config.status, 200);
    const today = config.body.today,
      type =
        config.body.roomTypes.find(
          (t: { name: string }) => t.name === "Standard",
        ) ?? config.body.roomTypes[0];
    const guestInput = {
      requestId: randomUUID(),
      fullName: "Phase Two Guest",
      phone: "08000000000",
    };
    const guest = await post("/guests", guestInput);
    assert.equal(guest.status, 201, JSON.stringify(guest.body));
    const replay = await post("/guests", guestInput);
    assert.equal(replay.body.id, guest.body.id);
    assert.equal(
      (await post("/guests", { ...guestInput, fullName: "Changed intent" }))
        .status,
      409,
    );
    assert.equal(
      (await post("/guests", { fullName: "Spoof", tenant_id: randomUUID() }))
        .status,
      400,
    );
    const foreign = await owner.tenants.findFirst({
      where: { id: { not: tenantId } },
    });
    assert.ok(foreign);
    const foreignGuest = await scope(
      owner,
      { tenantId: foreign.id, writable: true },
      (tx) =>
        mutation(tx, () =>
          tx.guests.create({
            data: {
              ...base({ tenantId: foreign.id }),
              full_name: "Foreign guest",
            },
          }),
        ),
    );
    assert.equal((await get("/guests/" + foreignGuest.id)).status, 404);
    const rooms = await get("/rooms?pageSize=100");
    assert.equal(rooms.status, 200);
    const room = rooms.body.items.find(
      (r: { room_type_id: string }) => r.room_type_id === type.id,
    );
    assert.ok(room);
    const input = {
      guestId: guest.body.id,
      roomTypeId: type.id,
      roomId: room.id,
      checkInDate: today,
      checkOutDate: addDay(today, 1),
      adults: 1,
      children: 0,
      source: "phone",
    };
    assert.equal(
      (await post("/reservations", { ...input, guestId: foreignGuest.id }))
        .status,
      404,
    );
    assert.equal(
      (await post("/reservations", { ...input, adults: 20 })).status,
      400,
    );
    assert.equal(
      (await post("/reservations", { ...input, checkOutDate: "2026-02-30" }))
        .status,
      400,
    );
    const concurrent = await Promise.all([
      post("/reservations", input),
      post("/reservations", input),
    ]);
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [201, 409]);
    const stay = concurrent.find((r) => r.status === 201)!.body;
    assert.equal(
      (await post("/reservations/" + stay.id + "/check-out")).status,
      409,
    );
    const checkInput = { requestId: randomUUID() };
    assert.equal(
      (await post("/reservations/" + stay.id + "/check-in", checkInput)).status,
      200,
    );
    assert.equal(
      (await post("/reservations/" + stay.id + "/check-in", checkInput)).status,
      200,
    );
    assert.equal(
      (await post("/reservations/" + stay.id + "/check-in")).status,
      200,
    );
    let folio = await get("/folios/" + stay.folioId);
    assert.equal(folio.body.charges.length, 3);
    assert.equal(folio.body.balance, stay.price.total);
    assert.equal(
      (await post("/reservations/" + stay.id + "/check-out")).status,
      409,
    );
    assert.equal(
      (
        await request(app)
          .patch("/api/rooms/" + room.id + "/status")
          .set(headers)
          .send({
            requestId: randomUUID(),
            status: "available",
            reason: "Attempt occupied change",
          })
      ).status,
      409,
    );
    assert.equal(
      (
        await post("/reservations/" + stay.id + "/extend", {
          checkOutDate: addDay(today, 2),
        })
      ).status,
      200,
    );
    folio = await get("/folios/" + stay.folioId);
    assert.equal(folio.body.charges.length, 6);
    const admin = await owner.users.findFirstOrThrow({
      where: { tenant_id: tenantId, email: process.env.SEED_ADMIN_EMAIL },
    });
    // Test fixture only: actual payment APIs are deliberately deferred to Phase 3.
    await scope(owner, { tenantId, userId: admin.id, writable: true }, (tx) =>
      mutation(tx, () =>
        tx.payments.create({
          data: {
            ...base({ tenantId, userId: admin.id }),
            folio_id: stay.folioId,
            amount: folio.body.balance,
            method: "cash",
            received_by: admin.id,
            paid_at: new Date(),
            idempotency_key: randomUUID(),
          },
        }),
      ),
    );
    const checkoutInput = { requestId: randomUUID() };
    assert.equal(
      (await post("/reservations/" + stay.id + "/check-out", checkoutInput))
        .status,
      200,
    );
    assert.equal(
      (await post("/reservations/" + stay.id + "/check-out", checkoutInput))
        .status,
      200,
    );
    assert.equal(
      (await get("/folios/" + stay.folioId)).body.folio.status,
      "closed",
    );
    assert.equal(
      (await get("/rooms?pageSize=100")).body.items.find(
        (r: { id: string }) => r.id === room.id,
      ).status,
      "dirty",
    );
    assert.equal((await post("/walk-ins", input)).status, 409);
    assert.equal(
      (
        await request(app)
          .patch("/api/rooms/" + room.id + "/status")
          .set(headers)
          .send({
            requestId: randomUUID(),
            status: "available",
            reason: "Cleaned and inspected",
          })
      ).status,
      200,
    );
    const future = {
      ...input,
      checkInDate: addDay(today, 10),
      checkOutDate: addDay(today, 11),
    };
    const futureStay = await post("/reservations", future);
    assert.equal(futureStay.status, 201);
    assert.equal(
      (await post("/reservations/" + futureStay.body.id + "/check-in")).status,
      409,
    );
    assert.equal(
      (
        await post("/reservations/" + futureStay.body.id + "/cancel", {
          status: "no_show",
          reason: "Too early",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await post("/reservations/" + futureStay.body.id + "/cancel", {
          status: "cancelled",
          reason: "Guest requested",
        })
      ).status,
      200,
    );
    assert.equal(
      (await post("/reservations", future)).status,
      201,
      "Cancellation frees allocation",
    );
    const complimentary = await post("/room-types", {
      name: "Complimentary test",
      baseRate: "0.00",
      capacity: 2,
    });
    assert.equal(complimentary.status, 201);
    const bulk = await post("/rooms/bulk", {
      roomTypeId: complimentary.body.id,
      floor: 4,
      numbers: ["401", "402"],
    });
    assert.equal(bulk.status, 201);
    assert.equal(
      (
        await post("/rooms/bulk", {
          roomTypeId: complimentary.body.id,
          floor: 4,
          numbers: ["403"],
        })
      ).status,
      409,
      "Room quota enforced",
    );
    const free = await post("/walk-ins", {
      ...input,
      roomTypeId: complimentary.body.id,
      roomId: bulk.body.rooms[0].id,
    });
    assert.equal(free.status, 201, JSON.stringify(free.body));
    assert.equal(free.body.status, "checked_in");
    assert.equal(
      (await post("/reservations/" + free.body.id + "/check-out")).status,
      200,
    );
    const rep = await request(app)
      .post("/api/auth/login")
      .send({
        email: "reception@example.test",
        password: "Reception-changed-2026!",
      });
    assert.equal(
      (
        await request(app)
          .post("/api/rooms/bulk")
          .set("Authorization", `Bearer ${rep.body.accessToken}`)
          .send({
            requestId: randomUUID(),
            roomTypeId: type.id,
            floor: 4,
            numbers: ["999"],
          })
      ).status,
      403,
    );
    await acceptLicense(
      signLicense(
        {
          ...claims,
          issuedAt: Date.now(),
          validUntil: Date.now() + GRACE_MS,
          status: "suspended",
        },
        key,
      ),
    );
    assert.equal((await get("/reservations")).status, 200);
    assert.equal(
      (await post("/guests", { fullName: "Read only blocked" })).status,
      423,
    );
    assert.equal(
      (await post("/guests", guestInput)).body.id,
      guest.body.id,
      "Saved result remains readable after suspension",
    );
  } finally {
    await Promise.all([
      owner.$disconnect(),
      db.$disconnect(),
      licenseDb.$disconnect(),
    ]);
  }
});
