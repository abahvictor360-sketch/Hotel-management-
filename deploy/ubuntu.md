# Ubuntu 22.04

For a complete local demo, install Docker Engine/Compose and Node LTS, then follow
README Quick start. PostgreSQL runs as version 16 in Docker.

For a production hotel hub, use `compose.hub.yml`. Prepare these separate files:

- `.env.database`: POSTGRES_DB=hotel and a generated POSTGRES_PASSWORD.
- `.env.hub`: only hub runtime variables. URLs use hostname `db`. Configure
  NODE_ENV=production, HTTPS APP_ORIGIN, and external HTTPS PROVIDER_URL.
- `.env.backup`: HOTEL_ID and BACKUP_DATABASE_URL for `db`, under a backup identity.

Set file permissions to 600. Mount only the licence PUBLIC key on the hub. Run
migrations/provisioning with an owner credential before starting the runtime.
Do not mount a provider private key or the cloud migration URL in the hub container.
Use the same migrations on the cloud with that deployment's migration identity.
The Compose file persists DB data and restarts services after Docker starts.
Enable Docker at boot. Restrict incoming traffic to the hotel LAN and the HTTPS
reverse proxy port. Do not publish the database port in production.

Reserve a LAN address for the hub in your router or netplan. Use a local TLS CA
trusted by all clients, or a hotel-owned domain/certificate with local DNS.
The certificate must remain valid when external internet is disconnected.

The included backup container runs at startup and every 24 hours. For an exact
02:00 Africa/Lagos schedule, run `npm run backup` from a systemd timer or cron at
that local time. Keep 14 days and test restoration on another database.

## Supabase cloud

Create a dedicated project when ready for Phase 4. Use its direct database URL
or session pooler for migrations; retain TLS verification. Apply both committed
Prisma migrations. Configure provider_app and separate cloud API roles with
non-owner permissions. Keep the project's Data API disabled for these tables
unless explicitly designed policies/grants are added with tests.

Do not give the local hub direct cloud owner/service_role credentials. The sync
phase will use authenticated tenant-scoped server transport and schema negotiation.
CLOUD_DATABASE_URL in the development setup is a migration-only credential.
