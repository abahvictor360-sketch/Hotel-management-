# Trust boundaries and delivery design

Each hotel has one authoritative hub and one tenant UUID. Staff browsers connect
to the hub across the hotel network. That path does not involve Supabase, a CDN,
a remote auth service or the provider. All browser assets are local.

The provider API is a separate process, port, database login and JWT audience.
It owns subscriptions/licence issuance only. Staff API endpoints cannot select a
tenant by request body/query, and provider endpoints never return guest, folio,
charge or payment data. The shared cloud has the same complete schema and forced
RLS, ready for tenant-scoped replication APIs in Phase 4.

## Database identities

| Identity | Purpose |
|---|---|
| Migration owner | DDL/provision only, never an application runtime |
| hotel_app | RLS-scoped operational records, no subscription edits |
| license_agent | RLS-scoped signed licence cache only |
| provider_app | Control-plane tenants/subscriptions/licences/health, no guests/payments |

The tenant context is transaction-local through `set_config(..., true)` inside
Prisma interactive transactions. This prevents a pooled connection retaining a
previous request's tenant. Policies default-deny absent tenant context. The SQL
roles are not owners, superusers or BYPASSRLS. Startup verifies this configuration.
Tenant-composite foreign keys prevent relational cross-tenant mistakes.

The migration owner and the trusted server are privileged trust boundaries.
Database credentials never enter a browser. RLS based on application context
protects normal application queries, not a compromised server or a database
administrator who deliberately changes settings. All SQL parameters from input
use bound values; no dynamic user-supplied table names or expressions exist.

## Outbox and immutable records

`mutation(tx, fn)` supplies two application-generated UUIDs to a database trigger.
The trigger records an outbox event and redacted audit event in the same database
transaction as the source mutation. Missing event context rejects the write.
Any error rolls back source, outbox and audit together. App-generated UUIDs apply
to every table, including trigger-created records. Bootstrap/system actions use
null staff provenance with a system device identifier.

Financial rows cannot change. `sync_metadata` holds mutable replication status,
not a financial `synced` flag. Receipts retain their original content snapshot;
reprint events provide the count and each reprinting actor. Phase 3 will implement
reversal validation/settlement rules on top of these storage constraints.

`source_id`, `entity_id`, `record_id` and reference_id are polymorphic identifiers,
not unconditional foreign keys. Their future handlers must validate the declared
source type. Ordinary relational references have tenant-composite foreign keys.

## Auth and devices

Staff sessions use 10-minute access tokens and fixed 7-day refresh families. The
raw refresh token is never stored server-side; only its SHA-256 digest is stored.
Rotation locks the row, marks the old token revoked, and creates the next one.
Replay revokes the family in a transaction that commits before returning 401.
Every request checks user active status, token version, session and current role.
Password change revokes all sessions. Role changes invalidate tokens immediately.

Registered device IDs are operational labels, not cryptographic hardware identity.
The server enforces registered-device count and production login requires an ID.
A user who copies an existing ID can label another browser as that workstation.
Hardware-bound enrollment and administrator revocation are release-hardening work
before paid production rollout; do not represent this as strong device attestation.

## Offline licensing and deferred sync

Licence validation is independent of business sync. The worker runs hourly and
never blocks a staff request waiting for internet. Requests check the signed
cache locally. Each signed lease has a hard 14-day maximum. A clock high-water
mark catches ordinary rollback, but local admin tampering cannot be eliminated
by a pure offline software licence.

Phase 4 ships the replication worker and cloud sync API: ordered batches, an explicit
table contract, retry backoff, failed-event alerts, LWW conflict audit, a cloud-origin
booking pull and version negotiation. See docs/PHASE-4.md. It must never replay control-plane licence/subscription changes from
a hotel hub into provider authority. Passwords/credentials need their own secure
provisioning path, not the generic replication payload.

Phase 5 reports run the same parameterised SQL on the hub (hotel_app) and in the cloud
(report_reader, read-only transaction). The cloud dashboard authenticates with hashed
access links that replicate inside the `remote_access` setting. See docs/PHASE-5.md.

Phase 6 online booking runs in the cloud as booking_agent. The website sells from each
room type's online allotment, so a stale cloud copy cannot overbook; the hub confirms each
web booking into a real room. The cloud creates bookings and owns payments, the hub owns
every later change to a booking, so replication never merges two edits. Gateway secrets
are sealed on the hub to the cloud's public key. See docs/PHASE-6.md.
