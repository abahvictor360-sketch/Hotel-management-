-- Phase 6 online booking. Shared by hub and cloud, like every earlier migration.
-- Record ownership keeps replication free of conflicts:
--   online_bookings      created by the cloud website; every later change is the hub's
--   payment_transactions created and verified by the cloud; read-only on the hub
--   notifications        created by either side; delivery status is set by the cloud
ALTER TYPE "OnlineStatus" ADD VALUE IF NOT EXISTS 'cancelled';
ALTER TABLE payment_transactions ADD COLUMN online_booking_id uuid;
ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_booking_fk
 FOREIGN KEY (tenant_id,online_booking_id) REFERENCES online_bookings(tenant_id,id) ON DELETE RESTRICT;
CREATE INDEX payment_transactions_booking ON payment_transactions(tenant_id,online_booking_id);
CREATE INDEX online_bookings_open ON online_bookings(tenant_id,status) WHERE deleted_at IS NULL;
CREATE INDEX notifications_pending ON notifications(tenant_id,status,created_at);
CREATE UNIQUE INDEX reservations_one_per_online_booking ON reservations(tenant_id,cloud_booking_id)
 WHERE cloud_booking_id IS NOT NULL AND deleted_at IS NULL AND status NOT IN ('cancelled','no_show');

-- booking_agent: the public booking website in the cloud. It finds a hotel by its public
-- slug, reads what a guest may book, and writes only bookings, payments and messages.
-- Its writes go through the normal outbox trigger, so they reach the hub by pull.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='booking_agent') THEN CREATE ROLE booking_agent NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO booking_agent;
-- Hotel lookup by slug before a tenant context exists. Public profile columns only.
CREATE POLICY booking_directory ON tenants FOR SELECT TO booking_agent USING (true);
GRANT SELECT(id,slug,name,currency,currency_symbol,timezone,deleted_at) ON tenants TO booking_agent;
GRANT SELECT(tenant_id,status,features,deleted_at,created_at) ON subscriptions TO booking_agent;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['subscriptions','settings','room_types','rate_plans','service_categories','online_bookings','payment_transactions','notifications'] LOOP
  EXECUTE format('CREATE POLICY booking_scope ON %I FOR ALL TO booking_agent USING (tenant_id=public.context_tenant()) WITH CHECK (tenant_id=public.context_tenant())',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['settings','room_types','rate_plans','service_categories'] LOOP
  EXECUTE format('GRANT SELECT ON %I TO booking_agent',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON online_bookings TO booking_agent;
GRANT SELECT,INSERT,UPDATE ON payment_transactions,notifications TO booking_agent;
-- The outbox and audit trigger runs as the writer.
CREATE POLICY booking_outbox ON sync_queue FOR INSERT TO booking_agent WITH CHECK (tenant_id=public.context_tenant());
CREATE POLICY booking_audit ON audit_log FOR INSERT TO booking_agent WITH CHECK (tenant_id=public.context_tenant());
GRANT INSERT ON sync_queue,audit_log TO booking_agent;

DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I',r);
  END IF;
 END LOOP;
END $$;
