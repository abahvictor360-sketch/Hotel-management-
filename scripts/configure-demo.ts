import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import bcrypt from "bcryptjs";
if (existsSync(".env"))
  throw new Error(".env already exists. Keep your existing configuration.");
mkdirSync("secrets", { recursive: true, mode: 0o700 });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(
  "secrets/license-private.pem",
  privateKey.export({ type: "pkcs8", format: "pem" }),
  { mode: 0o600 },
);
writeFileSync(
  "secrets/license-public.pem",
  publicKey.export({ type: "spki", format: "pem" }),
);
const random = () => randomBytes(24).toString("hex");
const dbPassword = random(),
  providerDbPassword = random(),
  licenseDbPassword = random(),
  ownerPassword = random();
const adminPassword = randomBytes(15).toString("base64url"),
  providerPassword = randomBytes(15).toString("base64url");
const tenant = randomUUID(),
  installation = randomUUID();
const lines = {
  NODE_ENV: "development",
  PORT: "4000",
  PROVIDER_PORT: "4001",
  APP_ORIGIN: "http://localhost:5173",
  PROVIDER_ORIGIN: "http://localhost:5174",
  HOTEL_ID: tenant,
  INSTALLATION_ID: installation,
  POSTGRES_PASSWORD: ownerPassword,
  HOTEL_DB_PASSWORD: dbPassword,
  PROVIDER_DB_PASSWORD: providerDbPassword,
  LICENSE_DB_PASSWORD: licenseDbPassword,
  DATABASE_URL: `postgresql://hotel_app:${dbPassword}@localhost:5432/hotel?schema=public`,
  MIGRATION_DATABASE_URL: `postgresql://postgres:${ownerPassword}@localhost:5432/hotel?schema=public`,
  CLOUD_DATABASE_URL: `postgresql://postgres:${ownerPassword}@localhost:5433/cloud?schema=public`,
  PROVIDER_DATABASE_URL: `postgresql://provider_app:${providerDbPassword}@localhost:5433/cloud?schema=public`,
  LICENSE_DATABASE_URL: `postgresql://license_agent:${licenseDbPassword}@localhost:5432/hotel?schema=public`,
  JWT_SECRET: random(),
  PROVIDER_JWT_SECRET: random(),
  PROVIDER_PASSWORD_HASH: await bcrypt.hash(providerPassword, 12),
  CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  LICENSE_PRIVATE_KEY_FILE: "secrets/license-private.pem",
  LICENSE_PUBLIC_KEY_FILE: "secrets/license-public.pem",
  PROVIDER_URL: "http://localhost:4001",
  HUB_LICENSE_KEY: randomBytes(32).toString("base64url"),
  SEED_ADMIN_EMAIL: "admin@demo.hotel",
  SEED_ADMIN_PASSWORD: adminPassword,
  SEED_HOTEL_NAME: "Demo Hotel",
  BACKUP_DIR: "backups",
  PRINTER_INTERFACE: "tcp://192.168.1.200:9100",
};
writeFileSync(
  ".env",
  Object.entries(lines)
    .map(([k, v]) => `${k}='${v}'`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
writeFileSync(
  "secrets/demo-logins.txt",
  `Staff: admin@demo.hotel\nTemporary password: ${adminPassword}\nProvider password: ${providerPassword}\n`,
  { mode: 0o600 },
);
console.log(
  "Created local configuration. Demo passwords are in secrets/demo-logins.txt. Never commit secrets.",
);
