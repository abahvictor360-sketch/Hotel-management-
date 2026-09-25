import { test } from "node:test";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { frontdeskContract } from "./frontdesk-contract.js";
import { type Sql, databaseContract } from "./database-contract.js";
// Dedicated disposable database only. This test never drops or truncates data.
test("PostgreSQL 16 contract", async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  try {
    const v = await db.query("SHOW server_version_num");
    if (Number(v.rows[0].server_version_num) < 160000)
      throw new Error("PostgreSQL 16+ required");
    for (const migration of [
      "202609250001_phase1",
      "202609250002_security",
      "202609250003_frontdesk",
      "202609250004_billing",
    ])
      await db.query(
        readFileSync(
          `packages/db/prisma/migrations/${migration}/migration.sql`,
          "utf8",
        ),
      );
    const connection: Sql = {
      exec: (sql) => db.query(sql),
      query: (sql, params) => db.query(sql, params),
    };
    const tenants = await databaseContract(connection);
    await frontdeskContract(connection, tenants.a);
  } finally {
    await db.end();
  }
});
