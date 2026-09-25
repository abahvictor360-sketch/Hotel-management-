import { randomUUID } from "node:crypto";
import {
  SYNC_PROTOCOL,
  DATABASE_REVISION,
  BATCH_SIZE,
  MAX_ATTEMPTS,
  SYNC_INTERVAL_MS,
  pullTables,
} from "../../../packages/core/src/sync-contract.js";
import {
  applyEvent,
  audit,
  tenantTx,
  type ApplyResult,
  type Conn,
  type SyncEvent,
} from "./sync-apply.js";
type Connect = () => Promise<{ conn: Conn; release: () => void }>;
export type Transport = (
  path: string,
  body: unknown,
) => Promise<{ status: number; body: any }>;
// Internet or cloud host unreachable. Never consumes a row's retry attempts: an outage
// of any length must leave every change pending, not failed.
export class OfflineError extends Error {}
class SyncError extends Error {}
export function httpTransport(
  baseUrl: string,
  licenseKey: string,
  tenantId: string,
  installationId: string,
): Transport {
  return async (path, body) => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${licenseKey}`,
          "X-Hotel-Id": tenantId,
          "X-Installation-Id": installationId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new OfflineError("Cloud unreachable.");
    }
    if ([502, 503, 504].includes(response.status))
      throw new OfflineError(`Cloud service unavailable (${response.status}).`);
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json().catch(() => null),
    };
  };
}
export type SyncSnapshot = {
  configured: boolean;
  online: boolean | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};
const version = { protocol: SYNC_PROTOCOL, databaseRevision: DATABASE_REVISION };
export class SyncWorker {
  private running: Promise<void> | null = null;
  private online: boolean | null = null;
  private lastAttemptAt: Date | null = null;
  private lastSuccessAt: Date | null = null;
  private lastError: string | null = null;
  constructor(
    private connect: Connect,
    private tenantId: string,
    private transport: Transport | null,
    private hubVersion: string,
  ) {}
  snapshot(): SyncSnapshot {
    return {
      configured: !!this.transport,
      online: this.online,
      lastAttemptAt: this.lastAttemptAt?.toISOString() ?? null,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      lastError: this.lastError,
    };
  }
  runNow(): Promise<void> {
    if (!this.running)
      this.running = this.cycle().finally(() => {
        this.running = null;
      });
    return this.running;
  }
  start() {
    void this.runNow();
    const timer = setInterval(() => void this.runNow(), SYNC_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  }
  private async cycle() {
    if (!this.transport) return;
    this.lastAttemptAt = new Date();
    try {
      // Always push at least once: an empty push is the reachability check and heartbeat.
      for (let i = 0; i < 20; i++)
        if ((await this.push()) < BATCH_SIZE) break;
      for (let i = 0; i < 20; i++)
        if ((await this.pull()) < BATCH_SIZE) break;
      this.online = true;
      this.lastSuccessAt = new Date();
      this.lastError = null;
    } catch (error) {
      if (error instanceof OfflineError) {
        this.online = false;
        this.lastError = null;
      } else {
        this.online = error instanceof SyncError ? true : this.online;
        this.lastError = (error as Error).message.slice(0, 500);
        console.warn(
          JSON.stringify({ event: "sync_failed", message: this.lastError }),
        );
      }
    }
  }
  private check(status: number, body: any) {
    if (status === 401 || status === 403)
      throw new SyncError(
        "Cloud rejected this hub. Check HUB_LICENSE_KEY and INSTALLATION_ID.",
      );
    if (status === 409)
      throw new SyncError(
        body?.error ??
          "Hub and cloud versions differ. Upgrade both to the same release.",
      );
  }
  private async push(): Promise<number> {
    const batch = await tenantTx(this.connect, this.tenantId, async (c) => {
      const events = (
        await c.query(
          `SELECT id::text AS id,table_name AS "table",record_id::text AS "recordId",operation::text AS operation,payload::text AS payload
           FROM sync_queue WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=now()) ORDER BY seq LIMIT $1`,
          [BATCH_SIZE],
        )
      ).rows as SyncEvent[];
      const counts = (
        await c.query(
          `SELECT (SELECT count(*)::int FROM sync_queue WHERE status='pending') AS pending,
           (SELECT count(*)::int FROM sync_queue WHERE status='failed') AS failed,
           (SELECT count(*)::int FROM rooms WHERE deleted_at IS NULL) AS rooms,
           (SELECT count(*)::int FROM devices WHERE deleted_at IS NULL AND revoked_at IS NULL) AS devices`,
        )
      ).rows[0];
      return { events, counts };
    });
    const res = await this.transport!("/api/sync/push", {
      ...version,
      hub: {
        version: this.hubVersion,
        ...batch.counts,
        lastError: this.lastError,
      },
      events: batch.events,
    });
    this.check(res.status, res.body);
    let results: ApplyResult[];
    if (res.status === 200 && Array.isArray(res.body?.results))
      results = res.body.results;
    else
      results = batch.events.map((e) => ({
        id: e.id,
        status: "error",
        error: `Cloud returned ${res.status}${res.body?.error ? `: ${res.body.error}` : ""}`,
      }));
    const byId = new Map(results.map((r) => [r.id, r]));
    await tenantTx(this.connect, this.tenantId, async (c) => {
      for (const event of batch.events) {
        const r = byId.get(event.id) ?? {
          id: event.id,
          status: "error" as const,
          error: "Cloud returned no result for this record.",
        };
        if (r.status === "error") {
          await c.query(
            `UPDATE sync_queue SET attempts=attempts+1,last_error=$2,updated_at=now(),
             status=CASE WHEN attempts+1>=$3 THEN 'failed'::"SyncStatus" ELSE 'pending'::"SyncStatus" END,
             next_attempt_at=now()+make_interval(secs=>least(30*power(2,attempts),3600))
             WHERE id=$1`,
            [event.id, r.error ?? "Rejected by cloud.", MAX_ATTEMPTS],
          );
          continue;
        }
        await c.query(
          "UPDATE sync_queue SET status='sent',sent_at=now(),updated_at=now(),last_error=$2 WHERE id=$1",
          [event.id, r.status === "stale" ? "Cloud kept a newer version." : null],
        );
        await c.query(
          `INSERT INTO sync_metadata(id,tenant_id,device_id,table_name,record_id,synced,last_synced_at,source_updated_at)
           SELECT $1,q.tenant_id,'sync',q.table_name,q.record_id,
           NOT EXISTS(SELECT 1 FROM sync_queue o WHERE o.table_name=q.table_name AND o.record_id=q.record_id AND o.status IN ('pending','failed')),
           now(),q.source_updated_at FROM sync_queue q WHERE q.id=$2
           ON CONFLICT(tenant_id,table_name,record_id) DO UPDATE SET synced=EXCLUDED.synced,last_synced_at=EXCLUDED.last_synced_at,
           source_updated_at=greatest(sync_metadata.source_updated_at,EXCLUDED.source_updated_at),updated_at=now()`,
          [randomUUID(), event.id],
        );
        if (r.conflict)
          await audit(
            c,
            this.tenantId,
            `sync_conflict_${r.conflict.winner}_wins`,
            event.table,
            event.recordId,
            null,
            event.payload,
          );
      }
    });
    if (res.status !== 200)
      throw new SyncError(
        `Cloud returned ${res.status}${res.body?.error ? `: ${res.body.error}` : ""}`,
      );
    return batch.events.length;
  }
  private async pull(): Promise<number> {
    const res = await this.transport!("/api/sync/pull", {
      ...version,
      limit: BATCH_SIZE,
    });
    this.check(res.status, res.body);
    if (res.status !== 200 || !Array.isArray(res.body?.events))
      throw new SyncError(`Cloud pull returned ${res.status}`);
    const events = res.body.events as SyncEvent[];
    if (!events.length) return 0;
    const results = await tenantTx(this.connect, this.tenantId, async (c) => {
      const out: ApplyResult[] = [];
      for (const event of events) {
        const r = await applyEvent(c, this.tenantId, event, "hub", pullTables);
        if (r.status === "applied") {
          await audit(
            c,
            this.tenantId,
            "sync_pull",
            event.table,
            event.recordId,
            null,
            event.payload,
          );
          if (event.table === "online_bookings")
            await c.query(
              "UPDATE online_bookings SET processed=true WHERE id=$1",
              [event.recordId],
            );
        }
        out.push(r);
      }
      return out;
    });
    const failed = results.filter((r) => r.status === "error");
    const ack = await this.transport!("/api/sync/ack", {
      ...version,
      applied: results.filter((r) => r.status !== "error").map((r) => r.id),
      failed: failed.map((r) => ({ id: r.id, error: r.error ?? "Rejected." })),
    });
    this.check(ack.status, ack.body);
    if (ack.status !== 204) throw new SyncError(`Cloud ack returned ${ack.status}`);
    if (failed.length)
      throw new SyncError(
        `${failed.length} cloud record(s) could not be applied: ${failed[0].error}`,
      );
    return events.length;
  }
}
let hubSync: SyncWorker | null = null;
export const setHubSync = (worker: SyncWorker) => {
  hubSync = worker;
};
export const getHubSync = () => hubSync;
