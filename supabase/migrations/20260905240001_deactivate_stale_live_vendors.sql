-- H5: vendors marked is_active with frozen GPS after the app is killed must not
-- stay discoverable as "live". Client pings last_updated every 20 minutes while
-- running; once the process dies those pings stop. Auto-offline after 45 minutes
-- (~2× the ping interval) so Radar/Help never surface stale coordinates as live.

INSERT INTO public.app_config (key, value, default_value)
VALUES (
  'vendor_live_stale_minutes',
  '45',
  '45'
)
ON CONFLICT (key) DO UPDATE
SET default_value = EXCLUDED.default_value;

CREATE OR REPLACE FUNCTION public.deactivate_stale_live_vendors()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  stale_minutes integer;
  affected integer;
BEGIN
  SELECT NULLIF(trim(value), '')::integer
  INTO stale_minutes
  FROM public.app_config
  WHERE key = 'vendor_live_stale_minutes';

  IF stale_minutes IS NULL OR stale_minutes < 1 THEN
    RAISE EXCEPTION 'app_config key vendor_live_stale_minutes is missing or invalid';
  END IF;

  UPDATE public.vendors
  SET is_active = false
  WHERE is_active = true
    AND (
      last_updated IS NULL
      OR last_updated < now() - (stale_minutes || ' minutes')::interval
    );

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

COMMENT ON FUNCTION public.deactivate_stale_live_vendors() IS
  'Sets is_active=false for vendors whose last_updated is older than vendor_live_stale_minutes (default 45). Prevents Help/Radar from showing killed-app vendors as live with stale GPS.';

REVOKE ALL ON FUNCTION public.deactivate_stale_live_vendors() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deactivate_stale_live_vendors()
  TO service_role;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'deactivate-stale-live-vendors';

SELECT cron.schedule(
  'deactivate-stale-live-vendors',
  '*/5 * * * *',
  $$SELECT public.deactivate_stale_live_vendors();$$
);
