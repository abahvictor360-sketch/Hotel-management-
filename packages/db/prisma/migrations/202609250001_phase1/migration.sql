-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('available', 'occupied', 'reserved', 'dirty', 'maintenance');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show');

-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('walk_in', 'phone', 'online');

-- CreateEnum
CREATE TYPE "FolioStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'served', 'cancelled');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'pos', 'transfer', 'online');

-- CreateEnum
CREATE TYPE "Gateway" AS ENUM ('paystack', 'flutterwave');

-- CreateEnum
CREATE TYPE "SyncOperation" AS ENUM ('insert', 'update');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('pending', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('pending', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "OnlineStatus" AS ENUM ('pending', 'confirmed', 'rejected');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trial', 'active', 'past_due', 'suspended', 'cancelled');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('standard', 'premium');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "branding" JSONB NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Lagos',
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "currency_symbol" TEXT NOT NULL DEFAULT '₦',
    "schema_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "name" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password_hash" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "force_password_change" BOOLEAN NOT NULL DEFAULT true,
    "token_version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "label" TEXT NOT NULL,
    "local_ip" TEXT,
    "assigned_department" TEXT,
    "last_seen_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "id_type" TEXT,
    "id_number" TEXT,
    "address" TEXT,
    "nationality" TEXT,
    "notes" TEXT,

    CONSTRAINT "guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_types" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "name" TEXT NOT NULL,
    "base_rate" DECIMAL(12,2) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "description" TEXT,
    "amenities" JSONB NOT NULL,
    "online_allotment" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "room_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "room_number" TEXT NOT NULL,
    "room_type_id" UUID NOT NULL,
    "floor" INTEGER NOT NULL DEFAULT 0,
    "status" "RoomStatus" NOT NULL DEFAULT 'available',

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "room_type_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(12,2) NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE NOT NULL,

    CONSTRAINT "rate_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "guest_id" UUID NOT NULL,
    "room_id" UUID,
    "room_type_id" UUID NOT NULL,
    "check_in_date" DATE NOT NULL,
    "check_out_date" DATE NOT NULL,
    "adults" INTEGER NOT NULL DEFAULT 1,
    "children" INTEGER NOT NULL DEFAULT 0,
    "rate" DECIMAL(12,2) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'pending',
    "source" "BookingSource" NOT NULL DEFAULT 'walk_in',
    "notes" TEXT,
    "cloud_booking_id" UUID,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folios" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "reservation_id" UUID,
    "guest_id" UUID NOT NULL,
    "status" "FolioStatus" NOT NULL DEFAULT 'open',
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "folios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "name" TEXT NOT NULL,
    "vat_enabled" BOOLEAN NOT NULL DEFAULT true,
    "service_charge_enabled" BOOLEAN NOT NULL DEFAULT true,
    "vat_rate" DECIMAL(12,3) NOT NULL DEFAULT 7.500,
    "service_charge_rate" DECIMAL(12,3) NOT NULL DEFAULT 10.000,

    CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "unit" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "track_inventory" BOOLEAN NOT NULL DEFAULT false,
    "inventory_item_id" UUID,
    "inventory_qty_per_unit" DECIMAL(12,3) NOT NULL DEFAULT 1.000,

    CONSTRAINT "service_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "folio_id" UUID,
    "category_id" UUID NOT NULL,
    "room_id" UUID,
    "ordered_by" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending',
    "total" DECIMAL(12,2) NOT NULL,
    "idempotency_key" TEXT NOT NULL,

    CONSTRAINT "service_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "order_id" UUID NOT NULL,
    "service_item_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "service_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folio_charges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "folio_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "charged_at" TIMESTAMPTZ(6) NOT NULL,
    "reversal_of_id" UUID,

    CONSTRAINT "folio_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "folio_id" UUID,
    "order_id" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "received_by" UUID NOT NULL,
    "paid_at" TIMESTAMPTZ(6) NOT NULL,
    "gateway_reference" TEXT,
    "reversal_of_id" UUID,
    "idempotency_key" TEXT NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "receipt_number" TEXT NOT NULL,
    "folio_id" UUID,
    "order_id" UUID,
    "payload" JSONB NOT NULL,
    "printed_at" TIMESTAMPTZ(6),
    "reversal_of_id" UUID,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_reprints" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "receipt_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "printed_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "receipt_reprints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_counters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "counter_device" TEXT NOT NULL,
    "next_number" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "receipt_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "user_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),
    "opening_float" DECIMAL(12,2) NOT NULL,
    "closing_cash" DECIMAL(12,2),
    "variance" DECIMAL(12,2),

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "housekeeping_tasks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "room_id" UUID NOT NULL,
    "assigned_to" UUID,
    "type" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "housekeeping_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity_on_hand" DECIMAL(12,3) NOT NULL DEFAULT 0.000,
    "reorder_level" DECIMAL(12,3) NOT NULL DEFAULT 0.000,
    "category" TEXT NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "item_id" UUID NOT NULL,
    "change_qty" DECIMAL(12,3) NOT NULL,
    "reason" TEXT NOT NULL,
    "reference_id" UUID,
    "moved_by" UUID NOT NULL,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "online_bookings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "payload" JSONB NOT NULL,
    "matched_reservation_id" UUID,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "status" "OnlineStatus" NOT NULL DEFAULT 'pending',
    "external_reference" TEXT NOT NULL,
    "notification_status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "online_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "gateway" "Gateway" NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL,
    "raw_response" JSONB NOT NULL,
    "verified_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_queue" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "table_name" TEXT NOT NULL,
    "record_id" UUID NOT NULL,
    "operation" "SyncOperation" NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "status" "SyncStatus" NOT NULL DEFAULT 'pending',
    "sent_at" TIMESTAMPTZ(6),
    "next_attempt_at" TIMESTAMPTZ(6),
    "source_updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sync_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_metadata" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "table_name" TEXT NOT NULL,
    "record_id" UUID NOT NULL,
    "synced" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMPTZ(6),
    "source_updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sync_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "replaced_by_id" UUID,

    CONSTRAINT "refresh_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "gateway" "Gateway" NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "encrypted_payload" TEXT NOT NULL,

    CONSTRAINT "gateway_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "license_cache" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "installation_id" UUID NOT NULL,
    "signed_token" TEXT NOT NULL,
    "last_checked_at" TIMESTAMPTZ(6) NOT NULL,
    "max_observed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "license_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "plan" "PlanTier" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'trial',
    "trial_ends_at" TIMESTAMPTZ(6),
    "period_ends_at" TIMESTAMPTZ(6),
    "features" JSONB NOT NULL,
    "max_devices" INTEGER NOT NULL DEFAULT 8,
    "max_rooms" INTEGER NOT NULL DEFAULT 50,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licenses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "key_hash" TEXT NOT NULL,
    "installation_id" UUID,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_billing" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "description" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "paid_at" TIMESTAMPTZ(6),

    CONSTRAINT "subscription_billing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub_heartbeats" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "installation_id" UUID NOT NULL,
    "hub_version" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "last_sync_at" TIMESTAMPTZ(6),
    "device_count" INTEGER NOT NULL DEFAULT 0,
    "room_count" INTEGER NOT NULL DEFAULT 0,
    "pending_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL,
    "seen_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "hub_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "online_booking_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_submissions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "idempotency_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "submitted_by" UUID NOT NULL,
    "applied_entity_id" UUID,

    CONSTRAINT "draft_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_audit" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "device_id" TEXT NOT NULL DEFAULT 'hub',
    "created_by" UUID,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "provider_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenants_tenant_id_idx" ON "tenants"("tenant_id");

-- CreateIndex
CREATE INDEX "tenants_tenant_id_created_by_idx" ON "tenants"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_tenant_id_slug_key" ON "tenants"("tenant_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_tenant_id_id_key" ON "tenants"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "roles_tenant_id_idx" ON "roles"("tenant_id");

-- CreateIndex
CREATE INDEX "roles_tenant_id_created_by_idx" ON "roles"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_name_key" ON "roles"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_id_key" ON "roles"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- CreateIndex
CREATE INDEX "users_tenant_id_created_by_idx" ON "users"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "users_tenant_id_role_id_idx" ON "users"("tenant_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_id_key" ON "users"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "devices_tenant_id_idx" ON "devices"("tenant_id");

-- CreateIndex
CREATE INDEX "devices_tenant_id_created_by_idx" ON "devices"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "devices_tenant_id_id_key" ON "devices"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "guests_tenant_id_idx" ON "guests"("tenant_id");

-- CreateIndex
CREATE INDEX "guests_tenant_id_created_by_idx" ON "guests"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "guests_tenant_id_id_key" ON "guests"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "room_types_tenant_id_idx" ON "room_types"("tenant_id");

-- CreateIndex
CREATE INDEX "room_types_tenant_id_created_by_idx" ON "room_types"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "room_types_tenant_id_name_key" ON "room_types"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "room_types_tenant_id_id_key" ON "room_types"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "rooms_tenant_id_idx" ON "rooms"("tenant_id");

-- CreateIndex
CREATE INDEX "rooms_tenant_id_created_by_idx" ON "rooms"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "rooms_tenant_id_room_type_id_idx" ON "rooms"("tenant_id", "room_type_id");

-- CreateIndex
CREATE INDEX "rooms_tenant_id_status_idx" ON "rooms"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_tenant_id_room_number_key" ON "rooms"("tenant_id", "room_number");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_tenant_id_id_key" ON "rooms"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "rate_plans_tenant_id_idx" ON "rate_plans"("tenant_id");

-- CreateIndex
CREATE INDEX "rate_plans_tenant_id_created_by_idx" ON "rate_plans"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "rate_plans_tenant_id_room_type_id_idx" ON "rate_plans"("tenant_id", "room_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "rate_plans_tenant_id_id_key" ON "rate_plans"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "reservations_tenant_id_idx" ON "reservations"("tenant_id");

-- CreateIndex
CREATE INDEX "reservations_tenant_id_created_by_idx" ON "reservations"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "reservations_tenant_id_guest_id_idx" ON "reservations"("tenant_id", "guest_id");

-- CreateIndex
CREATE INDEX "reservations_tenant_id_room_id_idx" ON "reservations"("tenant_id", "room_id");

-- CreateIndex
CREATE INDEX "reservations_tenant_id_room_type_id_idx" ON "reservations"("tenant_id", "room_type_id");

-- CreateIndex
CREATE INDEX "reservations_tenant_id_cloud_booking_id_idx" ON "reservations"("tenant_id", "cloud_booking_id");

-- CreateIndex
CREATE INDEX "reservations_tenant_id_check_in_date_status_idx" ON "reservations"("tenant_id", "check_in_date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_tenant_id_id_key" ON "reservations"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "folios_tenant_id_idx" ON "folios"("tenant_id");

-- CreateIndex
CREATE INDEX "folios_tenant_id_created_by_idx" ON "folios"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "folios_tenant_id_reservation_id_idx" ON "folios"("tenant_id", "reservation_id");

-- CreateIndex
CREATE INDEX "folios_tenant_id_guest_id_idx" ON "folios"("tenant_id", "guest_id");

-- CreateIndex
CREATE INDEX "folios_tenant_id_status_idx" ON "folios"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "folios_tenant_id_id_key" ON "folios"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "service_categories_tenant_id_idx" ON "service_categories"("tenant_id");

-- CreateIndex
CREATE INDEX "service_categories_tenant_id_created_by_idx" ON "service_categories"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "service_categories_tenant_id_name_key" ON "service_categories"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "service_categories_tenant_id_id_key" ON "service_categories"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "service_items_tenant_id_idx" ON "service_items"("tenant_id");

-- CreateIndex
CREATE INDEX "service_items_tenant_id_created_by_idx" ON "service_items"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "service_items_tenant_id_category_id_idx" ON "service_items"("tenant_id", "category_id");

-- CreateIndex
CREATE INDEX "service_items_tenant_id_inventory_item_id_idx" ON "service_items"("tenant_id", "inventory_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_items_tenant_id_id_key" ON "service_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "service_orders_tenant_id_idx" ON "service_orders"("tenant_id");

-- CreateIndex
CREATE INDEX "service_orders_tenant_id_created_by_idx" ON "service_orders"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "service_orders_tenant_id_folio_id_idx" ON "service_orders"("tenant_id", "folio_id");

-- CreateIndex
CREATE INDEX "service_orders_tenant_id_category_id_idx" ON "service_orders"("tenant_id", "category_id");

-- CreateIndex
CREATE INDEX "service_orders_tenant_id_room_id_idx" ON "service_orders"("tenant_id", "room_id");

-- CreateIndex
CREATE INDEX "service_orders_tenant_id_ordered_by_idx" ON "service_orders"("tenant_id", "ordered_by");

-- CreateIndex
CREATE UNIQUE INDEX "service_orders_tenant_id_idempotency_key_key" ON "service_orders"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "service_orders_tenant_id_id_key" ON "service_orders"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "service_order_items_tenant_id_idx" ON "service_order_items"("tenant_id");

-- CreateIndex
CREATE INDEX "service_order_items_tenant_id_created_by_idx" ON "service_order_items"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "service_order_items_tenant_id_order_id_idx" ON "service_order_items"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "service_order_items_tenant_id_service_item_id_idx" ON "service_order_items"("tenant_id", "service_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_items_tenant_id_id_key" ON "service_order_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "folio_charges_tenant_id_idx" ON "folio_charges"("tenant_id");

-- CreateIndex
CREATE INDEX "folio_charges_tenant_id_created_by_idx" ON "folio_charges"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "folio_charges_tenant_id_folio_id_idx" ON "folio_charges"("tenant_id", "folio_id");

-- CreateIndex
CREATE INDEX "folio_charges_tenant_id_reversal_of_id_idx" ON "folio_charges"("tenant_id", "reversal_of_id");

-- CreateIndex
CREATE UNIQUE INDEX "folio_charges_tenant_id_id_key" ON "folio_charges"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_idx" ON "payments"("tenant_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_created_by_idx" ON "payments"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "payments_tenant_id_folio_id_idx" ON "payments"("tenant_id", "folio_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_order_id_idx" ON "payments"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_received_by_idx" ON "payments"("tenant_id", "received_by");

-- CreateIndex
CREATE INDEX "payments_tenant_id_reversal_of_id_idx" ON "payments"("tenant_id", "reversal_of_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_paid_at_idx" ON "payments"("tenant_id", "paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_id_idempotency_key_key" ON "payments"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_id_gateway_reference_key" ON "payments"("tenant_id", "gateway_reference");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_id_id_key" ON "payments"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "receipts_tenant_id_idx" ON "receipts"("tenant_id");

-- CreateIndex
CREATE INDEX "receipts_tenant_id_created_by_idx" ON "receipts"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "receipts_tenant_id_folio_id_idx" ON "receipts"("tenant_id", "folio_id");

-- CreateIndex
CREATE INDEX "receipts_tenant_id_order_id_idx" ON "receipts"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "receipts_tenant_id_reversal_of_id_idx" ON "receipts"("tenant_id", "reversal_of_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_tenant_id_device_id_receipt_number_key" ON "receipts"("tenant_id", "device_id", "receipt_number");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_tenant_id_id_key" ON "receipts"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "receipt_reprints_tenant_id_idx" ON "receipt_reprints"("tenant_id");

-- CreateIndex
CREATE INDEX "receipt_reprints_tenant_id_created_by_idx" ON "receipt_reprints"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "receipt_reprints_tenant_id_receipt_id_idx" ON "receipt_reprints"("tenant_id", "receipt_id");

-- CreateIndex
CREATE INDEX "receipt_reprints_tenant_id_requested_by_idx" ON "receipt_reprints"("tenant_id", "requested_by");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_reprints_tenant_id_id_key" ON "receipt_reprints"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "receipt_counters_tenant_id_idx" ON "receipt_counters"("tenant_id");

-- CreateIndex
CREATE INDEX "receipt_counters_tenant_id_created_by_idx" ON "receipt_counters"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_counters_tenant_id_counter_device_key" ON "receipt_counters"("tenant_id", "counter_device");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_counters_tenant_id_id_key" ON "receipt_counters"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "shifts_tenant_id_idx" ON "shifts"("tenant_id");

-- CreateIndex
CREATE INDEX "shifts_tenant_id_created_by_idx" ON "shifts"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "shifts_tenant_id_user_id_idx" ON "shifts"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_tenant_id_id_key" ON "shifts"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "housekeeping_tasks_tenant_id_idx" ON "housekeeping_tasks"("tenant_id");

-- CreateIndex
CREATE INDEX "housekeeping_tasks_tenant_id_created_by_idx" ON "housekeeping_tasks"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "housekeeping_tasks_tenant_id_room_id_idx" ON "housekeeping_tasks"("tenant_id", "room_id");

-- CreateIndex
CREATE INDEX "housekeeping_tasks_tenant_id_assigned_to_idx" ON "housekeeping_tasks"("tenant_id", "assigned_to");

-- CreateIndex
CREATE UNIQUE INDEX "housekeeping_tasks_tenant_id_id_key" ON "housekeeping_tasks"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "inventory_items_tenant_id_idx" ON "inventory_items"("tenant_id");

-- CreateIndex
CREATE INDEX "inventory_items_tenant_id_created_by_idx" ON "inventory_items"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_tenant_id_id_key" ON "inventory_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "inventory_movements_tenant_id_idx" ON "inventory_movements"("tenant_id");

-- CreateIndex
CREATE INDEX "inventory_movements_tenant_id_created_by_idx" ON "inventory_movements"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "inventory_movements_tenant_id_item_id_idx" ON "inventory_movements"("tenant_id", "item_id");

-- CreateIndex
CREATE INDEX "inventory_movements_tenant_id_moved_by_idx" ON "inventory_movements"("tenant_id", "moved_by");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_tenant_id_id_key" ON "inventory_movements"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "online_bookings_tenant_id_idx" ON "online_bookings"("tenant_id");

-- CreateIndex
CREATE INDEX "online_bookings_tenant_id_created_by_idx" ON "online_bookings"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "online_bookings_tenant_id_matched_reservation_id_idx" ON "online_bookings"("tenant_id", "matched_reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_bookings_tenant_id_external_reference_key" ON "online_bookings"("tenant_id", "external_reference");

-- CreateIndex
CREATE UNIQUE INDEX "online_bookings_tenant_id_id_key" ON "online_bookings"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "payment_transactions_tenant_id_idx" ON "payment_transactions"("tenant_id");

-- CreateIndex
CREATE INDEX "payment_transactions_tenant_id_created_by_idx" ON "payment_transactions"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_tenant_id_gateway_reference_key" ON "payment_transactions"("tenant_id", "gateway", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_tenant_id_id_key" ON "payment_transactions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_idx" ON "audit_log"("tenant_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_created_by_idx" ON "audit_log"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_user_id_idx" ON "audit_log"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_occurred_at_idx" ON "audit_log"("tenant_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_tenant_id_id_key" ON "audit_log"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "sync_queue_tenant_id_idx" ON "sync_queue"("tenant_id");

-- CreateIndex
CREATE INDEX "sync_queue_tenant_id_created_by_idx" ON "sync_queue"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "sync_queue_tenant_id_status_next_attempt_at_created_at_idx" ON "sync_queue"("tenant_id", "status", "next_attempt_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sync_queue_tenant_id_id_key" ON "sync_queue"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "sync_metadata_tenant_id_idx" ON "sync_metadata"("tenant_id");

-- CreateIndex
CREATE INDEX "sync_metadata_tenant_id_created_by_idx" ON "sync_metadata"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "sync_metadata_tenant_id_table_name_record_id_key" ON "sync_metadata"("tenant_id", "table_name", "record_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_metadata_tenant_id_id_key" ON "sync_metadata"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "settings_tenant_id_idx" ON "settings"("tenant_id");

-- CreateIndex
CREATE INDEX "settings_tenant_id_created_by_idx" ON "settings"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "settings_tenant_id_key_key" ON "settings"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "settings_tenant_id_id_key" ON "settings"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "refresh_sessions_tenant_id_idx" ON "refresh_sessions"("tenant_id");

-- CreateIndex
CREATE INDEX "refresh_sessions_tenant_id_created_by_idx" ON "refresh_sessions"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "refresh_sessions_tenant_id_user_id_idx" ON "refresh_sessions"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "refresh_sessions_tenant_id_replaced_by_id_idx" ON "refresh_sessions"("tenant_id", "replaced_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_sessions_tenant_id_token_hash_key" ON "refresh_sessions"("tenant_id", "token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_sessions_tenant_id_id_key" ON "refresh_sessions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "gateway_credentials_tenant_id_idx" ON "gateway_credentials"("tenant_id");

-- CreateIndex
CREATE INDEX "gateway_credentials_tenant_id_created_by_idx" ON "gateway_credentials"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_credentials_tenant_id_gateway_key" ON "gateway_credentials"("tenant_id", "gateway");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_credentials_tenant_id_id_key" ON "gateway_credentials"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "license_cache_tenant_id_idx" ON "license_cache"("tenant_id");

-- CreateIndex
CREATE INDEX "license_cache_tenant_id_created_by_idx" ON "license_cache"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "license_cache_tenant_id_installation_id_key" ON "license_cache"("tenant_id", "installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "license_cache_tenant_id_id_key" ON "license_cache"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "subscriptions_tenant_id_idx" ON "subscriptions"("tenant_id");

-- CreateIndex
CREATE INDEX "subscriptions_tenant_id_created_by_idx" ON "subscriptions"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenant_id_key" ON "subscriptions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenant_id_id_key" ON "subscriptions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "licenses_tenant_id_idx" ON "licenses"("tenant_id");

-- CreateIndex
CREATE INDEX "licenses_tenant_id_created_by_idx" ON "licenses"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "licenses_tenant_id_key_hash_key" ON "licenses"("tenant_id", "key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "licenses_tenant_id_id_key" ON "licenses"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "subscription_billing_tenant_id_idx" ON "subscription_billing"("tenant_id");

-- CreateIndex
CREATE INDEX "subscription_billing_tenant_id_created_by_idx" ON "subscription_billing"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_billing_tenant_id_reference_key" ON "subscription_billing"("tenant_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_billing_tenant_id_id_key" ON "subscription_billing"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "hub_heartbeats_tenant_id_idx" ON "hub_heartbeats"("tenant_id");

-- CreateIndex
CREATE INDEX "hub_heartbeats_tenant_id_created_by_idx" ON "hub_heartbeats"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "hub_heartbeats_tenant_id_installation_id_key" ON "hub_heartbeats"("tenant_id", "installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "hub_heartbeats_tenant_id_id_key" ON "hub_heartbeats"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_idx" ON "notifications"("tenant_id");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_created_by_idx" ON "notifications"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_online_booking_id_idx" ON "notifications"("tenant_id", "online_booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_tenant_id_id_key" ON "notifications"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "draft_submissions_tenant_id_idx" ON "draft_submissions"("tenant_id");

-- CreateIndex
CREATE INDEX "draft_submissions_tenant_id_created_by_idx" ON "draft_submissions"("tenant_id", "created_by");

-- CreateIndex
CREATE INDEX "draft_submissions_tenant_id_submitted_by_idx" ON "draft_submissions"("tenant_id", "submitted_by");

-- CreateIndex
CREATE UNIQUE INDEX "draft_submissions_tenant_id_idempotency_key_key" ON "draft_submissions"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "draft_submissions_tenant_id_id_key" ON "draft_submissions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "provider_audit_tenant_id_idx" ON "provider_audit"("tenant_id");

-- CreateIndex
CREATE INDEX "provider_audit_tenant_id_created_by_idx" ON "provider_audit"("tenant_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "provider_audit_tenant_id_id_key" ON "provider_audit"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "roles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_tenant_id_room_type_id_fkey" FOREIGN KEY ("tenant_id", "room_type_id") REFERENCES "room_types"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_tenant_id_room_type_id_fkey" FOREIGN KEY ("tenant_id", "room_type_id") REFERENCES "room_types"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_guest_id_fkey" FOREIGN KEY ("tenant_id", "guest_id") REFERENCES "guests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_room_id_fkey" FOREIGN KEY ("tenant_id", "room_id") REFERENCES "rooms"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_room_type_id_fkey" FOREIGN KEY ("tenant_id", "room_type_id") REFERENCES "room_types"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_cloud_booking_id_fkey" FOREIGN KEY ("tenant_id", "cloud_booking_id") REFERENCES "online_bookings"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_tenant_id_reservation_id_fkey" FOREIGN KEY ("tenant_id", "reservation_id") REFERENCES "reservations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_tenant_id_guest_id_fkey" FOREIGN KEY ("tenant_id", "guest_id") REFERENCES "guests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "service_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_tenant_id_inventory_item_id_fkey" FOREIGN KEY ("tenant_id", "inventory_item_id") REFERENCES "inventory_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_tenant_id_folio_id_fkey" FOREIGN KEY ("tenant_id", "folio_id") REFERENCES "folios"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "service_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_tenant_id_room_id_fkey" FOREIGN KEY ("tenant_id", "room_id") REFERENCES "rooms"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_tenant_id_ordered_by_fkey" FOREIGN KEY ("tenant_id", "ordered_by") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "service_order_items" ADD CONSTRAINT "service_order_items_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "service_orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "service_order_items" ADD CONSTRAINT "service_order_items_tenant_id_service_item_id_fkey" FOREIGN KEY ("tenant_id", "service_item_id") REFERENCES "service_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "folio_charges" ADD CONSTRAINT "folio_charges_tenant_id_folio_id_fkey" FOREIGN KEY ("tenant_id", "folio_id") REFERENCES "folios"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "folio_charges" ADD CONSTRAINT "folio_charges_tenant_id_reversal_of_id_fkey" FOREIGN KEY ("tenant_id", "reversal_of_id") REFERENCES "folio_charges"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_folio_id_fkey" FOREIGN KEY ("tenant_id", "folio_id") REFERENCES "folios"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "service_orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_received_by_fkey" FOREIGN KEY ("tenant_id", "received_by") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_reversal_of_id_fkey" FOREIGN KEY ("tenant_id", "reversal_of_id") REFERENCES "payments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_tenant_id_folio_id_fkey" FOREIGN KEY ("tenant_id", "folio_id") REFERENCES "folios"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "service_orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_tenant_id_reversal_of_id_fkey" FOREIGN KEY ("tenant_id", "reversal_of_id") REFERENCES "receipts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "receipt_reprints" ADD CONSTRAINT "receipt_reprints_tenant_id_receipt_id_fkey" FOREIGN KEY ("tenant_id", "receipt_id") REFERENCES "receipts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "receipt_reprints" ADD CONSTRAINT "receipt_reprints_tenant_id_requested_by_fkey" FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_tenant_id_room_id_fkey" FOREIGN KEY ("tenant_id", "room_id") REFERENCES "rooms"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_tenant_id_assigned_to_fkey" FOREIGN KEY ("tenant_id", "assigned_to") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "inventory_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_tenant_id_moved_by_fkey" FOREIGN KEY ("tenant_id", "moved_by") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "online_bookings" ADD CONSTRAINT "online_bookings_tenant_id_matched_reservation_id_fkey" FOREIGN KEY ("tenant_id", "matched_reservation_id") REFERENCES "reservations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_tenant_id_replaced_by_id_fkey" FOREIGN KEY ("tenant_id", "replaced_by_id") REFERENCES "refresh_sessions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_online_booking_id_fkey" FOREIGN KEY ("tenant_id", "online_booking_id") REFERENCES "online_bookings"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "draft_submissions" ADD CONSTRAINT "draft_submissions_tenant_id_submitted_by_fkey" FOREIGN KEY ("tenant_id", "submitted_by") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

