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
    // Optional read-only role for the management dashboard and cloud departure export.
    CLOUD_REPORT_DATABASE_URL: z.string().min(1).optional(),
  })
  .parse(process.env);
const pool = new pg.Pool({
  connectionString: config.CLOUD_SYNC_DATABASE_URL,
  max: 10,
});
await assertSyncRole(pool);
const reportPool = config.CLOUD_REPORT_DATABASE_URL
  ? new pg.Pool({ connectionString: config.CLOUD_REPORT_DATABASE_URL, max: 5 })
  : null;
if (reportPool) await assertSyncRole(reportPool, "report_reader");
const server = createCloudApp(poolConnect(pool), {
  reports: reportPool ? poolConnect(reportPool) : undefined,
  dashboardDir: "apps/web/dist",
}).listen(
  config.CLOUD_PORT,
  "0.0.0.0",
  () =>
    console.log(
      `Cloud sync API ready on port ${config.CLOUD_PORT}${reportPool ? ", management dashboard at /dashboard" : ""}`,
    ),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () =>
    server.close(
      () =>
        void Promise.all([pool.end(), reportPool?.end()]).then(() =>
          process.exit(0),
        ),
    ),
  );
