-- Hardening before hosting. Shared by hub and cloud.
-- The public booking site finds a hotel by its slug, so a slug must name one hotel only.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_unique ON tenants(slug);
-- Trigger functions resolve names in public only, whatever search_path the caller set.
-- context_tenant() is left inlinable for the row-level security policies that call it.
ALTER FUNCTION public.touch_row() SET search_path = public, pg_temp;
ALTER FUNCTION public.deny_mutation() SET search_path = public, pg_temp;
ALTER FUNCTION public.deny_delete() SET search_path = public, pg_temp;
ALTER FUNCTION public.require_writable() SET search_path = public, pg_temp;
ALTER FUNCTION public.track_change() SET search_path = public, pg_temp;
ALTER FUNCTION public.open_folio_for_posting() SET search_path = public, pg_temp;
ALTER FUNCTION public.check_folio_closure() SET search_path = public, pg_temp;
ALTER FUNCTION public.validate_financial_reversal() SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_replicated(text) SET search_path = public, pg_temp;
DO $$ DECLARE r text; BEGIN
 IF to_regclass('public._prisma_migrations') IS NOT NULL THEN REVOKE ALL ON TABLE "_prisma_migrations" FROM PUBLIC; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I',r);
  END IF;
 END LOOP;
END $$;
