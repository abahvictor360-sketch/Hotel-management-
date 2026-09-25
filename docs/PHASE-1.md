# Phase 1 acceptance

## Included

- 39 tenant-scoped tables covering all originally requested business entities plus
  subscriptions, licences, credentials, refresh sessions, metadata and reprint events.
- Prisma 6 PostgreSQL schema, a generated DDL migration, and a security migration
  for local and cloud. TIMESTAMPTZ, JSONB, NUMERIC money, UUID v4 supplied by app.
- RLS, tenant-composite foreign keys, indexes, append-only financial protection,
  hard-delete rejection, updated_at triggers and atomic mutation outbox/audit.
- Bcrypt staff authentication, short-lived JWTs, hashed rotating refresh tokens,
  replay-family revocation, live account/role/session checks and password reset gate.
- Seeded roles, staff create/enable/disable, role creation API, device registration
  with signed plan limits and separate staff/provider auth domains.
- Signed offline leases, installation binding, hourly renewal, state policy,
  14-day maximum grace and read-only enforcement at API/database write boundary.
- Separate provider console: tenant create, subscription status/plan changes,
  trial extension, licence rotation and modeled fleet health.
- Staff PWA shell, permission-filtered navigation, branding and read-only messaging.
- AES-256-GCM per-tenant gateway credential storage with tenant/provider AAD.
- Docker development topology with separate hub/cloud PostgreSQL 16 databases.
- Production hub topology, PM2 configuration, Windows service source, backup script.

## Deliberate boundaries

This is not a complete production-ready hotel system yet.

- Phase 2: room calendar, guests, reservations, check-in, folios, room quota.
- Phase 3: departments, charges, tax calculation, payment settlement, receipt numbering,
  ESC/POS driver/tests, inventory, housekeeping and offline drafts.
- Phase 4: push/pull worker, retries/conflicts, schema version negotiation, sync admin,
  telemetry transport, full wizard, signed Windows installer and release update/rollback.
- Phase 5: reports, PDFs/CSV, read-only management dashboard and tenant departure exports.
- Phase 6: booking allotment workflow, guest notifications and gateway verification.

Schema support does not imply that these workflows already operate. The dashboard
explicitly says cloud sync is not enabled. Printer fields exist, but no test button
claims to print. PWA caches the shell only. Provider health is blank until telemetry exists.

## Assumptions

- Trial length: 14 days. Cached permission max: 14 days from provider validation.
- Past-due subscriptions warn but remain writable during a valid signed lease.
- One production tenant per hub database. Shared cloud database uses forced RLS.
- Standard: 8 devices / 50 rooms. Premium: 25 devices / 200 rooms. These are starting
  product tiers, not prescribed pricing. Staff/user count is not separately capped.
- VAT/service default on for all demo categories. The stored rates are editable
  per category when the service configuration module is built. No legal/tax claim
  is made about which services should be taxable at an individual hotel.
- Tax and service charge are independently calculated on net amounts, not compounded.
- Receipts are immutable snapshots. A reprint is a new event, not an UPDATE.
- System/provisioning rows have a null created_by. Human writes have staff provenance.
- Provider secret keys live only in the provider deployment. Demo co-location is not
  the production deployment model.
- Runtime performs no external fetch for normal staff authentication or hotel reads.
- Node 20.19+ remains the source compatibility floor; production targets Node 24 LTS.

## Checks for review

1. `npm ci && npm run generate && npm run build && npm test`.
2. Generate demo config and start Compose. Sign in, change initial password, sign in again.
3. Create a receptionist; verify their menu excludes staff and audit administration.
4. Register devices until the licence limit; the next create must return 409.
5. Validate the licence, disconnect external internet while retaining LAN, and sign in.
6. In provider console, suspend the hotel, then validate its licence at the hub.
   Hotel lists remain readable while staff/device/setting writes return 423.
7. Run CI on PostgreSQL 16. Inspect RLS, auth/replay and cross-tenant checks.

Windows installation, real printer output and physical LAN performance require
hardware acceptance in later phases. No under-300ms claim has been measured yet.
