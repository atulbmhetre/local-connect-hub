-- Duplicate path cleanup: bill notifications are already sent by client RPC flow.
-- Keep RPC path, drop DB trigger path to prevent duplicate inbox/push notifications.

DROP TRIGGER IF EXISTS order_bill_after_insert ON public.order_bills;
