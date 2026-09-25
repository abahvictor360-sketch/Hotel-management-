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
