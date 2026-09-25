import { Router, type Request } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { identity, requirePermission, type Identity } from "./auth.js";
import { db, scope, base, mutation, type Tx } from "./db.js";
import { route, HttpError } from "./http.js";
import { command } from "./commands.js";
import { folioBalance, checkOut } from "./stay-service.js";
import { money } from "../../../packages/core/src/stays.js";
import {
  collect,
  receipt,
  refundReceipt,
  openFolio,
  changeStock,
  positiveMoney,
  tender,
  dec,
  sum,
  type ReceiptSnapshot,
} from "./billing-service.js";
import { getLicense } from "./licensing.js";
export const billing = Router();
const uuid = z.string().uuid(),
  requestFields = { requestId: uuid },
  page = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(30),
  });
const services = ["restaurant", "bar", "laundry", "room_service"];
const canCategory = (who: Identity, name: string) =>
  who.permissions.includes("billing.write") ||
  who.permissions.includes(`services.${name}`);
async function reader(req: Request, p: string) {
  const who = await identity(req);
  requirePermission(who, p);
  return who;
}
async function categoryAccess(req: Request, id: string) {
  const who = await identity(req);
  const c = await scope(db, who, (tx) =>
    tx.service_categories.findFirst({ where: { id, deleted_at: null } }),
  );
  if (!c) throw new HttpError(404, "Category not found.");
  const permission = who.permissions.includes("billing.write")
    ? "billing.write"
    : `services.${c.name}`;
  requirePermission(who, permission);
  return permission;
}
async function cashierPermission(req: Request) {
  const who = await identity(req);
  const p = who.permissions.includes("billing.write")
    ? "billing.write"
    : who.permissions.find((p) => p.startsWith("services."));
  if (!p) throw new HttpError(403, "Cashier permission required.");
  requirePermission(who, p);
  return p;
}
export async function receiptAccess(tx: Tx, who: Identity, id: string) {
  const r = await tx.receipts.findFirst({ where: { id, deleted_at: null } });
  if (!r) throw new HttpError(404, "Receipt not found.");
  if (who.permissions.includes("billing.read")) return r;
  if (r.order_id) {
    const o = await tx.service_orders.findFirstOrThrow({
      where: { id: r.order_id },
      include: { rel_category_id: true },
    });
    if (canCategory(who, o.rel_category_id.name)) return r;
  }
  throw new HttpError(403, "Receipt access denied.");
}
billing.get(
  "/services/catalog",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(
      who,
      who.permissions.includes("billing.read")
        ? "billing.read"
        : (who.permissions.find((p) => p.startsWith("services.")) ??
            "billing.read"),
    );
    res.json(
      await scope(db, who, async (tx) => {
        const categories = await tx.service_categories.findMany({
          where: { deleted_at: null },
          orderBy: { name: "asc" },
        });
        const allowed = categories.filter(
          (c) =>
            who.permissions.includes("billing.read") ||
            canCategory(who, c.name),
        );
        return {
          categories: allowed,
          items: await tx.service_items.findMany({
            where: {
              category_id: { in: allowed.map((c) => c.id) },
              deleted_at: null,
              is_active:
                req.query.includeInactive === "true" &&
                who.permissions.includes("settings.write")
                  ? undefined
                  : true,
            },
            orderBy: { name: "asc" },
            take: 1000,
          }),
        };
      }),
    );
  }),
);
billing.get(
  "/services/room-folios",
  route(async (req, res) => {
    await cashierPermission(req);
    const who = await identity(req);
    res.json(
      await scope(db, who, async (tx) =>
        (
          await tx.reservations.findMany({
            where: { status: "checked_in", deleted_at: null },
            include: {
              rel_room_id: true,
              back_folios_reservation_id: { where: { status: "open" } },
            },
            take: 500,
          })
        ).map((r) => ({
          room: r.rel_room_id?.room_number,
          folioId: r.back_folios_reservation_id[0]?.id,
        })),
      ),
    );
  }),
);
billing.get(
  "/services/orders",
  route(async (req, res) => {
    const who = await identity(req);
    const p = page.extend({ categoryId: uuid }).parse(req.query);
    await categoryAccess(req, p.categoryId);
    res.json(
      await scope(db, who, async (tx) => ({
        items: await tx.service_orders.findMany({
          where: { category_id: p.categoryId, deleted_at: null },
          orderBy: [{ created_at: "desc" }, { id: "asc" }],
          skip: (p.page - 1) * p.pageSize,
          take: p.pageSize,
        }),
        total: await tx.service_orders.count({
          where: { category_id: p.categoryId, deleted_at: null },
        }),
        ...p,
      })),
    );
  }),
);
async function quoteOrder(
  tx: Tx,
  v: { categoryId: string; items: { itemId: string; quantity: string }[] },
) {
  const category = await tx.service_categories.findFirst({
    where: { id: v.categoryId, deleted_at: null },
  });
  if (!category) throw new HttpError(404, "Category not found.");
  const rows = [];
  for (const line of v.items) {
    const item = await tx.service_items.findFirst({
      where: {
        id: line.itemId,
        category_id: v.categoryId,
        is_active: true,
        deleted_at: null,
      },
    });
    if (!item) throw new HttpError(404, "Menu item unavailable.");
    rows.push({
      item,
      quantity: dec(line.quantity),
      subtotal: item.price
        .mul(line.quantity)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
    });
  }
  const net = sum(rows.map((r) => r.subtotal)),
    vat = category.vat_enabled
      ? net.mul(category.vat_rate).div(100).toDecimalPlaces(2)
      : dec(0),
    service = category.service_charge_enabled
      ? net.mul(category.service_charge_rate).div(100).toDecimalPlaces(2)
      : dec(0),
    total = net.plus(vat).plus(service);
  if (total.gt("9999999999.99"))
    throw new HttpError(400, "Order exceeds supported amount.");
  const lines = [
    ...rows.map((r) => ({
      description: `${r.item.name} × ${r.quantity.toString()}`,
      amount: r.subtotal.toFixed(2),
    })),
    { description: "VAT", amount: vat.toFixed(2) },
    { description: "Service charge", amount: service.toFixed(2) },
  ];
  const snapshot = {
    version: 1,
    net: net.toFixed(2),
    vat: vat.toFixed(2),
    service: service.toFixed(2),
    total: total.toFixed(2),
    vatRate: category.vat_rate.toString(),
    serviceRate: category.service_charge_rate.toString(),
    lines,
  };
  return { rows, net, vat, service, total, lines, snapshot };
}

