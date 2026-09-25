import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
export type Sql = {
  exec: (sql: string) => Promise<unknown>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};
export async function databaseContract(db: Sql) {
  const a = randomUUID(),
    b = randomUUID(),
    roleA = randomUUID(),
    roleB = randomUUID(),
    userA = randomUUID(),
    userB = randomUUID();
  async function context(tenant: string, role = "hotel_app", writable = true) {
    await db.exec(
      `RESET ROLE; SET ROLE ${role}; SELECT set_config('app.tenant_id','${tenant}',false),set_config('app.can_write','${writable}',false),set_config('app.device_id','test',false),set_config('app.user_id','',false);`,
    );
  }
  async function write(sql: string) {
    try {
      await db.exec(
        `SELECT set_config('app.event_id','${randomUUID()}',false),set_config('app.audit_id','${randomUUID()}',false);${sql}`,
      );
    } finally {
      await db.exec(
        "SELECT set_config('app.event_id','',false),set_config('app.audit_id','',false)",
      );
    }
  }
  await context(a, "provider_app");
  await write(
    `INSERT INTO tenants(id,tenant_id,name,slug,branding) VALUES('${a}','${a}','Hotel A','hotel-a','{}')`,
  );
  await context(b, "provider_app");
  await write(
    `INSERT INTO tenants(id,tenant_id,name,slug,branding) VALUES('${b}','${b}','Hotel B','hotel-b','{}')`,
  );
  for (const [tenant, role, user] of [
    [a, roleA, userA],
    [b, roleB, userB],
  ]) {
    await context(tenant);
    await write(
      `INSERT INTO roles(id,tenant_id,name,permissions) VALUES('${role}','${tenant}','admin','[]')`,
    );
    await write(
      `INSERT INTO users(id,tenant_id,name,email,password_hash,role_id) VALUES('${user}','${tenant}','Admin','same@email.test','secret-hash','${role}')`,
    );
  }
  await context(a);
  assert.equal(
    (await db.query("SELECT * FROM users")).rows.length,
    1,
    "RLS filters even unscoped reads",
  );
  assert.equal(
    (await db.query(`SELECT * FROM users WHERE id='${userB}'`)).rows.length,
    0,
    "Cross-tenant id lookup returns no rows",
  );
  await assert.rejects(
    () =>
      write(
        `INSERT INTO guests(id,tenant_id,full_name) VALUES('${randomUUID()}','${b}','Attack')`,
      ),
    /row.level security/i,
  );
  await assert.rejects(
    () =>
      write(
        `INSERT INTO users(id,tenant_id,name,email,password_hash,role_id) VALUES('${randomUUID()}','${a}','Attacker','bad@email.test','hash','${roleB}')`,
      ),
    /foreign key/i,
  );
  await assert.rejects(() =>
    write(`UPDATE users SET tenant_id='${b}' WHERE id='${userA}'`),
  );
  await assert.rejects(() => db.exec(`DELETE FROM users WHERE id='${userA}'`));
  await assert.rejects(
    () =>
      db.exec(
        `INSERT INTO guests(id,tenant_id,full_name) VALUES('${randomUUID()}','${a}','Untracked')`,
      ),
    /mutation context/i,
  );
  const guest = randomUUID(),
    folio = randomUUID(),
    pay = randomUUID();
  await write(
    `INSERT INTO guests(id,tenant_id,full_name) VALUES('${guest}','${a}','Test guest')`,
  );
  await write(
    `INSERT INTO folios(id,tenant_id,guest_id,opened_at) VALUES('${folio}','${a}','${guest}',now())`,
  );
  await write(
    `INSERT INTO payments(id,tenant_id,folio_id,amount,method,received_by,paid_at,idempotency_key) VALUES('${pay}','${a}','${folio}',100.01,'cash','${userA}',now(),'pay-1')`,
  );
  const payment = (
    await db.query(`SELECT amount::text FROM payments WHERE id='${pay}'`)
  ).rows[0];
  assert.equal(payment.amount, "100.01");
  await assert.rejects(() =>
    db.exec(`UPDATE payments SET amount=2 WHERE id='${pay}'`),
  );
  await assert.rejects(() => db.exec(`DELETE FROM payments WHERE id='${pay}'`));
  const receipt = randomUUID();
  await write(
    `INSERT INTO receipts(id,tenant_id,folio_id,receipt_number,payload) VALUES('${receipt}','${a}','${folio}','HUB-1','{}')`,
  );
  await assert.rejects(() =>
    db.exec(
      `UPDATE receipts SET payload='{"tampered":true}' WHERE id='${receipt}'`,
    ),
  );
  await write(
    `INSERT INTO receipt_reprints(id,tenant_id,receipt_id,requested_by,printed_at,reason) VALUES('${randomUUID()}','${a}','${receipt}','${userA}',now(),'Guest copy')`,
  );
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM receipt_reprints WHERE receipt_id='${receipt}'`,
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(() => db.exec("UPDATE audit_log SET action='tampered'"));
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM sync_queue WHERE payload::text LIKE '%secret-hash%'",
      )
    ).rows[0].n,
    0,
    "Password hashes excluded from outbox",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM audit_log WHERE after::text LIKE '%secret-hash%'",
      )
    ).rows[0].n,
    0,
    "Password hashes excluded from audit",
  );
  await db.exec("BEGIN");
  await write(
    `INSERT INTO guests(id,tenant_id,full_name) VALUES('${randomUUID()}','${a}','Rollback guest')`,
  );
  await db.exec("ROLLBACK");
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM sync_queue WHERE payload->>'full_name'='Rollback guest'",
      )
    ).rows[0].n,
    0,
    "Outbox rolls back with source",
  );
  await context(a, "hotel_app", false);
  await assert.rejects(
    () =>
      write(
        `INSERT INTO guests(id,tenant_id,full_name) VALUES('${randomUUID()}','${a}','Read only')`,
      ),
    /read.only/i,
  );
  assert.equal(
    (await db.query("SELECT * FROM users")).rows.length,
    1,
    "Reads remain available",
  );
  await context("", "hotel_app");
  assert.equal(
    (await db.query("SELECT * FROM users")).rows.length,
    0,
    "Missing tenant context denies reads",
  );
  await context(a, "provider_app");
  await assert.rejects(
    () => db.query("SELECT * FROM guests"),
    /permission denied/i,
  );
  await context(a, "license_agent");
  await assert.rejects(
    () => db.query("SELECT * FROM payments"),
    /permission denied/i,
  );
  await db.exec("RESET ROLE");
  return { a, b };
}
