-- Align remaining TEST/PROD FK drift (product never relies on CASCADE).
--
-- 1) feed_posts.vendor_id → vendors: ON DELETE SET NULL
--    (TEST was NO ACTION; PROD already SET NULL)
-- 2) feed_replies.suggested_vendor_id → vendors: ON DELETE SET NULL
--    (TEST was NO ACTION; PROD already SET NULL)
-- 3) order_bills.request_id → requests: plain REFERENCES (NO ACTION)
--    (PROD was CASCADE; TEST already NO ACTION)
--
-- Idempotent on both environments: drop + recreate to the shared target.

ALTER TABLE public.feed_posts
  DROP CONSTRAINT IF EXISTS feed_posts_vendor_id_fkey;

ALTER TABLE public.feed_posts
  ADD CONSTRAINT feed_posts_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE SET NULL;

ALTER TABLE public.feed_replies
  DROP CONSTRAINT IF EXISTS feed_replies_suggested_vendor_id_fkey;

ALTER TABLE public.feed_replies
  ADD CONSTRAINT feed_replies_suggested_vendor_id_fkey
  FOREIGN KEY (suggested_vendor_id) REFERENCES public.vendors(id) ON DELETE SET NULL;

ALTER TABLE public.order_bills
  DROP CONSTRAINT IF EXISTS order_bills_request_id_fkey;

ALTER TABLE public.order_bills
  ADD CONSTRAINT order_bills_request_id_fkey
  FOREIGN KEY (request_id) REFERENCES public.requests(id);
