import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import pg from "pg";
import { waitUntil } from "@vercel/functions";
import { timingSafeEqual } from "node:crypto";
// Serverless entry for Vercel. One build serves one of three services, chosen by
// HOTEL_HUB_SERVICE on each Vercel project:
//   cloud    - cloud sync API, management dashboard, public booking site, guest messages
//   provider - provider console and licence server (holds the licence signing key)
//   hub      - a hosted demo hotel hub (a real hotel runs its hub on its own network)
// Serverless functions cannot keep timers, so the background workers of the long-running
// servers become work done after a request (waitUntil) plus a daily Vercel cron.
const service = process.env.HOTEL_HUB_SERVICE ?? "cloud";
const pem = (v?: string) => v?.replace(/\\n/g, "\n");
// Poolers hand out a server connection per transaction; keep each instance small.
const pool = (url: string) =>
  new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000 });
function cronAuthorized(req: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const got = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return (
    secret.length >= 16 &&
    got.length === want.length &&
    timingSafeEqual(got, want)
  );
}
// Vercel's edge is the one proxy in front of every function and sets X-Forwarded-For
// to the visitor's address; trusting that hop gives rate limits the real client IP.
const behindVercel = <T extends express.Express>(a: T) => {
  a.set("trust proxy", 1);
  return a;
};
const background = (label: string, work: () => Promise<unknown>) =>
  waitUntil(
    work().catch((e) =>
      console.error(
        JSON.stringify({
          event: `${label}_failed`,
          error: String((e as Error)?.message ?? e),
        }),
      ),
    ),
  );
async function cloud() {
  const { createCloudApp } = await import("../../apps/api/src/cloud-app.js");
  const { poolConnect, assertSyncRole } = await import(
    "../../apps/api/src/sync-apply.js"
  );
  const { deliverPending, webhookDeliver, logDeliver } = await import(
    "../../apps/api/src/notifier.js"
  );
  const env = process.env;
  const sync = pool(env.CLOUD_SYNC_DATABASE_URL!);
  const reports = env.CLOUD_REPORT_DATABASE_URL
    ? pool(env.CLOUD_REPORT_DATABASE_URL)
    : null;
  const booking = env.CLOUD_BOOKING_DATABASE_URL
    ? pool(env.CLOUD_BOOKING_DATABASE_URL)
    : null;
  await assertSyncRole(sync);
  if (reports) await assertSyncRole(reports, "report_reader");
  if (booking) await assertSyncRole(booking, "booking_agent");
  const deliver =
    env.NOTIFY_WEBHOOK_URL && env.NOTIFY_WEBHOOK_SECRET
      ? webhookDeliver(env.NOTIFY_WEBHOOK_URL, env.NOTIFY_WEBHOOK_SECRET)
      : env.NOTIFY_LOG === "true"
        ? logDeliver
        : null;
  const notify = () => {
    if (booking && deliver)
      background("notify", () => deliverPending(poolConnect(booking), deliver));
  };
  const inner = createCloudApp(poolConnect(sync), {
    reports: reports ? poolConnect(reports) : undefined,
    dashboardDir: "apps/web/dist",
    booking: booking
      ? {
          connect: poolConnect(booking),
          publicUrl: env.CLOUD_PUBLIC_URL ?? "http://localhost:4002",
          sealingKey: pem(env.CLOUD_SEALING_PRIVATE_KEY) ?? null,
        }
      : undefined,
  });
  behindVercel(inner);
  const app = behindVercel(express());
  app.disable("x-powered-by");
  app.get("/api/cron/tick", (req, res) => {
    if (!cronAuthorized(req)) return res.status(401).end();
    notify();
    res.json({ ok: true });
  });
  // Guest messages go out right after the writes that create them: website bookings,
  // payment verification, and hub pushes that carry confirmations.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (
      req.method === "POST" &&
      (req.path.startsWith("/api/public/") || req.path === "/api/sync/push")
    )
      res.on("finish", notify);
    next();
  });
  app.use(inner);
  return app;
}
async function provider() {
  const { providerApp, providerDb } = await import(
    "../../apps/api/src/provider-app.js"
  );
  const { assertRuntimeRole } = await import("../../apps/api/src/db.js");
  await assertRuntimeRole(providerDb, "provider_app");
  return behindVercel(providerApp);
}
async function hub() {
  const { app: inner, HUB_VERSION } = await import("../../apps/api/src/app.js");
  const { env } = await import("../../apps/api/src/config.js");
  const { db, assertRuntimeRole } = await import("../../apps/api/src/db.js");
  const { licenseDb, refreshLicense } = await import(
    "../../apps/api/src/licensing.js"
  );
  const { poolConnect, assertSyncRole } = await import(
    "../../apps/api/src/sync-apply.js"
  );
  const { SyncWorker, httpTransport, setHubSync } = await import(
    "../../apps/api/src/sync-worker.js"
  );
  await assertRuntimeRole(db, "hotel_app");
  await assertRuntimeRole(licenseDb, "license_agent");
  const syncPool = env.SYNC_DATABASE_URL ? pool(env.SYNC_DATABASE_URL) : null;
  if (syncPool) await assertSyncRole(syncPool);
  const worker = new SyncWorker(
    syncPool
      ? poolConnect(syncPool)
      : async () => {
          throw new Error("Sync disabled");
        },
    env.HOTEL_ID,
    syncPool && env.CLOUD_SYNC_URL && env.HUB_LICENSE_KEY
      ? httpTransport(
          env.CLOUD_SYNC_URL,
          env.HUB_LICENSE_KEY,
          env.HOTEL_ID,
          env.INSTALLATION_ID,
        )
      : null,
    HUB_VERSION,
  );
  setHubSync(worker);
  let lastSync = 0,
    lastLicense = 0;
  const syncSoon = (force = false) => {
    if (!force && Date.now() - lastSync < 30_000) return;
    lastSync = Date.now();
    background("sync", () => worker.runNow());
  };
  const licenseSoon = (force = false) => {
    if (
      !env.HUB_LICENSE_KEY ||
      (!force && Date.now() - lastLicense < 3_600_000)
    )
      return;
    lastLicense = Date.now();
    // A cold provider can outlast the 8-second licence timeout; by the retry it is warm.
    background("license", () =>
      refreshLicense(env.HUB_LICENSE_KEY!).catch(() =>
        refreshLicense(env.HUB_LICENSE_KEY!),
      ),
    );
  };
  licenseSoon(true);
  behindVercel(inner);
  const app = behindVercel(express());
  app.disable("x-powered-by");
  app.get("/api/cron/tick", (req, res) => {
    if (!cronAuthorized(req)) return res.status(401).end();
    licenseSoon(true);
    syncSoon(true);
    res.json({ ok: true });
  });
  // The hub's 30-second sync and hourly licence check, driven by traffic instead of timers.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api/"))
      res.on("finish", () => {
        syncSoon(req.method !== "GET" && res.statusCode < 400);
        licenseSoon();
      });
    next();
  });
  app.use(inner);
  return app;
}
const app = await (service === "provider"
  ? provider()
  : service === "hub"
    ? hub()
    : cloud());
export default app;
