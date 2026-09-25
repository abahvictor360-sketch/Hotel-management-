# Phase 2 review: front desk

## Delivered

- Paginated room calendar, room board, reservations, searchable guests and stay history.
- Existing/new guest reservations, quoted pricing, atomic walk-in check-in, cancellation,
  no-show, allocation/date amendments, stay extension and notes.
- Room types, room bulk creation with licensed quota, dated rate plans.
- Folio ledger with pagination and exact decimal balance, room charges at check-in,
  transactional zero-balance check-out and dirty-room transition.
- Shared PostgreSQL migration with overlapping-stay exclusion, one current occupant,
  matching room type/guest foreign keys, one folio per reservation, immutable saved
  command results and no posting to closed folios.
- Tenant RLS, API permissions, licence gates, transactional audit/outbox on all new
  business writes. Each POST/PATCH/PUT accepts a required UUID requestId. Reusing it
  returns the committed result, or rejects a changed intent. It never applies twice.

## Run and review

Use README quick start on a disposable demo. For an existing Phase 1 demo, stop app
processes, back up, run `node --import tsx scripts/bootstrap.ts`, `npm run generate`
and `npm run build`, then restart. Bootstrap migrates both hub/cloud databases.
Do not reset a hotel database. Migration deploy tracks applied migrations.

```sh
npm ci
npm run generate
npm run build
npm test
# Fresh disposable PostgreSQL 16 contract database only:
TEST_DATABASE_URL=postgresql://... npm run test:postgres
```

GitHub CI additionally creates isolated seeded databases and runs, in order:

```sh
node --import tsx --test tests/api.integration.ts
node --import tsx --test tests/frontdesk.integration.ts
```

These HTTP checks deliberately modify passwords and licences. Never run them against
hotel data. They cover concurrent room competition, repeat requests, tenant spoofing,
foreign guest references, invalid dates/capacity, duplicate room charges, extension,
unsettled/settled check-out, dirty-room gates, future arrivals, cancellation, room
quota, complimentary walk-ins, role restrictions and read-only licensing.

Manual review: create a reservation, find it on the calendar, check it in, inspect
its three folio charge lines, try check-out with a balance (blocked). Create a zero-rate
room type and room to complete a complimentary walk-in and check-out. Disconnect the
internet while retaining LAN access and repeat. Disconnect LAN and verify changes
cannot be confirmed. Restore LAN and retry the same action without reloading.

## Explicit assumptions and remaining gates

- Dates follow the hotel's configured timezone, default Africa/Lagos. A stay is at
  least one and at most 365 nights. Departure date is exclusive for room allocation.
- Confirmed reservations receive a physical room immediately. Future availability
  uses date overlaps, while current arrivals also block occupied and dirty rooms.
- Adults plus children count toward room capacity. No day-use/extra-bed pricing yet.
- A chosen rate plan must cover every night. VAT and service charge independently
  apply to room net, with half-up decimal rounding. Quoted terms are snapshotted.
- Full contracted accommodation posts on check-in. Early departure does not silently
  reverse charges. Extensions retain the original rate/tax terms. Phase 3 supplies
  authorised financial adjustments, refunds, split payments and receipt printing.
- Saved command receipts stay on the hub, protected by RLS, outside the business
  sync outbox. Keep the screen open for automatic ID reuse after an ambiguous response.
  Following reload, inspect existing records before starting a new action.
- Folios refresh on open or explicit refresh. Streaming notifications are not shipped.
- DB migration revision is 3. Signed licence schemaVersion remains protocol version 1,
  not the Prisma migration count. Sync version negotiation is delivered in Phase 4.
- Phase 1 generator scripts are archived and refuse to overwrite the evolved schema.
- Cloud sync, browser draft queue, payment collection, printers, installer, measured
  sub-300ms LAN performance and hardware verification are not claimed complete.
- Browser visual verification must be performed on the running demo. This environment's
  browser cannot reach the local preview. Build/SQL/HTTP checks do not replace that.

This is a review increment, not a production deployment approval.
