# Hotel Hub

Offline-first, multi-tenant hotel management. Phase 1 review release (0.1.0).

This repository is a working foundation, not a finished hotel management product.
Phase 1 contains the complete business schema, security migrations, seed data,
staff authentication, roles, tenant boundaries, signed licensing, a staff PWA
shell, and a separate provider console. The six-phase delivery pauses here for review.

## Quick start: no Supabase account needed

Requirements: Git, Node.js 24 LTS (20.19+ compatibility target), Docker Desktop
on Windows or Docker Engine with Compose on Ubuntu 22.04.

```sh
git clone https://github.com/abahvictor360-sketch/Hotel-management-.git
cd Hotel-management-
npm ci
npm run setup:demo
docker compose up --build
```

Open http://localhost:4000 for staff and http://localhost:4001 for the provider.
Generated passwords are in `secrets/demo-logins.txt`. The administrator must
change their password before accessing the hotel. Initial licence validation
runs when the hub starts. If the provider was still starting, use the Activate
button on Overview with `HUB_LICENSE_KEY` from `.env`, or restart the hub.

The database setup service runs migrations and an idempotent demo seed.
It creates 12 rooms, three room types, eight roles, eight service categories,
sample menu items, and one administrator. No shared default password is shipped.
VAT defaults to 7.5% and service charge to 10%, each independently configurable
per service category in the schema. Actual charge calculation belongs to Phase 3.

For LAN testing, set `HUB_ORIGIN=http://YOUR-HUB-IP:4000` in `.env`, recreate the
hub container, and open that address from your devices. Do not expose port 5432.
The provider console stays bound to localhost in the demo.

## Development without app containers

```sh
docker compose up -d db cloud-db
node --import tsx scripts/bootstrap.ts
npm run seed
npm run generate
npm run dev
# Other terminals:
npm run dev:provider
npm run dev:web
npm run dev:console
```

Staff Vite app: http://localhost:5173. Provider Vite app: http://localhost:5174.
Use those origins from `.env`. A production build is served by Express itself.

## Checks

```sh
npm run generate
npm run build
npm test
npm audit --omit=dev --audit-level=high
```

`npm test` runs licence/cryptography checks plus the real PostgreSQL engine
compiled to WASM (PGlite PostgreSQL 17). It exercises RLS, cross-tenant inserts,
foreign keys, immutable financial records, immutable audit, read-only writes,
password redaction and outbox rollback. It is not a substitute for PostgreSQL 16.

GitHub Actions also runs the SQL contract and HTTP authentication suite against
PostgreSQL 16. Locally, use a NEW disposable database for the contract:

```sh
# Set TEST_DATABASE_URL to a fresh PostgreSQL 16 database owned by its migration user.
npm run test:postgres
```

`tests/api.integration.ts` requires freshly seeded hub/cloud test databases.
It changes the demo password and subscription state. Do not run it on hotel data.
See `.github/workflows/ci.yml` for the full disposable-database procedure.

## Repository map

| Location | Purpose |
|---|---|
| `apps/api/src` | Express hub and separate provider API processes |
| `apps/web` | Staff React/Vite/Tailwind PWA shell |
| `apps/provider` | Provider-only React console |
| `packages/db/prisma` | Full PostgreSQL schema and both shared migrations |
| `packages/core/src` | Licences, encryption, permission catalogue and plan defaults |
| `scripts` | Provisioning, demo configuration, seed, backup and bootstrap |
| `tests` | Unit, database-boundary and HTTP checks |
| `deploy` | Ubuntu/Windows operational setup |
| `docs` | Architecture, API, decisions, phase acceptance and staff guide |

## Tenant and database security

- UUID v4 identifiers come from application `crypto.randomUUID()`. No serials,
  database UUID defaults or floats for money. Amounts use NUMERIC(12,2).
- Business tables include tenant_id, created_at, updated_at, deleted_at,
  device_id and created_by. `created_by` is nullable only for system/provisioning
  records that exist before a staff user. Every non-null creator uses a
  tenant-composite foreign key.
- Tenant-scoped unique keys include tenant_id. Global UUID primary keys are
  the identity exception. Tenant id equals its own id. Platform plan definitions
  are versioned code; each tenant subscription stores its purchased limits.
- Runtime PostgreSQL roles cannot own tables, be superusers or bypass RLS.
  Startup rejects unsafe roles. RLS is ENABLED and FORCED on every business table.
- Each request uses transaction-local tenant context from a verified staff JWT.
  The hub rejects tokens for any other HOTEL_ID. Login uses the installed hub
  identity, never an email-derived or client-supplied tenant. Provider routes are
  separate, use a separate signing key/audience and have no guest/payment grants.
- Composite foreign keys `(tenant_id, foreign_id)` prevent cross-hotel references.
  No request API accepts raw SQL, a table name or tenant override.
- Supabase anon/authenticated/service_role table grants are revoked in the shared
  migration. The future public booking and remote report apps call scoped server
  APIs, not the unrestricted service-role Data API.
- A PostgreSQL trigger requires app-generated event/audit IDs for each business
  mutation and inserts both outbox and audit rows inside that transaction.
  A direct untracked mutation fails. Bulk writes must call `mutation()` per row.
