-- Performance indexes audit — missing indexes on hot query columns

-- requests table
CREATE INDEX IF NOT EXISTS requests_user_phone_idx ON public.requests (user_phone);
CREATE INDEX IF NOT EXISTS requests_status_idx ON public.requests (status);
CREATE INDEX IF NOT EXISTS requests_created_at_idx ON public.requests (created_at DESC);
CREATE INDEX IF NOT EXISTS requests_appointment_time_idx ON public.requests (appointment_time) WHERE appointment_time IS NOT NULL;
CREATE INDEX IF NOT EXISTS requests_payment_status_idx ON public.requests (payment_status) WHERE payment_status != 'unpaid';

-- vendors table
CREATE INDEX IF NOT EXISTS vendors_is_active_idx ON public.vendors (is_active);
CREATE INDEX IF NOT EXISTS vendors_service_mode_idx ON public.vendors (service_mode);
CREATE INDEX IF NOT EXISTS vendors_subscription_status_idx ON public.vendors (subscription_status);
CREATE INDEX IF NOT EXISTS vendors_category_idx ON public.vendors (category);
CREATE INDEX IF NOT EXISTS vendors_is_active_service_mode_idx ON public.vendors (is_active, service_mode);

-- vendor_credits table
CREATE INDEX IF NOT EXISTS vendor_credits_vendor_id_idx ON public.vendor_credits (vendor_id);
CREATE INDEX IF NOT EXISTS vendor_credits_disbursed_idx ON public.vendor_credits (disbursed) WHERE disbursed = false;

-- feed_posts table
CREATE INDEX IF NOT EXISTS feed_posts_vendor_id_idx ON public.feed_posts (vendor_id);
CREATE INDEX IF NOT EXISTS feed_posts_created_at_idx ON public.feed_posts (created_at DESC);
CREATE INDEX IF NOT EXISTS feed_posts_expires_at_idx ON public.feed_posts (expires_at) WHERE expires_at IS NOT NULL;

-- vendor_reviews table
CREATE INDEX IF NOT EXISTS vendor_reviews_vendor_id_idx ON public.vendor_reviews (vendor_id);

-- fcm_delivery_log table
CREATE INDEX IF NOT EXISTS fcm_delivery_log_created_at_idx ON public.fcm_delivery_log (created_at DESC);
CREATE INDEX IF NOT EXISTS fcm_delivery_log_notification_type_idx ON public.fcm_delivery_log (notification_type);
