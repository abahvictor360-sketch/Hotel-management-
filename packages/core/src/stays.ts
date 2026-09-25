import { Prisma } from "@prisma/client";
import { z } from "zod";
export const isoDate = z
  .string()
  .regex(/^20\d{2}-\d{2}-\d{2}$/)
  .refine((value) => {
    const d = new Date(value + "T00:00:00Z");
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }, "Use a valid date between 2000 and 2099.");
export const money = z
  .string()
  .regex(
    /^\d{1,10}(\.\d{1,2})?$/,
    "Use a monetary amount with at most two decimal places.",
  );
export const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
export const asDate = (date: string) => new Date(date + "T00:00:00Z");
export function hotelToday(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return ["year", "month", "day"]
    .map((k) => parts.find((p) => p.type === k)!.value)
    .join("-");
}
export const nightsBetween = (from: string, to: string) =>
  Math.round((asDate(to).getTime() - asDate(from).getTime()) / 86400000);
export const stayDates = z
  .object({ checkInDate: isoDate, checkOutDate: isoDate })
  .refine((v) => {
    const nights = nightsBetween(v.checkInDate, v.checkOutDate);
    return nights > 0 && nights <= 365;
  }, "Stays must be between 1 and 365 nights.");
export function priceStay(
  rate: string,
  checkInDate: string,
  checkOutDate: string,
  tax: {
    vat_enabled: boolean;
    vat_rate: { toString(): string };
    service_charge_enabled: boolean;
    service_charge_rate: { toString(): string };
  },
) {
  stayDates.parse({ checkInDate, checkOutDate });
  money.parse(rate);
  const nights = nightsBetween(checkInDate, checkOutDate);
  const net = new Prisma.Decimal(rate).mul(nights).toDecimalPlaces(2);
  const vat = tax.vat_enabled
    ? net
        .mul(tax.vat_rate.toString())
        .div(100)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    : new Prisma.Decimal(0);
  const service = tax.service_charge_enabled
    ? net
        .mul(tax.service_charge_rate.toString())
        .div(100)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    : new Prisma.Decimal(0);
  const total = net.plus(vat).plus(service);
  if (total.gt("9999999999.99"))
    throw new Error("Stay total exceeds the supported monetary limit.");
  return {
    version: 1,
    checkInDate,
    checkOutDate,
    nights,
    rate: new Prisma.Decimal(rate).toFixed(2),
    net: net.toFixed(2),
    vat: vat.toFixed(2),
    service: service.toFixed(2),
    total: total.toFixed(2),
    vatRate: tax.vat_rate.toString(),
    serviceRate: tax.service_charge_rate.toString(),
    vatEnabled: tax.vat_enabled,
    serviceEnabled: tax.service_charge_enabled,
  };
}
export type StayPrice = ReturnType<typeof priceStay>;
