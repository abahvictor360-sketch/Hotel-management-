#!/bin/sh
set -eu
# Runs once at start then daily; the Windows task runs nightly at 02:00 local time.
# BACKUP_DATABASE_URL must point to this hub's single-tenant database.
while true; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dest="/backups/${HOTEL_ID}"
  mkdir -p "$dest"
  umask 077
  if pg_dump "$BACKUP_DATABASE_URL" --format=custom --file="$dest/$stamp.dump.partial"; then
    mv "$dest/$stamp.dump.partial" "$dest/$stamp.dump"
    find "$dest" -name '*.dump' -mtime +13 -type f -delete
  else
    rm -f "$dest/$stamp.dump.partial"
    echo 'Database backup failed' >&2
  fi
  sleep 86400
done
