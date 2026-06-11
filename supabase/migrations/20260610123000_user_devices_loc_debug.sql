-- TEMP DEBUG: breadcrumb column for diagnosing silent location-save failures.
-- anon writes to user_devices demonstrably work (fcm token upsert), unlike
-- app_config where anon UPDATE is RLS-blocked. Drop after diagnosis.
ALTER TABLE public.user_devices ADD COLUMN IF NOT EXISTS loc_debug text;
