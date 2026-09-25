import { Router } from "express";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Prisma, type online_bookings } from "@prisma/client";
import { identity, requirePermission, type Identity } from "./auth.js";
import { db, scope, base, mutation, type Tx } from "./db.js";
import { route, HttpError } from "./http.js";
import { command } from "./commands.js";
import { env } from "./config.js";
import { getLicense } from "./licensing.js";
import {
  applyOnlinePayments,
  createBooking,
  freeRooms,
  todayAt,
} from "./stay-service.js";
import {
  BOOKING_SETTING,
  bookingPayload,
  gatewayNames,
  paymentModes,
  readBookingSettings,
  renderMessage,
  type BookingPayload,
  type MessageKind,
} from "../../../packages/core/src/booking.js";
import { sealForCloud, gatewayAad } from "../../../packages/core/src/crypto.js";
// Hub side of online booking. Website bookings arrive by sync as pending requests; staff
// confirm them into real reservations (a free room, the quoted price, any verified online
// payment on the folio) or reject them. The decision syncs back to the cloud, which
// releases the allotment and messages the guest.
export const onlineBookings = Router();
const uuid = z.string().uuid();
const requestFields = { requestId: uuid };
// The cloud's public key. Gateway secrets are sealed with it and never readable here.
const sealingKey = (() => {
  try {
    return env.CLOUD_SEALING_PUBLIC_KEY_FILE
      ? readFileSync(env.CLOUD_SEALING_PUBLIC_KEY_FILE, "utf8")
      : null;
  } catch {
    return null;
  }
})();
const publicBase = () =>
  env.CLOUD_PUBLIC_URL?.replace(/\/$/, "") ??
  env.CLOUD_DASHBOARD_URL?.replace(/\/dashboard\/?$/, "") ??
  null;
