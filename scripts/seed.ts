import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { scope, base, mutation } from "../apps/api/src/db.js";
import { seededRoles, plans } from "../packages/core/src/permissions.js";
import { hashToken } from "../packages/core/src/crypto.js";
const tenant = process.env.HOTEL_ID!;
const local = new PrismaClient({
  datasourceUrl: process.env.MIGRATION_DATABASE_URL,
});
const cloud = new PrismaClient({
  datasourceUrl: process.env.CLOUD_DATABASE_URL,
});
const password = process.env.SEED_ADMIN_PASSWORD;
if (!password || password.length < 12)
  throw new Error("Set SEED_ADMIN_PASSWORD (12+ characters)");
const ctx = { tenantId: tenant, writable: true };
async function tenantRow(db: PrismaClient) {
  await scope(db, ctx, async (tx) => {
    if (!(await tx.tenants.findUnique({ where: { id: tenant } })))
      await mutation(tx, () =>
        tx.tenants.create({
          data: {
            ...base(ctx),
            id: tenant,
            name: process.env.SEED_HOTEL_NAME ?? "Demo Hotel",
            slug: `hotel-${tenant}`,
            branding: { address: "Configure your hotel address", logoUrl: "" },
          },
        }),
      );
  });
}
await tenantRow(local);
await tenantRow(cloud);
await scope(local, ctx, async (tx) => {
  for (const [name, permissions] of Object.entries(seededRoles))
    if (!(await tx.roles.findFirst({ where: { name } })))
      await mutation(tx, () =>
        tx.roles.create({ data: { ...base(ctx), name, permissions } }),
      );
  const role = await tx.roles.findFirstOrThrow({ where: { name: "admin" } });
  if (
    !(await tx.users.findFirst({
      where: { email: process.env.SEED_ADMIN_EMAIL ?? "admin@demo.hotel" },
    }))
  ) {
    const password_hash = await bcrypt.hash(password, 12);
    await mutation(tx, () =>
      tx.users.create({
        data: {
          ...base(ctx),
          name: "Hotel Administrator",
          email: process.env.SEED_ADMIN_EMAIL ?? "admin@demo.hotel",
          password_hash,
          role_id: role.id,
        },
      }),
    );
  }
  if ((await tx.devices.count()) === 0)
    await mutation(tx, () =>
      tx.devices.create({
        data: {
          ...base(ctx),
          label: "Front desk hub",
          assigned_department: "frontdesk",
        },
      }),
    );
  for (const [name, rate, capacity] of [
    ["Standard", "35000.00", 2],
    ["Deluxe", "55000.00", 2],
    ["Suite", "95000.00", 4],
  ] as const) {
    let roomType = await tx.room_types.findFirst({ where: { name } });
    if (!roomType)
      roomType = await mutation(tx, () =>
        tx.room_types.create({
          data: {
            ...base(ctx),
            name,
            base_rate: rate,
            capacity,
            amenities: ["Wi-Fi", "Air conditioning", "Breakfast"],
            online_allotment: 0,
          },
        }),
      );
    for (let i = 1; i <= 4; i++) {
      const number = `${name === "Standard" ? 1 : name === "Deluxe" ? 2 : 3}0${i}`;
      if (!(await tx.rooms.findFirst({ where: { room_number: number } })))
        await mutation(tx, () =>
          tx.rooms.create({
            data: {
              ...base(ctx),
              room_number: number,
              room_type_id: roomType!.id,
              floor: Number(number[0]),
            },
          }),
        );
    }
  }
  for (const name of [
    "room",
    "restaurant",
    "bar",
    "laundry",
    "room_service",
    "spa",
    "conference",
    "other",
  ]) {
    let category = await tx.service_categories.findFirst({ where: { name } });
    if (!category)
      category = await mutation(tx, () =>
        tx.service_categories.create({
          data: {
            ...base(ctx),
            name,
            vat_enabled: true,
            service_charge_enabled: true,
            vat_rate: "7.500",
            service_charge_rate: "10.000",
          },
        }),
      );
    if (
      !(await tx.service_items.findFirst({
        where: { category_id: category.id },
      }))
    )
      await mutation(tx, () =>
        tx.service_items.create({
          data: {
            ...base(ctx),
            category_id: category!.id,
            name: `Sample ${name.replace("_", " ")} service`,
            price: name === "room" ? "35000.00" : "2500.00",
            unit: "each",
          },
        }),
      );
  }
  for (const [key, value] of Object.entries({
    branding: {
      name: process.env.SEED_HOTEL_NAME ?? "Demo Hotel",
      address: "Configure your hotel address",
      logoUrl: "",
    },
    printer: {
      type: "network",
      interface: process.env.PRINTER_INTERFACE ?? "tcp://192.168.1.200:9100",
      width: "80",
      characterSet: "PC858_EURO",
    },
    receipt_footer: { text: "Thank you for staying with us." },
    tax_calculation: {
      basis: "net",
      compound: false,
      rounding: "half_up",
      vat: "7.5",
      service_charge: "10",
    },
  })) {
    if (!(await tx.settings.findFirst({ where: { key } })))
      await mutation(tx, () =>
        tx.settings.create({ data: { ...base(ctx), key, value } }),
      );
  }
});
await scope(cloud, ctx, async (tx) => {
  if (!(await tx.subscriptions.findFirst({ where: { tenant_id: tenant } })))
    await mutation(tx, () =>
      tx.subscriptions.create({
        data: {
          ...base(ctx),
          plan: "standard",
          status: "trial",
          trial_ends_at: new Date(Date.now() + 14 * 86400_000),
          features: plans.standard.features,
          max_devices: 8,
          max_rooms: 50,
        },
      }),
    );
  if (!(await tx.licenses.findFirst({ where: { tenant_id: tenant } })))
    await mutation(tx, () =>
      tx.licenses.create({
        data: {
          ...base(ctx),
          key_hash: hashToken(process.env.HUB_LICENSE_KEY!),
          installation_id: process.env.INSTALLATION_ID,
          issued_at: new Date(),
        },
      }),
    );
});
await Promise.all([local.$disconnect(), cloud.$disconnect()]);
console.log("Seed complete. Rerunning preserves existing data and passwords.");
