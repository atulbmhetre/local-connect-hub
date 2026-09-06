-- Partial index for live-vendor queries that filter active vendors by GPS freshness:
--   • deactivate_stale_live_vendors cron (is_active=true AND last_updated stale)
--   • Radar Help mode (.eq is_active + .gte last_updated)

CREATE INDEX IF NOT EXISTS vendors_active_last_updated_idx
  ON public.vendors (is_active, last_updated)
  WHERE is_active = true;

COMMENT ON INDEX public.vendors_active_last_updated_idx IS
  'Speeds stale-live deactivation cron and Radar Help live-freshness filters on last_updated.';
