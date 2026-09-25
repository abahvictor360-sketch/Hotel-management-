import { sign, verify } from "node:crypto";
import { z } from "zod";
export const claimsSchema = z
  .object({
    tenantId: z.string().uuid(),
    installationId: z.string().uuid(),
    licenseId: z.string().uuid(),
    status: z.enum(["trial", "active", "past_due", "suspended", "cancelled"]),
    plan: z.enum(["standard", "premium"]),
    maxDevices: z.number().int().positive(),
    maxRooms: z.number().int().positive(),
    features: z.record(z.boolean()),
    issuedAt: z.number().int(),
    validUntil: z.number().int(),
    trialEndsAt: z.number().int().nullable(),
    schemaVersion: z.literal(1),
  })
  .strict();
export type LicenseClaims = z.infer<typeof claimsSchema>;
export const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
export function signLicense(claims: LicenseClaims, privateKey: string): string {
  const payload = Buffer.from(
    JSON.stringify(claimsSchema.parse(claims)),
  ).toString("base64url");
  return `${payload}.${sign(null, Buffer.from(payload), privateKey).toString("base64url")}`;
}
export function verifyLicense(
  token: string,
  publicKey: string,
  tenantId: string,
  installationId: string,
): LicenseClaims {
  const parts = token.split(".");
  if (
    parts.length !== 2 ||
    !verify(
      null,
      Buffer.from(parts[0]),
      publicKey,
      Buffer.from(parts[1], "base64url"),
    )
  )
    throw new Error("Invalid licence signature");
  const claims = claimsSchema.parse(
    JSON.parse(Buffer.from(parts[0], "base64url").toString()),
  );
  if (claims.tenantId !== tenantId || claims.installationId !== installationId)
    throw new Error("Licence belongs to another hotel or installation");
  if (
    claims.validUntil > claims.issuedAt + GRACE_MS ||
    claims.validUntil < claims.issuedAt
  )
    throw new Error("Invalid licence validity window");
  return claims;
}
export function licenseDecision(
  claims: LicenseClaims | null,
  now = Date.now(),
  maxObservedAt = 0,
) {
  if (!claims)
    return {
      writable: false,
      reason: "Activate this hub to enable hotel operations.",
    };
  if (now + 300_000 < maxObservedAt || claims.issuedAt > now + 300_000)
    return {
      writable: false,
      reason:
        "The hub clock has changed. Correct the time and validate the licence.",
    };
  if (["suspended", "cancelled"].includes(claims.status))
    return {
      writable: false,
      reason: `Subscription ${claims.status}. Contact your provider.`,
    };
  if (now >= claims.validUntil)
    return {
      writable: false,
      reason: "Offline licence grace expired. Connect to renew your licence.",
    };
  if (
    claims.status === "trial" &&
    (!claims.trialEndsAt || now >= claims.trialEndsAt)
  )
    return {
      writable: false,
      reason: "Trial ended. Contact your provider to activate a subscription.",
    };
  return {
    writable: true,
    reason:
      claims.status === "past_due"
        ? "Payment is due. Contact your provider."
        : "Licence valid.",
  };
}
