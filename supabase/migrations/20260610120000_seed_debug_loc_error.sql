-- TEMP DEBUG: seed row for remote location-error reporting.
-- The client upserts into this key from saveUserDeviceLocationSilently;
-- pre-creating the row lets the upsert resolve to UPDATE (anon has no INSERT
-- policy on app_config). Remove the row and this migration after diagnosis.
INSERT INTO public.app_config (key, value)
VALUES ('debug_loc_error', '(no error reported yet)')
ON CONFLICT (key) DO NOTHING;
