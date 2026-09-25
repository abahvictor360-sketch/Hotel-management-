-- Shared hub/cloud schema. Fails on inconsistent old data rather than silently dropping it.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER TABLE reservations ADD COLUMN price_snapshot jsonb;
ALTER TABLE reservations ADD COLUMN checked_in_at timestamptz;
ALTER TABLE reservations ADD COLUMN checked_out_at timestamptz;
ALTER TABLE reservations ADD CONSTRAINT active_stay_requires_room CHECK(status NOT IN ('confirmed','checked_in') OR room_id IS NOT NULL);
ALTER TABLE reservations ADD CONSTRAINT no_overlapping_stays EXCLUDE USING gist
 (tenant_id WITH =, room_id WITH =, daterange(check_in_date,check_out_date,'[)') WITH &&)
 WHERE (deleted_at IS NULL AND status IN ('pending','confirmed','checked_in') AND room_id IS NOT NULL);
CREATE UNIQUE INDEX one_current_occupant ON reservations(tenant_id,room_id) WHERE status='checked_in' AND deleted_at IS NULL;
CREATE UNIQUE INDEX folios_tenant_id_reservation_id_key ON folios(tenant_id,reservation_id);
CREATE UNIQUE INDEX room_charge_once ON folio_charges(tenant_id,folio_id,source_type,source_id)
 WHERE source_type IN ('room','room_vat','room_service_charge');
CREATE INDEX guests_name_search ON guests USING gin (full_name gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX guests_phone_search ON guests USING gin (phone gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX guests_email_search ON guests USING gin (email gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX reservations_tenant_dates ON reservations(tenant_id,check_in_date,check_out_date) WHERE deleted_at IS NULL;
CREATE TABLE hub_commands (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 device_id text NOT NULL DEFAULT 'hub', created_by uuid,
 request_id uuid NOT NULL, request_hash text NOT NULL, response jsonb NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX hub_commands_tenant ON hub_commands(tenant_id);
CREATE INDEX hub_commands_creator ON hub_commands(tenant_id,created_by);
ALTER TABLE hub_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON hub_commands TO hotel_app USING(tenant_id=context_tenant()) WITH CHECK(tenant_id=context_tenant());
REVOKE ALL ON hub_commands FROM PUBLIC;
GRANT SELECT,INSERT ON hub_commands TO hotel_app;
CREATE TRIGGER immutable BEFORE UPDATE ON hub_commands FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER no_delete BEFORE DELETE ON hub_commands FOR EACH ROW EXECUTE FUNCTION deny_delete();
CREATE TRIGGER writable BEFORE INSERT ON hub_commands FOR EACH ROW EXECUTE FUNCTION require_writable();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON hub_commands FOR EACH ROW EXECUTE FUNCTION touch_row();
-- Authenticated command receipts are local bookkeeping, not cloud-replicated business events.
-- Lock the folio for every ledger append, so closing cannot race a future payment/charge.
CREATE FUNCTION open_folio_for_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state "FolioStatus";
BEGIN
 IF NEW.folio_id IS NOT NULL THEN
   SELECT status INTO state FROM folios WHERE tenant_id=NEW.tenant_id AND id=NEW.folio_id AND deleted_at IS NULL FOR UPDATE;
   IF state IS DISTINCT FROM 'open'::"FolioStatus" THEN RAISE EXCEPTION 'Folio is not open' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ledger_open BEFORE INSERT ON folio_charges FOR EACH ROW EXECUTE FUNCTION open_folio_for_posting();
CREATE TRIGGER ledger_open BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION open_folio_for_posting();
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON hub_commands FROM %I',r);
   EXECUTE format('REVOKE ALL ON FUNCTION open_folio_for_posting() FROM %I',r);
  END IF;
 END LOOP;
END $$;
ALTER TABLE rooms ADD CONSTRAINT room_type_identity UNIQUE(tenant_id,id,room_type_id);
ALTER TABLE reservations ADD CONSTRAINT allocated_room_matches_type FOREIGN KEY(tenant_id,room_id,room_type_id) REFERENCES rooms(tenant_id,id,room_type_id);
ALTER TABLE reservations ADD CONSTRAINT reservation_guest_identity UNIQUE(tenant_id,id,guest_id);
ALTER TABLE folios ADD CONSTRAINT folio_matches_reservation_guest FOREIGN KEY(tenant_id,reservation_id,guest_id) REFERENCES reservations(tenant_id,id,guest_id);
CREATE FUNCTION check_folio_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE outstanding numeric;
BEGIN
 IF OLD.status='closed' AND NEW.status<>'closed' THEN RAISE EXCEPTION 'Closed folios cannot be reopened' USING ERRCODE='23514'; END IF;
 IF OLD.status='open' AND NEW.status='closed' THEN
  SELECT coalesce((SELECT sum(amount) FROM folio_charges WHERE tenant_id=NEW.tenant_id AND folio_id=NEW.id),0)-coalesce((SELECT sum(amount) FROM payments WHERE tenant_id=NEW.tenant_id AND folio_id=NEW.id),0) INTO outstanding;
  IF outstanding<>0 THEN RAISE EXCEPTION 'Cannot close a folio with a nonzero balance' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER folio_close BEFORE UPDATE ON folios FOR EACH ROW EXECUTE FUNCTION check_folio_closure();
REVOKE ALL ON FUNCTION check_folio_closure() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_folio_closure() TO hotel_app;
