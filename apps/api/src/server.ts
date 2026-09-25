import { app } from "./app.js";
import { env } from "./config.js";
import { db, assertRuntimeRole } from "./db.js";
import { licenseDb, startLicenseWorker } from "./licensing.js";
import { startPrintWorker } from "./printing.js";
import pg from "pg";
import { poolConnect, assertSyncRole } from "./sync-apply.js";
import { SyncWorker, httpTransport, setHubSync } from "./sync-worker.js";
import { HUB_VERSION } from "./app.js";
await assertRuntimeRole(db, "hotel_app");
await assertRuntimeRole(licenseDb, "license_agent");
const stopPrinter = await startPrintWorker();
const stop = startLicenseWorker(process.env.HUB_LICENSE_KEY ?? "");
const syncPool = env.SYNC_DATABASE_URL
  ? new pg.Pool({ connectionString: env.SYNC_DATABASE_URL, max: 3 })
  : null;
if (syncPool) await assertSyncRole(syncPool);
const hubSync = new SyncWorker(
  syncPool ? poolConnect(syncPool) : async () => { throw new Error("Sync disabled"); },
  env.HOTEL_ID,
  syncPool && env.CLOUD_SYNC_URL && env.HUB_LICENSE_KEY
    ? httpTransport(env.CLOUD_SYNC_URL, env.HUB_LICENSE_KEY, env.HOTEL_ID, env.INSTALLATION_ID)
    : null,
  HUB_VERSION,
);
setHubSync(hubSync);
const stopSync = hubSync.start();
const server = app.listen(env.PORT, "0.0.0.0", () =>
  console.log(`Hotel hub ready on port ${env.PORT}`),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stop();
    stopSync();
    void syncPool?.end();
    stopPrinter();
    server.close(
      () =>
        void Promise.all([db.$disconnect(), licenseDb.$disconnect()]).then(() =>
          process.exit(0),
        ),
    );
  });
