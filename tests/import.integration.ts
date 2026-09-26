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
import { db } from "../apps/api/src/db.js";
import { acceptLicense, licenseDb } from "../apps/api/src/licensing.js";
import { app } from "../apps/api/src/app.js";
// Runs after the other hub suites on the same seeded database.
const owner = new PrismaClient({
  datasourceUrl: process.env.MIGRATION_DATABASE_URL,
});
const tenantId = process.env.HOTEL_ID!;
const key = readFileSync(process.env.LICENSE_PRIVATE_KEY_FILE!, "utf8");
test("CSV import and setup guide over HTTP", async () => {
  try {
    const claims: LicenseClaims = {
      tenantId,
      installationId: process.env.INSTALLATION_ID!,
      licenseId: randomUUID(),
      status: "active",
      plan: "standard",
      maxDevices: 20,
      maxRooms: 200,
      features: {},
      issuedAt: Date.now(),
      validUntil: Date.now() + GRACE_MS,
      trialEndsAt: null,
      schemaVersion: 1,
    };
    await acceptLicense(signLicense(claims, key));
    const login = await request(app).post("/api/auth/login").send({
      email: process.env.SEED_ADMIN_EMAIL,
      password: "Changed-password-2026!",
    });
    assert.equal(login.status, 200);
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };
    const upload = (kind: string, csv: string, dryRun: boolean) =>
      request(app).post(`/api/import/${kind}`).set(auth).send({ csv, dryRun });
    const outbox = () => owner.sync_queue.count();

    // Preview writes nothing and reports row problems.
    const tag = randomUUID().slice(0, 6);
    const rooms = `room_number,room_type,floor,rate,capacity
I${tag}-1,Import ${tag},7,"48,000",2
I${tag}-2,Import ${tag},7,,
I${tag}-3,Other ${tag},7,,
`;
    const before = await outbox();
    const preview = await upload("rooms", rooms, true);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.imported, false);
    assert.deepEqual(
      preview.body.errors.map((e: { row: number }) => e.row),
      [4],
    );
    assert.equal(await outbox(), before);
    // A file with errors is refused as a whole.
    const refused = await upload("rooms", rooms, false);
    assert.equal(refused.body.imported, false);
    assert.equal(
      await owner.rooms.count({
        where: { room_number: { startsWith: `I${tag}` } },
      }),
      0,
    );

    // A clean file imports atomically, through the outbox like any write.
    const clean = rooms.split("\n").slice(0, 3).join("\n");
    const done = await upload("rooms", clean, false);
    assert.equal(done.body.imported, true);
    assert.equal(done.body.create, 3, "one new room type and two rooms");
    const type = await owner.room_types.findFirstOrThrow({
      where: { name: `Import ${tag}` },
    });
    assert.equal(type.base_rate.toFixed(2), "48000.00");
    assert.equal(await outbox(), before + 3);
    const again = await upload("rooms", clean, false);
    assert.equal(again.body.create, 0);
    assert.equal(again.body.skipped.length, 2);

    // Menu items need a known department; guests are de-duplicated by email or phone.
    const menu = await upload(
      "menu",
      `department,name,price\nbar,Zobo ${tag},1200\nkitchen,Stew,900\n`,
      false,
    );
    assert.equal(menu.body.imported, false);
    assert.match(menu.body.errors[0].message, /Unknown department "kitchen"/);
    const guests = await upload(
      "guests",
      `full_name,email\nGuest ${tag},g${tag}@example.test\nGuest Again,G${tag}@EXAMPLE.test\n`,
      false,
    );
    assert.equal(guests.body.imported, true);
    assert.equal(guests.body.create, 1);
    assert.equal(guests.body.skipped.length, 1);

    // Malformed CSV and oversized bodies are rejected cleanly.
    const broken = await upload("guests", 'full_name\n"unclosed', true);
    assert.equal(broken.status, 400);
    assert.match(broken.body.error, /could not be read/);
    assert.equal((await upload("staff", "a", true)).status, 400);

    // Setup guide: finishing is refused until required steps are done.
    const status = await request(app).get("/api/onboarding").set(auth);
    assert.equal(status.status, 200);
    assert.equal(status.body.total, 8);
    const taxes = status.body.steps.find(
      (s: { id: string }) => s.id === "taxes",
    );
    assert.equal(taxes.done, false);
    const early = await request(app)
      .post("/api/onboarding")
      .set(auth)
      .send({ finish: true });
    assert.equal(early.status, 409);
    const reviewed = await request(app)
      .post("/api/onboarding")
      .set(auth)
      .send({ review: "taxes" });
    assert.equal(
      reviewed.body.steps.find((s: { id: string }) => s.id === "taxes").done,
      true,
    );
    assert.equal(
      (
        await request(app)
          .post("/api/onboarding")
          .set(auth)
          .send({ review: "nope" })
      ).status,
      400,
    );
  } finally {
    await Promise.all([
      owner.$disconnect(),
      db.$disconnect(),
      licenseDb.$disconnect(),
    ]);
  }
});
