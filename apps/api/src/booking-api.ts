import express, { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { route, HttpError } from "./http.js";
import type { Conn } from "./sync-apply.js";
import { openSealed, gatewayAad } from "../../../packages/core/src/crypto.js";
import {
  BOOKING_SETTING,
  bookingPayload,
  bookingReference,
  gatewaySecret,
  readBookingSettings,
  renderMessage,
  type BookingPayload,
  type BookingSettings,
  type MessageKind,
} from "../../../packages/core/src/booking.js";
import {
  hotelToday,
  isoDate,
  money,
  nightsBetween,
  priceStay,
  stayDates,
} from "../../../packages/core/src/stays.js";
import {
  assess,
  gatewayClient,
  GatewayError,
  type Fetcher,
  type GatewayClient,
} from "./gateways.js";
// Public booking website API, served by the cloud. No login: a guest finds a hotel by its
// public slug. It runs as booking_agent, which can read what a guest may book and write
// only bookings, payment records and guest messages. Those rows reach the hub by pull.
type Connect = () => Promise<{ conn: Conn; release: () => void }>;
export type BookingDeps = {
  connect: Connect;
  // Public origin of this service, for payment return links and guest status links.
  publicUrl: string;
  // Private key that opens gateway secrets sealed by the hub. Without it, no payments.
  sealingKey: string | null;
  fetcher?: Fetcher;
  now?: () => Date;
};
const live = ["trial", "active", "past_due"];
type Hotel = {
  id: string;
  slug: string;
  name: string;
  currency: string;
  symbol: string;
  timezone: string;
  address: string;
  settings: BookingSettings;
};
const q = async (c: Conn, sql: string, params: unknown[] = []) =>
  (await c.query(sql, params)).rows;
// Every row write needs fresh outbox and audit ids, exactly like mutation() on the hub.
async function write(c: Conn, sql: string, params: unknown[]) {
  await c.query(
    "SELECT set_config('app.event_id',$1,true),set_config('app.audit_id',$2,true)",
    [randomUUID(), randomUUID()],
  );
  return q(c, sql, params);
}
async function hotelTx<T>(
  connect: Connect,
  slug: string,
  fn: (c: Conn, h: Hotel) => Promise<T>,
  allowClosed = false,
): Promise<T> {
  const { conn, release } = await connect();
  try {
    await conn.query("BEGIN");
    const [t] = await q(
      conn,
      "SELECT id::text AS id,slug,name,currency,currency_symbol,timezone FROM tenants WHERE slug=$1 AND deleted_at IS NULL",
      [slug],
    );
    if (!t)
      throw new HttpError(404, "This hotel does not take online bookings.");
    await conn.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.device_id','web',true),set_config('app.user_id','',true)",
      [t.id],
    );
    const settings = await q(
      conn,
      "SELECT key,value FROM settings WHERE key IN ($1,'branding') AND deleted_at IS NULL",
      [BOOKING_SETTING],
    );
    const [sub] = await q(
      conn,
      "SELECT status::text AS status,features FROM subscriptions WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
    );
    const s = readBookingSettings(
      settings.find((x) => x.key === BOOKING_SETTING)?.value,
    );
    const branding = (settings.find((x) => x.key === "branding")?.value ??
      {}) as Record<string, string>;
    const open =
      s.enabled &&
      !!sub &&
      live.includes(sub.status) &&
      sub.features?.online_booking === true;
    if (!open && !allowClosed)
      throw new HttpError(404, "This hotel does not take online bookings.");
    const result = await fn(conn, {
      id: t.id,
      slug: t.slug,
      name: branding.name || t.name,
      currency: t.currency,
      symbol: t.currency_symbol,
      timezone: t.timezone,
      address: branding.address ?? "",
      settings: s,
    });
    await conn.query("COMMIT");
    return result;
  } catch (error) {
    await conn.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    release();
  }
}
// Seasonal rate plans win over the base rate when one plan covers every night.
async function quote(
  c: Conn,
  h: Hotel,
  input: {
    roomTypeId: string;
    checkIn: string;
    checkOut: string;
    adults: number;
    children: number;
  },
  now: Date,
) {
  stayDates.parse({ checkInDate: input.checkIn, checkOutDate: input.checkOut });
  const today = hotelToday(h.timezone, now);
  if (input.checkIn < today)
    throw new HttpError(400, "Choose an arrival date from today onwards.");
  if (nightsBetween(today, input.checkIn) > h.settings.maxAdvanceDays)
    throw new HttpError(
      400,
      `Bookings open ${h.settings.maxAdvanceDays} days ahead.`,
    );
  if (nightsBetween(input.checkIn, input.checkOut) > 30)
    throw new HttpError(400, "Book at most 30 nights online.");
  const [type] = await q(
    c,
    "SELECT id::text AS id,name,capacity,base_rate::text AS base_rate,online_allotment FROM room_types WHERE id=$1 AND deleted_at IS NULL AND online_allotment>0",
    [input.roomTypeId],
  );
  if (!type) throw new HttpError(404, "Room type not available online.");
  if (input.adults + input.children > type.capacity)
    throw new HttpError(400, `This room sleeps at most ${type.capacity}.`);
  const [plan] = await q(
    c,
    "SELECT rate::text AS rate FROM rate_plans WHERE room_type_id=$1 AND deleted_at IS NULL AND valid_from<=$2::date AND valid_to>=($3::date-1) ORDER BY valid_from DESC,created_at DESC LIMIT 1",
    [type.id, input.checkIn, input.checkOut],
  );
  const [tax] = await q(
    c,
    "SELECT vat_enabled,vat_rate::text AS vat_rate,service_charge_enabled,service_charge_rate::text AS service_charge_rate FROM service_categories WHERE name='room' AND deleted_at IS NULL",
  );
  if (!tax) throw new HttpError(503, "Online booking is not set up yet.");
  const price = priceStay(
    plan?.rate ?? type.base_rate,
    input.checkIn,
    input.checkOut,
    tax,
  );
  const left = await remaining(
    c,
    type.id,
    type.online_allotment,
    input.checkIn,
    input.checkOut,
  );
  return { type, price, left };
}
// Online allotment: how many rooms of a type the website may sell per night. Holds that
// expired unpaid, rejected and cancelled bookings give their rooms back.
async function remaining(
  c: Conn,
  typeId: string,
  allotment: number,
  checkIn: string,
  checkOut: string,
) {
  const [r] = await q(
    c,
    `SELECT coalesce(min($2::int-coalesce(h.n,0)),0)::int AS left FROM generate_series($3::date,$4::date-1,interval '1 day') AS d(night)
     LEFT JOIN LATERAL (SELECT count(*) AS n FROM online_bookings b WHERE b.deleted_at IS NULL AND b.status IN ('pending','confirmed')
       AND b.payload->>'roomTypeId'=$1 AND (b.payload->>'checkIn')::date<=d.night::date AND (b.payload->>'checkOut')::date>d.night::date
       AND NOT (b.status='pending' AND b.payload->>'paymentMode'='required' AND (b.payload->>'holdUntil')::timestamptz<now()
         AND NOT EXISTS(SELECT 1 FROM payment_transactions t WHERE t.online_booking_id=b.id AND t.status='success'))) h ON true`,
    [typeId, allotment, checkIn, checkOut],
  );
  return Math.max(0, r.left as number);
}
function client(h: Hotel, deps: BookingDeps): GatewayClient | null {
  const g = h.settings.gateway;
  if (!g || !deps.sealingKey) return null;
  const secret = gatewaySecret.parse(
    openSealed(deps.sealingKey, g.sealed, gatewayAad(h.id, g.name)),
  );
  return gatewayClient(g.name, secret, deps.fetcher);
}
const statusUrl = (deps: BookingDeps, h: Hotel, ref: string) =>
  `${deps.publicUrl.replace(/\/$/, "")}/book/${h.slug}/status?ref=${encodeURIComponent(ref)}`;
