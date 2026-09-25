-- Phase 5 reports. Shared by hub and cloud, like every earlier migration.
-- report_reader is the identity behind the remote management dashboard and the cloud
-- departure export. It can only SELECT, only inside one hotel's tenant context, and never
-- sees password hashes, gateway credentials, licence hashes or sync bookkeeping.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='report_reader') THEN CREATE ROLE report_reader NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO report_reader;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['roles','users','devices','guests','room_types','rooms','rate_plans','reservations',
 'folios','service_categories','service_items','service_orders','service_order_items','folio_charges',
 'payments','receipts','receipt_reprints','receipt_counters','shifts','housekeeping_tasks','inventory_items',
 'inventory_movements','online_bookings','payment_transactions','settings','notifications',
 'tenants','subscriptions','hub_heartbeats'] LOOP
  EXECUTE format('CREATE POLICY report_scope ON %I FOR SELECT TO report_reader USING (tenant_id=public.context_tenant())',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['roles','devices','guests','room_types','rooms','rate_plans','reservations',
 'folios','service_categories','service_items','service_orders','service_order_items','folio_charges',
 'payments','receipts','receipt_reprints','receipt_counters','shifts','housekeeping_tasks','inventory_items',
 'inventory_movements','online_bookings','payment_transactions','settings','notifications','hub_heartbeats'] LOOP
  EXECUTE format('GRANT SELECT ON %I TO report_reader',t);
 END LOOP;
END $$;
-- Column grants: staff without password hashes, the hotel's own profile, and only the
-- subscription fields needed to decide whether the dashboard is part of the plan.
GRANT SELECT(id,tenant_id,created_at,updated_at,deleted_at,device_id,created_by,name,email,phone,role_id,is_active,force_password_change) ON users TO report_reader;
GRANT SELECT(id,tenant_id,created_at,updated_at,deleted_at,name,slug,branding,timezone,currency,currency_symbol,schema_version) ON tenants TO report_reader;
GRANT SELECT(id,tenant_id,created_at,plan,status,trial_ends_at,period_ends_at,features,deleted_at) ON subscriptions TO report_reader;

-- Reporting indexes. Every report filters one hotel by a time range.
CREATE INDEX IF NOT EXISTS folio_charges_tenant_charged ON folio_charges(tenant_id,charged_at);
CREATE INDEX IF NOT EXISTS payments_tenant_paid ON payments(tenant_id,paid_at);
CREATE INDEX IF NOT EXISTS service_orders_tenant_created ON service_orders(tenant_id,created_at);
CREATE INDEX IF NOT EXISTS shifts_tenant_opened ON shifts(tenant_id,opened_at);
CREATE INDEX IF NOT EXISTS inventory_movements_tenant_created ON inventory_movements(tenant_id,created_at);

-- Fix: the Phase 3 reversal check read the original row FOR UPDATE. Row locks need UPDATE
-- privilege, which hotel_app deliberately lacks on append-only ledgers, so every refund and
-- charge reversal failed with "permission denied" on PostgreSQL. The lock is not needed:
-- ledger rows cannot change (deny_mutation) and payment_single_reversal/charge_single_reversal
-- already allow one reversal per original.
CREATE OR REPLACE FUNCTION public.validate_financial_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original record;
BEGIN
 IF NEW.reversal_of_id IS NULL THEN RETURN NEW; END IF;
 EXECUTE format('SELECT * FROM %I WHERE tenant_id=$1 AND id=$2',TG_TABLE_NAME) INTO original USING NEW.tenant_id,NEW.reversal_of_id;
 IF original.id IS NULL OR original.reversal_of_id IS NOT NULL OR NEW.amount<>-original.amount OR NEW.folio_id IS DISTINCT FROM original.folio_id THEN RAISE EXCEPTION 'Reversal must negate its original in the same ledger' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='payments' THEN
  IF NEW.order_id IS DISTINCT FROM original.order_id OR NEW.method<>original.method THEN RAISE EXCEPTION 'Payment reversal must preserve target and method' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;

DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I',r);
  END IF;
 END LOOP;
END $$;
