import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  signLicense,
  GRACE_MS,
  type LicenseClaims,
} from "../packages/core/src/license.js";
import { base, mutation, scope } from "../apps/api/src/db.js";
const { app } = await import("../apps/api/src/app.js");
const { providerApp, providerDb } = await import(
  "../apps/api/src/provider-app.js"
);
const { db } = await import("../apps/api/src/db.js");
const { acceptLicense, licenseDb } = await import(
  "../apps/api/src/licensing.js"
);
const owner = new PrismaClient({
  datasourceUrl: process.env.MIGRATION_DATABASE_URL,
});
const tenant = process.env.HOTEL_ID!,
  installation = process.env.INSTALLATION_ID!;
const privateKey = readFileSync(process.env.LICENSE_PRIVATE_KEY_FILE!, "utf8");
const now = Date.now();
const claims: LicenseClaims = {
  tenantId: tenant,
  installationId: installation,
  licenseId: randomUUID(),
  status: "active",
  plan: "standard",
  maxDevices: 2,
  maxRooms: 50,
  features: { online_booking: false },
  issuedAt: now,
  validUntil: now + GRACE_MS,
  trialEndsAt: null,
  schemaVersion: 1,
};
const cookie = (res: request.Response) =>
  res.headers["set-cookie"][0].split(";")[0];
test("HTTP auth, tenant spoofing, role limits, read-only licence, provider separation and replay", async () => {
  try {
    await acceptLicense(signLicense(claims, privateKey));
    let login = await request(app)
      .post("/api/auth/login")
      .send({
        email: process.env.SEED_ADMIN_EMAIL,
        password: process.env.SEED_ADMIN_PASSWORD,
      });
    assert.equal(login.status, 200);
    let token = login.body.accessToken;
    assert.equal(
      (
        await request(app)
          .get("/api/users")
          .set("Authorization", `Bearer ${token}`)
      ).status,
      403,
      "First-login gate",
    );
    const password = "Changed-password-2026!";
    assert.equal(
      (
        await request(app)
          .post("/api/auth/password")
          .set("Authorization", `Bearer ${token}`)
          .send({
            currentPassword: process.env.SEED_ADMIN_PASSWORD,
            newPassword: password,
          })
      ).status,
      204,
    );
    assert.equal(
      (
        await request(app)
          .get("/api/auth/me")
          .set("Authorization", `Bearer ${token}`)
      ).status,
      401,
      "Password change invalidates old token",
    );
    login = await request(app)
      .post("/api/auth/login")
      .send({ email: process.env.SEED_ADMIN_EMAIL, password });
    token = login.body.accessToken;
    const headers = { Authorization: `Bearer ${token}` };
    const roleResponse = await request(app).get("/api/roles").set(headers);
    assert.equal(roleResponse.status, 200);
    const reception = roleResponse.body.find(
      (r: { name: string }) => r.name === "receptionist",
    );
    assert.equal(
      (
        await request(app)
          .post("/api/users")
          .set(headers)
          .send({
            name: "Bad tenant",
            email: "bad@example.test",
            password,
            roleId: reception.id,
            tenant_id: randomUUID(),
          })
      ).status,
      400,
      "Client cannot supply tenant",
    );
    const other = randomUUID(),
      otherRole = randomUUID();
    await scope(owner, { tenantId: other, writable: true }, async (tx) => {
      await mutation(tx, () =>
        tx.tenants.create({
          data: {
            ...base({ tenantId: other }),
            id: other,
            name: "Isolation test",
            slug: other,
            branding: {},
          },
        }),
      );
      await mutation(tx, () =>
        tx.roles.create({
          data: {
            ...base({ tenantId: other }),
            id: otherRole,
            name: "admin",
            permissions: [],
          },
        }),
      );
    });
    assert.equal(
      (
        await request(app)
          .post("/api/users")
          .set(headers)
          .send({
            name: "Wrong role",
            email: "wrong@example.test",
            password,
            roleId: otherRole,
          })
      ).status,
      400,
      "Cross-tenant role cannot be assigned",
    );
    const staff = await request(app)
      .post("/api/users")
      .set(headers)
      .send({
        name: "Receptionist",
        email: "reception@example.test",
        password,
        roleId: reception.id,
      });
    assert.equal(staff.status, 201);
    const first = await request(app)
      .post("/api/devices")
      .set(headers)
      .send({ label: "Tablet" });
    assert.equal(first.status, 201);
    assert.equal(
      (
        await request(app)
          .post("/api/devices")
          .set(headers)
          .send({ label: "Beyond plan" })
      ).status,
      409,
      "Device cap enforced",
    );
    const repLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "reception@example.test", password });
    await request(app)
      .post("/api/auth/password")
      .set("Authorization", `Bearer ${repLogin.body.accessToken}`)
      .send({
        currentPassword: password,
        newPassword: "Reception-changed-2026!",
      });
    const rep = await request(app)
      .post("/api/auth/login")
      .send({
        email: "reception@example.test",
        password: "Reception-changed-2026!",
      });
    assert.equal(
      (
        await request(app)
          .get("/api/users")
          .set("Authorization", `Bearer ${rep.body.accessToken}`)
      ).status,
      403,
    );
    assert.equal(
      (
        await request(app)
          .get("/api/audit")
          .set("Authorization", `Bearer ${rep.body.accessToken}`)
      ).status,
      403,
    );
    assert.equal(
      (await request(providerApp).get("/api/provider/tenants").set(headers))
        .status,
      401,
      "Staff JWT cannot enter provider console",
    );
    await acceptLicense(
      signLicense(
        {
          ...claims,
          issuedAt: Date.now(),
          validUntil: Date.now() + GRACE_MS,
          status: "suspended",
        },
        privateKey,
      ),
    );
    assert.equal(
      (await request(app).get("/api/users").set(headers)).status,
      200,
      "Suspended hotel can read",
    );
    assert.equal(
      (
        await request(app)
          .post("/api/users")
          .set(headers)
          .send({
            name: "Blocked",
            email: "blocked@example.test",
            password,
            roleId: reception.id,
          })
      ).status,
      423,
      "Suspended hotel cannot write",
    );
    const oldCookie = cookie(login);
    const refreshed = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", oldCookie);
    assert.equal(refreshed.status, 200);
    assert.equal(
      (await request(app).post("/api/auth/refresh").set("Cookie", oldCookie))
        .status,
      401,
      "Refresh replay blocked",
    );
    assert.equal(
      (
        await request(app)
          .get("/api/auth/me")
          .set("Authorization", `Bearer ${refreshed.body.accessToken}`)
      ).status,
      401,
      "Replay revokes family",
    );
    assert.equal(
      (
        await request(app)
          .post("/api/auth/login")
          .set("Origin", "https://attacker.test")
          .send({ email: process.env.SEED_ADMIN_EMAIL, password })
      ).status,
      403,
      "Origin enforced",
    );
  } finally {
    await Promise.all([
      owner.$disconnect(),
      db.$disconnect(),
      licenseDb.$disconnect(),
      providerDb.$disconnect(),
    ]);
  }
});
