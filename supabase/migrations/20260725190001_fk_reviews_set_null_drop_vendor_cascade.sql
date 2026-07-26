-- Preserve vendor_reviews when terminal requests are archived, and fail-safe
-- accidental hard vendor deletes (no silent CASCADE wipe of history).
--
-- 1) vendor_reviews.request_id: ON DELETE CASCADE → ON DELETE SET NULL
--    (same pattern as feed_posts.vendor_id / feed_replies.suggested_vendor_id)
-- 2) requests / vendor_menu_items / vendor_reviews → vendors: drop ON DELETE CASCADE
--    → plain REFERENCES (match TEST; hard vendor delete fails if children remain)

ALTER TABLE public.vendor_reviews
  DROP CONSTRAINT IF EXISTS vendor_reviews_request_id_fkey;

ALTER TABLE public.vendor_reviews
  ADD CONSTRAINT vendor_reviews_request_id_fkey
  FOREIGN KEY (request_id) REFERENCES public.requests(id) ON DELETE SET NULL;

ALTER TABLE public.requests
  DROP CONSTRAINT IF EXISTS requests_vendor_id_fkey;

ALTER TABLE public.requests
  ADD CONSTRAINT requests_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);

ALTER TABLE public.vendor_menu_items
  DROP CONSTRAINT IF EXISTS vendor_menu_items_vendor_id_fkey;

ALTER TABLE public.vendor_menu_items
  ADD CONSTRAINT vendor_menu_items_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);

ALTER TABLE public.vendor_reviews
  DROP CONSTRAINT IF EXISTS vendor_reviews_vendor_id_fkey;

ALTER TABLE public.vendor_reviews
  ADD CONSTRAINT vendor_reviews_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);
