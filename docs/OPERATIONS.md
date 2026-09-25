# Staff operations guide: Phase 1

## Sign in

Connect to the hotel Wi-Fi/LAN. Open the hub address supplied by the administrator.
Enter your staff email and password. On first login, create a password of at least
12 characters and sign in again. In production, use the device ID registered for
that workstation. Never reuse an administrator login for the reception team.

## Administrator setup

Open Staff to create accounts and assign their roles. Give each person their own
temporary password. Open Devices to register each hotel workstation, then copy
its device ID to that workstation's login screen. Open Settings to set the hotel
name, address and local logo path.

## Licence and connection messages

Internet loss alone does not prevent access to the hub. An unreachable hub means
the workstation cannot reach the hotel computer. Reconnect to the hotel Wi-Fi and
choose Retry connection. Do not assume a failed action was saved.

A read-only licence message allows viewing but blocks changes. Contact the product
provider, connect the hub to internet, and validate its licence key on Overview.
Never change the Windows clock to work around licence expiry.

## Check-in, check-out, charges and receipts

These workflows are not available in Phase 1. Do not run live stays or take hotel
payments using this review build. Their staff instructions will ship with Phases
2 and 3, alongside the working transaction and printer code.

## Administrator backup and recovery

Run `npm run backup` from the hub service folder with PostgreSQL 16's pg_dump on
PATH. Check that a new completed `.dump` appears under the hotel's backup folder.
Schedule it nightly at 02:00 local time in Windows Task Scheduler. Keep 14 days.
A backup is only proven after a restore test.

Recovery procedure:

1. Stop HotelHub Windows service / Ubuntu hub container.
2. Preserve the current database and last known working program version.
3. Restore a selected dump into a NEW PostgreSQL 16 database with pg_restore.
4. Recreate non-owner runtime roles/passwords and point the hub to the new database.
5. Restore the matching encryption key, public licence key and installation UUID.
6. Run migrations as the database owner. Start the application using hotel_app.
7. Verify hotel identity, staff login and expected record counts. Then reconnect staff.

Never restore a hotel's full dump into the shared cloud database. A cloud restore
or tenant export needs a tenant-scoped tool and is scheduled with the cloud phase.