const orderSchema = z
  .object({
    ...requestFields,
    categoryId: uuid,
    folioId: uuid.optional(),
    items: z
      .array(
        z
          .object({
            itemId: uuid,
            quantity: z
              .string()
              .regex(/^\d{1,6}(\.\d{1,3})?$/)
              .refine((v) => dec(v).gt(0)),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    payments: z.array(tender).max(8).default([]),
    expectedTotal: money,
  })
  .strict();
billing.post(
  "/services/quote",
  route(async (req, res) => {
    const v = orderSchema
      .pick({ categoryId: true, items: true })
      .strict()
      .parse(req.body);
    await categoryAccess(req, v.categoryId);
    const who = await identity(req);
    res.json(
      await scope(db, who, async (tx) => (await quoteOrder(tx, v)).snapshot),
    );
  }),
);
billing.post(
  "/services/orders",
  route(async (req, res) => {
    const v = orderSchema.parse(req.body),
      permission = await categoryAccess(req, v.categoryId);
    res.status(201).json(
      await command(req, permission, v, async (tx, who, license) => {
        const category = await tx.service_categories.findFirstOrThrow({
          where: { id: v.categoryId, deleted_at: null },
        });
        if (
          !services.includes(category.name) &&
          !who.permissions.includes("billing.write")
        )
          throw new HttpError(403, "Category access denied.");
        if (new Set(v.items.map((i) => i.itemId)).size !== v.items.length)
          throw new HttpError(
            400,
            "Combine repeated menu items into one line.",
          );
        let roomId: string | undefined;
        if (v.folioId) {
          const f = await openFolio(tx, v.folioId);
          const stay = f.reservation_id
            ? await tx.reservations.findFirst({
                where: { id: f.reservation_id, status: "checked_in" },
              })
            : null;
          if (!stay)
            throw new HttpError(
              409,
              "Room charges require a checked-in guest.",
            );
          roomId = stay.room_id ?? undefined;
          if (v.payments.length)
            throw new HttpError(
              400,
              "Post to the room or collect a walk-in payment, not both.",
            );
        }
        const { rows, total, lines, snapshot } = await quoteOrder(tx, v);
        if (!total.eq(v.expectedTotal))
          throw new HttpError(
            409,
            "The price changed. Request a new quote before confirming.",
          );
        if (!v.folioId && !sum(v.payments.map((p) => p.amount)).eq(total))
          throw new HttpError(
            400,
            `Split payments must equal ${total.toFixed(2)}.`,
          );
        const order = await mutation(tx, () =>
          tx.service_orders.create({
            data: {
              ...base(who),
              category_id: v.categoryId,
              folio_id: v.folioId,
              room_id: roomId,
              ordered_by: who.userId,
              status: "served",
              total,
              idempotency_key: v.requestId,
              price_snapshot: snapshot,
            },
          }),
        );
        for (const r of rows) {
          await mutation(tx, () =>
            tx.service_order_items.create({
              data: {
                ...base(who),
                order_id: order.id,
                service_item_id: r.item.id,
                item_name: r.item.name,
                quantity: r.quantity,
                unit_price: r.item.price,
                subtotal: r.subtotal,
              },
            }),
          );
          if (r.item.track_inventory) {
            if (!r.item.inventory_item_id)
              throw new HttpError(409, "Menu item stock mapping is missing.");
            await changeStock(
              tx,
              who,
              r.item.inventory_item_id,
              r.quantity.mul(r.item.inventory_qty_per_unit).negated(),
              "Service sale",
              order.id,
            );
          }
        }
        if (v.folioId) {
          for (const line of lines) {
            if (dec(line.amount).isZero()) continue;
            await mutation(tx, () =>
              tx.folio_charges.create({
                data: {
                  ...base(who),
                  folio_id: v.folioId!,
                  source_type: "service_order",
                  source_id: order.id,
                  description: `${category.name}: ${line.description}`,
                  amount: line.amount,
                  charged_at: new Date(),
                },
              }),
            );
          }
          return { order, receipt: null };
        }
        const payments = v.payments.length
          ? await collect(
              tx,
              who,
              { order_id: order.id },
              v.payments,
              v.requestId,
            )
          : [];
        return {
          order,
          receipt: await receipt(tx, who, { order_id: order.id }, payments, {
            providerCredit: license.features.provider_credit !== false,
          }),
        };
      }),
    );
  }),
);
billing.post(
  "/services/orders/:id/void",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id),
      v = z
        .object({
          ...requestFields,
          reason: z.string().trim().min(3).max(300),
          restock: z.boolean().default(false),
        })
        .strict()
        .parse(req.body);
    res.json(
      await command(req, "billing.write", v, async (tx, who, license) => {
        const order = await tx.service_orders.findFirst({
          where: { id, deleted_at: null },
        });
        if (!order || order.status !== "served")
          throw new HttpError(409, "Served order not found.");
        if (order.folio_id) {
          await openFolio(tx, order.folio_id);
          const charges = await tx.folio_charges.findMany({
            where: {
              source_type: "service_order",
              source_id: id,
              folio_id: order.folio_id,
            },
          });
          for (const c of charges)
            await mutation(tx, () =>
              tx.folio_charges.create({
                data: {
                  ...base(who),
                  folio_id: c.folio_id,
                  source_type: "order_reversal",
                  source_id: id,
                  description: `Void: ${v.reason}`,
                  amount: c.amount.negated(),
                  charged_at: new Date(),
                  reversal_of_id: c.id,
                },
              }),
            );
        }
        await mutation(tx, () =>
          tx.service_orders.update({
            where: { id },
            data: { status: "cancelled" },
          }),
        );
        const refunds = [];
        if (!order.folio_id) {
          const receipts = await tx.receipts.findMany({
            where: { order_id: id, reversal_of_id: null },
          });
          for (const r of receipts) {
            const p = r.payload as unknown as ReceiptSnapshot;
            if (
              p.payments.length &&
              !(await tx.receipts.findFirst({
                where: { reversal_of_id: r.id },
              }))
            )
              refunds.push(
                await refundReceipt(
                  tx,
                  who,
                  r.id,
                  v.reason,
                  v.requestId,
                  license.features.provider_credit !== false,
                ),
              );
          }
        }
        if (v.restock) {
          const movements = await tx.inventory_movements.findMany({
            where: { reference_id: id, reason: "Service sale" },
          });
          for (const m of movements)
            await changeStock(
              tx,
              who,
              m.item_id,
              m.change_qty.negated(),
              `Void restock: ${v.reason}`,
              id,
            );
        }
        await tx.audit_log.create({
          data: {
            ...base(who),
            user_id: who.userId,
            action: "void",
            entity: "service_orders",
            entity_id: id,
            after: { reason: v.reason, restock: v.restock },
            occurred_at: new Date(),
          },
        });
        return { orderId: id, refunds };
      }),
    );
  }),
);
billing.get(
  "/billing/folios",
  route(async (req, res) => {
    const who = await reader(req, "billing.read");
    const p = page.parse(req.query);
    res.json(
      await scope(db, who, async (tx) => ({
        items: await tx.folios.findMany({
          where: { deleted_at: null, status: "open" },
          include: {
            rel_guest_id: { select: { full_name: true } },
            rel_reservation_id: {
              select: {
                status: true,
                rel_room_id: { select: { room_number: true } },
              },
            },
          },
          take: p.pageSize,
          skip: (p.page - 1) * p.pageSize,
          orderBy: { opened_at: "desc" },
        }),
        total: await tx.folios.count({
          where: { deleted_at: null, status: "open" },
        }),
        ...p,
      })),
    );
  }),
);
billing.post(
  "/billing/folios/:id/pay",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id),
      v = z
        .object({
          ...requestFields,
          payments: z.array(tender).min(1).max(8),
          checkout: z.boolean().default(false),
        })
        .strict()
        .parse(req.body);
    res.json(
      await command(req, "billing.write", v, async (tx, who, license) => {
        const f = await openFolio(tx, id);
        const amount = sum(v.payments.map((p) => p.amount)),
          balance = await folioBalance(tx, id);
        if (amount.gt(balance))
          throw new HttpError(409, "Payment exceeds the outstanding balance.");
        const payments = await collect(
          tx,
          who,
          { folio_id: id },
          v.payments,
          v.requestId,
        );
        const r = await receipt(tx, who, { folio_id: id }, payments, {
          providerCredit: license.features.provider_credit !== false,
        });
        if (v.checkout) {
          if (!f.reservation_id)
            throw new HttpError(409, "Folio has no reservation.");
          await checkOut(tx, who, f.reservation_id);
        }
        return { receipt: r, balance: (await folioBalance(tx, id)).toFixed(2) };
      }),
    );
  }),
);
billing.post(
  "/billing/folios/:id/charge",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id),
      v = z
        .object({
          ...requestFields,
          description: z.string().trim().min(3).max(300),
          amount: positiveMoney,
          discount: z.boolean().default(false),
        })
        .strict()
        .parse(req.body);
    res.status(201).json(
      await command(req, "billing.write", v, async (tx, who) => {
        await openFolio(tx, id);
        if (v.discount) {
          const net =
            (
              await tx.folio_charges.aggregate({
                where: { folio_id: id },
                _sum: { amount: true },
              })
            )._sum.amount ?? dec(0);
          if (dec(v.amount).gt(net))
            throw new HttpError(409, "Discount exceeds total charges.");
        }
        return mutation(tx, () =>
          tx.folio_charges.create({
            data: {
              ...base(who),
              folio_id: id,
              source_type: v.discount ? "discount" : "manual",
              source_id: v.requestId,
              description: v.description,
              amount: v.discount ? dec(v.amount).negated() : dec(v.amount),
              charged_at: new Date(),
            },
          }),
        );
      }),
    );
  }),
);
billing.post(
  "/billing/charges/:id/reverse",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id),
      v = z
        .object({ ...requestFields, reason: z.string().trim().min(3).max(300) })
        .strict()
        .parse(req.body);
    res.json(
      await command(req, "billing.write", v, async (tx, who) => {
        const c = await tx.folio_charges.findFirst({
          where: { id, reversal_of_id: null },
        });
        if (!c || !["manual", "discount"].includes(c.source_type))
          throw new HttpError(
            409,
            "Only manual charges and discounts use this correction. Void service orders from their order screen.",
          );
        await openFolio(tx, c.folio_id);
        return mutation(tx, () =>
          tx.folio_charges.create({
            data: {
              ...base(who),
              folio_id: c.folio_id,
              source_type: "reversal",
              source_id: c.id,
              description: v.reason,
              amount: c.amount.negated(),
              reversal_of_id: c.id,
              charged_at: new Date(),
            },
          }),
        );
      }),
    );
  }),
);
billing.post(
  "/billing/folios/:id/close",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id),
      v = z.object(requestFields).strict().parse(req.body);
    res.json(
      await command(req, "billing.write", v, async (tx, who) => {
        const f = await openFolio(tx, id);
        if (f.reservation_id) return checkOut(tx, who, f.reservation_id);
        if (!(await folioBalance(tx, id)).isZero())
          throw new HttpError(409, "Settle the folio first.");
        return mutation(tx, () =>
          tx.folios.update({
            where: { id },
            data: { status: "closed", closed_at: new Date() },
          }),
        );
      }),
    );
  }),
);
billing.get(
  "/billing/receipts",
  route(async (req, res) => {
    const who = await reader(req, "billing.read"),
      p = page.parse(req.query);
    res.json(
      await scope(db, who, async (tx) => ({
        items: await tx.receipts.findMany({
          where: { deleted_at: null },
          orderBy: [{ created_at: "desc" }, { id: "asc" }],
          take: p.pageSize,
          skip: (p.page - 1) * p.pageSize,
        }),
        total: await tx.receipts.count({ where: { deleted_at: null } }),
        ...p,
      })),
    );
  }),
);
billing.get(
  "/billing/receipts/:id",
  route(async (req, res) => {
    const who = await identity(req),
      id = uuid.parse(req.params.id);
    res.json(
      await scope(db, who, async (tx) => ({
        ...(await receiptAccess(tx, who, id)),
        reprint_count: await tx.receipt_reprints.count({
          where: { receipt_id: id },
        }),
        print_jobs: await tx.print_jobs.findMany({
          where: { receipt_id: id },
          orderBy: { created_at: "desc" },
          take: 50,
        }),
      })),
    );
  }),
);
billing.post(
  "/billing/receipts/:id/reverse",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id),
      v = z
        .object({ ...requestFields, reason: z.string().trim().min(3).max(300) })
        .strict()
        .parse(req.body);
    res.json(
      await command(req, "billing.write", v, async (tx, who, license) => {
        const r = await tx.receipts.findFirst({ where: { id } });
        if (r?.order_id)
          throw new HttpError(
            409,
            "Void the walk-in order to refund its receipt.",
          );
        return refundReceipt(
          tx,
          who,
          id,
          v.reason,
          v.requestId,
          license.features.provider_credit !== false,
        );
      }),
    );
  }),
);
billing.get(
  "/billing/shift",
  route(async (req, res) => {
    await cashierPermission(req);
    const who = await identity(req);
    res.json(
      await scope(db, who, async (tx) => {
        const shift = await tx.shifts.findFirst({
          where: { user_id: who.userId, closed_at: null, deleted_at: null },
        });
        return {
          shift,
          expected: shift
            ? shift.opening_float
                .plus(
                  (
                    await tx.payments.aggregate({
                      where: { shift_id: shift.id, method: "cash" },
                      _sum: { amount: true },
                    })
                  )._sum.amount ?? 0,
                )
                .toFixed(2)
            : null,
        };
      }),
    );
  }),
);
billing.post(
  "/billing/shift/open",
  route(async (req, res) => {
    const p = await cashierPermission(req),
      v = z
        .object({ ...requestFields, openingFloat: money })
        .strict()
        .parse(req.body);
    res.status(201).json(
      await command(req, p, v, (tx, who) =>
        mutation(tx, () =>
          tx.shifts.create({
            data: {
              ...base(who),
              user_id: who.userId,
              opened_at: new Date(),
              opening_float: v.openingFloat,
            },
          }),
        ),
      ),
    );
  }),
);
billing.post(
  "/billing/shift/close",
  route(async (req, res) => {
    const p = await cashierPermission(req),
      v = z
        .object({ ...requestFields, closingCash: money })
        .strict()
        .parse(req.body);
    res.json(
      await command(req, p, v, async (tx, who) => {
        const shift = await tx.shifts.findFirst({
          where: { user_id: who.userId, closed_at: null, deleted_at: null },
        });
        if (!shift) throw new HttpError(409, "No open shift.");
        const cash =
          (
            await tx.payments.aggregate({
              where: { shift_id: shift.id, method: "cash" },
              _sum: { amount: true },
            })
          )._sum.amount ?? dec(0);
        return mutation(tx, () =>
          tx.shifts.update({
            where: { id: shift.id },
            data: {
              closing_cash: v.closingCash,
              closed_at: new Date(),
              variance: dec(v.closingCash)
                .minus(shift.opening_float)
                .minus(cash),
            },
          }),
        );
      }),
    );
  }),
);
billing.get(
  "/billing/folios/:id/invoice",
  route(async (req, res) => {
    const who = await reader(req, "billing.read"),
      id = uuid.parse(req.params.id);
    res.json(
      await scope(db, who, async (tx) => {
        const f = await tx.folios.findFirst({
          where: { id, deleted_at: null },
          include: { rel_guest_id: true },
        });
        if (!f) throw new HttpError(404, "Folio not found.");
        const hotel = await tx.tenants.findUniqueOrThrow({
            where: { id: who.tenantId },
          }),
          settings = await tx.settings.findMany({
            where: { key: { in: ["branding", "receipt_footer"] } },
          });
        const branding = (settings.find((s) => s.key === "branding")?.value ??
          hotel.branding) as Record<string, string>;
        const footer = settings.find((s) => s.key === "receipt_footer")
          ?.value as { text?: string } | undefined;
        const lines = (
          await tx.folio_charges.findMany({
            where: { folio_id: id },
            orderBy: [{ charged_at: "asc" }, { id: "asc" }],
          })
        ).map((c) => ({
          description: c.description,
          amount: c.amount.toFixed(2),
        }));
        const payments = await tx.payments.findMany({
          where: { folio_id: id },
          orderBy: { paid_at: "asc" },
        });
        return {
          version: 1,
          kind: "invoice",
          number: `FOLIO-${id}`,
          issuedAt: new Date().toISOString(),
          hotel: {
            name: branding.name || hotel.name,
            address: branding.address || "",
            logoUrl: branding.logoUrl || "",
            currency: hotel.currency,
            symbol: hotel.currency_symbol,
            footer: footer?.text || "",
            providerCredit:
              (await getLicense()).claims?.features.provider_credit !== false,
          },
          cashier: (
            await tx.users.findFirstOrThrow({ where: { id: who.userId } })
          ).name,
          customer: f.rel_guest_id.full_name,
          lines,
          payments: payments.map((p) => ({
            id: p.id,
            amount: p.amount.toFixed(2),
            method: p.method,
            reference: p.reference,
          })),
          total: sum(lines.map((c) => c.amount)).toFixed(2),
          paid: sum(payments.map((p) => p.amount)).toFixed(2),
          balance: (await folioBalance(tx, id)).toFixed(2),
        };
      }),
    );
  }),
);
