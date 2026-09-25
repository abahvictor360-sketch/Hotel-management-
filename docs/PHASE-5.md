# Phase 5 review: reports, exports and the management dashboard

## Delivered

- Seven reports on the hub (`reports.read`), each as a screen, a CSV file and a PDF file:
  management summary, revenue by department, payments collected, room occupancy,
  cashier shifts, open folio balances, and inventory and stock use.
- Reports read the hub's own database, so they work during an internet outage and while
  the licence is read-only.
- Read-only management dashboard served by the cloud sync API at `/dashboard`. It shows
  the same reports from the cloud copy, with a "Data as of" time from the last hub sync.
  Owners and managers open it with an access link. They do not need a staff login.
- Access links are created by an administrator on the hub (Data export page). They can be
  created offline and work after the next sync. Each link has a label, an expiry (1 to
  365 days), scopes (reports, export) and can be revoked. At most 10 are active at once.
- Tenant departure export: one ZIP file with every hotel table as UTF-8 CSV, a
  `manifest.json` with row counts and SHA-256 checksums, and a README. On the hub it
  includes the audit trail and is recorded in it (`tenant_export`). From the cloud it is
  available with an export-scoped link, including for suspended and cancelled hotels.
- Migration `202609250006_reports`: a new `report_reader` role, reporting indexes, and
  a fix for Phase 3 refunds (see below).

## Figures

| Report | How it is counted |
|---|---|
| Revenue | Room charges and folio adjustments on their charge time. Service sales when sold, split into net, VAT and service charge from the order's price snapshot. A voided sale is a negative line on the day it was voided. Folio lines that mirror a service sale are skipped, so nothing counts twice. |
| Payments | Every payment on its paid time, by method. Refunds are negative payments. |
| Occupancy | A sold night is a night between check-in and check-out of a stay that checked in. ADR and RevPAR use the booked nightly rate before VAT and service charge. Room count is today's configured rooms (room history is not versioned). |
| Shifts | Shifts opened in the period. Expected cash is the opening float plus cash taken, less cash refunds, on that shift. |
| Balances | Open folios with a non-zero balance, as of now. |
| Stock | Current count and reorder flag. Received and used cover the period. |

Days are hotel-local days in the hotel's time zone (`tenants.timezone`), not the server's
UTC day. A payment at 23:30 UTC in Lagos belongs to the next day. PostgreSQL does all
money arithmetic in NUMERIC and returns text, so Node never adds amounts. A period is
at most 366 days.

PDFs use the built-in Helvetica font, so no font is embedded and they build offline.
Characters outside Windows-1252 print as "?", and the naira sign is written as NGN.
CSV files start with a byte-order mark so Excel reads UTF-8 names. A cell that begins
with `=`, `+`, `-` or `@` (and is not a plain number) gets a leading apostrophe, so a
guest name cannot run as a spreadsheet formula.

## Security

| Boundary | Guarantee |
|---|---|
| Dashboard role | `report_reader` is non-owner and has no BYPASSRLS. It can only SELECT, with tenant-scoped policies, and every request runs in a `READ ONLY` transaction. The cloud server refuses to start with a role that owns tables or bypasses RLS. |
| Secrets | `report_reader` has no access to password hashes, licence hashes, gateway credentials, sync queue or audit log. Column grants limit `users`, `tenants` and `subscriptions`. |
| Access links | Format `hh1.<hotel>.<link id>.<secret>`. Only the SHA-256 of the 256-bit secret is stored, in the replicated `remote_access` setting. It is compared in constant time. Unknown, tampered, expired, revoked and not-yet-synced links all get the same 401. A link cannot be pointed at another hotel. |
| Link handling | A shared link carries the code after `#`, which browsers do not send to servers or in Referer headers. The page moves it to session storage and removes it from the address bar. |
| Plan and status | Reports need the `mobile_dashboard` feature (Premium) and a trial, active or past-due subscription. Export-only links work on every plan and every status. |
| Hub endpoints | Access link management and the full export need the administrator role. `GET /api/settings` never lists `remote_access`, and `PUT /api/settings` cannot write it. |
| No echo | Dashboard reads write nothing, so nothing enters the outbox. |

Revoking a link, or a new link, reaches the cloud on the next sync (every 30 seconds
while online). A hub that is offline cannot revoke a link in the cloud until it
reconnects. Links expire on their own even if the hub never syncs again.

The cloud export holds what the hub synced. It has no audit trail and no passwords.
The hub export is the complete record.

## Fix included: refunds on PostgreSQL

The Phase 3 reversal trigger read the original payment or charge `FOR UPDATE`. A row lock
needs UPDATE privilege, which `hotel_app` deliberately lacks on the append-only ledgers,
so every refund and charge reversal failed with "permission denied" on PostgreSQL 16
(`tests/billing.integration.ts` failed at the void step). The lock was unnecessary:
ledger rows cannot change, and unique indexes already allow one reversal per original.
The trigger now reads without a lock. No privilege was added.

## Configuration

Cloud sync API host (optional; without it the cloud serves sync only):

```
REPORT_DB_PASSWORD=<24+ random characters>
CLOUD_REPORT_DATABASE_URL=postgresql://report_reader:<password>@db.<project>.supabase.co:5432/postgres?sslmode=require
```

Hub (optional, shown to administrators next to new links):

```
CLOUD_DASHBOARD_URL=https://sync.your-provider.example/dashboard
```

Serve the cloud sync API over HTTPS in production. The dashboard page and its API share
that origin.

## Upgrading a Phase 4 hub and cloud

1. Stop the hub. Back up (`npm run backup`).
2. Add `REPORT_DB_PASSWORD` to `.env` (bootstrap now sets the report_reader password).
3. `node --import tsx scripts/bootstrap.ts` migrates hub and cloud to revision 6.
4. `npm run generate && npm run build`. Upgrade and start the cloud sync API first, with
   `CLOUD_REPORT_DATABASE_URL`, then the hub. A revision 6 hub pauses sync against a
   revision 5 cloud without failing any rows.

## Checks

```sh
npm test
```

`tests/reports.test.ts` seeds two hotels in real PostgreSQL (PGlite) and checks every
figure against hand-calculated values under both `hotel_app` and `report_reader`,
including the hotel-local day boundary, voids, refunds and tenant isolation. It checks
that `report_reader` cannot write or read secrets, that the export has every table with
valid checksums and no password hashes, and the remote API's link, plan, subscription
and scope rules. It also checks the PDF cross-reference table, CSV injection guard and
ZIP checksums.

`tests/reports.integration.ts` (CI, PostgreSQL 16) drives the hub HTTP endpoints
through Prisma: every report in JSON, CSV and PDF, the audited departure export,
link creation, plan gate, listing without hashes, revocation, and read-only mode.

## Remaining gates

- Run against a real Supabase project over HTTPS, with the dashboard opened on a phone.
- Very large hotels: the export is built in memory in one repeatable-read transaction
  (120-second limit). Streaming is a later change if a hotel outgrows it.
- Room history is not versioned, so occupancy for past periods uses today's room count.
- Phase 6 adds the public booking page, booking-to-reservation conversion and gateways.

This is a review increment, not a production deployment approval.
