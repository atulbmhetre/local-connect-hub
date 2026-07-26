-- Publish requests for postgres_changes (Home banner, IncomingOrders, MyOrders).
-- Matches existing supabase_realtime membership of user_notifications / vendors on PROD.
-- REPLICA IDENTITY FULL is required so UPDATE events include filter columns
-- (user_phone / vendor_id / device_id) — DEFAULT only ships the PK, which breaks
-- client filters like user_phone=eq.… / vendor_id=eq.… (vendors works with DEFAULT
-- because those subscriptions filter on id = PK).
-- Idempotent.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_rel pr
    JOIN pg_publication p ON p.oid = pr.prpubid
    JOIN pg_class c ON c.oid = pr.prrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE p.pubname = 'supabase_realtime'
      AND n.nspname = 'public'
      AND c.relname = 'requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.requests;
  END IF;
END $$;

ALTER TABLE public.requests REPLICA IDENTITY FULL;
