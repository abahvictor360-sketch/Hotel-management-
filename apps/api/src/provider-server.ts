import { providerApp, providerDb } from "./provider-app.js";
import { assertRuntimeRole } from "./db.js";
await assertRuntimeRole(providerDb, "provider_app");
const server = providerApp.listen(
  Number(process.env.PROVIDER_PORT ?? 4001),
  "0.0.0.0",
  () => console.log("Provider console ready"),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () =>
    server.close(
      () => void providerDb.$disconnect().then(() => process.exit(0)),
    ),
  );
