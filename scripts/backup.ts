import "dotenv/config";
import { mkdir, readdir, stat, rename, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "pg";
import { z } from "zod";
const tenant = z.string().uuid().parse(process.env.HOTEL_ID);
const database =
  process.env.BACKUP_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
if (!database) throw new Error("Backup database URL required");
const client = new Client({ connectionString: database });
await client.connect();
try {
  const result = await client.query("SELECT id FROM tenants");
  if (result.rows.length !== 1 || result.rows[0].id !== tenant)
    throw new Error("Refusing full backup of a shared/mismatched database");
} finally {
  await client.end();
}
const dir = resolve(process.env.BACKUP_DIR ?? "backups", tenant);
await mkdir(dir, { recursive: true, mode: 0o700 });
const dest = join(
  dir,
  `${new Date().toISOString().replace(/[:.]/g, "-")}.dump`,
);
const u = new URL(database); // Do not expose database password in process arguments.
await new Promise<void>((done, fail) => {
  const child = spawn(
    process.env.PG_DUMP_PATH ?? "pg_dump",
    ["--format=custom", "--file", dest + ".partial"],
    {
      env: {
        ...process.env,
        PGHOST: u.hostname,
        PGPORT: u.port || "5432",
        PGDATABASE: u.pathname.slice(1),
        PGUSER: decodeURIComponent(u.username),
        PGPASSWORD: decodeURIComponent(u.password),
      },
      stdio: "inherit",
    },
  );
  child.on("error", fail);
  child.on("exit", (code) =>
    code === 0 ? done() : fail(new Error(`pg_dump failed (${code})`)),
  );
});
await rename(dest + ".partial", dest);
for (const file of await readdir(dir))
  if (
    file.endsWith(".dump") &&
    (await stat(join(dir, file))).mtimeMs < Date.now() - 14 * 86400_000
  )
    await unlink(join(dir, file));
console.log(`Backup completed for hotel ${tenant}`);
