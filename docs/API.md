# Phase 1 API

All staff requests use `Authorization: Bearer <accessToken>` except login/refresh,
health and public hotel branding. Staff tokens live in browser memory. Refresh
tokens are HttpOnly, SameSite=Strict cookies and Secure in production. Express
uses same-origin checks on browser mutations. JSON body schemas reject extra keys
on authentication, staff creation and permission-sensitive writes.

| Method | Path | Access / behaviour |
|---|---|---|
| GET | /api/health | Local database readiness; no hotel secrets |
| GET | /api/branding | Installed hotel's public name/logo |
| POST | /api/auth/login | email, password, registered deviceId |
| POST | /api/auth/refresh | Rotate cookie, revoke family on replay |
| POST | /api/auth/logout | Revoke session family and clear cookie |
| GET | /api/auth/me | Current account, role and permissions |
| POST | /api/auth/password | currentPassword, newPassword; revokes all sessions |
| GET | /api/dashboard | Basic counts and actual Phase 1 sync state |
| GET | /api/license | Cached signed entitlement and writable status |
| POST | /api/license/activate | settings.write; key exchange with provider |
| GET/POST | /api/users | staff.read / staff.write; POST forces password change |
| PATCH | /api/users/:id | staff.write; roleId/isActive; cannot change own access |
| GET/POST | /api/roles | roles.read / roles.write |
| GET/POST | /api/devices | devices.read / devices.write; quota lock |
| GET/PUT | /api/settings | settings.read / settings.write; allowed setting schemas |
| PUT | /api/gateway-credentials | settings.write; gateway + secretKey; no read-back |
| GET | /api/audit | Seeded admin role plus audit.read; latest 100 immutable events |

Separate provider API, served by a different process and auth audience:

| Method | Path | Body |
|---|---|---|
| POST | /api/provider/login | password |
| GET | /api/provider/tenants | First 100 hotel subscriptions and health metadata |
| POST | /api/provider/tenants | name, slug, plan; returns one-time licence key |
| PATCH | /api/provider/tenants/:id/subscription | status, optional plan/trialEndsAt |
| POST | /api/provider/tenants/:id/license | Rotate key, revoke previous keys |
| POST | /api/license/validate | key, tenantId, installationId, schemaVersion=1 |

The activation exchange accepts a claimed tenant only with its matching licence
secret. This is the bootstrap exception to JWT tenant resolution. All operational
staff routes resolve tenant from a verified token bound to the installed hub.
Provider access is deliberately global, restricted to control-plane tables.

Errors: 400 invalid input, 401 session missing/expired, 403 permission denied,
404 missing record, 409 duplicate/quota, 423 licence read-only, 503 licence server
unavailable. Database internals are not returned to users.

List screens currently cap at 100. Cursor pagination/search follows with each
operational module. Do not use these endpoints as a bulk export mechanism.

## Phase 4 sync

| Method | Path | Access / behaviour |
|---|---|---|
| GET | /api/sync/status | Any signed-in user; state, pending, failed, last success, last error |
| GET | /api/sync/queue | sync.manage; status=pending or failed, paginated, no payloads |
| POST | /api/sync/retry | sync.manage; ids (1 to 100) or allFailed=true; audited |
| POST | /api/sync/run | sync.manage; starts a cycle now, returns 202 |
| GET | /api/online-bookings | frontdesk.read; latest 50 bookings pulled from the cloud |

Cloud sync API (separate process, hub-to-cloud only). Headers: Authorization Bearer
licence key, X-Hotel-Id, X-Installation-Id. Every body carries protocol and databaseRevision.

| Method | Path | Body |
|---|---|---|
| POST | /api/sync/push | hub counts, up to 100 events; returns applied, duplicate, stale or error per event |
| POST | /api/sync/pull | limit; returns pending cloud-origin events for pull tables |
| POST | /api/sync/ack | applied ids, failed ids with errors |

## Phase 5 reports and exports

Report kinds: summary, revenue, payments, occupancy, shifts, outstanding, inventory.
Query: from and to (YYYY-MM-DD, hotel-local, inclusive, at most 366 days), format=json|csv|pdf.

| Method | Path | Access / behaviour |
|---|---|---|
| GET | /api/reports/:kind | reports.read; works in read-only mode |
| GET | /api/exports/tenant | administrator; ZIP of every table plus manifest; audited |
| GET | /api/remote-access | administrator; links without hashes, plan and dashboard URL |
| POST | /api/remote-access | administrator; label, days (1 to 365), scopes; returns the link once |
| DELETE | /api/remote-access/:id | administrator; revokes; reaches the cloud on next sync |

Cloud management dashboard (cloud sync API process, needs CLOUD_REPORT_DATABASE_URL).
Header: Authorization Bearer access link code. Runs as report_reader in a read-only transaction.

| Method | Path | Behaviour |
|---|---|---|
| GET | /dashboard | Dashboard page |
| GET | /api/remote/session | Hotel, link label, scopes, expiry, plan state, last sync time |
| GET | /api/remote/reports/:kind | reports scope, Premium plan, live subscription |
| GET | /api/remote/export | export scope; any subscription status |

## Phase 6 online booking

Hub:

| Method | Path | Access / behaviour |
|---|---|---|
| GET | /api/online-bookings | frontdesk.read; status=pending, confirmed, rejected or cancelled; payment state |
| GET | /api/online-bookings/:id/rooms | frontdesk.read; free rooms for a pending booking |
| POST | /api/online-bookings/:id/confirm | frontdesk.write; requestId, optional roomId; creates the reservation and applies online payments |
| POST | /api/online-bookings/:id/reject | frontdesk.write; requestId, reason (sent to the guest) |
| GET | /api/online-booking/settings | settings.write; policy, allotments, gateway (never the secret), booking and webhook URLs |
| PUT | /api/online-booking/settings | administrator; secret key is sealed for the cloud and write-only |

Cloud public booking API (no login, rate limited, needs CLOUD_BOOKING_DATABASE_URL):

| Method | Path | Behaviour |
|---|---|---|
| GET | /book/:slug | Booking page (also /status and /return) |
| GET | /api/public/hotels/:slug | Hotel, room types sold online, payment policy |
| POST | /api/public/hotels/:slug/quote | roomTypeId, checkIn, checkOut, adults, children; price and availability |
| POST | /api/public/hotels/:slug/bookings | requestId, stay, guest, expectedTotal, payNow; returns reference and checkout URL |
| POST | /api/public/hotels/:slug/bookings/:ref/status | email; the booking as the guest sees it |
| POST | /api/public/hotels/:slug/bookings/:ref/pay | email; a new checkout for an unpaid booking |
| POST | /api/public/hotels/:slug/payments/verify | reference; asks the gateway, never trusts the browser |
| POST | /api/public/webhooks/:gateway/:slug | Gateway webhook; signature checked, then verified with the gateway |
