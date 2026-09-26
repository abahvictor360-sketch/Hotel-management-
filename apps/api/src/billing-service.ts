import { Prisma } from "@prisma/client";
import { z } from "zod";
import { base, mutation, type Tx } from "./db.js";
import type { Identity } from "./auth.js";
import { HttpError } from "./http.js";
import { folioBalance } from "./stay-service.js";
import { money } from "../../../packages/core/src/stays.js";
import { readBranding } from "../../../packages/core/src/branding.js";
export const positiveMoney = money.refine(
  (v) => new Prisma.Decimal(v).gt(0),
  "Amount must be positive.",
);
export const tender = z
  .object({
    method: z.enum(["cash", "pos", "transfer"]),
    amount: positiveMoney,
    reference: z.string().trim().max(100).optional(),
  })
  .strict()
  .refine(
    (v) => v.method === "cash" || !!v.reference,
    "POS and transfer require a reference.",
  );
export type Tender = z.infer<typeof tender>;
export const dec = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
export const sum = (v: Prisma.Decimal.Value[]) =>
  v.reduce<Prisma.Decimal>((a, b) => a.plus(b), dec(0));
export async function openFolio(tx: Tx, id: string) {
  const f = await tx.folios.findFirst({
    where: { id, deleted_at: null, status: "open" },
  });
  if (!f) throw new HttpError(409, "Open folio not found.");
  await tx.$queryRaw`SELECT id FROM folios WHERE id=${id}::uuid FOR UPDATE`;
  return f;
}
export async function activeShift(tx: Tx, who: Identity) {
  const shift = await tx.shifts.findFirst({
    where: { user_id: who.userId, closed_at: null, deleted_at: null },
  });
  if (!shift)
    throw new HttpError(
      409,
      "Open your cashier shift before collecting or refunding money.",
    );
  return shift;
}
export async function collect(
  tx: Tx,
  who: Identity,
  target: { folio_id?: string; order_id?: string },
  parts: Tender[],
  requestId: string,
) {
  const shift = await activeShift(tx, who);
  const result = [];
  for (const [i, p] of parts.entries())
    result.push(
      await mutation(tx, () =>
        tx.payments.create({
          data: {
            ...base(who),
            ...target,
            amount: p.amount,
            method: p.method,
            reference: p.reference,
            received_by: who.userId,
            paid_at: new Date(),
            shift_id: shift.id,
            idempotency_key: `${requestId}:${i}`,
          },
        }),
      ),
    );
  return result;
}
// Hotel details a receipt keeps. A receipt stores only a file path logo: an uploaded logo
// lives in the branding setting and is shown from there, so it is not copied into every
// receipt row.
export function receiptHotel(b: ReturnType<typeof readBranding>) {
  return {
    name: b.name,
    address: b.address,
    logoUrl: b.logoUrl.startsWith("/assets/") ? b.logoUrl : "",
    phone: b.phone,
    email: b.email,
    website: b.website,
  };
}
export type ReceiptSnapshot = {
  version: 1;
  kind: "payment" | "refund";
  number: string;
  issuedAt: string;
  hotel: {
    name: string;
    address: string;
    logoUrl: string;
    phone?: string;
    email?: string;
    website?: string;
    currency: string;
    symbol: string;
    footer: string;
    providerCredit: boolean;
  };
  cashier: string;
  customer: string;
  lines: { description: string; amount: string }[];
  payments: {
    id: string;
    amount: string;
    method: string;
    reference: string | null;
  }[];
  total: string;
  paid: string;
  balance: string;
  originalReceipt?: string;
};
export async function receipt(
  tx: Tx,
  who: Identity,
  target: { folio_id?: string; order_id?: string },
  payments: Awaited<ReturnType<typeof collect>>,
  options: { providerCredit: boolean; reversalOf?: string },
): Promise<{ id: string; receipt_number: string; payload: Prisma.JsonValue }> {
  const tenant = await tx.tenants.findUniqueOrThrow({
    where: { id: who.tenantId },
  });
  const settings = await tx.settings.findMany({
    where: { key: { in: ["branding", "receipt_footer"] }, deleted_at: null },
  });
  const branding = readBranding(
    settings.find((s) => s.key === "branding")?.value ?? tenant.branding,
    tenant.name,
  );
  const footer = (settings.find((s) => s.key === "receipt_footer")?.value ??
    {}) as Record<string, string>;
  const cashier = await tx.users.findFirstOrThrow({
    where: { id: who.userId },
  });
  const counter = await tx.receipt_counters.findFirst({
    where: { counter_device: who.deviceId ?? "hub" },
  });
  const sequence = counter?.next_number ?? 1;
  await mutation(tx, () =>
    counter
      ? tx.receipt_counters.update({
          where: { id: counter.id },
          data: { next_number: { increment: 1 } },
        })
      : tx.receipt_counters.create({
          data: {
            ...base(who),
            counter_device: who.deviceId ?? "hub",
            next_number: 2,
          },
        }),
  );
  const number = `${who.deviceId ?? "hub"}-${String(sequence).padStart(8, "0")}`;
  let lines: ReceiptSnapshot["lines"] = [],
    customer = "Walk-in customer",
    balance = "0.00";
  if (target.folio_id) {
    const folio = await tx.folios.findFirstOrThrow({
      where: { id: target.folio_id },
      include: { rel_guest_id: true },
    });
    customer = folio.rel_guest_id.full_name;
    lines = (
      await tx.folio_charges.findMany({
        where: { folio_id: folio.id },
        orderBy: [{ charged_at: "asc" }, { id: "asc" }],
      })
    ).map((c) => ({ description: c.description, amount: c.amount.toFixed(2) }));
    balance = (await folioBalance(tx, folio.id)).toFixed(2);
  } else {
    const order = await tx.service_orders.findFirstOrThrow({
      where: { id: target.order_id },
    });
    const snapshot = order.price_snapshot as {
      lines: ReceiptSnapshot["lines"];
    };
    lines = snapshot.lines;
    balance = dec(order.status === "cancelled" ? 0 : order.total)
      .minus(
        (
          await tx.payments.aggregate({
            where: { order_id: order.id },
            _sum: { amount: true },
          })
        )._sum.amount ?? 0,
      )
      .toFixed(2);
  }
  const payload: ReceiptSnapshot = {
    version: 1,
    kind: options.reversalOf ? "refund" : "payment",
    number,
    issuedAt: new Date().toISOString(),
    hotel: {
      ...receiptHotel(branding),
      currency: tenant.currency,
      symbol: tenant.currency_symbol,
      footer: footer.text || "Thank you for visiting.",
      providerCredit: options.providerCredit,
    },
    cashier: cashier.name,
    customer,
    lines,
    payments: payments.map((p) => ({
      id: p.id,
      amount: p.amount.toFixed(2),
      method: p.method,
      reference: p.reference,
    })),
    total: sum(lines.map((l) => l.amount)).toFixed(2),
    paid: sum(payments.map((p) => p.amount)).toFixed(2),
    balance,
    ...(options.reversalOf ? { originalReceipt: options.reversalOf } : {}),
  };
  return mutation(tx, () =>
    tx.receipts.create({
      data: {
        ...base(who),
        ...target,
        receipt_number: number,
        payload: payload as unknown as Prisma.InputJsonValue,
        reversal_of_id: options.reversalOf,
      },
    }),
  );
}
export async function refundReceipt(
  tx: Tx,
  who: Identity,
  id: string,
  reason: string,
  requestId: string,
  providerCredit: boolean,
) {
  const original = await tx.receipts.findFirst({
    where: { id, deleted_at: null },
  });
  if (!original || original.reversal_of_id)
    throw new HttpError(404, "Original receipt not found.");
  if (await tx.receipts.findFirst({ where: { reversal_of_id: id } }))
    throw new HttpError(409, "Receipt already reversed.");
  if (original.folio_id) await openFolio(tx, original.folio_id);
  const shift = await activeShift(tx, who);
  const snapshot = original.payload as unknown as ReceiptSnapshot;
  const ids = snapshot.payments.map((p) => p.id);
  if (!ids.length)
    throw new HttpError(409, "Receipt has no payments to reverse.");
  const originals = await tx.payments.findMany({
    where: { id: { in: ids }, reversal_of_id: null },
  });
  if (originals.length !== ids.length)
    throw new HttpError(409, "Receipt payment history is incomplete.");
  const refunds = [];
  for (const p of originals) {
    if (await tx.payments.findFirst({ where: { reversal_of_id: p.id } }))
      throw new HttpError(409, "A payment was already reversed.");
    refunds.push(
      await mutation(tx, () =>
        tx.payments.create({
          data: {
            ...base(who),
            folio_id: p.folio_id,
            order_id: p.order_id,
            amount: p.amount.negated(),
            method: p.method,
            reference: reason,
            received_by: who.userId,
            paid_at: new Date(),
            reversal_of_id: p.id,
            idempotency_key: `${requestId}:${p.id}`,
            shift_id: shift.id,
          },
        }),
      ),
    );
  }
  return receipt(
    tx,
    who,
    {
      ...(original.folio_id
        ? { folio_id: original.folio_id }
        : { order_id: original.order_id! }),
    },
    refunds,
    { providerCredit, reversalOf: id },
  );
}
export async function changeStock(
  tx: Tx,
  who: Identity,
  itemId: string,
  change: Prisma.Decimal,
  reason: string,
  referenceId?: string,
) {
  const item = await tx.inventory_items.findFirst({
    where: { id: itemId, deleted_at: null },
  });
  if (!item) throw new HttpError(404, "Stock item not found.");
  const next = item.quantity_on_hand.plus(change);
  if (next.lt(0)) throw new HttpError(409, `Insufficient stock: ${item.name}.`);
  await mutation(tx, () =>
    tx.inventory_items.update({
      where: { id: item.id },
      data: { quantity_on_hand: next },
    }),
  );
  await mutation(tx, () =>
    tx.inventory_movements.create({
      data: {
        ...base(who),
        item_id: item.id,
        change_qty: change,
        reason,
        reference_id: referenceId,
        moved_by: who.userId,
      },
    }),
  );
}
