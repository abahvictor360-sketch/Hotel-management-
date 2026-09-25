import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { identity, requirePermission, type Identity } from "./auth.js";
import { db, scope, base, mutation, type Tx } from "./db.js";
import { route, HttpError } from "./http.js";
import { getLicense } from "./licensing.js";
import { env } from "./config.js";
import {
  buildReport,
  rangeSchema,
  reportKinds,
  type Query,
} from "./reports.js";
import { tenantExport } from "./exports.js";
import {
  REMOTE_SETTING,
  MAX_ACTIVE,
  remoteScopes,
  issueToken,
  parseStored,
  publicView,
  isActive,
} from "./remote-access.js";
import { sendReport, sendExport, formatSchema } from "./report-http.js";
export const reporting = Router();
export const prismaQuery =
  (tx: Tx): Query =>
  (sql, params = []) =>
    tx.$queryRawUnsafe(sql, ...params);
// Reads only, so reports keep working while the licence is read-only.
reporting.get(
  "/reports/:kind",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "reports.read");
    const kind = z.enum(reportKinds).parse(req.params.kind);
    const { format, ...range } = z
      .object({ from: z.string(), to: z.string(), format: formatSchema })
      .strict()
      .parse(req.query);
    const r = rangeSchema.parse(range);
    const report = await scope(db, who, (tx) =>
      buildReport(prismaQuery(tx), kind, r, "hub"),
    );
    sendReport(res, report, format);
  }),
);
const adminOnly = (who: Identity) => {
  if (who.roleName !== "admin")
    throw new HttpError(403, "Only administrators can do this.");
};
async function audit(
  who: Identity,
  action: string,
  entityId: string,
  after: object,
) {
  await scope(db, who, (tx) =>
    tx.audit_log.create({
      data: {
        ...base(who),
        user_id: who.userId,
        action,
        entity: "tenants",
        entity_id: entityId,
        after,
        occurred_at: new Date(),
      },
    }),
  );
}
// Full departure export. Available in read-only mode on purpose: a cancelled hotel must
// still be able to take its records away.
reporting.get(
  "/exports/tenant",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "settings.read");
    adminOnly(who);
    const out = await scope(
      db,
      who,
      (tx) => tenantExport(prismaQuery(tx), "hub"),
      {
        timeout: 120_000,
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    );
    await audit(who, "tenant_export", who.tenantId, {
      tables: out.manifest.tables.length,
      rows: out.manifest.tables.reduce((a, t) => a + t.rows, 0),
    });
    sendExport(res, out.manifest.hotel, out.zip);
  }),
);
async function stored(tx: Tx) {
  const row = await tx.settings.findFirst({
    where: { key: REMOTE_SETTING, deleted_at: null },
  });
  return { row, tokens: parseStored(row?.value) };
}
reporting.get(
  "/remote-access",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "settings.write");
    adminOnly(who);
    const license = await getLicense();
    const tokens = await scope(
      db,
      who,
      async (tx) => (await stored(tx)).tokens,
    );
    res.json({
      dashboardIncluded: license.claims?.features.mobile_dashboard === true,
      dashboardUrl: env.CLOUD_DASHBOARD_URL ?? null,
      syncConfigured: !!(env.SYNC_DATABASE_URL && env.CLOUD_SYNC_URL),
      tokens: tokens.map(publicView).reverse(),
    });
  }),
);
reporting.post(
  "/remote-access",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "settings.write");
    adminOnly(who);
    const license = await getLicense();
    if (!license.writable) throw new HttpError(423, license.reason);
    const body = z
      .object({
        label: z.string().trim().min(2).max(80),
        days: z.number().int().min(1).max(365),
        scopes: z.array(z.enum(remoteScopes)).min(1).max(2),
      })
      .strict()
      .parse(req.body);
    if (
      body.scopes.includes("reports") &&
      license.claims?.features.mobile_dashboard !== true
    )
      throw new HttpError(
        403,
        "The remote management dashboard is not part of this hotel's plan. Export-only access is still available.",
      );
    const issued = issueToken(who.tenantId, body, who.userId);
    await scope(db, { ...who, writable: true }, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${who.tenantId}:remote`}))`;
      const { row, tokens } = await stored(tx);
      if (tokens.filter((t) => isActive(t)).length >= MAX_ACTIVE)
        throw new HttpError(
          409,
          `Revoke an access link first. At most ${MAX_ACTIVE} can be active.`,
        );
      // Keep the newest 50 records; expired and revoked ones age out.
      const value = { tokens: [...tokens, issued.record].slice(-50) };
      await mutation(tx, () =>
        row
          ? tx.settings.update({ where: { id: row.id }, data: { value } })
          : tx.settings.create({
              data: { ...base(who), key: REMOTE_SETTING, value },
            }),
      );
    });
    // The only time the secret leaves the hub. It reaches the cloud as a hash on next sync.
    res
      .status(201)
      .json({ token: issued.token, access: publicView(issued.record) });
  }),
);
reporting.delete(
  "/remote-access/:id",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "settings.write");
    adminOnly(who);
    const license = await getLicense();
    if (!license.writable) throw new HttpError(423, license.reason);
    const id = z.string().uuid().parse(req.params.id);
    await scope(db, { ...who, writable: true }, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${who.tenantId}:remote`}))`;
      const { row, tokens } = await stored(tx);
      const t = tokens.find((x) => x.id === id);
      if (!row || !t) throw new HttpError(404, "Access link not found.");
      if (t.revokedAt) return;
      t.revokedAt = new Date().toISOString();
      await mutation(tx, () =>
        tx.settings.update({
          where: { id: row.id },
          data: { value: { tokens } },
        }),
      );
    });
    res.status(204).end();
  }),
);
