import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Sealed } from "./crypto.js";
// Phase 6 online booking contract, shared by the hub (settings, confirmation) and the
// cloud (public booking website, payments, guest messages).

export const BOOKING_SETTING = "online_booking";
export const paymentModes = ["none", "optional", "required"] as const;
export const gatewayNames = ["paystack", "flutterwave"] as const;
export type GatewayName = (typeof gatewayNames)[number];
const sealed = z
  .object({
    v: z.literal(1),
    alg: z.literal("RSA-OAEP-256+A256GCM"),
    key: z.string(),
    iv: z.string(),
    tag: z.string(),
    data: z.string(),
  })
  .strict() as z.ZodType<Sealed>;
// Stored in settings (replicated). Holds no readable secret: the gateway secret key is
// sealed to the cloud's public key, and only the cloud can open it.
export const bookingSettings = z
  .object({
    enabled: z.boolean(),
    paymentMode: z.enum(paymentModes),
    holdMinutes: z.number().int().min(10).max(1440),
    maxAdvanceDays: z.number().int().min(1).max(730),
    policy: z.string().max(2000),
    gateway: z
      .object({
        name: z.enum(gatewayNames),
        publicKey: z.string().max(200),
        hint: z.string().max(12),
        sealed,
        updatedAt: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type BookingSettings = z.infer<typeof bookingSettings>;
export const defaultBookingSettings: BookingSettings = {
  enabled: false,
  paymentMode: "none",
  holdMinutes: 30,
  maxAdvanceDays: 365,
  policy: "",
  gateway: null,
};
export function readBookingSettings(value: unknown): BookingSettings {
  const v = bookingSettings.safeParse(value);
  return v.success ? v.data : defaultBookingSettings;
}
// What the sealed box contains. Flutterwave webhooks carry a shared hash, not an HMAC.
export const gatewaySecret = z
  .object({
    secretKey: z.string().min(10).max(500),
    webhookHash: z.string().max(200).optional(),
  })
  .strict();

// The booking the website creates. The hub never trusts it blindly: it re-checks the
// room, dates and price snapshot when staff confirm.
export const bookingPayload = z
  .object({
    version: z.literal(1),
    requestId: z.string().uuid(),
    roomTypeId: z.string().uuid(),
    roomTypeName: z.string(),
    checkIn: z.string(),
    checkOut: z.string(),
    adults: z.number().int(),
    children: z.number().int(),
    guest: z.object({
      fullName: z.string(),
      email: z.string(),
      phone: z.string().optional(),
    }),
    notes: z.string().optional(),
    price: z.object({
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
    }),
    currency: z.string(),
    paymentMode: z.enum(paymentModes),
    holdUntil: z.string(),
    // Written by the hub when staff decide.
    decision: z
      .object({
        at: z.string(),
        by: z.string().nullable(),
        reason: z.string().optional(),
        roomNumber: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();
export type BookingPayload = z.infer<typeof bookingPayload>;

// Guest-facing reference: short, unambiguous, random (not a counter).
const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export function bookingReference() {
  const bytes = randomBytes(8);
  return `WB-${[...bytes].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

// Gateways take integer minor units (kobo). Exact string conversion, no floats.
export function toMinor(amount: string) {
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(amount);
  if (!m) throw new Error("Invalid amount");
  const minor = BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
  return minor.toString();
}
export function fromMinor(minor: string | number | bigint) {
  const v = BigInt(minor);
  const neg = v < 0n,
    a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

export const messageKinds = [
  "booking_received",
  "payment_received",
  "booking_confirmed",
  "booking_rejected",
  "booking_cancelled",
] as const;
export type MessageKind = (typeof messageKinds)[number];
export type MessageContext = {
  hotel: string;
  reference: string;
  guest: string;
  checkIn: string;
  checkOut: string;
  roomType: string;
  total: string;
  currency: string;
  statusUrl?: string;
  reason?: string;
  paid?: boolean;
};
// Plain text on purpose: every email and SMS gateway accepts it.
export function renderMessage(kind: MessageKind, c: MessageContext) {
  const stay = `${c.roomType}, ${c.checkIn} to ${c.checkOut}`;
  const link = c.statusUrl ? `\n\nCheck your booking: ${c.statusUrl}` : "";
  const sign = `\n\n${c.hotel}`;
  const hello = `Hello ${c.guest},\n\n`;
  switch (kind) {
    case "booking_received":
      return {
        subject: `${c.hotel}: booking request ${c.reference} received`,
        text: `${hello}We have received your booking request ${c.reference} for ${stay}. Total ${c.currency} ${c.total}.\nThe hotel will confirm your room shortly.${link}${sign}`,
      };
    case "payment_received":
      return {
        subject: `${c.hotel}: payment received for ${c.reference}`,
        text: `${hello}We have received your payment of ${c.currency} ${c.total} for booking ${c.reference} (${stay}).${link}${sign}`,
      };
    case "booking_confirmed":
      return {
        subject: `${c.hotel}: booking ${c.reference} confirmed`,
        text: `${hello}Your booking ${c.reference} is confirmed: ${stay}.${c.paid ? " Your payment has been applied to your bill." : ` Amount due at the hotel: ${c.currency} ${c.total}.`}${link}${sign}`,
      };
    case "booking_rejected":
      return {
        subject: `${c.hotel}: booking ${c.reference} could not be confirmed`,
        text: `${hello}We are sorry, we could not confirm booking ${c.reference} (${stay}).${c.reason ? ` Reason: ${c.reason}.` : ""}${c.paid ? " Your payment will be refunded in full. The hotel will contact you." : ""}${link}${sign}`,
      };
    case "booking_cancelled":
      return {
        subject: `${c.hotel}: booking ${c.reference} cancelled`,
        text: `${hello}Booking ${c.reference} (${stay}) has been cancelled.${c.reason ? ` Reason: ${c.reason}.` : ""}${c.paid ? " The hotel will contact you about your payment." : ""}${link}${sign}`,
      };
  }
}
