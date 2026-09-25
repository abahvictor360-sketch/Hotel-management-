import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { scope, base, mutation } from "./db.js";
import { route, errors, HttpError } from "./http.js";
import { hashToken, opaqueToken } from "../../../packages/core/src/crypto.js";
import { plans } from "../../../packages/core/src/permissions.js";
import { signLicense, GRACE_MS } from "../../../packages/core/src/license.js";
const config = z
  .object({
    PROVIDER_DATABASE_URL: z.string(),
    PROVIDER_JWT_SECRET: z.string().min(32),
    PROVIDER_PASSWORD_HASH: z.string().min(50),
    LICENSE_PRIVATE_KEY_FILE: z.string(),
    PROVIDER_ORIGIN: z.string().default("http://localhost:5174"),
  })
  .parse(process.env);
export const providerDb = new PrismaClient({
  datasourceUrl: config.PROVIDER_DATABASE_URL,
});
const privateKey = readFileSync(config.LICENSE_PRIVATE_KEY_FILE, "utf8");
export const providerApp = express();
providerApp.disable("x-powered-by");
providerApp.use(helmet());
providerApp.use(express.json({ limit: "128kb" }));
providerApp.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.headers.origin && req.headers.origin !== config.PROVIDER_ORIGIN)
    return res.status(403).json({ error: "Untrusted origin." });
  next();
});
const limit = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
providerApp.post(
  "/api/provider/login",
  limit,
  route(async (req, res) => {
    const body = z
      .object({ password: z.string().max(200) })
      .strict()
      .parse(req.body);
    if (!(await bcrypt.compare(body.password, config.PROVIDER_PASSWORD_HASH)))
      throw new HttpError(401, "Invalid provider credentials.");
    res.json({
      accessToken: jwt.sign({ scope: "provider" }, config.PROVIDER_JWT_SECRET, {
        subject: "owner",
        issuer: "hotel-provider",
        audience: "provider-console",
        expiresIn: "15m",
        algorithm: "HS256",
      }),
    });
  }),
);
providerApp.post(
  "/api/license/validate",
  limit,
  route(async (req, res) => {
    const body = z
      .object({
        key: z.string().min(20).max(150),
        tenantId: z.string().uuid(),
        installationId: z.string().uuid(),
        schemaVersion: z.literal(1),
      })
      .strict()
      .parse(req.body);
    // This is an activation exchange, not an operational tenant API. Possession of the
    // random licence secret must match the claimed tenant before anything is returned.
    const result = await scope(
      providerDb,
      { tenantId: body.tenantId, writable: true },
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${body.tenantId}))`;
        const license = await tx.licenses.findFirst({
          where: {
            tenant_id: body.tenantId,
            key_hash: hashToken(body.key),
            revoked_at: null,
            deleted_at: null,
          },
        });
        if (
          !license ||
          (license.installation_id &&
            license.installation_id !== body.installationId)
        )
          throw new HttpError(403, "Licence is invalid for this hub.");
        if (!license.installation_id)
          await mutation(tx, () =>
            tx.licenses.update({
              where: { id: license.id },
              data: { installation_id: body.installationId },
            }),
          );
        const sub = await tx.subscriptions.findFirstOrThrow({
          where: { tenant_id: body.tenantId, deleted_at: null },
        });
        const now = Date.now();
        return signLicense(
          {
            tenantId: body.tenantId,
            installationId: body.installationId,
            licenseId: license.id,
            status: sub.status,
            plan: sub.plan,
            maxDevices: sub.max_devices,
            maxRooms: sub.max_rooms,
            features: z.record(z.boolean()).parse(sub.features),
            issuedAt: now,
            validUntil: now + GRACE_MS,
            trialEndsAt: sub.trial_ends_at?.getTime() ?? null,
            schemaVersion: 1,
          },
          privateKey,
        );
      },
    );
    res.json({ token: result });
  }),
);
providerApp.use("/api/provider", (req, res, next) => {
  try {
    const c = jwt.verify(
      req.headers.authorization?.replace(/^Bearer /, "") ?? "",
      config.PROVIDER_JWT_SECRET,
      {
        algorithms: ["HS256"],
        issuer: "hotel-provider",
        audience: "provider-console",
      },
    );
    if (typeof c === "string" || c.sub !== "owner" || c.scope !== "provider")
      throw new Error();
    next();
  } catch {
    res.status(401).json({ error: "Provider sign-in required." });
  }
});
providerApp.get(
  "/api/provider/tenants",
  route(async (_req, res) => {
    const tenants = await providerDb.tenants.findMany({
      where: { deleted_at: null },
      take: 100,
      orderBy: { created_at: "desc" },
    });
    const rows = await Promise.all(
      tenants.map(async (tenant) => ({
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        subscription: await providerDb.subscriptions.findFirst({
          where: { tenant_id: tenant.id, deleted_at: null },
        }),
        health: await providerDb.hub_heartbeats.findFirst({
          where: { tenant_id: tenant.id },
          orderBy: { seen_at: "desc" },
        }),
      })),
    );
    res.json(rows);
  }),
);
providerApp.post(
  "/api/provider/tenants",
  route(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2).max(120),
        slug: z.string().regex(/^[a-z0-9-]{3,60}$/),
        plan: z.enum(["standard", "premium"]),
      })
      .strict()
      .parse(req.body);
    const id = randomUUID(),
      key = opaqueToken();
    const plan = plans[body.plan];
    await scope(
      providerDb,
      { tenantId: id, writable: true, deviceId: "provider" },
      async (tx) => {
        await mutation(tx, () =>
          tx.tenants.create({
            data: {
              ...base({ tenantId: id, deviceId: "provider" }),
              id,
              name: body.name,
              slug: body.slug,
              branding: { name: body.name, address: "", logoUrl: "" },
            },
          }),
        );
        await mutation(tx, () =>
          tx.subscriptions.create({
            data: {
              ...base({ tenantId: id, deviceId: "provider" }),
              plan: body.plan,
              status: "trial",
              trial_ends_at: new Date(Date.now() + GRACE_MS),
              features: plan.features,
              max_devices: plan.maxDevices,
              max_rooms: plan.maxRooms,
            },
          }),
        );
        await mutation(tx, () =>
          tx.licenses.create({
            data: {
              ...base({ tenantId: id, deviceId: "provider" }),
              key_hash: hashToken(key),
              issued_at: new Date(),
            },
          }),
        );
        await tx.provider_audit.create({
          data: {
            ...base({ tenantId: id, deviceId: "provider" }),
            actor: "owner",
            action: "tenant_created",
            payload: { plan: body.plan },
          },
        });
      },
    );
    res
      .status(201)
      .json({
        tenantId: id,
        licenseKey: key,
        name: body.name,
        setup:
          "Run npm run provision:hub on the hub with this tenant ID and licence key.",
      });
  }),
);
providerApp.patch(
  "/api/provider/tenants/:id/subscription",
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        status: z.enum([
          "trial",
          "active",
          "past_due",
          "suspended",
          "cancelled",
        ]),
        plan: z.enum(["standard", "premium"]).optional(),
        trialEndsAt: z.string().datetime().optional(),
      })
      .strict()
      .parse(req.body);
    await scope(
      providerDb,
      { tenantId: id, writable: true, deviceId: "provider" },
      async (tx) => {
        const old = await tx.subscriptions.findFirst({
          where: { tenant_id: id, deleted_at: null },
        });
        if (!old) throw new HttpError(404, "Hotel not found.");
        const plan = body.plan ? plans[body.plan] : null;
        await mutation(tx, () =>
          tx.subscriptions.update({
            where: { id: old.id },
            data: {
              status: body.status,
              trial_ends_at: body.trialEndsAt
                ? new Date(body.trialEndsAt)
                : undefined,
              ...(plan
                ? {
                    plan: body.plan,
                    max_devices: plan.maxDevices,
                    max_rooms: plan.maxRooms,
                    features: plan.features,
                  }
                : {}),
            },
          }),
        );
        await tx.provider_audit.create({
          data: {
            ...base({ tenantId: id, deviceId: "provider" }),
            actor: "owner",
            action: "subscription_changed",
            payload: body,
          },
        });
      },
    );
    res.status(204).end();
  }),
);
providerApp.post(
  "/api/provider/tenants/:id/license",
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id),
      key = opaqueToken();
    await scope(
      providerDb,
      { tenantId: id, writable: true, deviceId: "provider" },
      async (tx) => {
        if (!(await tx.tenants.findFirst({ where: { id, deleted_at: null } })))
          throw new HttpError(404, "Hotel not found.");
        const old = await tx.licenses.findMany({
          where: { tenant_id: id, revoked_at: null },
        });
        for (const row of old)
          await mutation(tx, () =>
            tx.licenses.update({
              where: { id: row.id },
              data: { revoked_at: new Date() },
            }),
          );
        await mutation(tx, () =>
          tx.licenses.create({
            data: {
              ...base({ tenantId: id, deviceId: "provider" }),
              key_hash: hashToken(key),
              issued_at: new Date(),
            },
          }),
        );
        await tx.provider_audit.create({
          data: {
            ...base({ tenantId: id, deviceId: "provider" }),
            actor: "owner",
            action: "license_rotated",
            payload: {},
          },
        });
      },
    );
    res.status(201).json({ licenseKey: key });
  }),
);
providerApp.use("/api", (_req, res) =>
  res.status(404).json({ error: "Not found." }),
);
providerApp.use(express.static("apps/provider/dist"));
providerApp.get("*", (_req, res) =>
  res.sendFile("index.html", { root: "apps/provider/dist" }),
);
providerApp.use(errors);
