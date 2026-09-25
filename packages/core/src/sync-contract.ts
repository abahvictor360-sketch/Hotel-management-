// Hub <-> cloud replication contract. The SQL function public.sync_replicated() in
// migration 202609250005_sync must list exactly the same tables (tests/sync.test.ts checks).
export const SYNC_PROTOCOL = 1;
// Both sides must run the same migration revision. A mismatch pauses sync without
// consuming retry attempts, so nothing fails while the hub and cloud are upgraded.
export const DATABASE_REVISION = 6;
export const BATCH_SIZE = 100;
export const MAX_ATTEMPTS = 10;
export const SYNC_INTERVAL_MS = 30_000;

// Hub -> cloud. Control-plane (tenants, subscriptions, licences), credentials and
// device-local bookkeeping are deliberately absent.
export const replicatedTables = [
  "roles",
  "users",
  "devices",
  "guests",
  "room_types",
  "rooms",
  "rate_plans",
  "reservations",
  "folios",
  "service_categories",
  "service_items",
  "service_orders",
  "service_order_items",
  "folio_charges",
  "payments",
  "receipts",
  "receipt_reprints",
  "receipt_counters",
  "shifts",
  "housekeeping_tasks",
  "inventory_items",
  "inventory_movements",
  "online_bookings",
  "payment_transactions",
  "settings",
  "notifications",
] as const;
export type ReplicatedTable = (typeof replicatedTables)[number];

// Cloud -> hub. Only records the website and payment gateways create in the cloud.
export const pullTables = ["online_bookings", "payment_transactions"] as const;

// Columns the outbox never carries. Inserted with a value that cannot authenticate,
// and never overwritten by replication. Passwords stay on the hub.
export const redactedColumns: Partial<Record<ReplicatedTable, Record<string, string>>> =
  {
    users: { password_hash: "!replicated-no-login" },
  };

// Retry delay after a rejected row: 30s, 1m, 2m ... capped at 1 hour.
export function backoffMs(attempts: number) {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
}

export const isReplicated = (t: string): t is ReplicatedTable =>
  (replicatedTables as readonly string[]).includes(t);
