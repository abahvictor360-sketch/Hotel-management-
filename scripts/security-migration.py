raise SystemExit("Archived Phase 1 authoring helper. Edit schema.prisma and add a new migration instead.")
from pathlib import Path
import json
root=Path(__file__).resolve().parents[1]; meta=json.loads((root/'scripts/schema-meta.json').read_text()); tables=meta['tables']
control=['subscriptions','licenses','subscription_billing','hub_heartbeats','provider_audit']
internal=['sync_queue','sync_metadata','refresh_sessions','license_cache']
immutable=['payments','folio_charges','receipts','receipt_reprints','inventory_movements','audit_log','subscription_billing','provider_audit']
tracked=[t for t in tables if t not in internal+['audit_log','provider_audit']]
sql='''-- Applied after Prisma DDL on BOTH hub and cloud. Runtime roles never own tables.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='hotel_app') THEN CREATE ROLE hotel_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='provider_app') THEN CREATE ROLE provider_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='license_agent') THEN CREATE ROLE license_agent NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO hotel_app,provider_app,license_agent;
CREATE FUNCTION public.context_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id',true),'')::uuid $$;
CREATE FUNCTION public.touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN RAISE EXCEPTION 'Row identity and provenance are immutable'; END IF;
 NEW.updated_at=greatest(clock_timestamp(),OLD.updated_at+interval '1 microsecond'); RETURN NEW;
END $$;
CREATE FUNCTION public.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Append-only record: create a linked reversal or reprint'; END $$;
CREATE FUNCTION public.deny_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Hard deletes are disabled'; END $$;
CREATE FUNCTION public.require_writable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user='hotel_app' AND current_setting('app.can_write',true) IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Hotel is read-only'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.track_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_id uuid; audit_id uuid; actor uuid; doc jsonb; previous jsonb;
BEGIN
 event_id=nullif(current_setting('app.event_id',true),'')::uuid;
 audit_id=nullif(current_setting('app.audit_id',true),'')::uuid;
 actor=nullif(current_setting('app.user_id',true),'')::uuid;
 IF event_id IS NULL OR audit_id IS NULL THEN RAISE EXCEPTION 'Use an application mutation context'; END IF;
 doc=to_jsonb(NEW); previous=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
 IF TG_TABLE_NAME='users' THEN doc=doc-'password_hash'; previous=previous-'password_hash'; END IF;
 IF TG_TABLE_NAME='gateway_credentials' THEN doc=doc-'encrypted_payload'; previous=previous-'encrypted_payload'; END IF;
 IF TG_TABLE_NAME='licenses' THEN doc=doc-'key_hash'; previous=previous-'key_hash'; END IF;
 INSERT INTO public.sync_queue(id,tenant_id,device_id,created_by,table_name,record_id,operation,payload,source_updated_at)
 VALUES(event_id,NEW.tenant_id,NEW.device_id,actor,TG_TABLE_NAME,NEW.id,lower(TG_OP)::"SyncOperation",doc,NEW.updated_at);
 INSERT INTO public.audit_log(id,tenant_id,device_id,created_by,user_id,action,entity,entity_id,before,after,occurred_at)
 VALUES(audit_id,NEW.tenant_id,current_setting('app.device_id',true),actor,actor,
 CASE WHEN TG_OP='UPDATE' AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN 'soft_delete' ELSE lower(TG_OP) END,
 TG_TABLE_NAME,NEW.id,previous,doc,clock_timestamp());
 PERFORM set_config('app.event_id','',true); PERFORM set_config('app.audit_id','',true);
 RETURN NEW;
END $$;
'''
for t in tables:
 sql+=f'''ALTER TABLE "{t}" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "{t}" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "{t}" FOR ALL TO hotel_app,license_agent USING (tenant_id=public.context_tenant()) WITH CHECK (tenant_id=public.context_tenant());
CREATE TRIGGER no_delete BEFORE DELETE ON "{t}" FOR EACH ROW EXECUTE FUNCTION public.deny_delete();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "{t}" FOR EACH ROW EXECUTE FUNCTION public.touch_row();
'''
 if t not in control:
  sql+=f'GRANT SELECT ON "{t}" TO hotel_app;\n'
 if t not in control+['tenants','license_cache','sync_metadata']:
  sql+=f'GRANT INSERT ON "{t}" TO hotel_app;\n'
  if t not in immutable:sql+=f'GRANT UPDATE ON "{t}" TO hotel_app;\n'
 if t in control+['tenants','sync_queue','audit_log']:
  sql+=f'''GRANT INSERT ON "{t}" TO provider_app;
CREATE POLICY provider_scope ON "{t}" FOR ALL TO provider_app USING (true) WITH CHECK (true);
'''
  if t not in ['sync_queue','audit_log']:sql+=f'GRANT SELECT ON "{t}" TO provider_app;\n'
  if t not in immutable:sql+=f'GRANT UPDATE ON "{t}" TO provider_app;\n'
 if t in immutable:sql+=f'CREATE TRIGGER immutable BEFORE UPDATE ON "{t}" FOR EACH ROW EXECUTE FUNCTION public.deny_mutation();\n'
 if t in tracked:
  sql+=f'CREATE TRIGGER writable BEFORE INSERT OR UPDATE ON "{t}" FOR EACH ROW EXECUTE FUNCTION public.require_writable();\n'
  sql+=f'CREATE TRIGGER outbox AFTER INSERT OR UPDATE ON "{t}" FOR EACH ROW EXECUTE FUNCTION public.track_change();\n'
 if t not in ['tenants']:
  sql+=f'ALTER TABLE "{t}" ADD CONSTRAINT "{t}_tenant_fk" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;\n'
 # created_by remains nullable for system/seed writes; every non-null owner must belong to same hotel.
 sql+=f'ALTER TABLE "{t}" ADD CONSTRAINT "{t}_creator_fk" FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;\n'
