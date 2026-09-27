import { Router } from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { route } from "./http.js";
import type { Conn } from "./sync-apply.js";
import type { Lead } from "./lead-alerts.js";
type Connect = () => Promise<{ conn: Conn; release: () => void }>;
// Contact form on the public website. Runs as booking_agent, which may only insert a new
// enquiry; the provider console reads and follows them up.
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));
export const leadSchema = z
  .object({
    name: text(2, 120),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: optional(40),
    hotelName: text(2, 150),
    city: optional(100),
    rooms: z
      .union([z.number(), z.string()])
      .optional()
      .transform((v) => (v === undefined || v === "" ? null : Number(v)))
      .refine(
        (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 5000),
        "Rooms must be a whole number from 1 to 5000.",
      ),
    plan: z.enum(["standard", "premium", "custom", "unsure"]).optional(),
    message: text(10, 3000),
    // Spam traps: a field people never see, and how long the form was open.
    website: z.string().max(200).optional(),
    openedMs: z.number().int().min(0).optional(),
  })
  .strict();
export function leadsRouter(
  connect: Connect,
  options: {
    // Told about each stored enquiry, after it is saved. Not awaited: the visitor's
    // answer never waits for alerts.
    onLead?: (lead: Lead) => void;
    now?: () => number;
  } = {},
) {
  const now = options.now ?? (() => Date.now());
  const r = Router();
  r.use(
    rateLimit({
      windowMs: 10 * 60_000,
      limit: 5,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: {
        error: "Too many messages. Please try again in a few minutes.",
      },
    }),
  );
  r.post(
    "/",
    route(async (req, res) => {
      const v = leadSchema.parse(req.body);
      // Bots fill hidden fields and submit instantly. They get the same answer as people,
      // so they learn nothing, but nothing is stored.
      if (v.website || (v.openedMs !== undefined && v.openedMs < 3000))
        return res.status(201).json({ received: true });
      const id = randomUUID();
      const { conn, release } = await connect();
      try {
        await conn.query(
          `INSERT INTO sales_leads (id,name,email,phone,hotel_name,city,rooms,plan,message)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            v.name,
            v.email,
            v.phone,
            v.hotelName,
            v.city,
            v.rooms,
            v.plan ?? null,
            v.message,
          ],
        );
      } finally {
        release();
      }
      console.log(
        JSON.stringify({
          event: "lead_received",
          id,
          at: new Date(now()).toISOString(),
          rooms: v.rooms,
          plan: v.plan ?? null,
        }),
      );
      options.onLead?.({
        id,
        name: v.name,
        email: v.email,
        phone: v.phone,
        hotelName: v.hotelName,
        city: v.city,
        rooms: v.rooms,
        plan: v.plan ?? null,
        message: v.message,
      });
      res.status(201).json({ received: true });
    }),
  );
  return r;
}
