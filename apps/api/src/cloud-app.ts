import express, { type Request } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { route, errors, HttpError } from "./http.js";
import { hashToken } from "../../../packages/core/src/crypto.js";
import {
  SYNC_PROTOCOL,
  DATABASE_REVISION,
  BATCH_SIZE,
  MAX_ATTEMPTS,
  replicatedTables,
  pullTables,
} from "../../../packages/core/src/sync-contract.js";
import { applyEvent, tenantTx, type Conn } from "./sync-apply.js";
// Cloud side of replication. Hubs never receive cloud database credentials: each request
// proves possession of that hotel's licence key for its bound installation, and every
// query runs under that hotel's RLS context as the non-owner sync_agent role.
type Connect = () => Promise<{ conn: Conn; release: () => void }>;
const uuid = z.string().uuid();
const version = {
  protocol: z.number().int(),
  databaseRevision: z.number().int(),
};
const pushSchema = z
  .object({
    ...version,
    hub: z
      .object({
        version: z.string().max(40),
        pending: z.number().int().min(0),
        failed: z.number().int().min(0),
        rooms: z.number().int().min(0),
        devices: z.number().int().min(0),
        lastError: z.string().max(500).nullable(),
      })
      .strict(),
    events: z
      .array(
        z
          .object({
            id: uuid,
            table: z.string().max(64),
            recordId: uuid,
            operation: z.enum(["insert", "update"]),
            payload: z.string().max(1_000_000),
          })
          .strict(),
      )
      .max(BATCH_SIZE),
  })
  .strict();
const pullSchema = z
  .object({ ...version, limit: z.number().int().min(1).max(BATCH_SIZE) })
  .strict();
const ackSchema = z
  .object({
    ...version,
    applied: z.array(uuid).max(BATCH_SIZE),
    failed: z
      .array(z.object({ id: uuid, error: z.string().max(500) }).strict())
      .max(BATCH_SIZE),
  })
  .strict();
