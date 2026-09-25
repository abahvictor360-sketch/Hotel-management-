import { Router, type Request } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db, scope, base, mutation } from "./db.js";
import { identity, requirePermission } from "./auth.js";
import { route, HttpError } from "./http.js";
import { command } from "./commands.js";
import { cancelOnlineBooking } from "./online-bookings.js";
import {
  isoDate,
  money,
  asDate,
  dateOnly,
  stayDates,
  nightsBetween,
  priceStay,
} from "../../../packages/core/src/stays.js";
import {
  guestFields,
  createGuest,
  createBooking,
  quoteBooking,
  freeRooms,
  todayAt,
  getStay,
  checkIn,
  checkOut,
  folioBalance,
  storedPrice,
  postRoomCharges,
  activeStatuses,
} from "./stay-service.js";
export const frontdesk = Router();
const uuid = z.string().uuid();
const requestFields = { requestId: uuid };
const pager = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});
async function reader(req: Request, permission = "frontdesk.read") {
  const who = await identity(req);
  requirePermission(who, permission);
  return who;
}
const reservationInclude = Prisma.validator<Prisma.reservationsInclude>()({
  rel_guest_id: { select: { full_name: true, phone: true } },
  rel_room_id: { select: { room_number: true } },
  rel_room_type_id: { select: { name: true } },
  back_folios_reservation_id: { select: { id: true, status: true } },
});
function reservationView(
  row: Prisma.reservationsGetPayload<{ include: typeof reservationInclude }>,
) {
  const {
    rel_guest_id,
    rel_room_id,
    rel_room_type_id,
    back_folios_reservation_id,
    ...stay
  } = row;
  return {
    ...stay,
    rate: row.rate.toFixed(2),
    check_in_date: dateOnly(row.check_in_date),
    check_out_date: dateOnly(row.check_out_date),
    full_name: rel_guest_id.full_name,
    phone: rel_guest_id.phone,
    room_number: rel_room_id?.room_number ?? null,
    room_type: rel_room_type_id.name,
    folio_id: back_folios_reservation_id[0]?.id ?? null,
  };
}
const bookingSchema = z
  .object({
    ...requestFields,
    guestId: uuid.optional(),
    guest: z.object(guestFields).strict().optional(),
    roomTypeId: uuid,
    roomId: uuid.optional(),
    ratePlanId: uuid.optional(),
    checkInDate: isoDate,
    checkOutDate: isoDate,
    adults: z.number().int().min(1).max(20).default(1),
    children: z.number().int().min(0).max(20).default(0),
    source: z.enum(["walk_in", "phone"]).default("phone"),
    notes: z.string().max(2000).optional(),
  })
  .strict()
  .refine(
    (v) => !!v.guestId !== !!v.guest,
    "Select an existing guest or enter one new guest.",
  );
