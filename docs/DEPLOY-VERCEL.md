# Hosting the cloud side on Vercel and Supabase

A hotel's hub runs on the hotel's own network. The parts that must be reachable from the
internet run as serverless functions on Vercel, with Supabase PostgreSQL behind them. One
repository build serves every service; `HOTEL_HUB_SERVICE` on each Vercel project picks which.

| Vercel project         | `HOTEL_HUB_SERVICE` | Serves                                                       | Database         |
| ---------------------- | ------------------- | ------------------------------------------------------------ | ---------------- |
| `hotel-management-api` | `cloud`             | Sync API, management dashboard, booking site, guest messages | cloud            |
| `hotel-hub-provider`   | `provider`          | Provider console and licence server                          | cloud            |
| `hotel-hub-demo`       | `hub`               | A hosted demo hotel hub (real hotels run their own hub)      | its own demo hub |

The entry point is `deploy/vercel/entry.ts`, bundled by `npm run vercel-build` into
`deploy/vercel/dist/entry.mjs` and served through `api/index.mjs`. `vercel.json` routes every
path to that function and pins it to `dub1`, next to the `eu-west-1` databases.

## Serverless differences

- No timers. Work that a long-running server does on an interval happens after the request
  that caused it (`waitUntil`) and on a daily Vercel cron at `/api/cron/tick`, which needs
  `Authorization: Bearer $CRON_SECRET`.
  - cloud: guest messages are delivered after website bookings, payment checks and hub pushes.
  - hub: sync runs at most every 30 seconds while staff use the hub, and at once after a
    change; the licence is refreshed hourly and at each cold start.
- No files. Keys are given as PEM text: `LICENSE_PRIVATE_KEY`, `LICENSE_PUBLIC_KEY`,
  `CLOUD_SEALING_PRIVATE_KEY`, `CLOUD_SEALING_PUBLIC_KEY`. A literal `\n` is read as a newline.
- `NODE_ENV=production` is set on the projects, so the install runs `npm ci --include=dev`
  (the build needs Vite, esbuild and Prisma).

## Databases

Two Supabase projects: one cloud database and, for the demo hub, one hub database. Both carry
all migrations in `packages/db/prisma/migrations`, applied in order, plus the
`_prisma_migrations` history so `npm run migrate` sees them as applied.

Connect through the Supavisor pooler in transaction mode (port 6543). Every request sets its
tenant with transaction-local settings, so a transaction pooler is safe. User names take the
form `<role>.<project-ref>`. Copy the pooler host from the project's Connect dialog: it
differs between projects (`aws-0-…` or `aws-1-…`), and the wrong one fails with
"tenant/user not found". The direct `db.<ref>.supabase.co` host is IPv6-only and unreachable
from Vercel functions.

- Prisma URLs (`DATABASE_URL`, `LICENSE_DATABASE_URL`, `PROVIDER_DATABASE_URL`) end with
  `?pgbouncer=true&connection_limit=1`.
- `pg` URLs (`CLOUD_*_DATABASE_URL`, `SYNC_DATABASE_URL`) need no options.

Only the runtime roles get passwords: cloud `sync_agent`, `report_reader`, `booking_agent`,
`provider_app`; hub `hotel_app`, `license_agent`, `sync_agent`. All are non-owner and subject to
row-level security. Each service checks at start that it connected as the role it expects.

## Environment variables

cloud: `HOTEL_HUB_SERVICE=cloud`, `NODE_ENV`, `CLOUD_SYNC_DATABASE_URL`,
`CLOUD_REPORT_DATABASE_URL`, `CLOUD_BOOKING_DATABASE_URL`, `CLOUD_PUBLIC_URL`,
`CLOUD_SEALING_PRIVATE_KEY`, `CRON_SECRET`, and either `NOTIFY_WEBHOOK_URL` with
`NOTIFY_WEBHOOK_SECRET` or `NOTIFY_LOG=true`.

provider: `HOTEL_HUB_SERVICE=provider`, `NODE_ENV`, `PROVIDER_DATABASE_URL`,
`PROVIDER_JWT_SECRET`, `PROVIDER_PASSWORD_HASH`, `LICENSE_PRIVATE_KEY`, `PROVIDER_ORIGIN`.

hub: `HOTEL_HUB_SERVICE=hub`, `NODE_ENV`, `DATABASE_URL`, `LICENSE_DATABASE_URL`,
`SYNC_DATABASE_URL`, `HOTEL_ID`, `INSTALLATION_ID`, `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`,
`LICENSE_PUBLIC_KEY`, `PROVIDER_URL`, `CLOUD_SYNC_URL`, `HUB_LICENSE_KEY`, `APP_ORIGIN`,
`CLOUD_PUBLIC_URL`, `CLOUD_DASHBOARD_URL`, `CLOUD_SEALING_PUBLIC_KEY`, `CRON_SECRET`.

Keep every secret in Vercel as a sensitive variable. None belongs in the repository.

## Signing in on a production hub

A production hub accepts sign-in only from a registered device. Open the hub once on each
terminal with `/?device=<device ID>` (from Devices) and that browser remembers it; the
device ID field on the sign-in form is then filled in.

## Adding an administrator

On a hub with a shell: `npm run create-admin -- --email owner@example.com [--name "Name"]`,
or `--reset` for a new temporary password. The temporary password is printed once and must be
changed at first sign-in.
