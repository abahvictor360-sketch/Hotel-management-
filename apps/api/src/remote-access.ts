import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { hashToken } from "../../../packages/core/src/crypto.js";
// Remote management access. An administrator issues a token on the hub (it works offline);
// only its SHA-256 hash is stored, in the replicated `remote_access` setting, so the cloud
// can verify it once the hub has synced. The cloud never holds a staff password.
// Format: hh1.<hotel id>.<token id>.<secret>. The hotel id picks the tenant context.
export const REMOTE_SETTING = "remote_access";
export const remoteScopes = ["reports", "export"] as const;
export type RemoteScope = (typeof remoteScopes)[number];
const entry = z
  .object({
    id: z.string().uuid(),
    label: z.string().max(80),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    scopes: z.array(z.enum(remoteScopes)).min(1),
    createdAt: z.string(),
    createdBy: z.string().uuid().nullable(),
    expiresAt: z.string(),
    revokedAt: z.string().nullable(),
  })
  .strict();
export type RemoteToken = z.infer<typeof entry>;
export const remoteValue = z
  .object({ tokens: z.array(entry).max(50) })
  .strict();
export const MAX_ACTIVE = 10;
export function parseStored(value: unknown): RemoteToken[] {
  const v = remoteValue.safeParse(value);
  return v.success ? v.data.tokens : [];
}
export function issueToken(
  tenantId: string,
  input: { label: string; days: number; scopes: RemoteScope[] },
  createdBy: string | null,
  now = new Date(),
) {
  const id = randomUUID(),
    secret = randomBytes(32).toString("base64url");
  const record: RemoteToken = {
    id,
    label: input.label,
    hash: hashToken(secret),
    scopes: [...new Set(input.scopes)],
    createdAt: now.toISOString(),
    createdBy,
    expiresAt: new Date(now.getTime() + input.days * 86_400_000).toISOString(),
    revokedAt: null,
  };
  return { token: `hh1.${tenantId}.${id}.${secret}`, record };
}
const uuid = z.string().uuid();
export function parseToken(raw: string | undefined) {
  const parts = (raw ?? "").replace(/^Bearer /, "").split(".");
  if (parts.length !== 4 || parts[0] !== "hh1") return null;
  const [, tenant, id, secret] = parts;
  if (!uuid.safeParse(tenant).success || !uuid.safeParse(id).success)
    return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  return { tenant, id, secret };
}
export const isActive = (t: RemoteToken, now = Date.now()) =>
  !t.revokedAt && Date.parse(t.expiresAt) > now;
export function verifyToken(
  stored: RemoteToken[],
  id: string,
  secret: string,
  now = Date.now(),
) {
  const t = stored.find((x) => x.id === id);
  if (!t || !isActive(t, now)) return null;
  const a = Buffer.from(hashToken(secret), "hex"),
    b = Buffer.from(t.hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? t : null;
}
// What the hub shows administrators. Never the hash.
export const publicView = (t: RemoteToken) => ({
  id: t.id,
  label: t.label,
  scopes: t.scopes,
  createdAt: t.createdAt,
  expiresAt: t.expiresAt,
  revokedAt: t.revokedAt,
  active: isActive(t),
});
