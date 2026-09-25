import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { env } from "./config.js";
import { auth, identity, requirePermission, passwordSchema } from "./auth.js";
import { db, scope, base, mutation } from "./db.js";
import { getLicense, refreshLicense } from "./licensing.js";
import { route, errors, HttpError } from "./http.js";
import { permissions } from "../../../packages/core/src/permissions.js";
import { encryptSecret } from "../../../packages/core/src/crypto.js";
import { frontdesk } from "./frontdesk.js";
import { billing } from "./billing.js";
import { printing } from "./printing.js";
import { operations } from "./operations.js";
import { printerSchema } from "./printer.js";
import { drafts } from "./drafts.js";
export const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin &&
    req.headers.origin !== env.APP_ORIGIN
  )
    return res.status(403).json({ error: "Untrusted request origin." });
  next();
});
app.get(
  "/api/health",
  route(async (_req, res) => {
    await db.$queryRaw`SELECT 1`;
    res.json({
      status: "ok",
      version: "0.3.0",
      schemaVersion: 1,
      databaseRevision: 4,
    });
  }),
);
app.get(
  "/api/branding",
  route(async (_req, res) => {
    res.json(
      await scope(db, { tenantId: env.HOTEL_ID }, async (tx) => {
        const t = await tx.tenants.findUniqueOrThrow({
          where: { id: env.HOTEL_ID },
        });
        const s = await tx.settings.findFirst({
          where: { key: "branding", deleted_at: null },
        });
        return {
          name: t.name,
          currency: t.currency,
          symbol: t.currency_symbol,
          ...((s?.value as object) ?? (t.branding as object)),
        };
      }),
    );
  }),
);
app.use("/api/auth", auth);
app.use("/api", frontdesk);
app.use("/api", billing);
app.use("/api", printing);
app.use("/api", operations);
app.use("/api", drafts);
app.get(
  "/api/license",
  route(async (req, res) => {
    await identity(req);
    res.json(await getLicense());
  }),
);
app.post(
  "/api/license/activate",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "settings.write");
    const body = z
      .object({ key: z.string().min(20).max(150) })
      .strict()
      .parse(req.body);
    try {
      res.json(await refreshLicense(body.key));
    } catch {
      throw new HttpError(
        503,
        "Licence validation failed. Check the key and provider connection.",
      );
    }
  }),
);
app.get(
  "/api/dashboard",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who);
    const data = await scope(db, who, async (tx) => ({
      staff: who.permissions.includes("staff.read")
        ? await tx.users.count({ where: { deleted_at: null } })
        : null,
      rooms: await tx.rooms.count({ where: { deleted_at: null } }),
      devices: who.permissions.includes("devices.read")
        ? await tx.devices.count({
            where: { deleted_at: null, revoked_at: null },
          })
        : null,
      pending: await tx.sync_queue.count({ where: { status: "pending" } }),
      failed: await tx.sync_queue.count({ where: { status: "failed" } }),
    }));
    res.json({ ...data, license: await getLicense(), syncImplemented: false });
  }),
);
app.get(
  "/api/users",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "staff.read");
    res.json(
      await scope(db, who, (tx) =>
        tx.users.findMany({
          where: { deleted_at: null },
          take: 100,
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            email: true,
            role_id: true,
            is_active: true,
            force_password_change: true,
          },
        }),
      ),
    );
  }),
);
app.post(
  "/api/users",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "staff.write");
    const license = await getLicense();
    if (!license.writable) throw new HttpError(423, license.reason);
    const body = z
      .object({
        name: z.string().min(1).max(150),
        email: z
          .string()
          .email()
          .transform((s) => s.toLowerCase()),
        password: passwordSchema,
        roleId: z.string().uuid(),
      })
      .strict()
      .parse(req.body);
    const hash = await bcrypt.hash(body.password, 12);
    const user = await scope(db, { ...who, writable: true }, async (tx) => {
      if (
        !(await tx.roles.findFirst({
          where: { id: body.roleId, deleted_at: null },
        }))
      )
        throw new HttpError(400, "Role not found.");
      return mutation(tx, () =>
        tx.users.create({
          data: {
            ...base(who),
            name: body.name,
            email: body.email,
            password_hash: hash,
            role_id: body.roleId,
          },
          select: { id: true, name: true, email: true },
        }),
      );
    });
    res.status(201).json(user);
  }),
);
app.patch(
  "/api/users/:id",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "staff.write");
    const license = await getLicense();
    if (!license.writable) throw new HttpError(423, license.reason);
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        roleId: z.string().uuid().optional(),
        isActive: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    if (id === who.userId)
      throw new HttpError(
        400,
        "Use another administrator to change your access.",
      );
    await scope(db, { ...who, writable: true }, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${who.tenantId}))`;
      const target = await tx.users.findFirst({
        where: { id, deleted_at: null },
      });
      if (!target) throw new HttpError(404, "Staff member not found.");
      if (
        body.roleId &&
        !(await tx.roles.findFirst({
          where: { id: body.roleId, deleted_at: null },
        }))
      )
        throw new HttpError(400, "Role not found.");
      await mutation(tx, () =>
        tx.users.update({
          where: { id },
          data: {
            role_id: body.roleId,
            is_active: body.isActive,
            token_version: { increment: 1 },
          },
        }),
      );
      await tx.refresh_sessions.updateMany({
        where: { user_id: id, revoked_at: null },
        data: { revoked_at: new Date() },
      });
    });
    res.status(204).end();
  }),
);
app.get(
  "/api/roles",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "roles.read");
    res.json(
      await scope(db, who, (tx) =>
        tx.roles.findMany({
          where: { deleted_at: null },
          orderBy: { name: "asc" },
        }),
      ),
    );
  }),
);
app.post(
  "/api/roles",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "roles.write");
    const license = await getLicense();
    if (!license.writable) throw new HttpError(423, license.reason);
    const body = z
      .object({
        name: z.string().min(2).max(50),
        permissions: z.array(z.enum(permissions)).max(permissions.length),
      })
      .strict()
      .parse(req.body);
    res
      .status(201)
      .json(
        await scope(db, { ...who, writable: true }, (tx) =>
          mutation(tx, () =>
            tx.roles.create({ data: { ...base(who), ...body } }),
          ),
        ),
      );
  }),
);
app.get(
  "/api/devices",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "devices.read");
    res.json(
      await scope(db, who, (tx) =>
        tx.devices.findMany({
          where: { deleted_at: null },
          take: 100,
          orderBy: { created_at: "asc" },
        }),
      ),
    );
  }),
);
app.post(
  "/api/devices",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "devices.write");
    const license = await getLicense();
    if (!license.writable || !license.claims)
      throw new HttpError(423, license.reason);
    const max = license.claims.maxDevices;
    const body = z
      .object({
        label: z.string().min(1).max(100),
        assigned_department: z.string().max(80).optional(),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(
      await scope(db, { ...who, writable: true }, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${who.tenantId}))`;
        if (
          (await tx.devices.count({
            where: { deleted_at: null, revoked_at: null },
          })) >= max
        )
          throw new HttpError(409, "Your plan device limit has been reached.");
        return mutation(tx, () =>
          tx.devices.create({ data: { ...base(who), ...body } }),
        );
      }),
    );
  }),
);
app.get(
  "/api/settings",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "settings.read");
    res.json(
      await scope(db, who, (tx) =>
        tx.settings.findMany({ where: { deleted_at: null }, take: 100 }),
      ),
    );
  }),
);
const settingsSchema = z.discriminatedUnion("key", [
  z.object({
    key: z.literal("branding"),
    value: z
      .object({
        name: z.string().min(1).max(120),
        address: z.string().max(500),
        logoUrl: z
          .string()
          .max(300)
          .refine(
            (v) => v === "" || v.startsWith("/assets/"),
            "Use a local /assets/ logo path",
          ),
      })
      .strict(),
  }),
  z.object({
    key: z.literal("printer"),
    value: printerSchema,
  }),
  z.object({
    key: z.literal("receipt_footer"),
    value: z.object({ text: z.string().max(500) }).strict(),
  }),
]);
app.put(
  "/api/settings",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "settings.write");
    const license = await getLicense();
    if (!license.writable) throw new HttpError(423, license.reason);
    const body = settingsSchema.parse(req.body);
    res.json(
      await scope(db, { ...who, writable: true }, async (tx) => {
        const existing = await tx.settings.findFirst({
          where: { key: body.key },
        });
        return mutation(tx, () =>
          existing
            ? tx.settings.update({
                where: { id: existing.id },
                data: { value: body.value },
              })
            : tx.settings.create({ data: { ...base(who), ...body } }),
        );
      }),
    );
  }),
);
app.put(
  "/api/gateway-credentials",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "settings.write");
    const license = await getLicense();
    if (!license.writable) throw new HttpError(423, license.reason);
    const body = z
      .object({
        gateway: z.enum(["paystack", "flutterwave"]),
        secretKey: z.string().min(10).max(500),
      })
      .strict()
      .parse(req.body);
    const encrypted = encryptSecret(
      { secretKey: body.secretKey },
      env.CREDENTIAL_ENCRYPTION_KEY,
      who.tenantId,
      body.gateway,
    );
    await scope(db, { ...who, writable: true }, async (tx) => {
      const old = await tx.gateway_credentials.findFirst({
        where: { gateway: body.gateway },
      });
      await mutation(tx, () =>
        old
          ? tx.gateway_credentials.update({
              where: { id: old.id },
              data: { encrypted_payload: encrypted },
            })
          : tx.gateway_credentials.create({
              data: {
                ...base(who),
                gateway: body.gateway,
                encrypted_payload: encrypted,
              },
            }),
      );
    });
    res.status(204).end();
  }),
);
app.get(
  "/api/audit",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "audit.read");
    if (who.roleName !== "admin")
      throw new HttpError(403, "Only administrators can view the audit trail.");
    res.json(
      await scope(db, who, (tx) =>
        tx.audit_log.findMany({
          where: { deleted_at: null },
          orderBy: [{ occurred_at: "desc" }, { id: "desc" }],
          take: 100,
        }),
      ),
    );
  }),
);
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Endpoint not available in Phase 1." }),
);
app.use(
  express.static("apps/web/dist", {
    setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=0"),
  }),
);
app.get("*", (_req, res) =>
  res.sendFile("index.html", { root: "apps/web/dist" }),
);
app.use(errors);
