-- Re-attach bill notify trigger (dropped in 20260702000011 when client invokeNotifyUser was sole path).
-- Client bill notify calls removed; server trigger is again the source of truth.

DROP TRIGGER IF EXISTS order_bill_after_insert ON public.order_bills;

CREATE TRIGGER order_bill_after_insert
AFTER INSERT ON public.order_bills
FOR EACH ROW
EXECUTE FUNCTION public.notify_order_bill_trigger();
