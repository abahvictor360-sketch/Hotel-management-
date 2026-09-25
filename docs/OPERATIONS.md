# Staff operations guide: Phase 2

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
choose Retry connection. A missing response may still mean the action committed. Keep the same screen open
and retry the same action to retrieve its saved result. After reloading, check the
reservation list before starting a new action.

A read-only licence message allows viewing but blocks changes. Contact the product
provider, connect the hub to internet, and validate its licence key on Overview.
Never change the Windows clock to work around licence expiry.

## Check-in, check-out, charges and receipts

1. Open Front desk → New stay. Choose dates, room type and rate plan. Select an existing
   guest or enter a new guest. Check availability, choose a room and confirm.
2. For an arriving walk-in, choose “Walk-in and check in now”. For a reservation,
   open its details from Calendar or Reservations and choose Check in. A clean room
   is required. The agreed room total, VAT and service charge post to the folio.
3. Open reservation details to read its folio. Use Refresh folio for the latest
   balance. Use Extend stay for extra nights before checking out an overdue guest.
4. Check-out requires an exact zero balance. Confirm check-out, then the room becomes
   dirty. Once cleaning is inspected, open Rooms and change it to available with a reason.
5. For an unarrived stay, use Change dates or room, Cancel, or mark No-show after its
   arrival date. Cancellation requires a zero balance.

Payment collection, service charges, discounts and receipt printing ship in Phase 3.
This review release can complete complimentary stays, but it cannot collect money.
Do not run live hotel stays using this incomplete review build.

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
