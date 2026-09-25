import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { databaseContract } from "./database-contract.js";
test("real PostgreSQL engine: tenant isolation, FK boundaries, append-only financials and atomic outbox", async () => {
  const db = new PGlite();
  try {
    for (const migration of ["202609250001_phase1", "202609250002_security"])
      await db.exec(
        readFileSync(
          `packages/db/prisma/migrations/${migration}/migration.sql`,
          "utf8",
        ),
      );
    await databaseContract(db);
  } finally {
    await db.close();
  }
});