sql+='''GRANT SELECT,INSERT,UPDATE ON license_cache TO license_agent;
ALTER TABLE tenants ADD CONSTRAINT tenant_identity CHECK (id=tenant_id);
ALTER TABLE reservations ADD CONSTRAINT stay_dates CHECK(check_out_date>check_in_date), ADD CONSTRAINT guest_counts CHECK(adults>0 AND children>=0), ADD CONSTRAINT nonnegative_rate CHECK(rate>=0);
ALTER TABLE room_types ADD CONSTRAINT capacity_positive CHECK(capacity>0 AND online_allotment>=0 AND base_rate>=0);
ALTER TABLE rate_plans ADD CONSTRAINT rate_dates CHECK(valid_to>=valid_from AND rate>=0);
ALTER TABLE service_categories ADD CONSTRAINT valid_tax CHECK(vat_rate BETWEEN 0 AND 100 AND service_charge_rate BETWEEN 0 AND 100);
ALTER TABLE service_items ADD CONSTRAINT item_price CHECK(price>=0 AND inventory_qty_per_unit>0);
ALTER TABLE service_order_items ADD CONSTRAINT item_quantity CHECK(quantity>0 AND unit_price>=0 AND subtotal>=0);
ALTER TABLE payments ADD CONSTRAINT payment_parent CHECK(num_nonnulls(folio_id,order_id)=1), ADD CONSTRAINT payment_sign CHECK((reversal_of_id IS NULL AND amount>0) OR (reversal_of_id IS NOT NULL AND amount<0));
ALTER TABLE receipts ADD CONSTRAINT receipt_parent CHECK(num_nonnulls(folio_id,order_id)=1);
ALTER TABLE folio_charges ADD CONSTRAINT nonzero_charge CHECK(amount<>0);
ALTER TABLE subscriptions ADD CONSTRAINT positive_limits CHECK(max_devices>0 AND max_rooms>0);
CREATE UNIQUE INDEX payment_single_reversal ON payments(tenant_id,reversal_of_id) WHERE reversal_of_id IS NOT NULL;
CREATE UNIQUE INDEX charge_single_reversal ON folio_charges(tenant_id,reversal_of_id) WHERE reversal_of_id IS NOT NULL;
CREATE UNIQUE INDEX receipt_single_reversal ON receipts(tenant_id,reversal_of_id) WHERE reversal_of_id IS NOT NULL;
-- No direct Supabase Data API access. Hosted apps will call authenticated cloud APIs.
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I',r);
   EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I',r);
  END IF;
 END LOOP;
END $$;
'''
p=root/'packages/db/prisma/migrations/202609250002_security';p.mkdir(exist_ok=True);(p/'migration.sql').write_text(sql)
