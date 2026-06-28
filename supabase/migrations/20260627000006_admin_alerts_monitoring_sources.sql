-- admin_alerts.function_name holds edge functions, external APIs, billing keys, and app_config expiry keys.
-- error_type CHECK is unchanged (billing, model, timeout, unknown).
COMMENT ON COLUMN public.admin_alerts.function_name IS
  'Alert source: edge function (e.g. suggest-category), external API (exotel-api, razorpay-api), billing (anthropic-credits, exotel-credits), or app_config key (e.g. supabase_plan_renewal).';
