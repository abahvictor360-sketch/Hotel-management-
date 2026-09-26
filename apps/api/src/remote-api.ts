import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { route, HttpError } from "./http.js";
import type { Conn } from "./sync-apply.js";
import {
  buildReport,
  rangeSchema,
  reportKinds,
  type Query,
} from "./reports.js";
import { tenantExport } from "./exports.js";
import { sendReport, sendExport, formatSchema } from "./report-http.js";
import {
  REMOTE_SETTING,
  parseStored,
  parseToken,
  verifyToken,
  type RemoteToken,
} from "./remote-access.js";
import {
  publicBranding,
  readBranding,
} from "../../../packages/core/src/branding.js";
// Read-only management dashboard over the cloud copy. Every request runs as report_reader
// inside a READ ONLY transaction for the one hotel named in its access token.
type Connect = () => Promise<{ conn: Conn; release: () => void }>;
const liveStatuses = ["trial", "active", "past_due"];
export async function readTx<T>(
  connect: Connect,
  tenantId: string,
  fn: (q: Query) => Promise<T>,
): Promise<T> {
  const { conn, release } = await connect();
  try {
    await conn.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await conn.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    const result = await fn(
      async (sql, params) => (await conn.query(sql, params)).rows,
    );
    await conn.query("COMMIT");
    return result;
  } catch (error) {
    await conn.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    release();
  }
}
type Access = {
  tenant: string;
  token: RemoteToken;
  hotel: string;
  brand: ReturnType<typeof publicBranding>;
  dashboard: boolean;
  subscription: string | null;
  lastSyncAt: string | null;
};
export function remoteRouter(connect: Connect) {
  const router = Router();
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  );
  const seen = new WeakMap<Request, Access>();
  router.use((req, _res, next) => {
    void (async () => {
      const parsed = parseToken(req.headers.authorization);
      if (!parsed)
        throw new HttpError(401, "A remote access link is required.");
      const access = await readTx(connect, parsed.tenant, async (q) => {
        const [setting] = await q(
          "SELECT value FROM settings WHERE key=$1 AND deleted_at IS NULL LIMIT 1",
          [REMOTE_SETTING],
        );
        const token = verifyToken(
          parseStored(setting?.value),
          parsed.id,
          parsed.secret,
        );
        if (!token) return null;
        const [sub] = await q(
          "SELECT status::text AS status,features FROM subscriptions WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
        );
        const [hotel] = await q(
          "SELECT name FROM tenants WHERE id=public.context_tenant()",
        );
        const [brandRow] = await q(
          "SELECT value FROM settings WHERE key='branding' AND deleted_at IS NULL LIMIT 1",
        );
        const brand = publicBranding(
          readBranding(brandRow?.value, (hotel?.name as string) ?? "Hotel"),
        );
        const [beat] = await q(
          "SELECT max(last_sync_at) AS at FROM hub_heartbeats",
        );
        return {
          tenant: parsed.tenant,
          token,
          hotel: brand.name,
          brand,
          subscription: (sub?.status as string) ?? null,
          dashboard:
            !!sub &&
            liveStatuses.includes(sub.status) &&
            sub.features?.mobile_dashboard === true,
          lastSyncAt: beat?.at ? new Date(beat.at).toISOString() : null,
        };
      });
      // Same answer for unknown, revoked, expired and not-yet-synced tokens.
      if (!access)
        throw new HttpError(
          401,
          "This access link is not valid. Ask the hotel administrator for a new one.",
        );
      seen.set(req, access);
      next();
    })().catch(next);
  });
  const need = (req: Request, scope: "reports" | "export") => {
    const a = seen.get(req)!;
    if (!a.token.scopes.includes(scope))
      throw new HttpError(
        403,
        scope === "export"
          ? "This link cannot download a data export."
          : "This link is for data export only.",
      );
    if (scope === "reports" && !a.dashboard)
      throw new HttpError(
        403,
        a.subscription && !liveStatuses.includes(a.subscription)
          ? "The subscription is not active, so the dashboard is closed. Data export stays available."
          : "The remote dashboard is not part of this hotel's plan.",
      );
    return a;
  };
  router.get(
    "/session",
    route(async (req, res) => {
      const a = seen.get(req)!;
      res.json({
        hotel: a.hotel,
        brand: a.brand,
        label: a.token.label,
        scopes: a.token.scopes,
        expiresAt: a.token.expiresAt,
        dashboard: a.dashboard,
        subscription: a.subscription,
        lastSyncAt: a.lastSyncAt,
      });
    }),
  );
  router.get(
    "/reports/:kind",
    route(async (req, res) => {
      const a = need(req, "reports");
      const kind = z.enum(reportKinds).parse(req.params.kind);
      const { format, ...range } = z
        .object({ from: z.string(), to: z.string(), format: formatSchema })
        .strict()
        .parse(req.query);
      const r = rangeSchema.parse(range);
      sendReport(
        res,
        await readTx(connect, a.tenant, (q) =>
          buildReport(q, kind, r, "cloud"),
        ),
        format,
      );
    }),
  );
  // Departure export from the cloud copy. Works for suspended and cancelled hotels.
  router.get(
    "/export",
    route(async (req, res) => {
      const a = need(req, "export");
      const out = await readTx(connect, a.tenant, (q) =>
        tenantExport(q, "cloud"),
      );
      console.log(
        JSON.stringify({
          event: "remote_export",
          tenant: a.tenant,
          access: a.token.id,
          tables: out.manifest.tables.length,
        }),
      );
      sendExport(res, out.manifest.hotel, out.zip);
    }),
  );
  return router;
}
