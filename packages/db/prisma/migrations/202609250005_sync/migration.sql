-- Phase 4 sync engine. Shared by hub and cloud, like every earlier migration.
-- sync_agent is the only identity allowed to apply replicated rows. Its writes keep the
-- origin updated_at (last-write-wins needs the real edit time) and never re-enter the
-- outbox, so a replicated row cannot echo back to where it came from.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='sync_agent') THEN CREATE ROLE sync_agent NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO sync_agent;

-- Commit-safe ordering. Rows written in one transaction share created_at, and random UUIDs
-- cannot order them, so a child could replay before its parent. An identity value is taken
-- when the outbox row is inserted, which is always after every row it can depend on.
ALTER TABLE sync_queue NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_queue ADD COLUMN seq bigint;
UPDATE sync_queue q SET seq=o.n FROM (SELECT id,row_number() OVER (ORDER BY created_at,id) AS n FROM sync_queue) o WHERE q.id=o.id;
ALTER TABLE sync_queue ALTER COLUMN seq SET NOT NULL;
ALTER TABLE sync_queue ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY;
SELECT setval(pg_get_serial_sequence('sync_queue','seq'),coalesce((SELECT max(seq) FROM sync_queue),0)+1,false);
CREATE UNIQUE INDEX sync_queue_tenant_seq ON sync_queue(tenant_id,seq);
CREATE INDEX sync_queue_tenant_status_seq ON sync_queue(tenant_id,status,seq);
CREATE INDEX sync_queue_tenant_record ON sync_queue(tenant_id,table_name,record_id) WHERE status IN ('pending','failed');

-- Explicit replication contract. Mirrors packages/core/src/sync-contract.ts (a test checks both).
-- Control-plane, credential and device-local tables stay where they are written.
CREATE FUNCTION public.sync_replicated(t text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT t = ANY(ARRAY['roles','users','devices','guests','room_types','rooms','rate_plans','reservations',
 'folios','service_categories','service_items','service_orders','service_order_items','folio_charges',
 'payments','receipts','receipt_reprints','receipt_counters','shifts','housekeeping_tasks','inventory_items',
 'inventory_movements','online_bookings','payment_transactions','settings','notifications'])
$$;

-- Outbox rows that can never replicate are closed with a reason instead of staying pending forever.
UPDATE sync_queue SET status='sent',sent_at=now(),last_error='Local-only record, not replicated'
 WHERE status<>'sent' AND NOT public.sync_replicated(table_name);
ALTER TABLE sync_queue FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN RAISE EXCEPTION 'Row identity and provenance are immutable'; END IF;
 IF current_user='sync_agent' THEN RETURN NEW; END IF;
 NEW.updated_at=greatest(clock_timestamp(),OLD.updated_at+interval '1 microsecond'); RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.track_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_id uuid; audit_id uuid; actor uuid; doc jsonb; previous jsonb;
BEGIN
 -- Replicated rows were audited where they were written. The sync engine audits pulls and conflicts itself.
 IF current_user='sync_agent' THEN RETURN NEW; END IF;
 event_id=nullif(current_setting('app.event_id',true),'')::uuid;
 audit_id=nullif(current_setting('app.audit_id',true),'')::uuid;
 actor=nullif(current_setting('app.user_id',true),'')::uuid;
 IF event_id IS NULL OR audit_id IS NULL THEN RAISE EXCEPTION 'Use an application mutation context'; END IF;
 doc=to_jsonb(NEW); previous=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
 IF TG_TABLE_NAME='users' THEN doc=doc-'password_hash'; previous=previous-'password_hash'; END IF;
 IF TG_TABLE_NAME='gateway_credentials' THEN doc=doc-'encrypted_payload'; previous=previous-'encrypted_payload'; END IF;
 IF TG_TABLE_NAME='licenses' THEN doc=doc-'key_hash'; previous=previous-'key_hash'; END IF;
 IF public.sync_replicated(TG_TABLE_NAME) THEN
  INSERT INTO public.sync_queue(id,tenant_id,device_id,created_by,table_name,record_id,operation,payload,source_updated_at)
  VALUES(event_id,NEW.tenant_id,NEW.device_id,actor,TG_TABLE_NAME,NEW.id,lower(TG_OP)::"SyncOperation",doc,NEW.updated_at);
 END IF;
 INSERT INTO public.audit_log(id,tenant_id,device_id,created_by,user_id,action,entity,entity_id,before,after,occurred_at)
 VALUES(audit_id,NEW.tenant_id,current_setting('app.device_id',true),actor,actor,
 CASE WHEN TG_OP='UPDATE' AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN 'soft_delete' ELSE lower(TG_OP) END,
 TG_TABLE_NAME,NEW.id,previous,doc,clock_timestamp());
 PERFORM set_config('app.event_id','',true); PERFORM set_config('app.audit_id','',true);
 RETURN NEW;
END $$;

-- sync_agent: tenant-scoped by the same transaction-local context as every other runtime role.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['roles','users','devices','guests','room_types','rooms','rate_plans','reservations',
 'folios','service_categories','service_items','service_orders','service_order_items','folio_charges',
 'payments','receipts','receipt_reprints','receipt_counters','shifts','housekeeping_tasks','inventory_items',
 'inventory_movements','online_bookings','payment_transactions','settings','notifications',
 'sync_queue','sync_metadata','audit_log','hub_heartbeats','tenants','licenses'] LOOP
  EXECUTE format('CREATE POLICY sync_scope ON %I FOR ALL TO sync_agent USING (tenant_id=public.context_tenant()) WITH CHECK (tenant_id=public.context_tenant())',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['roles','users','devices','guests','room_types','rooms','rate_plans','reservations',
 'folios','service_categories','service_items','service_orders','service_order_items','folio_charges',
 'payments','receipts','receipt_reprints','receipt_counters','shifts','housekeeping_tasks','inventory_items',
 'inventory_movements','online_bookings','payment_transactions','settings','notifications','hub_heartbeats'] LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO sync_agent',t);
 END LOOP;
END $$;
GRANT SELECT,UPDATE ON sync_queue TO sync_agent;
GRANT SELECT,INSERT,UPDATE ON sync_metadata TO sync_agent;
GRANT INSERT ON audit_log TO sync_agent;
GRANT SELECT ON tenants TO sync_agent;
-- Hub key check only. The key hash column is readable, never the provider's other tables.
GRANT SELECT(id,tenant_id,key_hash,installation_id,revoked_at,deleted_at) ON licenses TO sync_agent;

DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON FUNCTION public.sync_replicated(text) FROM %I',r);
   EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I',r);
  END IF;
 END LOOP;
END $$;
