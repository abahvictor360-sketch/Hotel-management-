import "dotenv/config";
import pg from "pg";
import { z } from "zod";
import { createCloudApp } from "./cloud-app.js";
import { readFileSync } from "node:fs";
import { poolConnect, assertSyncRole } from "./sync-apply.js";
import { startNotifier, webhookDeliver, logDeliver } from "./notifier.js";
// Runs next to Supabase (or the demo cloud-db), never on a hotel hub.
const config = z
  .object({
    CLOUD_SYNC_DATABASE_URL: z.string().min(1),
    CLOUD_PORT: z.coerce.number().default(4002),
    // Optional read-only role for the management dashboard and cloud departure export.
    CLOUD_REPORT_DATABASE_URL: z.string().min(1).optional(),
    // Optional public booking website (booking_agent role) and guest messages.
    CLOUD_BOOKING_DATABASE_URL: z.string().min(1).optional(),
    CLOUD_PUBLIC_URL: z.string().url().default("http://localhost:4002"),
    CLOUD_SEALING_PRIVATE_KEY_FILE: z.string().optional(),
    NOTIFY_WEBHOOK_URL: z.string().url().optional(),
    NOTIFY_WEBHOOK_SECRET: z.string().min(16).optional(),
    NOTIFY_LOG: z.enum(["true", "false"]).default("false"),
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
const bookingPool = config.CLOUD_BOOKING_DATABASE_URL
  ? new pg.Pool({ connectionString: config.CLOUD_BOOKING_DATABASE_URL, max: 10 })
  : null;
if (bookingPool) await assertSyncRole(bookingPool, "booking_agent");
const sealingKey = config.CLOUD_SEALING_PRIVATE_KEY_FILE
  ? readFileSync(config.CLOUD_SEALING_PRIVATE_KEY_FILE, "utf8")
  : null;
if (config.NOTIFY_WEBHOOK_URL && !config.NOTIFY_WEBHOOK_SECRET)
  throw new Error("NOTIFY_WEBHOOK_SECRET is required with NOTIFY_WEBHOOK_URL");
const deliver = config.NOTIFY_WEBHOOK_URL
  ? webhookDeliver(config.NOTIFY_WEBHOOK_URL, config.NOTIFY_WEBHOOK_SECRET!)
  : config.NOTIFY_LOG === "true"
    ? logDeliver
    : null;
// Without a transport, messages wait as pending and send once one is configured.
const stopNotifier =
  bookingPool && deliver ? startNotifier(poolConnect(bookingPool), deliver) : () => {};
const server = createCloudApp(poolConnect(pool), {
  reports: reportPool ? poolConnect(reportPool) : undefined,
  booking: bookingPool
    ? {
        connect: poolConnect(bookingPool),
        publicUrl: config.CLOUD_PUBLIC_URL,
        sealingKey,
      }
    : undefined,
  dashboardDir: "apps/web/dist",
}).listen(
  config.CLOUD_PORT,
  "0.0.0.0",
  () =>
    console.log(
      `Cloud sync API ready on port ${config.CLOUD_PORT}${reportPool ? ", management dashboard at /dashboard" : ""}${bookingPool ? ", booking site at /book/<hotel>" : ""}`,
    ),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopNotifier();
    server.close(
      () =>
        void Promise.all([pool.end(), reportPool?.end(), bookingPool?.end()]).then(() =>
          process.exit(0),
        ),
    );
  });
