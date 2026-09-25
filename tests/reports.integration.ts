import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  signLicense,
  GRACE_MS,
  type LicenseClaims,
} from "../packages/core/src/license.js";
import { db } from "../apps/api/src/db.js";
import { acceptLicense, licenseDb } from "../apps/api/src/licensing.js";
import { app } from "../apps/api/src/app.js";
import { unzip } from "./zip-reader.js";
// Runs after tests/billing.integration.ts on the same freshly seeded hub, so the ledger
// already holds sales, split payments and a refund.
const tenantId = process.env.HOTEL_ID!,
  key = readFileSync(process.env.LICENSE_PRIVATE_KEY_FILE!, "utf8");
const claims = (
  plan: "standard" | "premium",
  status: LicenseClaims["status"],
): LicenseClaims => ({
  tenantId,
  installationId: process.env.INSTALLATION_ID!,
  licenseId: randomUUID(),
  status,
  plan,
  maxDevices: 20,
  maxRooms: 50,
  features: { provider_credit: false, mobile_dashboard: plan === "premium" },
  issuedAt: Date.now(),
  validUntil: Date.now() + GRACE_MS,
  trialEndsAt: null,
  schemaVersion: 1,
});
const binary = (res: any, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};
test("hub reports over HTTP: permissions, formats, departure export and remote access links", async () => {
  try {
    await acceptLicense(signLicense(claims("standard", "active"), key));
    const login = await request(app)
      .post("/api/auth/login")
      .send({
        email: process.env.SEED_ADMIN_EMAIL,
        password: "Changed-password-2026!",
      });
    assert.equal(login.status, 200);
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Africa/Lagos",
    });
    const q = `from=${today}&to=${today}`;
    assert.equal(
      (await request(app).get(`/api/reports/summary?${q}`)).status,
      401,
    );
    for (const kind of [
      "summary",
      "revenue",
      "payments",
      "occupancy",
      "shifts",
      "outstanding",
      "inventory",
    ]) {
      const r = await request(app).get(`/api/reports/${kind}?${q}`).set(auth);
      assert.equal(r.status, 200, `${kind}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.source, "hub");
      assert.ok(r.body.tables.length >= 1);
    }
    const pay = await request(app).get(`/api/reports/payments?${q}`).set(auth);
    const cash = pay.body.tables[0].rows.find((r: any) => r.method === "Cash");
    // Money arrives as exact decimal text, never as a float.
    assert.match(cash.net, /^-?\d+\.\d{2}$/);
    assert.ok(
      Number(pay.body.tables[0].totals.refunded) > 0,
      "billing refund is reported",
    );
    const csv = await request(app)
      .get(`/api/reports/revenue?${q}&format=csv`)
      .set(auth);
    assert.equal(csv.status, 200);
    assert.match(
      csv.headers["content-disposition"],
      /attachment; filename=".*-revenue-/,
    );
    const pdf = await request(app)
      .get(`/api/reports/summary?${q}&format=pdf`)
      .set(auth)
      .buffer(true)
      .parse(binary);
    assert.equal(pdf.headers["content-type"], "application/pdf");
    assert.equal((pdf.body as Buffer).subarray(0, 5).toString(), "%PDF-");
    assert.equal(
      (
        await request(app)
          .get(`/api/reports/summary?from=${today}&to=2000-01-01`)
          .set(auth)
      ).status,
      400,
    );
    assert.equal(
      (
        await request(app)
          .get(`/api/reports/summary?${q}&table=users`)
          .set(auth)
      ).status,
      400,
    );
    // Full departure export, audited.
    const zip = await request(app)
      .get("/api/exports/tenant")
      .set(auth)
      .buffer(true)
      .parse(binary);
    assert.equal(zip.status, 200);
    assert.equal(zip.headers["content-type"], "application/zip");
    const files = unzip(zip.body as Buffer);
    const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
    assert.equal(manifest.source, "hub");
    assert.ok(
      manifest.tables.find((t: any) => t.table === "payments").rows > 0,
    );
    const users = files.get("data/users.csv")!.toString("utf8");
    assert.ok(users.includes(process.env.SEED_ADMIN_EMAIL!));
    assert.ok(
      !/\$2[aby]\$/.test(users) && !users.includes("password_hash"),
      "no bcrypt hashes",
    );
    // Standard plan: the dashboard scope is refused, export-only access is allowed.
    const denied = await request(app)
      .post("/api/remote-access")
      .set(auth)
      .send({ label: "Owner phone", days: 30, scopes: ["reports"] });
    assert.equal(denied.status, 403);
    const exportLink = await request(app)
      .post("/api/remote-access")
      .set(auth)
      .send({ label: "Accountant", days: 7, scopes: ["export"] });
    assert.equal(exportLink.status, 201);
    assert.match(exportLink.body.token, /^hh1\./);
    await acceptLicense(signLicense(claims("premium", "active"), key));
    const link = await request(app)
      .post("/api/remote-access")
      .set(auth)
      .send({ label: "Owner phone", days: 30, scopes: ["reports", "export"] });
    assert.equal(link.status, 201);
    const list = await request(app).get("/api/remote-access").set(auth);
    assert.equal(list.body.dashboardIncluded, true);
    assert.equal(list.body.tokens[0].label, "Owner phone");
    const secret = link.body.token.split(".")[3];
    assert.ok(!JSON.stringify(list.body).includes(secret));
    assert.ok(!JSON.stringify(list.body).includes('"hash"'));
    const settings = await request(app).get("/api/settings").set(auth);
    assert.ok(!settings.body.some((s: any) => s.key === "remote_access"));
    assert.equal(
      (
        await request(app)
          .put("/api/settings")
          .set(auth)
          .send({ key: "remote_access", value: { tokens: [] } })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(app)
          .delete(`/api/remote-access/${link.body.access.id}`)
          .set(auth)
      ).status,
      204,
    );
    const after = await request(app).get("/api/remote-access").set(auth);
    assert.equal(
      after.body.tokens.find((t: any) => t.id === link.body.access.id).active,
      false,
    );
    // A cancelled hotel is read-only but keeps its reports and its departure export.
    await acceptLicense(signLicense(claims("premium", "cancelled"), key));
    assert.equal(
      (await request(app).get(`/api/reports/summary?${q}`).set(auth)).status,
      200,
    );
    assert.equal(
      (await request(app).get("/api/exports/tenant").set(auth)).status,
      200,
    );
    assert.equal(
      (
        await request(app)
          .post("/api/remote-access")
          .set(auth)
          .send({ label: "Late", days: 1, scopes: ["export"] })
      ).status,
      423,
    );
    const audit = await request(app).get("/api/audit").set(auth);
    assert.ok(audit.body.some((a: any) => a.action === "tenant_export"));
    await acceptLicense(signLicense(claims("standard", "active"), key));
  } finally {
    await Promise.all([db.$disconnect(), licenseDb.$disconnect()]);
  }
});
