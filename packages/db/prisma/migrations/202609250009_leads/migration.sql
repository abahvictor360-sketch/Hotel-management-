-- Sales enquiries from the public website's contact form. Cloud-side and not tied to a
-- hotel. The public site (booking_agent) may only add a new enquiry; only the provider
-- console reads them and records follow-up.
CREATE TABLE "sales_leads" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "hotel_name" TEXT NOT NULL,
    "city" TEXT,
    "rooms" INTEGER,
    "plan" TEXT,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    CONSTRAINT "sales_leads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_leads_status_check" CHECK ("status" IN ('new','contacted','won','lost')),
    CONSTRAINT "sales_leads_rooms_check" CHECK ("rooms" IS NULL OR "rooms" BETWEEN 1 AND 5000),
    CONSTRAINT "sales_leads_lengths_check" CHECK (
      length("name") BETWEEN 2 AND 120 AND length("email") <= 254 AND length("hotel_name") BETWEEN 2 AND 150
      AND length("message") BETWEEN 10 AND 3000 AND coalesce(length("phone"),0) <= 40
      AND coalesce(length("city"),0) <= 100 AND coalesce(length("plan"),0) <= 30
      AND coalesce(length("notes"),0) <= 3000)
);
CREATE INDEX "sales_leads_status_created_idx" ON "sales_leads"("status", "created_at" DESC);
-- touch_row() expects tenant columns; leads have none, so they keep their own.
CREATE FUNCTION public.touch_lead() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
 IF NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'Row identity is immutable'; END IF;
 IF ROW(NEW.name,NEW.email,NEW.phone,NEW.hotel_name,NEW.city,NEW.rooms,NEW.plan,NEW.message)
    IS DISTINCT FROM ROW(OLD.name,OLD.email,OLD.phone,OLD.hotel_name,OLD.city,OLD.rooms,OLD.plan,OLD.message)
 THEN RAISE EXCEPTION 'An enquiry is kept as the visitor sent it'; END IF;
 NEW.updated_at=greatest(clock_timestamp(),OLD.updated_at+interval '1 microsecond'); RETURN NEW;
END $$;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "sales_leads" FOR EACH ROW EXECUTE FUNCTION public.touch_lead();
CREATE TRIGGER no_delete BEFORE DELETE ON "sales_leads" FOR EACH ROW EXECUTE FUNCTION public.deny_delete();
ALTER TABLE "sales_leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_leads" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "sales_leads" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 -- Hosted Postgres may grant new tables to its API roles by default; this table is not theirs.
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON TABLE sales_leads FROM %I',r);
  END IF;
 END LOOP;
END $$;
CREATE POLICY lead_submit ON "sales_leads" FOR INSERT TO booking_agent
  WITH CHECK ("status" = 'new' AND "notes" IS NULL);
GRANT INSERT ("id","name","email","phone","hotel_name","city","rooms","plan","message") ON "sales_leads" TO booking_agent;
CREATE POLICY lead_follow_up ON "sales_leads" FOR ALL TO provider_app USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE ("status","notes") ON "sales_leads" TO provider_app;
