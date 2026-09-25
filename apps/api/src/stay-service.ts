import { Prisma, type reservations } from "@prisma/client";
import { z } from "zod";
import { base, mutation, type Tx } from "./db.js";
import type { Identity } from "./auth.js";
import { HttpError } from "./http.js";
import {
  asDate,
  dateOnly,
  hotelToday,
  priceStay,
  stayDates,
  type StayPrice,
} from "../../../packages/core/src/stays.js";
export const activeStatuses = ["pending", "confirmed", "checked_in"] as const;
export async function todayAt(tx: Tx, tenantId: string) {
  return hotelToday(
    (
      await tx.tenants.findUniqueOrThrow({
        where: { id: tenantId },
        select: { timezone: true },
      })
    ).timezone,
  );
}
export async function getStay(tx: Tx, id: string) {
  const row = await tx.reservations.findFirst({
    where: { id, deleted_at: null },
  });
  if (!row) throw new HttpError(404, "Reservation not found.");
  return row;
}
export async function folioBalance(tx: Tx, id: string) {
  const charges = await tx.folio_charges.aggregate({
    where: { folio_id: id },
    _sum: { amount: true },
  });
  const payments = await tx.payments.aggregate({
    where: { folio_id: id },
    _sum: { amount: true },
  });
  return new Prisma.Decimal(charges._sum.amount ?? 0).minus(
    payments._sum.amount ?? 0,
  );
}
export async function freeRooms(
  tx: Tx,
  tenantId: string,
  typeId: string,
  from: string,
  to: string,
  ignoreId?: string,
) {
  const today = await todayAt(tx, tenantId);
  const rooms = await tx.rooms.findMany({
    where: {
      room_type_id: typeId,
      deleted_at: null,
      status: { not: "maintenance" },
    },
    orderBy: { room_number: "asc" },
  });
  const occupied = await tx.reservations.findMany({
    where: {
      deleted_at: null,
      id: ignoreId ? { not: ignoreId } : undefined,
      room_type_id: typeId,
      status: { in: [...activeStatuses] },
      OR: [
        {
          check_in_date: { lt: asDate(to) },
          check_out_date: { gt: asDate(from) },
        },
        ...(from <= today ? [{ status: "checked_in" as const }] : []),
      ],
    },
    select: { room_id: true },
  });
  const blocked = new Set(occupied.map((r) => r.room_id));
  return rooms.filter(
    (r) =>
      !blocked.has(r.id) &&
      (from > today ||
        r.status === "available" ||
        r.status === "reserved" ||
        (ignoreId && r.status === "occupied")),
  );
}
export const guestFields = {
  fullName: z.string().trim().min(2).max(150),
  phone: z.string().trim().max(40).optional(),
  email: z.string().email().max(254).optional(),
  nationality: z.string().max(80).optional(),
  address: z.string().max(500).optional(),
  idType: z.string().max(50).optional(),
  idNumber: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
};
export type GuestInput = z.infer<z.ZodObject<typeof guestFields>>;
export async function createGuest(tx: Tx, who: Identity, input: GuestInput) {
  return mutation(tx, () =>
    tx.guests.create({
      data: {
        ...base(who),
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
}
export type Booking = {
  guestId?: string;
  guest?: GuestInput;
  roomTypeId: string;
  roomId?: string;
  ratePlanId?: string;
  checkInDate: string;
  checkOutDate: string;
  adults: number;
  children: number;
  source: "walk_in" | "phone";
  notes?: string;
};
export async function quoteBooking(tx: Tx, input: Booking) {
  stayDates.parse(input);
  const type = await tx.room_types.findFirst({
    where: { id: input.roomTypeId, deleted_at: null },
  });
  if (!type) throw new HttpError(404, "Room type not found.");
  if (input.adults + input.children > type.capacity)
    throw new HttpError(400, "Guest count exceeds room capacity.");
  let rate = type.base_rate;
  if (input.ratePlanId) {
    const plan = await tx.rate_plans.findFirst({
      where: { id: input.ratePlanId, room_type_id: type.id, deleted_at: null },
    });
    if (
      !plan ||
      dateOnly(plan.valid_from) > input.checkInDate ||
      dateOnly(plan.valid_to) <
        dateOnly(new Date(asDate(input.checkOutDate).getTime() - 86400000))
    )
      throw new HttpError(
        400,
        "Rate plan does not cover every night of the stay.",
      );
    rate = plan.rate;
  }
  const tax = await tx.service_categories.findFirst({
    where: { name: "room", deleted_at: null },
  });
  if (!tax)
    throw new HttpError(
      409,
      "Configure the room service category before making a reservation.",
    );
  try {
    return priceStay(
      rate.toFixed(2),
      input.checkInDate,
      input.checkOutDate,
      tax,
    );
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    throw new HttpError(400, (error as Error).message);
  }
}
export async function createBooking(
  tx: Tx,
  who: Identity,
  input: Booking,
  walkIn = false,
) {
  const today = await todayAt(tx, who.tenantId);
  if (input.checkInDate < today || (walkIn && input.checkInDate !== today))
    throw new HttpError(
      400,
      walkIn
        ? "Walk-in check-in must start today."
        : "New reservations cannot start in the past.",
    );
  const price = await quoteBooking(tx, input);
  const available = await freeRooms(
    tx,
    who.tenantId,
    input.roomTypeId,
    input.checkInDate,
    input.checkOutDate,
  );
  const room = input.roomId
    ? available.find((r) => r.id === input.roomId)
    : available[0];
  if (!room)
    throw new HttpError(409, "No eligible room is available for these dates.");
  let guestId = input.guestId;
  if (guestId) {
    if (
      !(await tx.guests.findFirst({ where: { id: guestId, deleted_at: null } }))
    )
      throw new HttpError(404, "Guest not found.");
  } else if (input.guest)
    guestId = (await createGuest(tx, who, input.guest)).id;
  else throw new HttpError(400, "Select or create a guest.");
  const stay = await mutation(tx, () =>
    tx.reservations.create({
      data: {
        ...base(who),
        guest_id: guestId!,
        room_id: room.id,
        room_type_id: input.roomTypeId,
        check_in_date: asDate(input.checkInDate),
        check_out_date: asDate(input.checkOutDate),
        adults: input.adults,
        children: input.children,
        rate: price.rate,
        price_snapshot: price,
        status: "confirmed",
        source: input.source,
        notes: input.notes,
      },
    }),
  );
  const folio = await mutation(tx, () =>
    tx.folios.create({
      data: {
        ...base(who),
        reservation_id: stay.id,
        guest_id: guestId!,
        opened_at: new Date(),
      },
    }),
  );
  if (walkIn) await checkIn(tx, who, stay.id);
  return {
    id: stay.id,
    folioId: folio.id,
    roomId: room.id,
    roomNumber: room.room_number,
    status: walkIn ? "checked_in" : "confirmed",
    price,
  };
}
const priceSchema = z.object({
  version: z.literal(1),
  checkInDate: z.string(),
  checkOutDate: z.string(),
  nights: z.number(),
  rate: z.string(),
  net: z.string(),
  vat: z.string(),
  service: z.string(),
  total: z.string(),
  vatRate: z.string(),
  serviceRate: z.string(),
  vatEnabled: z.boolean(),
  serviceEnabled: z.boolean(),
});
export function storedPrice(stay: reservations) {
  const result = priceSchema.safeParse(stay.price_snapshot);
  if (!result.success)
    throw new HttpError(
      409,
      "This reservation needs a current room quote before check-in. Amend its dates or room first.",
    );
  return result.data;
}
export async function postRoomCharges(
  tx: Tx,
  who: Identity,
  folioId: string,
  sourceId: string,
  price: Pick<StayPrice, "net" | "vat" | "service">,
  extension = false,
) {
  for (const [kind, label, amount] of [
    ["room", "Room accommodation", price.net],
    ["room_vat", "VAT on room accommodation", price.vat],
    ["room_service_charge", "Room service charge", price.service],
  ] as const) {
    if (new Prisma.Decimal(amount).isZero()) continue;
    await mutation(tx, () =>
      tx.folio_charges.create({
        data: {
          ...base(who),
          folio_id: folioId,
          source_type: extension ? `${kind}_extension` : kind,
          source_id: sourceId,
          description: extension ? `${label} (stay extension)` : label,
          amount,
          charged_at: new Date(),
        },
      }),
    );
  }
}
export async function checkIn(tx: Tx, who: Identity, id: string) {
  const stay = await getStay(tx, id);
  if (stay.status === "checked_in") return { id, status: stay.status };
  if (!["pending", "confirmed"].includes(stay.status) || !stay.room_id)
    throw new HttpError(
      409,
      "Only an allocated reservation can be checked in.",
    );
  const today = await todayAt(tx, who.tenantId);
  if (
    dateOnly(stay.check_in_date) > today ||
    dateOnly(stay.check_out_date) <= today
  )
    throw new HttpError(
      409,
      "Check-in must occur within the reserved stay dates. Amend the dates first.",
    );
  const room = await tx.rooms.findFirst({
    where: { id: stay.room_id, deleted_at: null },
  });
  if (!room || !["available", "reserved"].includes(room.status))
    throw new HttpError(
      409,
      "The room must be clean and available before check-in.",
    );
  if (
    await tx.reservations.findFirst({
      where: {
        room_id: stay.room_id,
        deleted_at: null,
        status: "checked_in",
        id: { not: id },
      },
    })
  )
    throw new HttpError(409, "Another guest still occupies this room.");
  const folio = await tx.folios.findFirst({
    where: { reservation_id: id, deleted_at: null, status: "open" },
  });
  if (!folio) throw new HttpError(409, "An open folio is required.");
  await tx.$queryRaw`SELECT id FROM folios WHERE id=${folio.id}::uuid FOR UPDATE`;
  await postRoomCharges(tx, who, folio.id, id, storedPrice(stay));
  await mutation(tx, () =>
    tx.reservations.update({
      where: { id },
      data: { status: "checked_in", checked_in_at: new Date() },
    }),
  );
  await mutation(tx, () =>
    tx.rooms.update({
      where: { id: stay.room_id! },
      data: { status: "occupied" },
    }),
  );
  return { id, status: "checked_in", folioId: folio.id };
}
export async function checkOut(tx: Tx, who: Identity, id: string) {
  const stay = await getStay(tx, id);
  if (stay.status === "checked_out") return { id, status: "checked_out" };
  if (stay.status !== "checked_in" || !stay.room_id)
    throw new HttpError(409, "Only a checked-in stay can be checked out.");
  if (dateOnly(stay.check_out_date) < (await todayAt(tx, who.tenantId)))
    throw new HttpError(409, "Extend the stay through today before checkout.");
  const folio = await tx.folios.findFirst({
    where: { reservation_id: id, deleted_at: null, status: "open" },
  });
  if (!folio) throw new HttpError(409, "An open folio is required.");
  await tx.$queryRaw`SELECT id FROM folios WHERE id=${folio.id}::uuid FOR UPDATE`;
  const roomCharges = await tx.folio_charges.aggregate({
    where: {
      folio_id: folio.id,
      source_type: {
        in: [
          "room",
          "room_vat",
          "room_service_charge",
          "room_extension",
          "room_vat_extension",
          "room_service_charge_extension",
        ],
      },
    },
    _sum: { amount: true },
  });
  if (
    !new Prisma.Decimal(roomCharges._sum.amount ?? 0).equals(
      storedPrice(stay).total,
    )
  )
    throw new HttpError(
      409,
      "Room charges do not match the agreed stay. Reconcile the folio before checkout.",
    );
  const balance = await folioBalance(tx, folio.id);
  if (!balance.isZero())
    throw new HttpError(
      409,
      `Folio must have a zero balance before checkout. Current balance: ${balance.toFixed(2)}. Payment and refund entry arrive in Phase 3.`,
    );
  await mutation(tx, () =>
    tx.folios.update({
      where: { id: folio.id },
      data: { status: "closed", closed_at: new Date() },
    }),
  );
  await mutation(tx, () =>
    tx.reservations.update({
      where: { id },
      data: { status: "checked_out", checked_out_at: new Date() },
    }),
  );
  await mutation(tx, () =>
    tx.rooms.update({
      where: { id: stay.room_id! },
      data: { status: "dirty" },
    }),
  );
  return { id, status: "checked_out", folioId: folio.id };
}
