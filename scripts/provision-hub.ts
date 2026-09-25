import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { scope, base, mutation } from "../apps/api/src/db.js";
import {
  verifyLicense,
  licenseDecision,
} from "../packages/core/src/license.js";
import { seededRoles } from "../packages/core/src/permissions.js";
const e = z
  .object({
    HOTEL_ID: z.string().uuid(),
    INSTALLATION_ID: z.string().uuid(),
    HUB_LICENSE_KEY: z.string().min(20),
    PROVIDER_URL: z.string().url(),
    MIGRATION_DATABASE_URL: z.string(),
    LICENSE_PUBLIC_KEY_FILE: z.string(),
    SEED_ADMIN_EMAIL: z.string().email(),
    SEED_ADMIN_PASSWORD: z.string().min(12).max(72),
    SEED_HOTEL_NAME: z.string().min(2),
  })
  .parse(process.env);
const response = await fetch(`${e.PROVIDER_URL}/api/license/validate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    key: e.HUB_LICENSE_KEY,
    tenantId: e.HOTEL_ID,
    installationId: e.INSTALLATION_ID,
    schemaVersion: 1,
  }),
  signal: AbortSignal.timeout(10000),
});
if (!response.ok)
  throw new Error("Activation failed. Check the provider URL and licence key.");
const { token } = (await response.json()) as { token: string };
const claims = verifyLicense(
  token,
  readFileSync(e.LICENSE_PUBLIC_KEY_FILE, "utf8"),
  e.HOTEL_ID,
  e.INSTALLATION_ID,
);
if (!licenseDecision(claims).writable)
  throw new Error("Licence does not allow activation.");
const db = new PrismaClient({ datasourceUrl: e.MIGRATION_DATABASE_URL });
await scope(db, { tenantId: e.HOTEL_ID, writable: true }, async (tx) => {
  const count = await tx.tenants.count();
  if (count && !(await tx.tenants.findUnique({ where: { id: e.HOTEL_ID } })))
    throw new Error("A hub may serve only one tenant.");
  if (await tx.users.count({ where: { tenant_id: e.HOTEL_ID } }))
    throw new Error("Hub already provisioned. Existing staff are unchanged.");
  const ctx = { tenantId: e.HOTEL_ID };
  if (!count)
    await mutation(tx, () =>
      tx.tenants.create({
        data: {
          ...base(ctx),
          id: e.HOTEL_ID,
          name: e.SEED_HOTEL_NAME,
          slug: `hotel-${e.HOTEL_ID}`,
          branding: { name: e.SEED_HOTEL_NAME, address: "", logoUrl: "" },
        },
      }),
    );
  for (const [name, permissions] of Object.entries(seededRoles))
    if (!(await tx.roles.findFirst({ where: { tenant_id: e.HOTEL_ID, name } })))
      await mutation(tx, () =>
        tx.roles.create({ data: { ...base(ctx), name, permissions } }),
      );
  const admin = await tx.roles.findFirstOrThrow({
    where: { tenant_id: e.HOTEL_ID, name: "admin" },
  });
  const password_hash = await bcrypt.hash(e.SEED_ADMIN_PASSWORD, 12);
  await mutation(tx, () =>
    tx.users.create({
      data: {
        ...base(ctx),
        name: "Hotel Administrator",
        email: e.SEED_ADMIN_EMAIL.toLowerCase(),
        password_hash,
        role_id: admin.id,
      },
    }),
  );
  await mutation(tx, () =>
    tx.devices.create({
      data: {
        ...base(ctx),
        label: "Front desk hub",
        assigned_department: "frontdesk",
      },
    }),
  );
  await tx.license_cache.create({
    data: {
      ...base(ctx),
      installation_id: e.INSTALLATION_ID,
      signed_token: token,
      last_checked_at: new Date(claims.issuedAt),
      max_observed_at: new Date(),
    },
  });
});
await db.$disconnect();
console.log(
  "Hub activated. Sign in with the temporary admin password and change it.",
);
