-- Remove legacy dashboard-created Database Webhook on public.requests.
-- Trigger notify_vendor_on_order called notify-vendor on every INSERT via
-- supabase_functions.http_request, duplicating ParchiSheet's client-side
-- invokeNotifyVendor (new_order + typeless notification rows).
-- Client path is the maintained source of truth for Help/Delivery/Appointment.

DROP TRIGGER IF EXISTS notify_vendor_on_order ON public.requests;
