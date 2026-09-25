import { Router } from "express";
import { z } from "zod";
import { identity, requirePermission } from "./auth.js";
import { db, scope, base, mutation } from "./db.js";
import { route, HttpError } from "./http.js";
import { command } from "./commands.js";
import { changeStock, dec } from "./billing-service.js";
import { money } from "../../../packages/core/src/stays.js";
export const operations = Router();
const uuid = z.string().uuid(),
  requestFields = { requestId: uuid },
  qty = z.string().regex(/^\d{1,8}(\.\d{1,3})?$/),
  pager = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(30),
  });
operations.get(
  "/inventory",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "inventory.read");
    const p = pager.parse(req.query);
    res.json(
      await scope(db, who, async (tx) => ({
        items: (
          await tx.inventory_items.findMany({
            where: { deleted_at: null },
            orderBy: { name: "asc" },
            take: p.pageSize,
            skip: (p.page - 1) * p.pageSize,
          })
        ).map((i) => ({
          ...i,
          lowStock: i.quantity_on_hand.lte(i.reorder_level),
        })),
        total: await tx.inventory_items.count({ where: { deleted_at: null } }),
        ...p,
      })),
    );
  }),
);
operations.post(
  "/inventory",
  route(async (req, res) => {
    const v = z
      .object({
        ...requestFields,
        name: z.string().trim().min(2).max(100),
        unit: z.string().min(1).max(30),
        category: z.string().min(1).max(50),
        reorderLevel: qty,
      })
      .strict()
      .parse(req.body);
    res
      .status(201)
      .json(
        await command(req, "inventory.write", v, (tx, who) =>
          mutation(tx, () =>
            tx.inventory_items.create({
              data: {
                ...base(who),
                name: v.name,
                unit: v.unit,
                category: v.category,
                reorder_level: v.reorderLevel,
              },
            }),
          ),
        ),
      );
  }),
);
operations.post(
  "/inventory/:id/adjust",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id),
      v = z
        .object({
          ...requestFields,
          change: z
            .string()
            .regex(/^-?\d{1,8}(\.\d{1,3})?$/)
            .refine((v) => !dec(v).isZero()),
          reason: z.string().trim().min(3).max(300),
        })
        .strict()
        .parse(req.body);
    res.json(
      await command(req, "inventory.write", v, async (tx, who) => {
        await changeStock(tx, who, id, dec(v.change), v.reason, v.requestId);
        return { id };
      }),
    );
  }),
);
operations.get(
  "/inventory/:id/movements",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "inventory.read");
    const id = uuid.parse(req.params.id),
      p = pager.parse(req.query);
    res.json(
      await scope(db, who, (tx) =>
        tx.inventory_movements.findMany({
          where: { item_id: id },
          orderBy: { created_at: "desc" },
          take: p.pageSize,
          skip: (p.page - 1) * p.pageSize,
        }),
      ),
    );
  }),
);
operations.post(
  "/services/items",
  route(async (req, res) => {
    const v = z
      .object({
        ...requestFields,
        categoryId: uuid,
        name: z.string().trim().min(2).max(100),
        price: money,
        unit: z.string().min(1).max(30),
        inventoryItemId: uuid.optional(),
        stockPerUnit: qty.default("1"),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(
      await command(req, "settings.write", v, async (tx, who) => {
        if (dec(v.stockPerUnit).lte(0))
          throw new HttpError(400, "Stock per unit must be positive.");
        if (
          !(await tx.service_categories.findFirst({
            where: { id: v.categoryId, deleted_at: null },
          }))
        )
          throw new HttpError(404, "Category not found.");
        if (
          v.inventoryItemId &&
          !(await tx.inventory_items.findFirst({
            where: { id: v.inventoryItemId, deleted_at: null },
          }))
        )
          throw new HttpError(404, "Stock item not found.");
        return mutation(tx, () =>
          tx.service_items.create({
            data: {
              ...base(who),
              category_id: v.categoryId,
              name: v.name,
              price: v.price,
              unit: v.unit,
              track_inventory: !!v.inventoryItemId,
              inventory_item_id: v.inventoryItemId,
              inventory_qty_per_unit: v.stockPerUnit,
            },
          }),
        );
      }),
    );
  }),
);
operations.patch(
  "/services/items/:id",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id),
      v = z
        .object({
          ...requestFields,
          price: money.optional(),
          isActive: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
    res.json(
      await command(req, "settings.write", v, async (tx) => {
        if (
          !(await tx.service_items.findFirst({
            where: { id, deleted_at: null },
          }))
        )
          throw new HttpError(404, "Item not found.");
        return mutation(tx, () =>
          tx.service_items.update({
            where: { id },
            data: { price: v.price, is_active: v.isActive },
          }),
        );
      }),
    );
  }),
);
operations.patch(
  "/services/categories/:id/tax",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id),
      percent = z
        .string()
        .regex(/^\d{1,3}(\.\d{1,3})?$/)
        .refine((v) => dec(v).lte(100)),
      v = z
        .object({
          ...requestFields,
          vatEnabled: z.boolean(),
          serviceEnabled: z.boolean(),
          vatRate: percent,
          serviceRate: percent,
        })
        .strict()
        .parse(req.body);
    res.json(
      await command(req, "settings.write", v, async (tx) => {
        if (
          !(await tx.service_categories.findFirst({
            where: { id, deleted_at: null },
          }))
        )
          throw new HttpError(404, "Category not found.");
        return mutation(tx, () =>
          tx.service_categories.update({
            where: { id },
            data: {
              vat_enabled: v.vatEnabled,
              service_charge_enabled: v.serviceEnabled,
              vat_rate: v.vatRate,
              service_charge_rate: v.serviceRate,
            },
          }),
        );
      }),
    );
  }),
);
operations.get(
  "/housekeeping",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "housekeeping.read");
    res.json(
      await scope(db, who, async (tx) => ({
        rooms: await tx.rooms.findMany({
          where: { deleted_at: null },
          select: { id: true, room_number: true, status: true },
          orderBy: { room_number: "asc" },
          take: 500,
        }),
        staff: await tx.users.findMany({
          where: { deleted_at: null, is_active: true },
          select: { id: true, name: true },
          take: 500,
        }),
        tasks: await tx.housekeeping_tasks.findMany({
          where: { deleted_at: null, status: { not: "completed" } },
          include: {
            rel_room_id: { select: { room_number: true } },
            rel_assigned_to: { select: { name: true } },
          },
          orderBy: { created_at: "asc" },
          take: 100,
        }),
      })),
    );
  }),
);
operations.post(
  "/housekeeping",
  route(async (req, res) => {
    const v = z
      .object({
        ...requestFields,
        roomId: uuid,
        assignedTo: uuid,
        type: z.enum(["cleaning", "maintenance"]),
        notes: z.string().max(1000).default(""),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(
      await command(req, "housekeeping.write", v, async (tx, who) => {
        if (
          !(await tx.rooms.findFirst({
            where: { id: v.roomId, deleted_at: null },
          })) ||
          !(await tx.users.findFirst({
            where: { id: v.assignedTo, is_active: true, deleted_at: null },
          }))
        )
          throw new HttpError(404, "Room or staff member unavailable.");
        return mutation(tx, () =>
          tx.housekeeping_tasks.create({
            data: {
              ...base(who),
              room_id: v.roomId,
              assigned_to: v.assignedTo,
              type: v.type,
              notes: v.notes,
            },
          }),
        );
      }),
    );
  }),
);
operations.post(
  "/housekeeping/:id/complete",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id),
      v = z
        .object({
          ...requestFields,
          status: z.enum(["available", "maintenance"]),
          notes: z.string().max(1000),
        })
        .strict()
        .parse(req.body);
    res.json(
      await command(req, "housekeeping.write", v, async (tx) => {
        const task = await tx.housekeeping_tasks.findFirst({
          where: { id, deleted_at: null },
        });
        if (!task) throw new HttpError(404, "Task not found.");
        if (task.status === "completed") return task;
        const room = await tx.rooms.findFirstOrThrow({
          where: { id: task.room_id },
        });
        if (
          room.status === "occupied" ||
          (await tx.reservations.findFirst({
            where: { room_id: room.id, status: "checked_in", deleted_at: null },
          }))
        )
          throw new HttpError(
            409,
            "Check the guest out before marking the room available or under maintenance.",
          );
        await mutation(tx, () =>
          tx.rooms.update({
            where: { id: room.id },
            data: { status: v.status },
          }),
        );
        return mutation(tx, () =>
          tx.housekeeping_tasks.update({
            where: { id },
            data: {
              status: "completed",
              notes: v.notes,
              completed_at: new Date(),
            },
          }),
        );
      }),
    );
  }),
);
