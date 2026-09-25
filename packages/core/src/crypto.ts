import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  publicEncrypt,
  privateDecrypt,
  constants,
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
// Sealed to the cloud: the hub encrypts a payment gateway secret with the cloud's public
// key, so only the cloud (which must call the gateway) can ever read it. The hub keeps no
// way to decrypt it. RSA-OAEP-SHA256 wraps a one-time AES-256-GCM key; the AAD binds the
// ciphertext to one hotel and one gateway, so it cannot be replayed for another.
export type Sealed = {
  v: 1;
  alg: "RSA-OAEP-256+A256GCM";
  key: string;
  iv: string;
  tag: string;
  data: string;
};
export function sealForCloud(
  publicKeyPem: string,
  value: unknown,
  aad: string,
): Sealed {
  const cek = randomBytes(32),
    iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cek, iv);
  c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([
    c.update(JSON.stringify(value), "utf8"),
    c.final(),
  ]);
  const key = publicEncrypt(
    {
      key: publicKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    cek,
  );
  return {
    v: 1,
    alg: "RSA-OAEP-256+A256GCM",
    key: key.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: c.getAuthTag().toString("base64url"),
    data: data.toString("base64url"),
  };
}
export function openSealed(
  privateKeyPem: string,
  sealed: Sealed,
  aad: string,
): unknown {
  if (sealed?.v !== 1 || sealed.alg !== "RSA-OAEP-256+A256GCM")
    throw new Error("Unsupported sealed secret");
  const cek = privateDecrypt(
    {
      key: privateKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(sealed.key, "base64url"),
  );
  const d = createDecipheriv(
    "aes-256-gcm",
    cek,
    Buffer.from(sealed.iv, "base64url"),
  );
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(sealed.tag, "base64url"));
  return JSON.parse(
    Buffer.concat([
      d.update(Buffer.from(sealed.data, "base64url")),
      d.final(),
    ]).toString("utf8"),
  );
}
export const gatewayAad = (tenantId: string, gateway: string) =>
  `hotel-hub:gateway:${tenantId}:${gateway}:v1`;
