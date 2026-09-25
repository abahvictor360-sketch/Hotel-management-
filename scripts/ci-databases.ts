import { Client } from "pg";
import { readFileSync, writeFileSync } from "node:fs";
const db = new Client({
  connectionString:
    "postgresql://postgres:ci-local-password-not-a-secret@localhost:5432/postgres",
});
await db.connect();
for (const name of ["hotel", "cloud"])
  await db.query(`CREATE DATABASE ${name}`);
await db.end();
let env = readFileSync(".env", "utf8");
for (const [key, value] of Object.entries({
  MIGRATION_DATABASE_URL:
    "postgresql://postgres:ci-local-password-not-a-secret@localhost:5432/hotel",
  CLOUD_DATABASE_URL:
    "postgresql://postgres:ci-local-password-not-a-secret@localhost:5432/cloud",
}))
  env = env.replace(new RegExp(`^${key}=.*$`, "m"), `${key}='${value}'`);
env = env.replace(/localhost:5433/g, "localhost:5432");
writeFileSync(".env", env, { mode: 0o600 });
