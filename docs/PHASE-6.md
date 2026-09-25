# Phase 6 review: online booking, payments and guest messages

## Delivered

- Public booking website, served by the cloud at `/book/<hotel slug>`. Guests pick dates
  and guests, see each room type with its exact total (VAT and service charge included),
  book, and pay online when the hotel wants that. A status page (`/book/<slug>/status`)
  shows the booking with its reference and the guest's email.
- Booking allotment. Each room type has an online allotment: how many rooms per night the
  website may sell. The website never sells past it, even while the hub is offline. The
  hub turns each web booking into a real room.
- Online bookings page on the hub (Operations). Website bookings arrive by sync. Staff
  confirm one (the first free room or a chosen one) or reject it with a reason for the
  guest. Confirming creates the guest (or reuses the guest with the same email), the
  reservation at the price the guest was quoted, and the folio. Any verified online
  payment is added to the folio as an `online` payment.
- Cancelling a confirmed web reservation at the front desk cancels the web booking too,
  returns its room to the website, and tells the guest.
- Paystack and Flutterwave. A payment counts only after the gateway's verify API confirms
  the exact amount and currency. The browser's return and the webhook body are never
  trusted; a webhook only says which reference to check. Webhook signatures are checked
  (Paystack HMAC-SHA512 over the exact body, Flutterwave shared hash).
- Guest emails: booking received, payment received, confirmed, not confirmed, cancelled.
  The cloud sends them through one configurable HTTPS endpoint, with retries and backoff.
  Delivery status syncs down to the hub.
- Setup on the hub (administrators): website on/off, payment policy (pay at hotel,
  optional, required), how long an unpaid room is held, how far ahead guests may book,
  the policy text, the gateway keys and each room type's allotment.
- Migration `202609250007_booking`: a new `booking_agent` role, `payment_transactions.online_booking_id`,
  an `OnlineStatus` value `cancelled`, one active reservation per web booking.

## How a booking moves

| Step | Where | Record written |
|---|---|---|
| Guest books | Cloud (`booking_agent`) | `online_bookings` pending, with the quoted price. A "received" email. |
| Guest pays | Cloud, gateway verify API | `payment_transactions` success. A "payment received" email. |
| Sync | Cloud to hub | Booking, payments and emails pulled down |
| Staff confirm or reject | Hub | Reservation, folio, online payment. Booking confirmed or rejected. An email. |
| Sync | Hub to cloud | The decision; the cloud frees the room if rejected; the email is sent |

Each record has one owner, so replication never has to choose between two edits: the
cloud creates bookings and owns payments; the hub owns every change to a booking after
it is created. `booking_agent` has no UPDATE on `online_bookings`.

## Allotment rules

- Rooms left for a night = allotment minus web bookings for that night that are pending or
  confirmed. Rejected and cancelled bookings give their room back.
- When payment is required, an unpaid booking holds its room for the hold time (default
  30 minutes). After that it no longer counts, the guest can no longer pay, and the hub
  shows "Hold expired unpaid". A payment that arrives late still counts, and staff decide.
- Allotments are capped at the number of rooms of that type. Keep allotted rooms free on
  the hub: if a web booking cannot get a room when staff confirm it, reject it and the
  guest is told (with a refund note when they paid).
- Web sales for a room type are serialised with a lock, so two guests cannot both take
  the last room. A retried request (same request ID) returns the same booking and the
  same checkout, never a second one.

## Prices

The website uses the room type's base rate, or the latest rate plan that covers every
night, and the hotel's room tax category, with the same rounding as the front desk. The
hub confirms at that quoted price, not today's rate. At most 30 nights per web booking.

## Payment keys

The secret key is entered on the hub and sealed there with the cloud's public key
(RSA-OAEP-SHA256 wrapping AES-256-GCM, bound to the hotel and gateway). Only the sealed
box is stored, in the replicated `online_booking` setting. The hub cannot decrypt it; only
the cloud, which calls the gateway, can. The hub shows the last four characters. The
secret is write-only: leave it blank to keep the stored one.

