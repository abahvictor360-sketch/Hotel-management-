import { app } from "./app.js";
import { env } from "./config.js";
import { db, assertRuntimeRole } from "./db.js";
import { licenseDb, startLicenseWorker } from "./licensing.js";
await assertRuntimeRole(db, "hotel_app");
await assertRuntimeRole(licenseDb, "license_agent");
const stop = startLicenseWorker(process.env.HUB_LICENSE_KEY ?? "");
const server = app.listen(env.PORT, "0.0.0.0", () =>
  console.log(`Hotel hub ready on port ${env.PORT}`),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stop();
    server.close(
      () =>
        void Promise.all([db.$disconnect(), licenseDb.$disconnect()]).then(() =>
          process.exit(0),
        ),
    );
  });