frontdesk.get(
  "/frontdesk/config",
  route(async (req, res) => {
    const who = await reader(req);
    res.json(
      await scope(db, who, async (tx) => {
        const hotel = await tx.tenants.findUniqueOrThrow({
          where: { id: who.tenantId },
        });
        return {
          today: await todayAt(tx, who.tenantId),
          timezone: hotel.timezone,
          currency: hotel.currency,
          symbol: hotel.currency_symbol,
          roomTypes: await tx.room_types.findMany({
            where: { deleted_at: null },
            orderBy: { name: "asc" },
            take: 100,
          }),
          ratePlans: await tx.rate_plans.findMany({
            where: { deleted_at: null },
            orderBy: { name: "asc" },
            take: 500,
          }),
        };
      }),
    );
  }),
);
frontdesk.get(
  "/rooms",
  route(async (req, res) => {
    const who = await reader(req);
    const p = pager.parse(req.query);
    res.json(
      await scope(db, who, async (tx) => {
        const where = { deleted_at: null };
        const [rows, total] = await Promise.all([
          tx.rooms.findMany({
            where,
            skip: (p.page - 1) * p.pageSize,
            take: p.pageSize,
            orderBy: [{ floor: "asc" }, { room_number: "asc" }],
            include: {
              rel_room_type_id: {
                select: { name: true, base_rate: true, capacity: true },
              },
            },
          }),
          tx.rooms.count({ where }),
        ]);
        return {
          items: rows.map(({ rel_room_type_id, ...r }) => ({
            ...r,
            room_type: rel_room_type_id.name,
            base_rate: rel_room_type_id.base_rate.toFixed(2),
            capacity: rel_room_type_id.capacity,
          })),
          total,
          ...p,
        };
      }),
    );
  }),
);
frontdesk.get(
  "/availability",
  route(async (req, res) => {
    const who = await reader(req);
    const input = z
      .object({
        roomTypeId: uuid,
        checkInDate: isoDate,
        checkOutDate: isoDate,
        adults: z.coerce.number().int().positive().default(1),
        children: z.coerce.number().int().min(0).default(0),
        ratePlanId: uuid.optional(),
        ignoreId: uuid.optional(),
      })
      .parse(req.query);
    stayDates.parse(input);
    res.json(
      await scope(db, who, async (tx) => ({
        rooms: await freeRooms(
          tx,
          who.tenantId,
          input.roomTypeId,
          input.checkInDate,
          input.checkOutDate,
          input.ignoreId,
        ),
        price: await quoteBooking(tx, { ...input, source: "phone" }),
      })),
    );
  }),
);
frontdesk.get(
  "/calendar",
  route(async (req, res) => {
    const who = await reader(req);
    const { from, to, ...p } = pager
      .extend({ from: isoDate, to: isoDate })
      .parse(req.query);
    if (nightsBetween(from, to) < 1 || nightsBetween(from, to) > 31)
      throw new HttpError(
        400,
        "Choose a calendar range between 1 and 31 days.",
      );
    res.json(
      await scope(db, who, async (tx) => {
        const [rooms, total] = await Promise.all([
          tx.rooms.findMany({
            where: { deleted_at: null },
            skip: (p.page - 1) * p.pageSize,
            take: p.pageSize,
            orderBy: [{ floor: "asc" }, { room_number: "asc" }],
            include: { rel_room_type_id: { select: { name: true } } },
          }),
          tx.rooms.count({ where: { deleted_at: null } }),
        ]);
        const rows = await tx.reservations.findMany({
          where: {
            deleted_at: null,
            room_id: { in: rooms.map((r) => r.id) },
            status: { in: [...activeStatuses] },
            OR: [
              {
                check_in_date: { lt: asDate(to) },
                check_out_date: { gt: asDate(from) },
              },
              { status: "checked_in" },
            ],
          },
          include: reservationInclude,
          orderBy: { check_in_date: "asc" },
        });
        return {
          rooms: rooms.map(({ rel_room_type_id, ...room }) => ({
            ...room,
            room_type: rel_room_type_id.name,
          })),
          reservations: rows.map(reservationView),
          total,
          from,
          to,
          ...p,
        };
      }),
    );
  }),
);
frontdesk.post(
  "/room-types",
  route(async (req, res) => {
    const input = z
      .object({
        ...requestFields,
        name: z.string().trim().min(2).max(100),
        baseRate: money,
        capacity: z.number().int().min(1).max(20),
        description: z.string().max(1000).optional(),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(
      await command(req, "settings.write", input, (tx, who) =>
        mutation(tx, () =>
          tx.room_types.create({
            data: {
              ...base(who),
              name: input.name,
              base_rate: input.baseRate,
              capacity: input.capacity,
              description: input.description,
              amenities: [],
            },
          }),
        ),
      ),
    );
  }),
);
frontdesk.post(
  "/rooms/bulk",
  route(async (req, res) => {
    const input = z
      .object({
        ...requestFields,
        roomTypeId: uuid,
        floor: z.number().int().min(-5).max(150),
        numbers: z.array(z.string().trim().min(1).max(20)).min(1).max(100),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(
      await command(req, "settings.write", input, async (tx, who, license) => {
        if (new Set(input.numbers).size !== input.numbers.length)
          throw new HttpError(400, "Room numbers must be distinct.");
        if (
          !(await tx.room_types.findFirst({
            where: { id: input.roomTypeId, deleted_at: null },
          }))
        )
          throw new HttpError(404, "Room type not found.");
        if (
          (await tx.rooms.count({ where: { deleted_at: null } })) +
            input.numbers.length >
          license.maxRooms
        )
          throw new HttpError(409, "Your plan room limit would be exceeded.");
        const rooms = [];
        for (const room_number of input.numbers)
          rooms.push(
            await mutation(tx, () =>
              tx.rooms.create({
                data: {
                  ...base(who),
                  room_type_id: input.roomTypeId,
                  floor: input.floor,
                  room_number,
                },
              }),
            ),
          );
        return { rooms };
      }),
    );
  }),
);
frontdesk.post(
  "/rate-plans",
  route(async (req, res) => {
    const input = z
      .object({
        ...requestFields,
        roomTypeId: uuid,
        name: z.string().trim().min(2).max(100),
        rate: money,
        validFrom: isoDate,
        validTo: isoDate,
      })
      .strict()
      .parse(req.body);
    if (input.validTo < input.validFrom)
      throw new HttpError(400, "Rate plan dates are invalid.");
    res.status(201).json(
      await command(req, "settings.write", input, async (tx, who) => {
        if (
          !(await tx.room_types.findFirst({
            where: { id: input.roomTypeId, deleted_at: null },
          }))
        )
          throw new HttpError(404, "Room type not found.");
        return mutation(tx, () =>
          tx.rate_plans.create({
            data: {
              ...base(who),
              room_type_id: input.roomTypeId,
              name: input.name,
              rate: input.rate,
              valid_from: asDate(input.validFrom),
              valid_to: asDate(input.validTo),
            },
          }),
        );
      }),
    );
  }),
);
frontdesk.patch(
  "/rooms/:id/status",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const input = z
      .object({
        ...requestFields,
        status: z.enum(["available", "dirty", "maintenance"]),
        reason: z.string().trim().min(3).max(500),
      })
      .strict()
      .parse(req.body);
    res.json(
      await command(req, "frontdesk.write", input, async (tx, who) => {
        const room = await tx.rooms.findFirst({
          where: { id, deleted_at: null },
        });
        if (!room) throw new HttpError(404, "Room not found.");
        if (
          room.status === "occupied" ||
          (await tx.reservations.findFirst({
            where: { room_id: id, status: "checked_in", deleted_at: null },
          }))
        )
          throw new HttpError(
            409,
            "Check the guest out before changing the room status.",
          );
        const result = await mutation(tx, () =>
          tx.rooms.update({ where: { id }, data: { status: input.status } }),
        );
        await tx.audit_log.create({
          data: {
            ...base(who),
            user_id: who.userId,
            action: "room_status_reason",
            entity: "rooms",
            entity_id: id,
            after: { reason: input.reason, status: input.status },
            occurred_at: new Date(),
          },
        });
        return result;
      }),
    );
  }),
);
frontdesk.get(
  "/guests",
  route(async (req, res) => {
    const who = await reader(req);
    const { q, ...p } = pager
      .extend({ q: z.string().trim().max(120).default("") })
      .parse(req.query);
    res.json(
      await scope(db, who, async (tx) => {
        const where: Prisma.guestsWhereInput = {
          deleted_at: null,
          ...(q
            ? {
                OR: ["full_name", "phone", "email"].map((key) => ({
                  [key]: { contains: q, mode: "insensitive" },
                })),
              }
            : {}),
        };
        const [items, total] = await Promise.all([
          tx.guests.findMany({
            where,
            take: p.pageSize,
            skip: (p.page - 1) * p.pageSize,
            orderBy: [{ full_name: "asc" }, { id: "asc" }],
            select: {
              id: true,
              full_name: true,
              phone: true,
              email: true,
              nationality: true,
            },
          }),
          tx.guests.count({ where }),
        ]);
        return { items, total, ...p };
      }),
    );
  }),
);
frontdesk.get(
  "/guests/:id",
  route(async (req, res) => {
    const who = await reader(req);
    const id = uuid.parse(req.params.id);
    res.json(
      await scope(db, who, async (tx) => {
        const guest = await tx.guests.findFirst({
          where: { id, deleted_at: null },
        });
        if (!guest) throw new HttpError(404, "Guest not found.");
        const p = pager.parse(req.query);
        const [history, total] = await Promise.all([
          tx.reservations.findMany({
            where: { guest_id: id, deleted_at: null },
            skip: (p.page - 1) * p.pageSize,
            take: p.pageSize,
            orderBy: { check_in_date: "desc" },
            include: reservationInclude,
          }),
          tx.reservations.count({ where: { guest_id: id, deleted_at: null } }),
        ]);
        return { guest, history: history.map(reservationView), total, ...p };
      }),
    );
  }),
);
frontdesk.post(
  "/guests",
  route(async (req, res) => {
    const input = z
      .object({ ...requestFields, ...guestFields })
      .strict()
      .parse(req.body);
    res
      .status(201)
      .json(
        await command(req, "frontdesk.write", input, (tx, who) =>
          createGuest(tx, who, input),
        ),
      );
  }),
);
frontdesk.put(
  "/guests/:id",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const input = z
      .object({ ...requestFields, ...guestFields })
      .strict()
      .parse(req.body);
    res.json(
      await command(req, "frontdesk.write", input, async (tx) => {
        if (!(await tx.guests.findFirst({ where: { id, deleted_at: null } })))
          throw new HttpError(404, "Guest not found.");
        return mutation(tx, () =>
          tx.guests.update({
            where: { id },
            data: {
              full_name: input.fullName,
              phone: input.phone,
              email: input.email,
              nationality: input.nationality,
              address: input.address,
              id_type: input.idType,
              id_number: input.idNumber,
              notes: input.notes,
            },
          }),
        );
      }),
    );
  }),
);
frontdesk.get(
  "/reservations",
  route(async (req, res) => {
    const who = await reader(req);
    const { from, to, status, ...p } = pager
      .extend({
        from: isoDate.optional(),
        to: isoDate.optional(),
        status: z
          .enum([
            "pending",
            "confirmed",
            "checked_in",
            "checked_out",
            "cancelled",
            "no_show",
          ])
          .optional(),
      })
      .parse(req.query);
    if (!!from !== !!to || (from && to && from >= to))
      throw new HttpError(400, "Provide both dates in a valid range.");
    res.json(
      await scope(db, who, async (tx) => {
        const where: Prisma.reservationsWhereInput = {
          deleted_at: null,
          status,
          ...(from && to
            ? {
                check_in_date: { lt: asDate(to) },
                check_out_date: { gt: asDate(from) },
              }
            : {}),
        };
        const [items, total] = await Promise.all([
          tx.reservations.findMany({
            where,
            include: reservationInclude,
            orderBy: [{ check_in_date: "desc" }, { id: "asc" }],
            take: p.pageSize,
            skip: (p.page - 1) * p.pageSize,
          }),
          tx.reservations.count({ where }),
        ]);
        return { items: items.map(reservationView), total, ...p };
      }),
    );
  }),
);
frontdesk.get(
  "/reservations/:id",
  route(async (req, res) => {
    const who = await reader(req);
    const id = uuid.parse(req.params.id);
    res.json(
      await scope(db, who, async (tx) => {
        const row = await tx.reservations.findFirst({
          where: { id, deleted_at: null },
          include: reservationInclude,
        });
        if (!row) throw new HttpError(404, "Reservation not found.");
        return reservationView(row);
      }),
    );
  }),
);
for (const [path, walkIn] of [
  ["/reservations", false],
  ["/walk-ins", true],
] as const)
  frontdesk.post(
    path,
    route(async (req, res) => {
      const input = bookingSchema.parse(req.body);
      stayDates.parse(input);
      res
        .status(201)
        .json(
          await command(req, "frontdesk.write", input, (tx, who) =>
            createBooking(
              tx,
              who,
              { ...input, source: walkIn ? "walk_in" : input.source },
              walkIn,
            ),
          ),
        );
    }),
  );
