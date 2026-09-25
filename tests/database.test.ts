import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import { frontdeskContract } from "./frontdesk-contract.js";
import { databaseContract } from "./database-contract.js";
test("real PostgreSQL engine: tenant isolation, FK boundaries, append-only financials and atomic outbox", async () => {
  const db = new PGlite({ extensions: { btree_gist, pg_trgm } });
  try {
    for (const migration of [
      "202609250001_phase1",
      "202609250002_security",
      "202609250003_frontdesk",
    ])
      await db.exec(
        readFileSync(
          `packages/db/prisma/migrations/${migration}/migration.sql`,
          "utf8",
        ),
      );
    const tenants = await databaseContract(db);
    await frontdeskContract(db, tenants.a);
  } finally {
    await db.close();
  }
});
