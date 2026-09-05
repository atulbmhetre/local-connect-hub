-- Document client/SQL coupling for delivery slot wall-clock hours (no behavior change).
-- Canonical client constants: src/lib/deliverySlotDeadline.ts
--   DELIVERY_SLOT_DEADLINE_HOUR, DELIVERY_SLOT_CUTOFF_HOUR,
--   DELIVERY_SLOT_WINDOW_BEFORE_DEADLINE_MS, DELIVERY_SLOT_TOMORROW_WINDOW_BEFORE_DEADLINE_MS

COMMENT ON FUNCTION public._delivery_slot_deadline_on(text, date) IS
  'IST slot ends: morning 12:00, afternoon 16:00, evening/default 20:00. Keep in sync with src/lib/deliverySlotDeadline.ts DELIVERY_SLOT_DEADLINE_HOUR.';

COMMENT ON FUNCTION public.delivery_slot_window_start(text, timestamptz) IS
  'Window open: morning/afternoon/evening = deadline − 4h; tomorrow = deadline − 20h; asap/null = NULL. Keep in sync with src/lib/deliverySlotDeadline.ts DELIVERY_SLOT_WINDOW_*_MS.';