frontdesk.patch(
  "/reservations/:id",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const input = z
      .object({
        ...requestFields,
        roomId: uuid,
        checkInDate: isoDate,
        checkOutDate: isoDate,
        ratePlanId: uuid.optional(),
        adults: z.number().int().min(1).max(20),
        children: z.number().int().min(0).max(20),
      })
      .strict()
      .parse(req.body);
    stayDates.parse(input);
    res.json(
      await command(req, "frontdesk.write", input, async (tx, who) => {
        const stay = await getStay(tx, id);
        if (!["pending", "confirmed"].includes(stay.status))
          throw new HttpError(
            409,
            "Only unarrived reservations can be amended.",
          );
        if (input.checkInDate < (await todayAt(tx, who.tenantId)))
          throw new HttpError(400, "New arrival date cannot be in the past.");
        const room = await tx.rooms.findFirst({
          where: { id: input.roomId, deleted_at: null },
        });
        if (!room) throw new HttpError(404, "Room not found.");
        if (
          !(
            await freeRooms(
              tx,
              who.tenantId,
              room.room_type_id,
              input.checkInDate,
              input.checkOutDate,
              id,
            )
          ).some((r) => r.id === room.id)
        )
          throw new HttpError(409, "The chosen room is unavailable.");
        const price = await quoteBooking(tx, {
          ...input,
          roomTypeId: room.room_type_id,
          source: "phone",
        });
        return mutation(tx, () =>
          tx.reservations.update({
            where: { id },
            data: {
              room_id: room.id,
              room_type_id: room.room_type_id,
              check_in_date: asDate(input.checkInDate),
              check_out_date: asDate(input.checkOutDate),
              rate: price.rate,
              price_snapshot: price,
              adults: input.adults,
              children: input.children,
              status: "confirmed",
            },
          }),
        );
      }),
    );
  }),
);
frontdesk.post(
  "/reservations/:id/extend",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const input = z
      .object({ ...requestFields, checkOutDate: isoDate })
      .strict()
      .parse(req.body);
    res.json(
      await command(req, "frontdesk.write", input, async (tx, who) => {
        const stay = await getStay(tx, id);
        if (stay.status !== "checked_in" || !stay.room_id)
          throw new HttpError(409, "Only an occupied stay can be extended.");
        if (
          input.checkOutDate <= dateOnly(stay.check_out_date) ||
          input.checkOutDate < (await todayAt(tx, who.tenantId))
        )
          throw new HttpError(
            400,
            "Choose a later departure date no earlier than today.",
          );
        stayDates.parse({
          checkInDate: dateOnly(stay.check_in_date),
          checkOutDate: input.checkOutDate,
        });
        const overlap = await tx.reservations.findFirst({
          where: {
            id: { not: id },
            deleted_at: null,
            room_id: stay.room_id,
            status: { in: [...activeStatuses] },
            check_in_date: { lt: asDate(input.checkOutDate) },
            check_out_date: { gt: stay.check_out_date },
          },
        });
        if (overlap)
          throw new HttpError(
            409,
            "The extension overlaps another reservation.",
          );
        const old = storedPrice(stay);
        const price = priceStay(old.rate, old.checkInDate, input.checkOutDate, {
          vat_enabled: old.vatEnabled,
          vat_rate: old.vatRate,
          service_charge_enabled: old.serviceEnabled,
          service_charge_rate: old.serviceRate,
        });
        const folio = await tx.folios.findFirst({
          where: { reservation_id: id, status: "open", deleted_at: null },
        });
        if (!folio) throw new HttpError(409, "Open folio not found.");
        await postRoomCharges(
          tx,
          who,
          folio.id,
          input.requestId,
          {
            net: new Prisma.Decimal(price.net).minus(old.net).toFixed(2),
            vat: new Prisma.Decimal(price.vat).minus(old.vat).toFixed(2),
            service: new Prisma.Decimal(price.service)
              .minus(old.service)
              .toFixed(2),
          },
          true,
        );
        await mutation(tx, () =>
          tx.reservations.update({
            where: { id },
            data: {
              check_out_date: asDate(input.checkOutDate),
              price_snapshot: price,
            },
          }),
        );
        return { id, price };
      }),
    );
  }),
);
frontdesk.patch(
  "/reservations/:id/notes",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const input = z
      .object({ ...requestFields, notes: z.string().max(2000) })
      .strict()
      .parse(req.body);
    res.json(
      await command(req, "frontdesk.write", input, async (tx) => {
        await getStay(tx, id);
        return mutation(tx, () =>
          tx.reservations.update({
            where: { id },
            data: { notes: input.notes },
          }),
        );
      }),
    );
  }),
);
frontdesk.post(
  "/reservations/:id/cancel",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const input = z
      .object({
        ...requestFields,
        status: z.enum(["cancelled", "no_show"]),
        reason: z.string().trim().min(3).max(500),
      })
      .strict()
      .parse(req.body);
    res.json(
      await command(req, "frontdesk.write", input, async (tx, who) => {
        const stay = await getStay(tx, id);
        if (!["pending", "confirmed"].includes(stay.status))
          throw new HttpError(
            409,
            "Only an unarrived reservation can be cancelled or marked no-show.",
          );
        if (
          input.status === "no_show" &&
          dateOnly(stay.check_in_date) >= (await todayAt(tx, who.tenantId))
        )
          throw new HttpError(409, "Mark no-show only after the arrival date.");
        const folio = await tx.folios.findFirst({
          where: { reservation_id: id, status: "open", deleted_at: null },
        });
        if (folio) {
          await tx.$queryRaw`SELECT id FROM folios WHERE id=${folio.id}::uuid FOR UPDATE`;
          if (!(await folioBalance(tx, folio.id)).isZero())
            throw new HttpError(
              409,
              "Settle or refund the folio before cancelling.",
            );
          await mutation(tx, () =>
            tx.folios.update({
              where: { id: folio.id },
              data: { status: "closed", closed_at: new Date() },
            }),
          );
        }
        const updated = await mutation(tx, () =>
          tx.reservations.update({
            where: { id },
            data: {
              status: input.status,
              notes:
                `${stay.notes ?? ""}\n${input.status}: ${input.reason}`.trim(),
            },
          }),
        );
        // Releases the website allotment and tells the guest.
        if (stay.cloud_booking_id)
          await cancelOnlineBooking(tx, who, stay.cloud_booking_id, input.reason);
        return updated;
      }),
    );
  }),
);
for (const action of ["check-in", "check-out"] as const)
  frontdesk.post(
    `/reservations/:id/${action}`,
    route(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const input = z.object(requestFields).strict().parse(req.body);
      res.json(
        await command(
          req,
          action === "check-in" ? "frontdesk.write" : "billing.write",
          input,
          (tx, who) =>
            action === "check-in"
              ? checkIn(tx, who, id)
              : checkOut(tx, who, id),
        ),
      );
    }),
  );