- Payments, charges, receipts, reprint events, stock movements and audit entries
  reject UPDATE and DELETE. Other tables reject DELETE. Correct financial errors
  with linked reversal entries. Receipt reprint counts are derived from events.
- `sync_metadata.synced` replaces mutable `synced` flags on financial rows.
  Auth sessions and sync bookkeeping are local control records, not replicated
  business changes. Password hashes and gateway ciphertext are omitted from
  outbox/audit payloads; future sync must use explicit per-table contracts.

## Licensing

Licences are random high-entropy secrets stored hashed in the provider database.
First activation binds one key to one installation UUID. The provider signs
an Ed25519 lease containing tenant, installation, subscription, entitlements,
schema version and expiry. Only the public key reaches production hubs.

The hub refreshes hourly with an 8-second timeout. No cloud request is made in
staff login or an operational request. Each write checks the locally cached
signature and expiry. Online failure never extends the lease. Clock rollback
past the persisted high-water mark makes writes read-only.

| State | Behaviour |
|---|---|
| trial | Writes until the earlier of trial expiry and signed lease expiry |
| active | Writes while the cached lease is valid |
| past_due | Writes during the signed lease, with a payment-due message |
| suspended | Read-only as soon as the signed suspension reaches the hub |
| cancelled | Read-only as soon as the signed cancellation reaches the hub |
| no licence / lease expired | Read-only with activation/renewal message |

Every lease lasts at most 14 days. An offline suspension cannot reach the hub
immediately; the last signed permission expires within that window. Provider
operators must move overdue subscriptions to suspended/cancelled when appropriate.
Billing records are modeled, but automatic SaaS billing is not in this phase.
Database/OS administrators can alter local programs and clocks; this is a
commercial offline licence system, not tamper-proof DRM.

Standard defaults to 8 devices / 50 rooms. Premium defaults to 25 / 200.
The provider can change plan on the subscription endpoint. Feature flags are
signed, not trusted from UI input. Device registration enforces the limit under
a database advisory lock. Room-limit enforcement is part of Phase 2 room creation.

## New hotel onboarding (Phase 1)

1. Sign in to the provider console and create a hotel. Save its ID and one-time key.
2. Prepare a fresh PostgreSQL 16 hub database and run both migrations as the owner.
3. Create non-owner `hotel_app` and `license_agent` login passwords. Keep migration
   credentials out of the running hub environment.
4. Configure `.env` with HOTEL_ID, a new stable INSTALLATION_ID, public licence key,
   provider URL, HUB_LICENSE_KEY and initial administrator details.
5. Run `npm run provision:hub` from the hub with temporary migration credentials.
   This validates the signed licence before creating any local hotel data.
6. Remove migration credentials from the running service environment. Start the
   hub and change the administrator password. Register the other devices.

The full first-run wizard, CSV import, printer test and compiled Windows installer
are scheduled with the operational modules. They are not represented as completed
by this Phase 1 release. New tenant administrators are created on their hub,
not in the provider cloud database, so their login works during internet loss.

## Windows hub

See [Windows setup](deploy/windows/README.md). Use a static LAN IP, PostgreSQL 16,
Node LTS, a PM2 process wrapped by a Windows service, and nightly Task Scheduler
backups. The source includes a service-registration script. This is not yet a
signed one-click installer executable.

## Ubuntu hub

See [Ubuntu setup](deploy/ubuntu.md). `compose.hub.yml` is the hub-only topology.
It intentionally has no provider signing key or provider admin credentials.
The local demo `compose.yml` runs both sides only for development.

## Browser offline and HTTPS

The cached PWA shell needs a secure browser context. `http://localhost` works for
development, but `http://192.168.x.x` generally cannot register a service worker.
Install a trusted LAN TLS certificate on all eight devices and use HTTPS for
production. Internet independence and hub connectivity are different: a device
without hub access cannot confirm payments, allocations or receipt numbers.
Phase 1 caches only static assets, never API responses or guest data. Draft
queuing for orders, guests, housekeeping and notes comes with those modules.

## Backups and restore

`npm run backup` makes a PostgreSQL custom-format dump in
`BACKUP_DIR/HOTEL_ID`, then prunes completed dumps older than 14 days. It refuses
a multi-tenant/mismatched source database. Include the encryption key, licence
public key and installation config in a separate encrypted recovery package.

Restore to a fresh PostgreSQL 16 database using `pg_restore --no-owner`, recreate
runtime login roles/grants, point the app at it, run migration checks, then verify
staff login and record counts before switching devices. Stop the hub first and
keep the old database untouched until validation passes. Use a UPS and keep an
encrypted backup copy on another physical device. See `docs/OPERATIONS.md`.

## Production release gates

Do not use this phase for live hotel transactions. Required later gates include
concurrent room allocation, settlement/reversal tests, printer hardware tests,
Windows service reboot/upgrade/rollback tests, LAN latency measurement, offline
multi-device tests, Supabase deployment and end-to-end sync fault injection.
Node.js 20 is end-of-life as of this release date; Node.js 24 LTS is recommended.
See `docs/PHASE-1.md` for the precise completed/pending boundary.