## Security

| Boundary | Guarantee |
|---|---|
| booking_agent | Non-owner, no BYPASSRLS. Reads hotel id, slug, name and currency across hotels (to find a hotel by slug), and within one hotel only room types, rate plans, the room tax category and settings. Writes only bookings (insert), payments and messages. No access to guests, reservations, folios, payments, users or credentials. |
| Guests | No login. A booking is looked up by reference plus email. References are random (8 characters, about 39 bits), not sequential. Per-address rate limits on booking, lookup, payment and verification. |
| Amounts | Kobo conversion is exact string arithmetic. A payment for the wrong amount or currency is recorded as `mismatch` and does not count. |
| Messages | Signed with HMAC-SHA256 (`X-Hotel-Hub-Signature`), with an `Idempotency-Key`. No SMTP credentials in this codebase. |

## Configuration

Cloud sync API host:

```
BOOKING_DB_PASSWORD=<24+ random characters>
CLOUD_BOOKING_DATABASE_URL=postgresql://booking_agent:<password>@db.<project>.supabase.co:5432/postgres?sslmode=require
CLOUD_PUBLIC_URL=https://sync.your-provider.example
CLOUD_SEALING_PRIVATE_KEY_FILE=secrets/cloud-sealing-private.pem
NOTIFY_WEBHOOK_URL=https://messages.your-provider.example/hotel-hub
NOTIFY_WEBHOOK_SECRET=<32+ random characters>
```

Hub:

```
CLOUD_PUBLIC_URL=https://sync.your-provider.example
CLOUD_SEALING_PUBLIC_KEY_FILE=secrets/cloud-sealing-public.pem
```

Generate the sealing pair once per cloud (`npm run setup:demo` does this for the demo):
`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out cloud-sealing-private.pem`
and `openssl pkey -in cloud-sealing-private.pem -pubout -out cloud-sealing-public.pem`.
Give hubs only the public file. The demo Compose file mounts one `secrets` folder into
every container for convenience; a real hub must never hold the private key.

Without `NOTIFY_WEBHOOK_URL`, messages wait as pending (`NOTIFY_LOG=true` prints them, for
development). In the gateway dashboard, set the webhook address shown on the hub's
Setup tab.

The website is served only when the hotel's plan includes `online_booking` (Premium),
the subscription is trial, active or past due, and the hotel switched it on.

## Upgrading a Phase 5 hub and cloud

1. Stop the hub. Back up (`npm run backup`).
2. Add `BOOKING_DB_PASSWORD` to `.env` (bootstrap now sets the booking_agent password) and
   create the sealing key pair.
3. `node --import tsx scripts/bootstrap.ts` migrates hub and cloud to revision 7.
4. `npm run generate && npm run build`. Start the cloud first, then the hub.

## Checks

`tests/booking.test.ts` runs a real hub database and a real cloud database (PGlite), the
real sync worker, the cloud booking API and a stand-in for Paystack's API. It covers the
quote and tax, capacity and date rules, idempotent retries, the allotment limit, exact
kobo amounts, pending, successful and underpaid verification, webhook signatures over the
exact body, the guest lookup, hold expiry, the pull to the hub, a hub rejection freeing
the room in the cloud, and message delivery with retry and status sync. It also checks
`booking_agent`'s boundaries, the Flutterwave client, sealing and exact amounts.

`tests/booking.integration.ts` (CI, PostgreSQL 16) drives the hub endpoints: plan gate,
key validation, allotment cap, sealed keys never shown, confirm with a returning guest
and a prepaid folio credit, one payment per gateway reference, reject, cancel and the
queued guest messages.

## Remaining gates

- A real Paystack and Flutterwave test account end to end (redirect, webhook, verify).
- Refunds are recorded by staff; the gateway refund call is not automated.
- Room history and multi-room bookings: one room per web booking.
- The hub does not yet hold allotted rooms back from walk-ins; staff keep them free.

This is a review increment, not a production deployment approval.
