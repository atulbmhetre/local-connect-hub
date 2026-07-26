-- Client postgres_changes filters on requests use user_phone / vendor_id / device_id,
-- which are not in the WAL under REPLICA IDENTITY DEFAULT (PK only). Without FULL,
-- UPDATE events never match those filters even when the table is in supabase_realtime.

ALTER TABLE public.requests REPLICA IDENTITY FULL;
