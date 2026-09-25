import { Router } from "express";
import { z } from "zod";
import { identity, requirePermission } from "./auth.js";
import { db, scope, base } from "./db.js";
import { route } from "./http.js";
import { getHubSync } from "./sync-worker.js";
export const sync = Router();
const uuid = z.string().uuid();
async function counts(who: Parameters<typeof scope>[1]) {
  return scope(db, who, async (tx) => ({
    pending: await tx.sync_queue.count({ where: { status: "pending" } }),
    failed: await tx.sync_queue.count({ where: { status: "failed" } }),
  }));
}
// Header indicator for every signed-in user: synced, syncing, offline or error.
sync.get(
  "/sync/status",
  route(async (req, res) => {
    const who = await identity(req);
    const c = await counts(who);
    const s = getHubSync()?.snapshot() ?? {
      configured: false,
      online: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
    };
    const state = !s.configured
      ? "disabled"
      : s.online === false
        ? "offline"
        : s.lastError || c.failed
          ? "error"
          : c.pending || s.online === null
            ? "syncing"
            : "synced";
    res.json({ state, ...c, ...s });
  }),
);
sync.get(
  "/sync/queue",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "sync.manage");
    const p = z
      .object({
        status: z.enum(["pending", "failed"]).default("failed"),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    res.json(
      await scope(db, who, async (tx) => ({
        rows: await tx.sync_queue.findMany({
          where: { status: p.status },
          orderBy: { seq: "asc" },
          skip: (p.page - 1) * p.pageSize,
          take: p.pageSize,
          select: {
            id: true,
            table_name: true,
            record_id: true,
            operation: true,
            attempts: true,
            last_error: true,
            created_at: true,
            next_attempt_at: true,
            device_id: true,
          },
        }),
        total: await tx.sync_queue.count({ where: { status: p.status } }),
        ...p,
      })),
    );
  }),
);
// Resets failed rows for another 10 attempts. Recorded in the audit trail.
sync.post(
  "/sync/retry",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "sync.manage");
    const body = z
      .union([
        z.object({ ids: z.array(uuid).min(1).max(100) }).strict(),
        z.object({ allFailed: z.literal(true) }).strict(),
      ])
      .parse(req.body);
    const retried = await scope(db, who, async (tx) => {
      const where = {
        status: "failed" as const,
        ...("ids" in body ? { id: { in: body.ids } } : {}),
      };
      const { count } = await tx.sync_queue.updateMany({
        where,
        data: {
          status: "pending",
          attempts: 0,
          next_attempt_at: null,
          last_error: null,
        },
      });
      await tx.audit_log.create({
        data: {
          ...base(who),
          user_id: who.userId,
          action: "sync_retry",
          entity: "sync_queue",
          entity_id: "ids" in body ? body.ids[0] : who.tenantId,
          after: { count, ...body },
          occurred_at: new Date(),
        },
      });
      return count;
    });
    void getHubSync()?.runNow();
    res.json({ retried });
  }),
);
sync.post(
  "/sync/run",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "sync.manage");
    void getHubSync()?.runNow();
    res.status(202).json({ started: !!getHubSync() });
  }),
);