const adminOnly = (who: Identity) => {
  if (who.roleName !== "admin")
    throw new HttpError(403, "Only administrators can change online booking.");
};
async function paymentState(tx: Tx, bookingId: string) {
  const rows = await tx.payment_transactions.findMany({
    where: { online_booking_id: bookingId, deleted_at: null },
    orderBy: { created_at: "asc" },
  });
  const paid = rows.filter((r) => r.status === "success");
  return {
    paid: paid.length > 0,
    paidAmount: paid
      .reduce((a, r) => a.plus(r.amount), new Prisma.Decimal(0))
      .toFixed(2),
    attempts: rows.length,
    mismatch: rows.some((r) => r.status === "mismatch"),
  };
}
function view(
  b: online_bookings,
  pay: Awaited<ReturnType<typeof paymentState>>,
) {
  const p = bookingPayload.safeParse(b.payload);
  if (!p.success)
    return {
      id: b.id,
      reference: b.external_reference,
      status: b.status,
      invalid: true,
    };
  const d = p.data;
  const expired =
    b.status === "pending" &&
    d.paymentMode === "required" &&
    !pay.paid &&
    Date.parse(d.holdUntil) < Date.now();
  return {
    id: b.id,
    reference: b.external_reference,
    status: b.status,
    receivedAt: b.created_at,
    guest: d.guest,
    roomTypeId: d.roomTypeId,
    roomType: d.roomTypeName,
    checkIn: d.checkIn,
    checkOut: d.checkOut,
    nights: d.price.nights,
    adults: d.adults,
    children: d.children,
    notes: d.notes ?? null,
    total: d.price.total,
    currency: d.currency,
    paymentMode: d.paymentMode,
    payment: pay.paid
      ? "paid"
      : d.paymentMode === "none"
        ? "at_hotel"
        : "unpaid",
    paidAmount: pay.paidAmount,
    paymentMismatch: pay.mismatch,
    holdUntil: d.holdUntil,
    expired,
    refundDue: pay.paid && ["rejected", "cancelled"].includes(b.status),
    reservationId: b.matched_reservation_id,
    decision: d.decision ?? null,
  };
}
async function message(
  tx: Tx,
  who: Identity,
  b: online_bookings,
  p: BookingPayload,
  kind: MessageKind,
  extra: { reason?: string; paid?: boolean } = {},
) {
  const tenant = await tx.tenants.findUniqueOrThrow({
    where: { id: who.tenantId },
  });
  const branding = (
    await tx.settings.findFirst({
      where: { key: "branding", deleted_at: null },
    })
  )?.value as { name?: string } | undefined;
  const base_ = publicBase();
  const msg = renderMessage(kind, {
    hotel: branding?.name || tenant.name,
    reference: b.external_reference,
    guest: p.guest.fullName,
    checkIn: p.checkIn,
    checkOut: p.checkOut,
    roomType: p.roomTypeName,
    total: p.price.total,
    currency: p.currency,
    statusUrl: base_
      ? `${base_}/book/${tenant.slug}/status?ref=${encodeURIComponent(b.external_reference)}`
      : undefined,
    ...extra,
  });
  // Written here, delivered by the cloud once this row syncs.
  await mutation(tx, () =>
    tx.notifications.create({
      data: {
        ...base(who),
        online_booking_id: b.id,
        channel: "email",
        destination: p.guest.email,
        payload: { kind, reference: b.external_reference, ...msg },
      },
    }),
  );
}
async function pendingBooking(tx: Tx, id: string) {
  const b = await tx.online_bookings.findFirst({
    where: { id, deleted_at: null },
  });
  if (!b) throw new HttpError(404, "Online booking not found.");
  if (b.status !== "pending")
    throw new HttpError(409, `This booking is already ${b.status}.`);
  const p = bookingPayload.safeParse(b.payload);
  if (!p.success)
    throw new HttpError(
      409,
      "This booking request is incomplete. Reject it and contact the guest.",
    );
  return { b, p: p.data };
}
onlineBookings.get(
  "/online-bookings",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "frontdesk.read");
    const q = z
      .object({
        status: z
          .enum(["pending", "confirmed", "rejected", "cancelled"])
          .default("pending"),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(req.query);
    res.json(
      await scope(db, who, async (tx) => {
        const where = { status: q.status, deleted_at: null };
        const rows = await tx.online_bookings.findMany({
          where,
          orderBy:
            q.status === "pending"
              ? { created_at: "asc" }
              : { updated_at: "desc" },
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        });
        const out = [];
        for (const b of rows) out.push(view(b, await paymentState(tx, b.id)));
        return {
          rows: out,
          total: await tx.online_bookings.count({ where }),
          pending: await tx.online_bookings.count({
            where: { status: "pending", deleted_at: null },
          }),
          ...q,
        };
      }),
    );
  }),
);
onlineBookings.get(
  "/online-bookings/:id/rooms",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "frontdesk.read");
    const id = uuid.parse(req.params.id);
    res.json(
      await scope(db, who, async (tx) => {
        const { p } = await pendingBooking(tx, id);
        return (
          await freeRooms(tx, who.tenantId, p.roomTypeId, p.checkIn, p.checkOut)
        ).map((r) => ({
          id: r.id,
          roomNumber: r.room_number,
          status: r.status,
        }));
      }),
    );
  }),
);
onlineBookings.post(
  "/online-bookings/:id/confirm",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const input = z
      .object({ ...requestFields, roomId: uuid.optional() })
      .strict()
      .parse(req.body);
    res.json(
      await command(req, "frontdesk.write", input, async (tx, who) => {
        const { b, p } = await pendingBooking(tx, id);
        const pay = await paymentState(tx, b.id);
        if (
          p.paymentMode === "required" &&
          !pay.paid &&
          Date.parse(p.holdUntil) < Date.now()
        )
          throw new HttpError(
            409,
            "Payment was required and never arrived. Reject this booking.",
          );
        if (p.checkIn < (await todayAt(tx, who.tenantId)))
          throw new HttpError(
            409,
            "The arrival date has passed. Reject this booking or contact the guest.",
          );
        // Returning guests are matched on email, so their history stays in one record.
        const guest = await tx.guests.findFirst({
          where: {
            email: { equals: p.guest.email, mode: "insensitive" },
            deleted_at: null,
          },
          orderBy: { created_at: "asc" },
        });
        const stay = await createBooking(tx, who, {
          guestId: guest?.id,
          guest: guest
            ? undefined
            : {
                fullName: p.guest.fullName,
                email: p.guest.email,
                phone: p.guest.phone,
              },
          roomTypeId: p.roomTypeId,
          roomId: input.roomId,
          checkInDate: p.checkIn,
          checkOutDate: p.checkOut,
          adults: p.adults,
          children: p.children,
          source: "online",
          notes: [`Online booking ${b.external_reference}`, p.notes]
            .filter(Boolean)
            .join(". "),
          price: p.price,
          cloudBookingId: b.id,
        });
        const applied = await applyOnlinePayments(tx, who, b.id, stay.folioId);
        const decided = {
          ...p,
          decision: {
            at: new Date().toISOString(),
            by: who.userId,
            roomNumber: stay.roomNumber,
          },
        };
        await mutation(tx, () =>
          tx.online_bookings.update({
            where: { id: b.id },
            data: {
              status: "confirmed",
              matched_reservation_id: stay.id,
              payload: decided,
              notification_status: "queued",
            },
          }),
        );
        await message(tx, who, b, p, "booking_confirmed", { paid: pay.paid });
        return {
          reservationId: stay.id,
          roomNumber: stay.roomNumber,
          folioId: stay.folioId,
          paymentsApplied: applied.length,
        };
      }),
    );
  }),
);
onlineBookings.post(
  "/online-bookings/:id/reject",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const input = z
      .object({ ...requestFields, reason: z.string().trim().min(3).max(300) })
      .strict()
      .parse(req.body);
    res.json(
      await command(req, "frontdesk.write", input, async (tx, who) => {
        const { b, p } = await pendingBooking(tx, id);
        const pay = await paymentState(tx, b.id);
        await mutation(tx, () =>
          tx.online_bookings.update({
            where: { id: b.id },
            data: {
              status: "rejected",
              payload: {
                ...p,
                decision: {
                  at: new Date().toISOString(),
                  by: who.userId,
                  reason: input.reason,
                },
              },
              notification_status: "queued",
            },
          }),
        );
        await message(tx, who, b, p, "booking_rejected", {
          reason: input.reason,
          paid: pay.paid,
        });
        return { id: b.id, status: "rejected", refundDue: pay.paid };
      }),
    );
  }),
);
// Called when staff cancel a reservation that came from the website: the allotment is
// released in the cloud and the guest is told.
export async function cancelOnlineBooking(
  tx: Tx,
  who: Identity,
  bookingId: string,
  reason: string,
) {
  const b = await tx.online_bookings.findFirst({
    where: { id: bookingId, deleted_at: null },
  });
  const p = b ? bookingPayload.safeParse(b.payload) : null;
  if (!b || !p?.success || b.status !== "confirmed") return;
  const pay = await paymentState(tx, b.id);
  await mutation(tx, () =>
    tx.online_bookings.update({
      where: { id: b.id },
      data: {
        status: "cancelled",
        payload: {
          ...p.data,
          decision: {
            ...p.data.decision,
            at: new Date().toISOString(),
            by: who.userId,
            reason,
          },
        },
      },
    }),
  );
  await message(tx, who, b, p.data, "booking_cancelled", {
    reason,
    paid: pay.paid,
  });
}

