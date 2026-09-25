# Windows 10/11 hub setup (Phase 1 source)

This phase provides manual setup and a Windows service script, not a compiled
one-click installer. Do not describe the source script as a tested installer.
The NSIS bundle and signed upgrade/rollback path remain a Phase 4 release gate.

1. Install Node.js 24 LTS and PostgreSQL 16 x64 from their official distributions.
   Include command-line tools. Keep PostgreSQL bound to localhost. Use a strong
   postgres owner password and a dedicated `hotel` database.
2. Place this checkout at `C:\HotelHub`. From an administrator terminal, run
   `npm ci`, `npm run generate`, then `npm run build`.
3. Create `.env` from `.env.example`. Production hub config includes only hub
   settings and the licence public key. Do not copy the provider private key,
   PROVIDER_PASSWORD_HASH or PROVIDER_JWT_SECRET onto a hotel computer.
4. Use a temporary migration-owner DATABASE_URL to run `npm run migrate`.
   Give the migration-created hotel_app and license_agent roles LOGIN with
   different strong passwords. Put those runtime URLs in the hub environment.
5. Onboard the hotel in the provider console. Configure its ID, licence key,
   installation UUID, administrator email/password. Run `npm run provision:hub`
   with MIGRATION_DATABASE_URL present. Remove that owner URL afterwards.
6. Configure a DHCP reservation or static IPv4 on the hub, e.g. 192.168.1.10.
   Exclude it from conflicting DHCP leases. Use Ethernet for the hub when possible.
7. Add trusted LAN HTTPS before production. PWA installation, secure refresh
   cookies and offline shell support require HTTPS on remote LAN devices.
8. Obtain WinSW x64 from the official WinSW project, validate its release hash,
   and run from elevated PowerShell:

```powershell
.\deploy\windows\Install-Service.ps1 -AppPath C:\HotelHub -WinSWPath C:\Installers\WinSW-x64.exe
Get-Service HotelHub
```

The script runs pm2-runtime through WinSW as LocalService. It opens TCP 4000 only
for the Private network profile and local subnet. If a TLS reverse proxy serves
443 instead, open only that port to clients and restrict 4000 to the proxy.
No `pm2 startup` command is assumed to create a Windows service.

9. On each of the eight browser devices, open the hub HTTPS address, enter the
   administrator-registered device ID, then sign in as that staff member.
10. Configure Task Scheduler to run `npm run backup` at 02:00 hotel local time.
    Use a dedicated backup identity and environment with pg_dump credentials.
    Never grant hotel_app database-owner access for backups.
11. Reboot and verify PostgreSQL starts, HotelHub is running, login succeeds,
    and a test backup restores into a separate disposable database.

## Printer readiness

Keep printer interface/model transport out of hardcoded code. Phase 1 stores
network/USB/serial, width 58/80, interface and characterSet in settings. Actual
ESC/POS transport, the admin print-test button and XP-80C / TM-T20 acceptance
will ship in Phase 3. No physical printer testing has occurred in this phase.

## Installer/update acceptance planned for Phase 4

- Bundle verified Node LTS, PostgreSQL 16, app build, WinSW and dependencies for
  installation without internet. Include redistributable notices and hashes.
- Generate unique database/application secrets locally; never ship .env or a
  provider signing key. Register services and complete first-run activation.
- Back up first, stop API/workers, apply forward-only migrations, health-check,
  then commit the release pointer. Idempotent migration deployment is required.
- Roll back app only when its schema compatibility permits it. Otherwise restore
  the pre-upgrade database backup and app together. Never guess a down migration.
- Test clean Windows 10/11, failed migration, power interruption and reboot.
