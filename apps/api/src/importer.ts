import { Router } from "express";
import { z } from "zod";
import { identity, requirePermission } from "./auth.js";
import { getLicense } from "./licensing.js";
import { db, scope, base, mutation, type Tx } from "./db.js";
import { HttpError, route } from "./http.js";
import { createGuest } from "./stay-service.js";
import {
  importKinds,
  readImport,
  type ImportKind,
  type RowError,
} from "../../../packages/core/src/csv-import.js";
// CSV import of set-up data. Every upload is checked in full first (a preview); an import
// then writes all its rows in one transaction or none. Records that already exist are
// skipped, so uploading the same file twice is harmless. Each row is an ordinary tracked
// write, so the audit trail and cloud sync see imported records like any other.
export const importer = Router();
const permissionFor: Record<ImportKind, string> = {
  rooms: "settings.write",
  menu: "settings.write",
  guests: "frontdesk.write",
};
type Plan = {
  create: number;
  skipped: { row: number; reason: string }[];
  errors: RowError[];
  notes: string[];
  apply: (tx: Tx) => Promise<void>;
};
const lower = (s: string) => s.trim().toLowerCase();
async function planRooms(
  tx: Tx,
  who: Parameters<typeof base>[0],
  text: string,
  maxRooms: number,
): Promise<Plan> {
  const { rows, errors } = readImport("rooms", text);
  const types = await tx.room_types.findMany({
    select: { id: true, name: true, deleted_at: true },
  });
  const typeByName = new Map(types.map((t) => [lower(t.name), t]));
  const existing = new Set(
    (await tx.rooms.findMany({ select: { room_number: true } })).map((r) =>
      lower(r.room_number),
    ),
  );
  const newTypes = new Map<
    string,
    { name: string; rate: string; capacity: number; id?: string }
  >();
  const skipped: Plan["skipped"] = [];
  const creates: (typeof rows)[number][] = [];
  for (const r of rows) {
    const v = r.value;
    const known = typeByName.get(lower(v.roomType));
    if (known?.deleted_at) {
      errors.push({
        row: r.row,
        message: `Room type "${v.roomType}" was removed earlier. Use a different name.`,
      });
      continue;
    }
    if (!known && !newTypes.has(lower(v.roomType))) {
      if (!v.rate) {
        errors.push({
          row: r.row,
          message: `"${v.roomType}" is a new room type: give its nightly rate on its first row.`,
        });
        continue;
      }
      newTypes.set(lower(v.roomType), {
        name: v.roomType,
        rate: v.rate,
        capacity: v.capacity ?? 2,
      });
    }
    if (existing.has(lower(v.roomNumber))) {
      skipped.push({
        row: r.row,
        reason: `Room ${v.roomNumber} already exists.`,
      });
      continue;
    }
    creates.push(r);
  }
  const current = await tx.rooms.count({ where: { deleted_at: null } });
  if (current + creates.length > maxRooms)
    errors.push({
      row: 1,
      message: `Your plan allows ${maxRooms} rooms; this import would bring the hotel to ${current + creates.length}.`,
    });
  const notes = [...newTypes.values()].map(
    (t) => `New room type ${t.name} at ${t.rate} a night for ${t.capacity}.`,
  );
  return {
    create: creates.length + newTypes.size,
    skipped,
    errors,
    notes,
    apply: async (tx) => {
      for (const t of newTypes.values()) {
        const created = await mutation(tx, () =>
          tx.room_types.create({
            data: {
              ...base(who),
              name: t.name,
              base_rate: t.rate,
              capacity: t.capacity,
              amenities: [],
            },
          }),
        );
        t.id = created.id;
      }
      for (const r of creates) {
        const typeId =
          typeByName.get(lower(r.value.roomType))?.id ??
          newTypes.get(lower(r.value.roomType))!.id!;
        await mutation(tx, () =>
          tx.rooms.create({
            data: {
              ...base(who),
              room_type_id: typeId,
              floor: r.value.floor,
              room_number: r.value.roomNumber,
            },
          }),
        );
      }
    },
  };
}
async function planMenu(
  tx: Tx,
  who: Parameters<typeof base>[0],
  text: string,
): Promise<Plan> {
  const { rows, errors } = readImport("menu", text);
  const categories = await tx.service_categories.findMany({
    where: { deleted_at: null },
    select: { id: true, name: true },
  });
  const categoryByName = new Map(categories.map((c) => [c.name, c.id]));
  const items = await tx.service_items.findMany({
    where: { deleted_at: null },
    select: { category_id: true, name: true },
  });
  const have = new Set(items.map((i) => `${i.category_id}|${lower(i.name)}`));
  const skipped: Plan["skipped"] = [];
  const creates: { categoryId: string; v: (typeof rows)[number]["value"] }[] =
    [];
  for (const r of rows) {
    const categoryId = categoryByName.get(r.value.department);
    if (!categoryId) {
      errors.push({
        row: r.row,
        message: `Unknown department "${r.value.department}". Use one of: ${categories.map((c) => c.name).join(", ")}.`,
      });
      continue;
    }
    if (have.has(`${categoryId}|${lower(r.value.name)}`)) {
      skipped.push({
        row: r.row,
        reason: `${r.value.name} is already on the menu.`,
      });
      continue;
    }
    creates.push({ categoryId, v: r.value });
  }
  return {
    create: creates.length,
    skipped,
    errors,
    notes: [],
    apply: async (tx) => {
      for (const { categoryId, v } of creates)
        await mutation(tx, () =>
          tx.service_items.create({
            data: {
              ...base(who),
              category_id: categoryId,
              name: v.name,
              price: v.price,
              unit: v.unit,
            },
          }),
        );
    },
  };
}
async function planGuests(
  tx: Tx,
  who: Parameters<typeof createGuest>[1],
  text: string,
): Promise<Plan> {
  const { rows, errors } = readImport("guests", text);
  const known = await tx.guests.findMany({
    where: { deleted_at: null },
    select: { email: true, phone: true },
  });
  const emails = new Set(
    known.flatMap((g) => (g.email ? [lower(g.email)] : [])),
  );
  const phones = new Set(
    known.flatMap((g) => (g.phone ? [g.phone.replace(/\D/g, "")] : [])),
  );
  const skipped: Plan["skipped"] = [];
  const creates: (typeof rows)[number]["value"][] = [];
  for (const r of rows) {
    const v = r.value;
    const phone = v.phone?.replace(/\D/g, "") ?? "";
    if (
      (v.email && emails.has(v.email)) ||
      (phone.length >= 7 && phones.has(phone))
    ) {
      skipped.push({ row: r.row, reason: `${v.fullName} is already a guest.` });
      continue;
    }
    if (v.email) emails.add(v.email);
    if (phone.length >= 7) phones.add(phone);
    creates.push(v);
  }
  return {
    create: creates.length,
    skipped,
    errors,
    notes: [],
    apply: async (tx) => {
      for (const v of creates) await createGuest(tx, who, v);
    },
  };
}
importer.post(
  "/import/:kind",
  route(async (req, res) => {
    const kind = z.enum(importKinds).parse(req.params.kind);
    const body = z
      .object({ csv: z.string().max(240_000), dryRun: z.boolean() })
      .strict()
      .parse(req.body);
    const who = await identity(req);
    requirePermission(who, permissionFor[kind]);
    const license = await getLicense();
    if (!license.writable || !license.claims)
      throw new HttpError(423, license.reason);
    const maxRooms = license.claims.maxRooms;
    let parseError: string | null = null;
    const result = await scope(
      db,
      { ...who, writable: true },
      async (tx) => {
        // Same per-hotel lock as other commands: quotas and duplicate checks stay true.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${who.tenantId},0))`;
        let plan: Plan;
        try {
          plan =
            kind === "rooms"
              ? await planRooms(tx, who, body.csv, maxRooms)
              : kind === "menu"
                ? await planMenu(tx, who, body.csv)
                : await planGuests(tx, who, body.csv);
        } catch (e) {
          parseError = (e as Error).message;
          return null;
        }
        const summary = {
          kind,
          dryRun: body.dryRun,
          create: plan.create,
          skipped: plan.skipped,
          errors: plan.errors.sort((a, b) => a.row - b.row),
          notes: plan.notes,
          imported: false,
        };
        if (body.dryRun || plan.errors.length || plan.create === 0)
          return summary;
        await plan.apply(tx);
        return { ...summary, imported: true };
      },
      { timeout: 55_000 },
    );
    if (parseError)
      throw new HttpError(400, `The file could not be read: ${parseError}`);
    // Row problems are part of the answer, not a failure: the page lists them.
    res.json(result);
  }),
);
