-- Align TEST live value with PROD (50). Seed was originally 50; TEST drifted to 200.
-- Idempotent: safe if later applied on PROD (already 50).

SET app.via_admin_rpc = 'true';

UPDATE public.app_config
SET value = '50'
WHERE key = 'vendor_stopped_distance_meters'
  AND value IS DISTINCT FROM '50';

RESET app.via_admin_rpc;
