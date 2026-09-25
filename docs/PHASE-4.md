# Phase 4 review: sync engine and cloud database

## Delivered

- Hub sync worker. Runs every 30 seconds inside the hub process. Pushes the outbox
  to the cloud in batches of 100, in commit-safe order, then pulls website records down.
- Cloud sync API (`npm run start:cloud`, port 4002). Runs beside Supabase, never on a hub.
  The hub holds no cloud database credentials. Each request proves possession of the
  hotel's licence key for its bound installation, and every query runs under that
  hotel's RLS context.
- New `sync_agent` database role on both databases. Non-owner, no BYPASSRLS, tenant
  scoped. Its writes keep the origin `updated_at` and never re-enter the outbox, so a
  replicated row cannot echo back.
- Migration `202609250005_sync`: `sync_queue.seq` ordering column, explicit replication
  contract (`sync_replicated()`), sync_agent grants and policies. Existing outbox rows
  for local-only tables are closed with a reason.
- Header sync indicator for every user: Online and synced, Syncing (N pending),
  Offline (N records pending), Sync error, or Cloud sync off.
- Cloud sync admin page (`sync.manage`): pending and failed outbox, last error per row,
  Sync now, Retry selected, Retry all failed (audited as `sync_retry`), and the list of
  online bookings received from the website.
- Provider heartbeat: each push updates `hub_heartbeats` with version, pending and failed
  counts, so the provider console can see a hotel that has stopped syncing.
- New staff UI design (neutral dashboard style, tinted stat cards, light and dark themes,
  theme toggle). System fonts and inline icons only, so the app still loads offline.

## How sync behaves

| Situation | Result |
|---|---|
| Internet or cloud host down | Hub shows Offline. No retry attempts are consumed. Rows wait. |
| Cloud rejects a row (constraint, bad data) | Attempts +1, backoff 30s, 1m, 2m ... max 1h |
| 10 rejected attempts | Row becomes failed. Red alert on Overview and Cloud sync page |
| Wrong licence key or unbound installation | Sync error. Attempts not consumed |
| Hub and cloud on different releases | Sync error "Version mismatch". Attempts not consumed |
| Record changed on both sides | Last write wins on `updated_at`. Tie: hub wins. Both sides audit it |

Ordering: rows written in one transaction share `created_at`, so the queue is ordered
by `seq`, which is assigned when each outbox row is written. A child row therefore
always replays after its parent.

Money: payloads travel as raw Postgres JSON text and are converted by Postgres itself
(`jsonb_populate_record`), so NUMERIC(12,2) keeps every digit. Node never parses them.

What replicates (hub to cloud): roles, users (without password hashes), devices, guests,
rooms, room types, rate plans, reservations, folios, service categories, items and orders,
charges, payments, receipts, reprints, receipt counters, shifts, housekeeping, inventory,
online bookings, payment transactions, settings, notifications.

What stays local: tenants, subscriptions and licences (provider-owned), gateway
credentials, refresh sessions, licence cache, drafts, command receipts, print jobs,
sync bookkeeping. Audit history stays on the hub. Conflicts are audited on both sides.

What pulls down (cloud to hub): online bookings and payment transactions. After the
hub stores one, the cloud marks it `processed=true`. Staff see them on the Cloud sync
page. Turning an online booking into a reservation comes with the Phase 6 booking page.

## Configuration

Hub `.env`:

```
SYNC_DB_PASSWORD=<24+ random characters>
SYNC_DATABASE_URL=postgresql://sync_agent:<password>@localhost:5432/hotel?schema=public
CLOUD_SYNC_URL=https://sync.your-provider.example
HUB_LICENSE_KEY=<already present>
```

Cloud sync API host:

```
CLOUD_SYNC_DATABASE_URL=postgresql://sync_agent:<password>@db.<project>.supabase.co:5432/postgres?sslmode=require
CLOUD_PORT=4002
```

Leave `SYNC_DATABASE_URL` or `CLOUD_SYNC_URL` empty and the hub runs fully offline. The
outbox keeps growing, and everything uploads once sync is configured.

## Upgrading an existing Phase 3 demo or hub

1. Stop the hub. Back up (`npm run backup`).
2. Add `SYNC_DB_PASSWORD` to `.env` (bootstrap now sets the sync_agent password).
3. `node --import tsx scripts/bootstrap.ts` migrates hub and cloud to revision 5.
4. `npm run generate && npm run build`, start the cloud sync API, then the hub.
5. Upgrade the cloud first. A hub on revision 5 pauses sync against an older cloud
   without failing any rows.

The first cycle uploads the whole backlog from Phases 1 to 3.

## Checks

```sh
npm test
```

`tests/sync.test.ts` runs two real PostgreSQL engines (hub and cloud) and the actual
cloud API. It covers: parent and child rows in one transaction, exact money, password
redaction, no echo into the cloud outbox, heartbeat counts, update timestamps preserved,
online booking pull and processed flag, conflict in both directions with audit on both
sides, the tie rule, offline without attempt loss, wrong key, version mismatch, backoff
to 10 attempts and failure, and manual retry. A second test keeps the SQL and TypeScript
replication lists identical.

## Remaining gates

- End-to-end run against a real Supabase project and a real WAN outage.
- The cloud sync API needs a host (Render, Fly.io, Railway or a small VPS) with HTTPS.
  Vercel serverless is not a good fit for the long transactions.
- Phase 5 reports and the management dashboard read from this cloud copy.
- Phase 6 adds the public booking page, booking-to-reservation conversion and gateways.

This is a review increment, not a production deployment approval.
