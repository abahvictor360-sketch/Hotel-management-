import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import type { Sql } from "./database-contract.js";
export async function frontdeskContract(db: Sql, tenant: string) {
  await db.exec(
    `RESET ROLE; SET ROLE hotel_app; SELECT set_config('app.tenant_id','${tenant}',false),set_config('app.can_write','true',false)`,
  );
  const guest = randomUUID(),
    type = randomUUID(),
    room = randomUUID(),
    a = randomUUID(),
    b = randomUUID();
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
  await write(
    `INSERT INTO guests(id,tenant_id,full_name) VALUES('${guest}','${tenant}','Calendar guest')`,
  );
  await write(
    `INSERT INTO room_types(id,tenant_id,name,base_rate,capacity,amenities) VALUES('${type}','${tenant}','Contract type',100,2,'[]')`,
  );
  await write(
    `INSERT INTO rooms(id,tenant_id,room_number,room_type_id) VALUES('${room}','${tenant}','contract-101','${type}')`,
  );
  const book = (id: string, from: string, to: string) =>
    `INSERT INTO reservations(id,tenant_id,guest_id,room_id,room_type_id,check_in_date,check_out_date,rate,status) VALUES('${id}','${tenant}','${guest}','${room}','${type}','${from}','${to}',100,'confirmed')`;
  await write(book(a, "2030-01-01", "2030-01-03"));
  await assert.rejects(
    () => write(book(randomUUID(), "2030-01-02", "2030-01-04")),
    /exclusion constraint/i,
  );
  await write(book(b, "2030-01-03", "2030-01-04"));
  await write(`UPDATE reservations SET status='checked_in' WHERE id='${a}'`);
  await assert.rejects(
    () => write(`UPDATE reservations SET status='checked_in' WHERE id='${b}'`),
    /unique constraint/i,
  );
  const folio = randomUUID();
  await write(
    `INSERT INTO folios(id,tenant_id,reservation_id,guest_id,opened_at) VALUES('${folio}','${tenant}','${a}','${guest}',now())`,
  );
  await assert.rejects(
    () =>
      write(
        `INSERT INTO folios(id,tenant_id,reservation_id,guest_id,opened_at) VALUES('${randomUUID()}','${tenant}','${a}','${guest}',now())`,
      ),
    /unique constraint/i,
  );
  await write(
    `INSERT INTO folio_charges(id,tenant_id,folio_id,source_type,source_id,description,amount,charged_at) VALUES('${randomUUID()}','${tenant}','${folio}','room','${a}','Room',100,now())`,
  );
  await assert.rejects(
    () => write(`UPDATE folios SET status='closed' WHERE id='${folio}'`),
    /nonzero balance/i,
  );
  await assert.rejects(
    () =>
      write(
        `INSERT INTO folio_charges(id,tenant_id,folio_id,source_type,source_id,description,amount,charged_at) VALUES('${randomUUID()}','${tenant}','${folio}','room','${a}','Duplicate room',100,now())`,
      ),
    /unique constraint/i,
  );
  const empty = randomUUID();
  await write(
    `INSERT INTO folios(id,tenant_id,guest_id,opened_at) VALUES('${empty}','${tenant}','${guest}',now())`,
  );
  await write(
    `UPDATE folios SET status='closed',closed_at=now() WHERE id='${empty}'`,
  );
  await assert.rejects(
    () =>
      write(
        `INSERT INTO folio_charges(id,tenant_id,folio_id,source_type,description,amount,charged_at) VALUES('${randomUUID()}','${tenant}','${empty}','other','Too late',100,now())`,
      ),
    /not open/i,
  );
  await assert.rejects(
    () => write(`UPDATE folios SET status='open' WHERE id='${empty}'`),
    /cannot be reopened/i,
  );
  await db.exec("RESET ROLE");
}