async function notify(
  c: Conn,
  h: Hotel,
  deps: BookingDeps,
  booking: { id: string; external_reference: string; payload: BookingPayload },
  kind: MessageKind,
) {
  const p = booking.payload;
  const msg = renderMessage(kind, {
    hotel: h.name,
    reference: booking.external_reference,
    guest: p.guest.fullName,
    checkIn: p.checkIn,
    checkOut: p.checkOut,
    roomType: p.roomTypeName,
    total: p.price.total,
    currency: p.currency,
    statusUrl: statusUrl(deps, h, booking.external_reference),
  });
  await write(
    c,
    "INSERT INTO notifications(id,tenant_id,device_id,online_booking_id,channel,destination,payload) VALUES($1,$2,'web',$3,'email',$4,$5::jsonb)",
    [
      randomUUID(),
      h.id,
      booking.id,
      p.guest.email,
      JSON.stringify({ kind, reference: booking.external_reference, ...msg }),
    ],
  );
}
type Tx = {
  id: string;
  reference: string;
  amount: string;
  status: string;
  online_booking_id: string;
};
// Starts a gateway payment for an unpaid booking. The row is written first, so a guest who
// pays after a network failure is still matched on verification.
async function startPayment(
  deps: BookingDeps,
  slug: string,
  reference: string,
) {
  const prepared = await hotelTx(deps.connect, slug, async (c, h) => {
    const [b] = await q(
      c,
      "SELECT id::text AS id,external_reference,status::text AS status,payload FROM online_bookings WHERE external_reference=$1 AND deleted_at IS NULL",
      [reference],
    );
    if (!b) throw new HttpError(404, "Booking not found.");
    const p = bookingPayload.parse(b.payload);
    if (b.status !== "pending")
      throw new HttpError(409, "This booking no longer takes payment online.");
    if (p.paymentMode === "none")
      throw new HttpError(409, "Pay for this booking at the hotel.");
    const g = client(h, deps);
    if (!g)
      throw new HttpError(
        503,
        "Online payment is not available right now. Pay at the hotel.",
      );
    const paid = await q(
      c,
      "SELECT 1 FROM payment_transactions WHERE online_booking_id=$1 AND status='success'",
      [b.id],
    );
    if (paid.length) throw new HttpError(409, "This booking is already paid.");
    if (
      p.paymentMode === "required" &&
      Date.parse(p.holdUntil) < (deps.now?.() ?? new Date()).getTime()
    )
      throw new HttpError(
        409,
        "The time to pay for this booking has passed. Make a new booking.",
      );
    const [{ n }] = await q(
      c,
      "SELECT count(*)::int AS n FROM payment_transactions WHERE online_booking_id=$1",
      [b.id],
    );
    const tx = {
      id: randomUUID(),
      reference: `${b.external_reference}-P${n + 1}`,
    };
    await write(
      c,
      "INSERT INTO payment_transactions(id,tenant_id,device_id,gateway,reference,amount,status,raw_response,online_booking_id) VALUES($1,$2,'web',$3,$4,$5,'initialized','{}'::jsonb,$6)",
      [tx.id, h.id, g.name, tx.reference, p.price.total, b.id],
    );
    return { h, g, p, tx, booking: b };
  });
  try {
    const { url } = await prepared.g.initialize({
      reference: prepared.tx.reference,
      amount: prepared.p.price.total,
      currency: prepared.p.currency,
      email: prepared.p.guest.email,
      name: prepared.p.guest.fullName,
      callbackUrl: `${deps.publicUrl.replace(/\/$/, "")}/book/${slug}/return?booking=${encodeURIComponent(reference)}`,
      metadata: { booking: reference, hotel: prepared.h.slug },
    });
    // Kept so a retried request resumes this checkout instead of starting another.
    await hotelTx(deps.connect, slug, (c) =>
      write(
        c,
        "UPDATE payment_transactions SET raw_response=jsonb_build_object('checkoutUrl',$2::text) WHERE id=$1 AND status='initialized'",
        [prepared.tx.id, url],
      ),
    );
    return { paymentUrl: url, paymentReference: prepared.tx.reference };
  } catch (e) {
    await hotelTx(deps.connect, slug, (c) =>
      write(
        c,
        "UPDATE payment_transactions SET status='init_failed' WHERE id=$1 AND status='initialized'",
        [prepared.tx.id],
      ),
    ).catch(() => {});
    if (e instanceof GatewayError) throw new HttpError(502, e.message);
    throw e;
  }
}
// Asks the gateway, never the browser. Safe to repeat: a verified payment stays verified.
export async function verifyPayment(
  deps: BookingDeps,
  slug: string,
  reference: string,
) {
  const found = await hotelTx(
    deps.connect,
    slug,
    async (c, h) => {
      const [t] = await q(
        c,
        "SELECT id::text AS id,reference,amount::text AS amount,status,online_booking_id::text AS online_booking_id FROM payment_transactions WHERE reference=$1",
        [reference],
      );
      return t
        ? { t: t as Tx, g: client(h, deps), currency: h.currency }
        : null;
    },
    true,
  );
  if (!found) throw new HttpError(404, "Payment not found.");
  if (found.t.status === "success") return { status: "success", reference };
  if (!found.g)
    throw new HttpError(
      503,
      "Payment verification is not available right now.",
    );
  let v;
  try {
    v = await found.g.verify(reference);
  } catch (e) {
    if (e instanceof GatewayError) throw new HttpError(502, e.message);
    throw e;
  }
  const outcome = assess(
    { amount: found.t.amount, currency: found.currency },
    v,
  );
  return hotelTx(
    deps.connect,
    slug,
    async (c, h) => {
      const [t] = await q(
        c,
        "SELECT status FROM payment_transactions WHERE id=$1 FOR UPDATE",
        [found.t.id],
      );
      if (t.status === "success") return { status: "success", reference };
      if (outcome === "pending" && t.status === "initialized")
        return { status: "pending", reference };
      const raw = {
        status: v.status,
        amount: v.amount,
        currency: v.currency,
        paidAt: v.paidAt,
        gatewayId: v.gatewayId,
        channel: v.channel,
      };
      await write(
        c,
        "UPDATE payment_transactions SET status=$2,raw_response=$3::jsonb,verified_at=CASE WHEN $2='success' THEN now() ELSE verified_at END WHERE id=$1",
        [found.t.id, outcome, JSON.stringify(raw)],
      );
      if (outcome === "success") {
        const [b] = await q(
          c,
          "SELECT id::text AS id,external_reference,payload FROM online_bookings WHERE id=$1",
          [found.t.online_booking_id],
        );
        if (b)
          await notify(
            c,
            h,
            deps,
            { ...b, payload: bookingPayload.parse(b.payload) },
            "payment_received",
          );
      }
      return { status: outcome, reference };
    },
    true,
  );
}
const guestSchema = z
  .object({
    fullName: z.string().trim().min(2).max(150),
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((s) => s.toLowerCase()),
    phone: z.string().trim().max(40).optional(),
  })
  .strict();