frontdesk.get(
  "/folios/:id",
  route(async (req, res) => {
    const who = await reader(req, "billing.read");
    const id = uuid.parse(req.params.id);
    const p = pager.parse(req.query);
    res.json(
      await scope(db, who, async (tx) => {
        const folio = await tx.folios.findFirst({
          where: { id, deleted_at: null },
          include: {
            rel_guest_id: { select: { full_name: true } },
            rel_reservation_id: {
              select: {
                id: true,
                price_snapshot: true,
                status: true,
                check_in_date: true,
                check_out_date: true,
              },
            },
          },
        });
        if (!folio) throw new HttpError(404, "Folio not found.");
        const [charges, payments, chargeCount, paymentCount] =
          await Promise.all([
            tx.folio_charges.findMany({
              where: { folio_id: id },
              orderBy: { charged_at: "asc" },
              take: p.pageSize,
              skip: (p.page - 1) * p.pageSize,
            }),
            tx.payments.findMany({
              where: { folio_id: id },
              orderBy: { paid_at: "asc" },
              take: p.pageSize,
              skip: (p.page - 1) * p.pageSize,
            }),
            tx.folio_charges.count({ where: { folio_id: id } }),
            tx.payments.count({ where: { folio_id: id } }),
          ]);
        return {
          ...p,
          chargeCount,
          paymentCount,
          folio,
          charges,
          payments,
          balance: (await folioBalance(tx, id)).toFixed(2),
        };
      }),
    );
  }),
);
