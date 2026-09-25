import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { createCloudApp } from "../apps/api/src/cloud-app.js";
import {
  SyncWorker,
  OfflineError,
  type Transport,
} from "../apps/api/src/sync-worker.js";
import { hashToken } from "../packages/core/src/crypto.js";
import {
  replicatedTables,
  MAX_ATTEMPTS,
} from "../packages/core/src/sync-contract.js";
const migrations = [
  "202609250001_phase1",
  "202609250002_security",
  "202609250003_frontdesk",
  "202609250004_billing",
  "202609250005_sync",
];
async function database() {
  const db = new PGlite({ extensions: { btree_gist, pg_trgm } });
  for (const m of migrations)
    await db.exec(
      readFileSync(`packages/db/prisma/migrations/${m}/migration.sql`, "utf8"),
    );
  return db;
}
// A PGlite session acting as a logged-in role, like one pooled production connection.
const as = (db: PGlite, role: string) => async () => {
  await db.exec(`SET ROLE ${role}`);
  return {
    conn: { query: (sql: string, params?: unknown[]) => db.query(sql, params) as any },
    release: () => void db.exec("RESET ROLE"),
  };
};
function writer(db: PGlite, tenant: string) {
  return async (sql: string, role = "hotel_app") => {
    await db.exec(
      `RESET ROLE; SET ROLE ${role}; SELECT set_config('app.tenant_id','${tenant}',false),set_config('app.can_write','true',false),set_config('app.device_id','test',false),set_config('app.user_id','',false),set_config('app.event_id','${randomUUID()}',false),set_config('app.audit_id','${randomUUID()}',false); ${sql}; RESET ROLE;`,
    );
  };
}
async function one(db: PGlite, tenant: string, sql: string, role = "hotel_app") {
  await db.exec(
    `RESET ROLE; SET ROLE ${role}; SELECT set_config('app.tenant_id','${tenant}',false)`,
  );
  try {
    return (await db.query<any>(sql)).rows[0];
  } finally {
    await db.exec("RESET ROLE");
  }
}
test("hub and cloud replicate in order, resolve conflicts by last write and never lose pending rows", async () => {
  const hub = await database(),
    cloud = await database();
  const tenant = randomUUID(),
    installation = randomUUID(),
    key = "k".repeat(43);
  const hubWrite = writer(hub, tenant),
    cloudWrite = writer(cloud, tenant);
  try {
    for (const w of [hubWrite, cloudWrite])
      await w(
        `INSERT INTO tenants(id,tenant_id,name,slug,branding) VALUES('${tenant}','${tenant}','Hotel','hotel','{}')`,
        "provider_app",
      );
    await cloudWrite(
      `INSERT INTO licenses(id,tenant_id,key_hash,installation_id,issued_at) VALUES('${randomUUID()}','${tenant}','${hashToken(key)}','${installation}',now())`,
      "provider_app",
    );
    const cloudApp = createCloudApp(as(cloud, "sync_agent"));
    const transport =
      (secret = key): Transport =>
      async (path, body) => {
        const res = await request(cloudApp)
          .post(path)
          .set("Authorization", `Bearer ${secret}`)
          .set("X-Hotel-Id", tenant)
          .set("X-Installation-Id", installation)
          .send(body as object);
        return { status: res.status, body: res.body };
      };
    const worker = new SyncWorker(
      as(hub, "sync_agent"),
      tenant,
      transport(),
      "test",
    );
    const role = randomUUID(),
      user = randomUUID(),
      guest = randomUUID(),
      folio = randomUUID(),
      payment = randomUUID();
    await hubWrite(
      `INSERT INTO roles(id,tenant_id,name,permissions) VALUES('${role}','${tenant}','admin','[]')`,
    );
    await hubWrite(
      `INSERT INTO users(id,tenant_id,name,email,password_hash,role_id) VALUES('${user}','${tenant}','Admin','a@h.test','$2a$12$secret-hash','${role}')`,
    );
    // Parent and children in one transaction share created_at; seq keeps them ordered.
    await hub.exec("BEGIN");
    await hubWrite(
      `INSERT INTO guests(id,tenant_id,full_name) VALUES('${guest}','${tenant}','Ada Obi')`,
    );
    await hubWrite(
      `INSERT INTO folios(id,tenant_id,guest_id,opened_at) VALUES('${folio}','${tenant}','${guest}',now())`,
    );
    await hubWrite(
      `INSERT INTO payments(id,tenant_id,folio_id,amount,method,received_by,paid_at,idempotency_key) VALUES('${payment}','${tenant}','${folio}',1234567890.12,'cash','${user}',now(),'p1')`,
    );
    await hub.exec("COMMIT");

    await worker.runNow();
    assert.equal(worker.snapshot().lastError, null);
    assert.equal(worker.snapshot().online, true);
    assert.equal(
      (await one(cloud, tenant, `SELECT amount::text AS a FROM payments WHERE id='${payment}'`)).a,
      "1234567890.12",
      "Money keeps every digit through replication",
    );
    assert.equal(
      (await one(cloud, tenant, `SELECT password_hash AS p FROM users WHERE id='${user}'`)).p,
      "!replicated-no-login",
      "Password hashes never leave the hub",
    );
    assert.deepEqual(
      await one(hub, tenant, "SELECT count(*) FILTER (WHERE status<>'sent')::int AS open FROM sync_queue"),
      { open: 0 },
    );
    assert.deepEqual(
      await one(hub, tenant, `SELECT synced FROM sync_metadata WHERE record_id='${payment}'`),
      { synced: true },
    );
    assert.deepEqual(
      await one(cloud, tenant, "SELECT count(*)::int AS n FROM sync_queue"),
      { n: 0 },
      "Replicated rows do not re-enter the cloud outbox",
    );
    assert.deepEqual(
      await one(cloud, tenant, "SELECT pending_count,failed_count FROM hub_heartbeats", "sync_agent"),
      { pending_count: 5, failed_count: 0 },
    );

    // Update keeps the hub's updated_at exactly.
    await hubWrite(`UPDATE guests SET full_name='Ada Obi-Okafor' WHERE id='${guest}'`);
    await worker.runNow();
    const hubGuest = await one(hub, tenant, `SELECT full_name,updated_at::text AS u FROM guests WHERE id='${guest}'`);
    assert.deepEqual(
      await one(cloud, tenant, `SELECT full_name,updated_at::text AS u FROM guests WHERE id='${guest}'`),
      hubGuest,
    );

    // Pull: a website booking written in the cloud reaches the hub once, marked processed.
    const booking = randomUUID();
    await cloudWrite(
      `INSERT INTO online_bookings(id,tenant_id,payload,external_reference,device_id) VALUES('${booking}','${tenant}','{"guest":"Web Guest","total":"70000.00"}','WEB-1','website')`,
    );
    await worker.runNow();
    assert.deepEqual(
      await one(hub, tenant, `SELECT processed,payload->>'total' AS total FROM online_bookings WHERE id='${booking}'`),
      { processed: true, total: "70000.00" },
    );
    assert.deepEqual(
      await one(cloud, tenant, `SELECT processed FROM online_bookings WHERE id='${booking}'`),
      { processed: true },
    );
    assert.deepEqual(
      await one(hub, tenant, `SELECT count(*)::int AS n FROM audit_log WHERE action='sync_pull' AND entity_id='${booking}'`),
      { n: 1 },
    );

    // Conflict 1: hub edits first, cloud edits later. Cloud is newer and wins everywhere.
    await hubWrite(`UPDATE online_bookings SET status='confirmed' WHERE id='${booking}'`);
    await cloudWrite(`UPDATE online_bookings SET notification_status='sent' WHERE id='${booking}'`);
    await worker.runNow();
    const cloudWins = `SELECT status::text,notification_status,updated_at::text AS u FROM online_bookings WHERE id='${booking}'`;
    assert.deepEqual(await one(hub, tenant, cloudWins), await one(cloud, tenant, cloudWins));
    assert.equal((await one(hub, tenant, cloudWins)).notification_status, "sent");
    for (const db of [hub, cloud])
      assert.deepEqual(
        await one(db, tenant, `SELECT count(*)::int AS n FROM audit_log WHERE action='sync_conflict_cloud_wins' AND entity_id='${booking}'`),
        { n: 1 },
        "Conflict resolution is audited on both sides",
      );

    // Conflict 2: cloud edits first, hub edits later. Hub is newer and wins.
    await cloudWrite(`UPDATE online_bookings SET notification_status='failed' WHERE id='${booking}'`);
    await hubWrite(`UPDATE online_bookings SET status='rejected' WHERE id='${booking}'`);
    await worker.runNow();
    assert.deepEqual(await one(hub, tenant, cloudWins), await one(cloud, tenant, cloudWins));
    assert.equal((await one(cloud, tenant, cloudWins)).status, "rejected");
    assert.deepEqual(
      await one(cloud, tenant, `SELECT count(*)::int AS n FROM audit_log WHERE action='sync_conflict_hub_wins' AND entity_id='${booking}'`),
      { n: 1 },
    );

    // Tie on updated_at with different content: the hub record wins.
    await hubWrite(`UPDATE guests SET notes='hub note' WHERE id='${guest}'`);
    const tied = (await one(hub, tenant, `SELECT updated_at::text AS u FROM guests WHERE id='${guest}'`)).u;
    await cloud.exec(
      `SET ROLE sync_agent; SELECT set_config('app.tenant_id','${tenant}',false); UPDATE guests SET notes='cloud note',updated_at='${tied}' WHERE id='${guest}'; RESET ROLE;`,
    );
    await worker.runNow();
    assert.deepEqual(
      await one(cloud, tenant, `SELECT notes FROM guests WHERE id='${guest}'`),
      { notes: "hub note" },
    );

    // Offline: no attempts consumed, row stays pending, header shows offline.
    await hubWrite(`UPDATE guests SET phone='0800' WHERE id='${guest}'`);
    const offline = new SyncWorker(as(hub, "sync_agent"), tenant, async () => {
      throw new OfflineError("down");
    }, "test");
    await offline.runNow();
    assert.equal(offline.snapshot().online, false);
    const pendingRow = `SELECT status::text,attempts FROM sync_queue WHERE record_id='${guest}' AND status<>'sent'`;
    assert.deepEqual(await one(hub, tenant, pendingRow), { status: "pending", attempts: 0 });

    // Wrong key and version mismatch pause sync without consuming attempts.
    const badKey = new SyncWorker(as(hub, "sync_agent"), tenant, transport("x".repeat(43)), "test");
    await badKey.runNow();
    assert.match(badKey.snapshot().lastError ?? "", /rejected this hub/);
    const oldHub = new SyncWorker(as(hub, "sync_agent"), tenant, async () => ({
      status: 409,
      body: { error: "Version mismatch." },
    }), "test");
    await oldHub.runNow();
    assert.equal(oldHub.snapshot().lastError, "Version mismatch.");
    assert.deepEqual(await one(hub, tenant, pendingRow), { status: "pending", attempts: 0 });

    // Rejected rows back off and fail after MAX_ATTEMPTS, raising the admin alert state.
    const rejecting = new SyncWorker(as(hub, "sync_agent"), tenant, async (path, body: any) =>
      path === "/api/sync/push"
        ? { status: 200, body: { results: body.events.map((e: any) => ({ id: e.id, status: "error", error: "constraint" })) } }
        : { status: 200, body: { events: [] } },
    "test");
    await rejecting.runNow();
    const backoff = await one(hub, tenant, `SELECT attempts,next_attempt_at>now() AS waiting FROM sync_queue WHERE record_id='${guest}' AND status<>'sent'`);
    assert.deepEqual(backoff, { attempts: 1, waiting: true });
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await hub.exec(
        `SELECT set_config('app.tenant_id','${tenant}',false); UPDATE sync_queue SET next_attempt_at=NULL WHERE record_id='${guest}'`,
      );
      await rejecting.runNow();
    }
    assert.deepEqual(await one(hub, tenant, pendingRow), { status: "failed", attempts: MAX_ATTEMPTS });

    // Manual retry resets the row and the real cloud accepts it.
    await hub.exec(
      `SELECT set_config('app.tenant_id','${tenant}',false); UPDATE sync_queue SET status='pending',attempts=0,next_attempt_at=NULL,last_error=NULL WHERE status='failed'`,
    );
    await worker.runNow();
    assert.deepEqual(
      await one(cloud, tenant, `SELECT phone FROM guests WHERE id='${guest}'`),
      { phone: "0800" },
    );
    assert.deepEqual(
      await one(hub, tenant, "SELECT count(*) FILTER (WHERE status<>'sent')::int AS open FROM sync_queue"),
      { open: 0 },
    );
  } finally {
    await hub.close();
    await cloud.close();
  }
});
test("SQL replication contract matches the TypeScript contract", () => {
  const sql = readFileSync(
    "packages/db/prisma/migrations/202609250005_sync/migration.sql",
    "utf8",
  );
  const fn = sql.match(/sync_replicated\(t text\)[\s\S]*?ARRAY\[([\s\S]*?)\]/)!;
  const tables = [...fn[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(tables, [...replicatedTables]);
});
