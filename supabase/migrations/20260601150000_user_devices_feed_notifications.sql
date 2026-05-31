ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS feed_notifications_enabled boolean NOT NULL DEFAULT true;
