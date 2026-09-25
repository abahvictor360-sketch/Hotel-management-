import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  redactedColumns,
  type ReplicatedTable,
} from "../../../packages/core/src/sync-contract.js";
// Works with a pg client and with PGlite in tests. Always used inside tenantTx().
export type Conn = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};
export type SyncEvent = {
  id: string;
  table: string;
  recordId: string;
  operation: "insert" | "update";
  // Raw JSON text from Postgres. Never parsed in Node, so NUMERIC money keeps every digit.
  payload: string;
};
export type Side = "hub" | "cloud";
export type ApplyResult = {
  id: string;
  status: "applied" | "duplicate" | "stale" | "error";
  error?: string;
  conflict?: { winner: Side };
};
const q = pg.escapeIdentifier;
const immutableColumns = ["id", "tenant_id", "created_at", "created_by"];
const columnCache = new Map<string, string[]>();
async function columns(conn: Conn, table: string) {
  let cols = columnCache.get(table);
  if (!cols) {
    cols = (
      await conn.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
        [table],
      )
    ).rows.map((r) => r.column_name as string);
    if (!cols.length) throw new Error(`Unknown table ${table}`);
    columnCache.set(table, cols);
  }
  return cols;
}
export const poolConnect = (pool: pg.Pool) => async () => {
  const client = await pool.connect();
  return { conn: client as Conn, release: () => client.release() };
};
// Same guarantees as assertRuntimeRole: never the owner, a superuser or BYPASSRLS.
export async function assertSyncRole(pool: pg.Pool, expected = "sync_agent") {
  const role = (
    await pool.query(
      "SELECT rolname,rolsuper,rolbypassrls,(SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND tableowner=current_user) AS owned FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  if (
    role?.rolname !== expected ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.owned !== 0
  )
    throw new Error(`Unsafe database role: expected non-owner ${expected}`);
}
// Runs fn in one transaction with the hotel's tenant context. SET CONSTRAINTS ALL IMMEDIATE
// makes deferred foreign keys fail inside the row's savepoint instead of failing the commit.
export async function tenantTx<T>(
  connect: () => Promise<{ conn: Conn; release: () => void }>,
  tenantId: string,
  fn: (conn: Conn) => Promise<T>,
): Promise<T> {
  const { conn, release } = await connect();
  try {
    await conn.query("BEGIN");
    await conn.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.device_id','sync',true),set_config('app.user_id','',true)",
      [tenantId],
    );
    await conn.query("SET CONSTRAINTS ALL IMMEDIATE");
    const result = await fn(conn);
    await conn.query("COMMIT");
    return result;
  } catch (error) {
    await conn.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    release();
  }
}
export async function audit(
  conn: Conn,
  tenantId: string,
  action: string,
  entity: string,
  entityId: string,
  before: string | null,
  after: string | null,
) {
  await conn.query(
    "INSERT INTO audit_log(id,tenant_id,device_id,action,entity,entity_id,before,after,occurred_at) VALUES($1,$2,'sync',$3,$4,$5,$6::jsonb,$7::jsonb,clock_timestamp())",
    [randomUUID(), tenantId, action, entity, entityId, before, after],
  );
}
// Last write wins on updated_at. On a tie the hub record wins. A conflict is an
// incoming change for a record that also has unsent local changes; every resolved
// conflict is written to this database's audit_log.
export async function applyEvent(
  conn: Conn,
  tenantId: string,
  event: SyncEvent,
  side: Side,
  allowed: readonly string[],
): Promise<ApplyResult> {
  if (!allowed.includes(event.table))
    return { id: event.id, status: "error", error: "Table is not replicated." };
  const table = event.table as ReplicatedTable;
  const t = `public.${q(table)}`;
  const redacted = redactedColumns[table] ?? {};
  const hidden = Object.keys(redacted);
  await conn.query("SAVEPOINT sync_event");
  try {
    const cols = await columns(conn, table);
    const incoming = (
      await conn.query(
        `SELECT p.id::text AS id,p.tenant_id::text AS tenant_id,(to_jsonb(p)-$2::text[])::text AS doc FROM jsonb_populate_record(NULL::${t},$1::jsonb) p`,
        [event.payload, hidden],
      )
    ).rows[0];
    if (incoming.id !== event.recordId || incoming.tenant_id !== tenantId)
      throw new Error("Payload does not match the event record or hotel.");
    const current = (
      await conn.query(
        `SELECT c.updated_at>p.updated_at AS local_newer,c.updated_at=p.updated_at AS tie,(to_jsonb(c)-$3::text[])::text AS doc,
         (to_jsonb(c)-$3::text[])=(to_jsonb(p)-$3::text[]) AS same
         FROM ${t} c,jsonb_populate_record(NULL::${t},$2::jsonb) p WHERE c.id=$1 FOR UPDATE OF c`,
        [event.recordId, event.payload, hidden],
      )
    ).rows[0] as
      | { local_newer: boolean; tie: boolean; doc: string; same: boolean }
      | undefined;
    let result: ApplyResult;
    if (!current) {
      const list = cols.map(q).join(",");
      await conn.query(
        `INSERT INTO ${t}(${list}) SELECT ${list} FROM jsonb_populate_record(NULL::${t},$1::jsonb||$2::jsonb)`,
        [event.payload, JSON.stringify(redacted)],
      );
      result = { id: event.id, status: "applied" };
    } else if (current.same) {
      result = { id: event.id, status: "duplicate" };
    } else {
      const localPending = (
        await conn.query(
          "SELECT EXISTS(SELECT 1 FROM sync_queue WHERE table_name=$1 AND record_id=$2 AND status IN ('pending','failed')) AS pending",
          [table, event.recordId],
        )
      ).rows[0].pending as boolean;
      const incomingSide: Side = side === "cloud" ? "hub" : "cloud";
      const incomingWins =
        !current.local_newer && (!current.tie || incomingSide === "hub");
      if (incomingWins) {
        const set = cols.filter(
          (c) => !immutableColumns.includes(c) && !hidden.includes(c),
        );
        await conn.query(
          `UPDATE ${t} SET (${set.map(q).join(",")})=(SELECT ${set.map(q).join(",")} FROM jsonb_populate_record(NULL::${t},$1::jsonb)) WHERE id=$2`,
          [event.payload, event.recordId],
        );
        result = { id: event.id, status: "applied" };
      } else result = { id: event.id, status: "stale" };
      if (localPending || current.tie) {
        const winner = incomingWins ? incomingSide : side;
        result.conflict = { winner };
        await audit(
          conn,
          tenantId,
          `sync_conflict_${winner}_wins`,
          table,
          event.recordId,
          current.doc,
          incoming.doc,
        );
      }
    }
    await conn.query("RELEASE SAVEPOINT sync_event");
    return result;
  } catch (error) {
    await conn.query("ROLLBACK TO SAVEPOINT sync_event");
    return {
      id: event.id,
      status: "error",
      error: String((error as Error).message ?? error).slice(0, 500),
    };
  }
}
