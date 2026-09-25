import "dotenv/config";
import { spawnSync } from "node:child_process";
import { Client, escapeLiteral } from "pg";
const local = process.env.MIGRATION_DATABASE_URL!,
  cloud = process.env.CLOUD_DATABASE_URL!;
if (!local || !cloud) throw new Error("Migration URLs required");
for (const url of [local, cloud]) {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/prisma/build/index.js",
      "migrate",
      "deploy",
      "--schema",
      "packages/db/prisma/schema.prisma",
    ],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } },
  );
  if (result.status !== 0)
    throw new Error("Migration failed. Application start aborted.");
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    for (const [role, key] of [
      ["hotel_app", "HOTEL_DB_PASSWORD"],
      ["provider_app", "PROVIDER_DB_PASSWORD"],
      ["license_agent", "LICENSE_DB_PASSWORD"],
      ["sync_agent", "SYNC_DB_PASSWORD"],
    ]) {
      const password = process.env[key];
      if (!password || password.length < 24)
        throw new Error(`${key} must be at least 24 characters`);
      await db.query(
        `ALTER ROLE ${role} LOGIN PASSWORD ${escapeLiteral(password)}`,
      );
    }
  } finally {
    await db.end();
  }
}
console.log("Both databases migrated; non-owner runtime roles configured.");
