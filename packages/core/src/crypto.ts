import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
export const hashToken = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const opaqueToken = () => randomBytes(32).toString("base64url");
export function encryptSecret(
  secret: unknown,
  keyHex: string,
  tenantId: string,
  gateway: string,
): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(`${tenantId}:${gateway}:v1`));
  const cipher = Buffer.concat([
    c.update(JSON.stringify(secret), "utf8"),
    c.final(),
  ]);
  return [iv, c.getAuthTag(), cipher]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function decryptSecret(
  payload: string,
  keyHex: string,
  tenantId: string,
  gateway: string,
): unknown {
  const [iv, tag, data] = payload
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  const c = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  c.setAAD(Buffer.from(`${tenantId}:${gateway}:v1`));
  c.setAuthTag(tag);
  return JSON.parse(Buffer.concat([c.update(data), c.final()]).toString());
}
