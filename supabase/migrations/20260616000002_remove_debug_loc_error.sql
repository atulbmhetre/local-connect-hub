-- Remove temporary location-debug config row (no longer needed).

DELETE FROM public.app_config
WHERE key = 'debug_loc_error';