function checkVersion(body: { protocol: number; databaseRevision: number }) {
  if (
    body.protocol !== SYNC_PROTOCOL ||
    body.databaseRevision !== DATABASE_REVISION
  )
    throw new HttpError(
      409,
      `Version mismatch. Cloud runs protocol ${SYNC_PROTOCOL}, database revision ${DATABASE_REVISION}.`,
    );
}
export function createCloudApp(connect: Connect) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "8mb" }));
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/api/health", (_req, res) =>
    res.json({
      status: "ok",
      protocol: SYNC_PROTOCOL,
      databaseRevision: DATABASE_REVISION,
    }),
  );
  app.use(
    "/api/sync",
    rateLimit({
      windowMs: 60_000,
      limit: 240,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  );
  const hubs = new WeakMap<Request, { tenant: string; installation: string }>();
  app.use("/api/sync", (req, _res, next) => {
    void (async () => {
      const tenant = uuid.safeParse(req.headers["x-hotel-id"]);
      const installation = uuid.safeParse(req.headers["x-installation-id"]);
      const key = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (!tenant.success || !installation.success || key.length < 20)
        throw new HttpError(401, "Hub credentials required.");
      const found = await tenantTx(connect, tenant.data, (c) =>
        c.query(
          "SELECT 1 FROM licenses WHERE key_hash=$1 AND installation_id=$2 AND revoked_at IS NULL AND deleted_at IS NULL",
          [hashToken(key), installation.data],
        ),
      );
      if (!found.rows.length)
        throw new HttpError(401, "Hub credentials were rejected.");
      hubs.set(req, { tenant: tenant.data, installation: installation.data });
      next();
    })().catch(next);
  });
  app.post(
    "/api/sync/push",
    route(async (req, res) => {
      const hub = hubs.get(req)!;
      const body = pushSchema.parse(req.body);
      checkVersion(body);
      const results = await tenantTx(connect, hub.tenant, async (c) => {
        const out = [];
        for (const event of body.events)
          out.push(
            await applyEvent(c, hub.tenant, event, "cloud", replicatedTables),
          );
        const errorsSeen = out.filter((r) => r.status === "error").length;
        await c.query(
          `INSERT INTO hub_heartbeats(id,tenant_id,device_id,installation_id,hub_version,schema_version,last_sync_at,device_count,room_count,pending_count,failed_count,errors,seen_at)
           VALUES($1,$2,'sync',$3,$4,$5,now(),$6,$7,$8,$9,$10::jsonb,now())
           ON CONFLICT(tenant_id,installation_id) DO UPDATE SET hub_version=EXCLUDED.hub_version,schema_version=EXCLUDED.schema_version,
           last_sync_at=EXCLUDED.last_sync_at,device_count=EXCLUDED.device_count,room_count=EXCLUDED.room_count,
           pending_count=EXCLUDED.pending_count,failed_count=EXCLUDED.failed_count,errors=EXCLUDED.errors,seen_at=EXCLUDED.seen_at,updated_at=now()`,
          [
            randomUUID(),
            hub.tenant,
            hub.installation,
            body.hub.version,
            DATABASE_REVISION,
            body.hub.devices,
            body.hub.rooms,
            body.hub.pending,
            body.hub.failed,
            JSON.stringify(
              [
                body.hub.lastError,
                errorsSeen ? `${errorsSeen} rows rejected` : null,
              ].filter(Boolean),
            ),
          ],
        );
        return out;
      });
      res.json({ results });
    }),
  );
  app.post(
    "/api/sync/pull",
    route(async (req, res) => {
      const hub = hubs.get(req)!;
      const body = pullSchema.parse(req.body);
      checkVersion(body);
      const events = await tenantTx(connect, hub.tenant, async (c) =>
        (
          await c.query(
            `SELECT id::text AS id,table_name AS "table",record_id::text AS "recordId",operation::text AS operation,payload::text AS payload
             FROM sync_queue WHERE status='pending' AND table_name=ANY($1::text[])
             AND (next_attempt_at IS NULL OR next_attempt_at<=now()) ORDER BY seq LIMIT $2`,
            [pullTables, body.limit],
          )
        ).rows,
      );
      res.json({ events });
    }),
  );
  app.post(
    "/api/sync/ack",
    route(async (req, res) => {
      const hub = hubs.get(req)!;
      const body = ackSchema.parse(req.body);
      checkVersion(body);
      await tenantTx(connect, hub.tenant, async (c) => {
        const sent = (
          await c.query(
            `UPDATE sync_queue SET status='sent',sent_at=now(),updated_at=now(),last_error=NULL
             WHERE id=ANY($1::uuid[]) AND table_name=ANY($2::text[]) AND status<>'sent' RETURNING table_name,record_id::text AS record_id`,
            [body.applied, pullTables],
          )
        ).rows;
        const bookings = sent
          .filter((r) => r.table_name === "online_bookings")
          .map((r) => r.record_id);
        // The hub now owns these bookings. updated_at is preserved for sync_agent.
        if (bookings.length)
          await c.query(
            "UPDATE online_bookings SET processed=true WHERE id=ANY($1::uuid[]) AND NOT processed",
            [bookings],
          );
        for (const f of body.failed)
          await c.query(
            `UPDATE sync_queue SET attempts=attempts+1,last_error=$2,updated_at=now(),
             status=CASE WHEN attempts+1>=$3 THEN 'failed'::"SyncStatus" ELSE 'pending'::"SyncStatus" END,
             next_attempt_at=now()+make_interval(secs=>least(30*power(2,attempts),3600))
             WHERE id=$1 AND status='pending' AND table_name=ANY($4::text[])`,
            [f.id, f.error, MAX_ATTEMPTS, pullTables],
          );
      });
      res.status(204).end();
    }),
  );
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));
  app.use(errors);
  return app;
}
