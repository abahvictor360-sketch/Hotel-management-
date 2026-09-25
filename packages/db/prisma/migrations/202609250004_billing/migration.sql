ALTER TABLE service_orders ADD COLUMN price_snapshot jsonb;
ALTER TABLE service_order_items ADD COLUMN item_name text NOT NULL DEFAULT '';
ALTER TABLE inventory_items ADD CONSTRAINT nonnegative_stock CHECK(quantity_on_hand>=0 AND reorder_level>=0);
CREATE UNIQUE INDEX one_open_shift ON shifts(tenant_id,user_id) WHERE closed_at IS NULL AND deleted_at IS NULL;
ALTER TABLE payments ADD COLUMN shift_id uuid;
ALTER TABLE payments ADD CONSTRAINT payment_shift_fk FOREIGN KEY(tenant_id,shift_id) REFERENCES shifts(tenant_id,id);
CREATE INDEX payments_shift ON payments(tenant_id,shift_id);
CREATE INDEX service_orders_recent ON service_orders(tenant_id,created_at DESC);
CREATE INDEX receipts_recent ON receipts(tenant_id,created_at DESC);
CREATE TRIGGER immutable BEFORE UPDATE ON service_order_items FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE FUNCTION validate_financial_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original record;
BEGIN
 IF NEW.reversal_of_id IS NULL THEN RETURN NEW; END IF;
 EXECUTE format('SELECT * FROM %I WHERE tenant_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_NAME) INTO original USING NEW.tenant_id,NEW.reversal_of_id;
 IF original.id IS NULL OR original.reversal_of_id IS NOT NULL OR NEW.amount<>-original.amount OR NEW.folio_id IS DISTINCT FROM original.folio_id THEN RAISE EXCEPTION 'Reversal must negate its original in the same ledger' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='payments' THEN
  IF NEW.order_id IS DISTINCT FROM original.order_id OR NEW.method<>original.method THEN RAISE EXCEPTION 'Payment reversal must preserve target and method' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reversal_valid BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION validate_financial_reversal();
CREATE TRIGGER reversal_valid BEFORE INSERT ON folio_charges FOR EACH ROW EXECUTE FUNCTION validate_financial_reversal();
REVOKE ALL ON FUNCTION validate_financial_reversal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION validate_financial_reversal() TO hotel_app;
CREATE TABLE print_jobs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,
 device_id text NOT NULL DEFAULT 'hub',created_by uuid,
 receipt_id uuid,kind text NOT NULL CHECK(kind IN ('original','reprint','test')),
 reason text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','uncertain')),
 error text,sent_at timestamptz,
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,receipt_id) REFERENCES receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id),
 CHECK((kind='test' AND receipt_id IS NULL) OR (kind<>'test' AND receipt_id IS NOT NULL))
);
CREATE INDEX print_jobs_tenant_status ON print_jobs(tenant_id,status,created_at);
CREATE INDEX print_jobs_creator ON print_jobs(tenant_id,created_by);
CREATE INDEX print_jobs_receipt ON print_jobs(tenant_id,receipt_id);
CREATE UNIQUE INDEX receipt_original_print ON print_jobs(tenant_id,receipt_id) WHERE kind='original';
ALTER TABLE print_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON print_jobs TO hotel_app USING(tenant_id=context_tenant()) WITH CHECK(tenant_id=context_tenant());
REVOKE ALL ON print_jobs FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON print_jobs TO hotel_app;
CREATE TRIGGER no_delete BEFORE DELETE ON print_jobs FOR EACH ROW EXECUTE FUNCTION deny_delete();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON print_jobs FOR EACH ROW EXECUTE FUNCTION touch_row();
-- Print jobs are local delivery metadata. Receipt and reprint financial content stays immutable.
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
 IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON print_jobs FROM %I',r); END IF;
 END LOOP;
END $$;