// Settings: website on/off, payment policy, gateway keys and per-room-type allotment.
onlineBookings.get(
  "/online-booking/settings",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "settings.write");
    const license = await getLicense();
    res.json(
      await scope(db, who, async (tx) => {
        const row = await tx.settings.findFirst({
          where: { key: BOOKING_SETTING, deleted_at: null },
        });
        const s = readBookingSettings(row?.value);
        const tenant = await tx.tenants.findUniqueOrThrow({
          where: { id: who.tenantId },
        });
        const types = await tx.room_types.findMany({
          where: { deleted_at: null },
          orderBy: { name: "asc" },
        });
        const rooms = await tx.rooms.groupBy({
          by: ["room_type_id"],
          where: { deleted_at: null },
          _count: true,
        });
        const b = publicBase();
        return {
          enabled: s.enabled,
          paymentMode: s.paymentMode,
          holdMinutes: s.holdMinutes,
          maxAdvanceDays: s.maxAdvanceDays,
          policy: s.policy,
          gateway: s.gateway
            ? {
                name: s.gateway.name,
                publicKey: s.gateway.publicKey,
                hint: s.gateway.hint,
                updatedAt: s.gateway.updatedAt,
              }
            : null,
          planIncludes: license.claims?.features.online_booking === true,
          sealingAvailable: !!sealingKey,
          bookingUrl: b ? `${b}/book/${tenant.slug}` : null,
          webhookUrls: b
            ? Object.fromEntries(
                gatewayNames.map((g) => [
                  g,
                  `${b}/api/public/webhooks/${g}/${tenant.slug}`,
                ]),
              )
            : null,
          roomTypes: types.map((t) => ({
            id: t.id,
            name: t.name,
            rooms: rooms.find((r) => r.room_type_id === t.id)?._count ?? 0,
            onlineAllotment: t.online_allotment,
          })),
        };
      }),
    );
  }),
);
const settingsInput = z
  .object({
    enabled: z.boolean(),
    paymentMode: z.enum(paymentModes),
    holdMinutes: z.number().int().min(10).max(1440),
    maxAdvanceDays: z.number().int().min(1).max(730),
    policy: z.string().trim().max(2000),
    allotments: z
      .array(
        z
          .object({
            roomTypeId: uuid,
            onlineAllotment: z.number().int().min(0).max(500),
          })
          .strict(),
      )
      .max(100),
    // Omit to keep the stored gateway; null removes it. The secret key is write-only.
    gateway: z
      .object({
        name: z.enum(gatewayNames),
        publicKey: z.string().trim().min(10).max(200),
        secretKey: z.string().trim().min(10).max(500).optional(),
        webhookHash: z.string().trim().min(8).max(200).optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
onlineBookings.put(
  "/online-booking/settings",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "settings.write");
    adminOnly(who);
    const license = await getLicense();
    if (!license.writable) throw new HttpError(423, license.reason);
    const input = settingsInput.parse(req.body);
    if (input.enabled && license.claims?.features.online_booking !== true)
      throw new HttpError(
        403,
        "Online booking is not part of this hotel's plan.",
      );
    await scope(db, { ...who, writable: true }, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${who.tenantId}:booking-settings`}))`;
      const row = await tx.settings.findFirst({
        where: { key: BOOKING_SETTING },
      });
      const old = readBookingSettings(row?.value);
      let gateway = old.gateway;
      if (input.gateway === null) gateway = null;
      else if (input.gateway) {
        const g = input.gateway;
        if (!/^(pk|FLWPUBK)[_-]/.test(g.publicKey))
          throw new HttpError(
            400,
            "That does not look like a public key. It starts with pk_ (Paystack) or FLWPUBK (Flutterwave).",
          );
        if (g.secretKey) {
          if (!/^(sk|FLWSECK)[_-]/.test(g.secretKey))
            throw new HttpError(
              400,
              "That does not look like a secret key. It starts with sk_ (Paystack) or FLWSECK (Flutterwave).",
            );
          if (g.name === "flutterwave" && !g.webhookHash)
            throw new HttpError(
              400,
              "Flutterwave needs the webhook secret hash from its dashboard.",
            );
          if (!sealingKey)
            throw new HttpError(
              503,
              "The cloud sealing key is not installed on this hub. Set CLOUD_SEALING_PUBLIC_KEY_FILE.",
            );
          gateway = {
            name: g.name,
            publicKey: g.publicKey,
            hint: `…${g.secretKey.slice(-4)}`,
            sealed: sealForCloud(
              sealingKey,
              { secretKey: g.secretKey, webhookHash: g.webhookHash },
              gatewayAad(who.tenantId, g.name),
            ),
            updatedAt: new Date().toISOString(),
          };
        } else if (old.gateway?.name === g.name)
          gateway = { ...old.gateway, publicKey: g.publicKey };
        else
          throw new HttpError(
            400,
            "Enter the secret key for the new payment provider.",
          );
      }
      if (input.paymentMode !== "none" && !gateway)
        throw new HttpError(
          400,
          "Add a payment provider before taking payment online.",
        );
      for (const a of input.allotments) {
        const t = await tx.room_types.findFirst({
          where: { id: a.roomTypeId, deleted_at: null },
        });
        if (!t) throw new HttpError(404, "Room type not found.");
        const rooms = await tx.rooms.count({
          where: { room_type_id: t.id, deleted_at: null },
        });
        if (a.onlineAllotment > rooms)
          throw new HttpError(
            400,
            `${t.name} has ${rooms} rooms, so the website can sell at most ${rooms}.`,
          );
        if (t.online_allotment !== a.onlineAllotment)
          await mutation(tx, () =>
            tx.room_types.update({
              where: { id: t.id },
              data: { online_allotment: a.onlineAllotment },
            }),
          );
      }
      const value = {
        enabled: input.enabled,
        paymentMode: input.paymentMode,
        holdMinutes: input.holdMinutes,
        maxAdvanceDays: input.maxAdvanceDays,
        policy: input.policy,
        gateway,
      };
      await mutation(tx, () =>
        row
          ? tx.settings.update({
              where: { id: row.id },
              data: { value, deleted_at: null },
            })
          : tx.settings.create({
              data: { ...base(who), key: BOOKING_SETTING, value },
            }),
      );
    });
    res.status(204).end();
  }),
);
