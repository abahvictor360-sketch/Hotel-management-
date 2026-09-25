import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import rateLimit from "express-rate-limit";
import { env } from "./config.js";
import { db, scope, base, mutation, type Context } from "./db.js";
import { opaqueToken, hashToken } from "../../../packages/core/src/crypto.js";
import { HttpError, route } from "./http.js";
export const passwordSchema = z
  .string()
  .min(12)
  .max(72)
  .refine(
    (v) => Buffer.byteLength(v, "utf8") <= 72,
    "Password exceeds bcrypt byte limit",
  );
export type Identity = Context & {
  userId: string;
  sessionId: string;
  permissions: string[];
  forcePasswordChange: boolean;
  roleName: string;
};
const claimsSchema = z.object({
  sub: z.string().uuid(),
  tid: z.string().uuid(),
  sid: z.string().uuid(),
  ver: z.number().int(),
  device: z.string(),
});
const cookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/api/auth",
  maxAge: 7 * 86400_000,
};
function setCookie(res: Response, token: string) {
  res.cookie("hotel_refresh", token, cookieOptions);
}
export async function identity(req: Request): Promise<Identity> {
  try {
    const encoded = req.headers.authorization?.replace(/^Bearer /, "");
    if (!encoded) throw new Error();
    const c = claimsSchema.parse(
      jwt.verify(encoded, env.JWT_SECRET, {
        algorithms: ["HS256"],
        issuer: "hotel-hub",
        audience: "hotel-staff",
      }),
    );
    if (c.tid !== env.HOTEL_ID) throw new Error();
    return await scope(db, { tenantId: c.tid }, async (tx) => {
      const user = await tx.users.findFirst({
        where: { id: c.sub, is_active: true, deleted_at: null },
      });
      const session = await tx.refresh_sessions.findFirst({
        where: {
          id: c.sid,
          user_id: c.sub,
          revoked_at: null,
          expires_at: { gt: new Date() },
        },
      });
      if (!user || !session || user.token_version !== c.ver) throw new Error();
      if (c.device !== "hub") {
        const device = await tx.devices.findFirst({
          where: { id: c.device, deleted_at: null, revoked_at: null },
        });
        if (!device) throw new Error();
      }
      const role = await tx.roles.findFirst({
        where: { id: user.role_id, deleted_at: null },
      });
      if (!role) throw new Error();
      return {
        tenantId: c.tid,
        userId: user.id,
        sessionId: c.sid,
        deviceId: c.device,
        permissions: z.array(z.string()).parse(role.permissions),
        forcePasswordChange: user.force_password_change,
        roleName: role.name,
      };
    });
  } catch {
    throw new HttpError(401, "Sign in to continue.");
  }
}
export function requirePermission(who: Identity, permission?: string) {
  if (who.forcePasswordChange)
    throw new HttpError(403, "Change your temporary password first.");
  if (permission && !who.permissions.includes(permission))
    throw new HttpError(403, "You do not have permission for this action.");
}
function access(
  user: { id: string; token_version: number },
  sessionId: string,
  device: string,
) {
  return jwt.sign(
    { tid: env.HOTEL_ID, sid: sessionId, ver: user.token_version, device },
    env.JWT_SECRET,
    {
      subject: user.id,
      expiresIn: "10m",
      issuer: "hotel-hub",
      audience: "hotel-staff",
      algorithm: "HS256",
    },
  );
}
export const auth = Router();
auth.use(
  rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
);
auth.post(
  "/login",
  route(async (req, res) => {
    const input = z
      .object({
        email: z
          .string()
          .email()
          .transform((s) => s.toLowerCase()),
        password: z.string().max(200),
        deviceId: z.string().uuid().optional(),
      })
      .strict()
      .parse(req.body);
    const ctx = { tenantId: env.HOTEL_ID };
    const result = await scope(db, ctx, async (tx) => {
      const user = await tx.users.findFirst({
        where: { email: input.email, deleted_at: null, is_active: true },
      });
      // Same work for unknown users reduces account enumeration through timing.
      const valid = await bcrypt.compare(
        input.password,
        user?.password_hash ??
          "$2b$12$QBL5c5.5FxGhtKB6VpHTYev6vCJeFBDDNgaGjIQtnDU0SaKBc7FsS",
      );
      if (!user || !valid)
        throw new HttpError(401, "Email or password is incorrect.");
      if (
        input.deviceId &&
        !(await tx.devices.findFirst({
          where: { id: input.deviceId, deleted_at: null, revoked_at: null },
        }))
      )
        throw new HttpError(403, "Device is not registered.");
      // Production requires a registered device. Development permits the hub console.
      if (env.NODE_ENV === "production" && !input.deviceId)
        throw new HttpError(403, "Select a registered device.");
      const token = opaqueToken();
      const id = randomUUID();
      await tx.refresh_sessions.create({
        data: {
          ...base({
            ...ctx,
            userId: user.id,
            deviceId: input.deviceId ?? "hub",
          }),
          id,
          user_id: user.id,
          token_hash: hashToken(token),
          family_id: randomUUID(),
          expires_at: new Date(Date.now() + 7 * 86400_000),
        },
      });
      return {
        token,
        accessToken: access(user, id, input.deviceId ?? "hub"),
        forcePasswordChange: user.force_password_change,
      };
    });
    setCookie(res, result.token);
    res.json({
      accessToken: result.accessToken,
      forcePasswordChange: result.forcePasswordChange,
    });
  }),
);
auth.post(
  "/refresh",
  route(async (req, res) => {
    const token = z.string().min(20).max(200).parse(req.cookies.hotel_refresh);
    // Lock row for refresh rotation, then commit family revocation before returning errors.
    const result = await scope(db, { tenantId: env.HOTEL_ID }, async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM refresh_sessions WHERE tenant_id=${env.HOTEL_ID}::uuid AND token_hash=${hashToken(token)} FOR UPDATE`;
      if (!rows.length) return null;
      const old = await tx.refresh_sessions.findUniqueOrThrow({
        where: { id: rows[0].id },
      });
      if (old.revoked_at || old.expires_at <= new Date()) {
        await tx.refresh_sessions.updateMany({
          where: { family_id: old.family_id, revoked_at: null },
          data: { revoked_at: new Date() },
        });
        return null;
      }
      const user = await tx.users.findFirst({
        where: { id: old.user_id, is_active: true, deleted_at: null },
      });
      if (!user) return null;
      if (
        old.device_id !== "hub" &&
        !(await tx.devices.findFirst({
          where: { id: old.device_id, revoked_at: null, deleted_at: null },
        }))
      )
        return null;
      const next = opaqueToken();
      const id = randomUUID();
      await tx.refresh_sessions.create({
        data: {
          ...base({
            tenantId: env.HOTEL_ID,
            userId: user.id,
            deviceId: old.device_id,
          }),
          id,
          user_id: user.id,
          token_hash: hashToken(next),
          family_id: old.family_id,
          expires_at: old.expires_at,
        },
      });
      await tx.refresh_sessions.update({
        where: { id: old.id },
        data: { revoked_at: new Date(), replaced_by_id: id },
      });
      return { token: next, accessToken: access(user, id, old.device_id) };
    });
    if (!result) {
      res.clearCookie("hotel_refresh", cookieOptions);
      throw new HttpError(401, "Session expired. Sign in again.");
    }
    setCookie(res, result.token);
    res.json({ accessToken: result.accessToken });
  }),
);
auth.post(
  "/logout",
  route(async (req, res) => {
    const token = req.cookies.hotel_refresh;
    if (typeof token === "string")
      await scope(db, { tenantId: env.HOTEL_ID }, async (tx) => {
        const row = await tx.refresh_sessions.findFirst({
          where: { token_hash: hashToken(token) },
        });
        if (row)
          await tx.refresh_sessions.updateMany({
            where: { family_id: row.family_id },
            data: { revoked_at: new Date() },
          });
      });
    res.clearCookie("hotel_refresh", cookieOptions);
    res.status(204).end();
  }),
);
auth.get(
  "/me",
  route(async (req, res) => {
    const who = await identity(req);
    res.json(who);
  }),
);
auth.post(
  "/password",
  route(async (req, res) => {
    const who = await identity(req);
    const body = z
      .object({
        currentPassword: z.string().max(200),
        newPassword: passwordSchema,
      })
      .strict()
      .parse(req.body);
    await scope(db, { ...who, writable: true }, async (tx) => {
      const user = await tx.users.findUniqueOrThrow({
        where: { id: who.userId },
      });
      if (!(await bcrypt.compare(body.currentPassword, user.password_hash)))
        throw new HttpError(400, "Current password is incorrect.");
      if (await bcrypt.compare(body.newPassword, user.password_hash))
        throw new HttpError(400, "Choose a different password.");
      const awaitHash = await bcrypt.hash(body.newPassword, 12);
      await mutation(tx, () =>
        tx.users.update({
          where: { id: who.userId },
          data: {
            password_hash: awaitHash,
            force_password_change: false,
            token_version: { increment: 1 },
          },
        }),
      );
      await tx.refresh_sessions.updateMany({
        where: { user_id: who.userId, revoked_at: null },
        data: { revoked_at: new Date() },
      });
    });
    res.clearCookie("hotel_refresh", cookieOptions);
    res.status(204).end();
  }),
);
