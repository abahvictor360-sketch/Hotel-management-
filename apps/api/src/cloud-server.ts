import "dotenv/config";
import pg from "pg";
import { z } from "zod";
import { createCloudApp } from "./cloud-app.js";
import { poolConnect, assertSyncRole } from "./sync-apply.js";
// Runs next to Supabase (or the demo cloud-db), never on a hotel hub.
const config = z
  .object({
    CLOUD_SYNC_DATABASE_URL: z.string().min(1),
    CLOUD_PORT: z.coerce.number().default(4002),
  })
  .parse(process.env);
const pool = new pg.Pool({
  connectionString: config.CLOUD_SYNC_DATABASE_URL,
  max: 10,
});
await assertSyncRole(pool);
const server = createCloudApp(poolConnect(pool)).listen(
  config.CLOUD_PORT,
  "0.0.0.0",
  () => console.log(`Cloud sync API ready on port ${config.CLOUD_PORT}`),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () =>
    server.close(() => void pool.end().then(() => process.exit(0))),
  );
