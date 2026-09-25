import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  signLicense,
  verifyLicense,
  licenseDecision,
  GRACE_MS,
  type LicenseClaims,
} from "../packages/core/src/license.js";
import { encryptSecret, decryptSecret } from "../packages/core/src/crypto.js";
const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
  publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const now = Date.now();
const c: LicenseClaims = {
  tenantId: randomUUID(),
  installationId: randomUUID(),
  licenseId: randomUUID(),
  status: "active",
  plan: "standard",
  maxDevices: 8,
  maxRooms: 50,
  features: { online_booking: false },
  issuedAt: now,
  validUntil: now + GRACE_MS,
  trialEndsAt: null,
  schemaVersion: 1,
};
test("signed licence is bound to tenant and installation", () => {
  const token = signLicense(c, privateKey);
  assert.deepEqual(
    verifyLicense(token, publicKey, c.tenantId, c.installationId),
    c,
  );
  assert.throws(() =>
    verifyLicense(token, publicKey, randomUUID(), c.installationId),
  );
  assert.throws(() =>
    verifyLicense(token, publicKey, c.tenantId, randomUUID()),
  );
  assert.throws(() =>
    verifyLicense(token.slice(1), publicKey, c.tenantId, c.installationId),
  );
});
test("14 day grace boundary is read-only, never blocks reads", () => {
  assert.equal(licenseDecision(c, now + GRACE_MS - 1).writable, true);
  assert.equal(licenseDecision(c, now + GRACE_MS).writable, false);
  assert.equal(licenseDecision(null).writable, false);
});
test("all five subscription states have defined behaviour", () => {
  for (const status of ["active", "past_due"] as const)
    assert.equal(licenseDecision({ ...c, status }, now).writable, true);
  for (const status of ["suspended", "cancelled"] as const)
    assert.equal(licenseDecision({ ...c, status }, now).writable, false);
  assert.equal(
    licenseDecision({ ...c, status: "trial", trialEndsAt: now + 1 }, now)
      .writable,
    true,
  );
  assert.equal(
    licenseDecision({ ...c, status: "trial", trialEndsAt: now }, now).writable,
    false,
  );
});
test("clock rollback fails closed and overlong leases are rejected", () => {
  assert.equal(licenseDecision(c, now, now + 600_000).writable, false);
  assert.throws(() =>
    verifyLicense(
      signLicense({ ...c, validUntil: now + GRACE_MS + 1 }, privateKey),
      publicKey,
      c.tenantId,
      c.installationId,
    ),
  );
});
test("gateway ciphertext cannot be moved across hotels or providers", () => {
  const key = "ab".repeat(32);
  const token = encryptSecret(
    { secretKey: "not-in-the-audit-log" },
    key,
    c.tenantId,
    "paystack",
  );
  assert.deepEqual(decryptSecret(token, key, c.tenantId, "paystack"), {
    secretKey: "not-in-the-audit-log",
  });
  assert.throws(() => decryptSecret(token, key, randomUUID(), "paystack"));
  assert.throws(() => decryptSecret(token, key, c.tenantId, "flutterwave"));
  assert.ok(!token.includes("not-in-the-audit-log"));
});