const stayInput = {
  roomTypeId: z.string().uuid(),
  checkIn: isoDate,
  checkOut: isoDate,
  adults: z.number().int().min(1).max(20),
  children: z.number().int().min(0).max(20),
};
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const refSchema = z.string().regex(/^WB-[2-9A-Z]{8}$/);
export function bookingRouter(deps: BookingDeps) {
  const r = Router();
  const now = () => deps.now?.() ?? new Date();
  r.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  );
  // Per-address limits for each guest action, so browsing never blocks booking or paying.
  const limit = (n: number) =>
    rateLimit({
      windowMs: 60_000,
      limit: n,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    });
  const bookingLimit = limit(10),
    lookupLimit = limit(20),
    payLimit = limit(10),
    verifyLimit = limit(30);
  r.get(
    "/hotels/:slug",
    route(async (req, res) => {
      const slug = slugSchema.parse(req.params.slug);
      res.json(
        await hotelTx(deps.connect, slug, async (c, h) => ({
          name: h.name,
          address: h.address,
          currency: h.currency,
          symbol: h.symbol,
          today: hotelToday(h.timezone, now()),
          maxAdvanceDays: h.settings.maxAdvanceDays,
          policy: h.settings.policy,
          payment:
            h.settings.gateway && deps.sealingKey
              ? h.settings.paymentMode
              : "none",
          gateway: h.settings.gateway?.name ?? null,
          roomTypes: await q(
            c,
            'SELECT id::text AS id,name,description,capacity,amenities,base_rate::text AS "fromRate" FROM room_types WHERE deleted_at IS NULL AND online_allotment>0 ORDER BY base_rate,name',
          ),
        })),
      );
    }),
  );
  r.post(
    "/hotels/:slug/quote",
    route(async (req, res) => {
      const slug = slugSchema.parse(req.params.slug);
      const input = z.object(stayInput).strict().parse(req.body);
      res.json(
        await hotelTx(deps.connect, slug, async (c, h) => {
          const x = await quote(c, h, input, now());
          return {
            available: x.left > 0,
            roomsLeft: Math.min(x.left, 5),
            price: x.price,
            currency: h.currency,
          };
        }),
      );
    }),
  );
  r.post(
    "/hotels/:slug/bookings",
    bookingLimit,
    route(async (req, res) => {
      const slug = slugSchema.parse(req.params.slug);
      const input = z
        .object({
          ...stayInput,
          requestId: z.string().uuid(),
          guest: guestSchema,
          notes: z.string().trim().max(500).optional(),
          expectedTotal: money,
          payNow: z.boolean().default(true),
        })
        .strict()
        .parse(req.body);
      const created = await hotelTx(deps.connect, slug, async (c, h) => {
        // One web sale at a time per room type, so two guests cannot take the last room.
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `${h.id}:web:${input.roomTypeId}`,
        ]);
        const [old] = await q(
          c,
          "SELECT external_reference,payload FROM online_bookings WHERE payload->>'requestId'=$1",
          [input.requestId],
        );
        if (old) {
          if ((old.payload as BookingPayload).guest.email !== input.guest.email)
            throw new HttpError(
              409,
              "This request ID belongs to a different booking.",
            );
          return {
            reference: old.external_reference as string,
            replay: true,
            mode: (old.payload as BookingPayload).paymentMode,
          };
        }
        const x = await quote(c, h, input, now());
        if (x.left < 1)
          throw new HttpError(
            409,
            "Sorry, this room type has just sold out for those dates.",
          );
        if (x.price.total !== input.expectedTotal)
          throw new HttpError(
            409,
            "The price changed. Review the new total and book again.",
          );
        const mode =
          h.settings.gateway && deps.sealingKey
            ? h.settings.paymentMode
            : "none";
        if (mode === "required" && !input.payNow)
          throw new HttpError(
            400,
            "This hotel requires payment when you book.",
          );
        const payload: BookingPayload = {
          version: 1,
          requestId: input.requestId,
          roomTypeId: x.type.id,
          roomTypeName: x.type.name,
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          adults: input.adults,
          children: input.children,
          guest: input.guest,
          notes: input.notes,
          price: x.price,
          currency: h.currency,
          paymentMode: mode,
          holdUntil: new Date(
            now().getTime() + h.settings.holdMinutes * 60_000,
          ).toISOString(),
        };
        const booking = {
          id: randomUUID(),
          external_reference: bookingReference(),
          payload,
        };
        await write(
          c,
          "INSERT INTO online_bookings(id,tenant_id,device_id,payload,status,external_reference) VALUES($1,$2,'web',$3::jsonb,'pending',$4)",
          [
            booking.id,
            h.id,
            JSON.stringify(payload),
            booking.external_reference,
          ],
        );
        await notify(c, h, deps, booking, "booking_received");
        return { reference: booking.external_reference, replay: false, mode };
      });
      let payment: {
        paymentUrl?: string;
        paymentReference?: string;
        paymentError?: string;
      } = {};
      const resume = created.replay
        ? await hotelTx(deps.connect, slug, async (c) => {
            const [t] = await q(
              c,
              `SELECT t.reference,t.status,t.raw_response->>'checkoutUrl' AS url FROM payment_transactions t
               JOIN online_bookings b ON b.id=t.online_booking_id WHERE b.external_reference=$1 ORDER BY t.created_at DESC LIMIT 1`,
              [created.reference],
            );
            return t;
          })
        : null;
      if (resume?.status === "success") payment = {};
      else if (resume?.status === "initialized" && resume.url)
        payment = {
          paymentUrl: resume.url,
          paymentReference: resume.reference,
        };
      else if (created.mode !== "none" && input.payNow)
        try {
          payment = await startPayment(deps, slug, created.reference);
        } catch (e) {
          payment = { paymentError: (e as Error).message };
        }
      res
        .status(created.replay ? 200 : 201)
        .json({
          reference: created.reference,
          paymentMode: created.mode,
          ...payment,
        });
    }),
  );
  // A guest looks a booking up with its reference and their email, like an airline PNR.
  const lookup = z
    .object({
      email: z
        .string()
        .trim()
        .email()
        .max(254)
        .transform((s) => s.toLowerCase()),
    })
    .strict();
  r.post(
    "/hotels/:slug/bookings/:ref/status",
    lookupLimit,
    route(async (req, res) => {
      const slug = slugSchema.parse(req.params.slug),
        ref = refSchema.parse(req.params.ref),
        { email } = lookup.parse(req.body);
      res.json(
        await hotelTx(
          deps.connect,
          slug,
          async (c, h) => {
            const [b] = await q(
              c,
              "SELECT id::text AS id,status::text AS status,payload FROM online_bookings WHERE external_reference=$1 AND deleted_at IS NULL",
              [ref],
            );
            const p = b ? bookingPayload.safeParse(b.payload) : null;
            if (!b || !p?.success || p.data.guest.email !== email)
              throw new HttpError(
                404,
                "No booking matches that reference and email.",
              );
            const txs = await q(
              c,
              "SELECT status FROM payment_transactions WHERE online_booking_id=$1",
              [b.id],
            );
            const paid = txs.some((t) => t.status === "success");
            const expired =
              !paid &&
              p.data.paymentMode === "required" &&
              b.status === "pending" &&
              Date.parse(p.data.holdUntil) < now().getTime();
            return {
              reference: ref,
              hotel: h.name,
              status: expired ? "expired" : b.status,
              roomType: p.data.roomTypeName,
              checkIn: p.data.checkIn,
              checkOut: p.data.checkOut,
              adults: p.data.adults,
              children: p.data.children,
              guest: p.data.guest.fullName,
              total: p.data.price.total,
              currency: p.data.currency,
              paymentMode: p.data.paymentMode,
              payment: paid
                ? "paid"
                : p.data.paymentMode === "none"
                  ? "at_hotel"
                  : "unpaid",
              canPay:
                !paid &&
                !expired &&
                b.status === "pending" &&
                p.data.paymentMode !== "none",
              holdUntil: p.data.holdUntil,
              roomNumber: p.data.decision?.roomNumber ?? null,
              reason:
                b.status === "rejected" || b.status === "cancelled"
                  ? (p.data.decision?.reason ?? null)
                  : null,
            };
          },
          true,
        ),
      );
    }),
  );
  r.post(
    "/hotels/:slug/bookings/:ref/pay",
    payLimit,
    route(async (req, res) => {
      const slug = slugSchema.parse(req.params.slug),
        ref = refSchema.parse(req.params.ref),
        { email } = lookup.parse(req.body);
      await hotelTx(deps.connect, slug, async (c) => {
        const [b] = await q(
          c,
          "SELECT payload->'guest'->>'email' AS email FROM online_bookings WHERE external_reference=$1",
          [ref],
        );
        if (!b || b.email !== email)
          throw new HttpError(
            404,
            "No booking matches that reference and email.",
          );
      });
      res.json(await startPayment(deps, slug, ref));
    }),
  );
  r.post(
    "/hotels/:slug/payments/verify",
    verifyLimit,
    route(async (req, res) => {
      const slug = slugSchema.parse(req.params.slug);
      const { reference } = z
        .object({ reference: z.string().regex(/^WB-[2-9A-Z]{8}-P\d{1,3}$/) })
        .strict()
        .parse(req.body);
      res.json(await verifyPayment(deps, slug, reference));
    }),
  );
  // Gateway webhooks. The signature proves the sender; the verify API still decides.
  r.post(
    "/webhooks/:gateway/:slug",
    route(async (req: Request & { rawBody?: Buffer }, res) => {
      const slug = slugSchema.parse(req.params.slug),
        gateway = z.enum(["paystack", "flutterwave"]).parse(req.params.gateway);
      const g = await hotelTx(
        deps.connect,
        slug,
        async (_c, h) =>
          h.settings.gateway?.name === gateway ? client(h, deps) : null,
        true,
      );
      if (!g || !req.rawBody || !g.webhookValid(req.headers, req.rawBody))
        throw new HttpError(401, "Invalid webhook signature.");
      const reference = g.webhookReference(req.body);
      if (reference && /^WB-[2-9A-Z]{8}-P\d{1,3}$/.test(reference))
        await verifyPayment(deps, slug, reference).catch(() => {});
      res.status(200).json({ received: true });
    }),
  );
  return r;
}
// Keeps the exact bytes of webhook bodies: signatures are computed over them.
export const jsonWithRawWebhooks = express.json({
  limit: "8mb",
  verify: (req, _res, buf) => {
    if ((req as Request).originalUrl?.startsWith("/api/public/webhooks/"))
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
  },
});
