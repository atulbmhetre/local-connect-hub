-- Gate masked Secure Call / AI-Bridge dialing until Exotel KYC is live.
-- Flip value to 'true' after Exotel credentials/KYC are configured; clients
-- read via useAppConfig (exotelSecureCallingEnabled) with default false.
SET app.via_admin_rpc = 'true';
INSERT INTO public.app_config (key, value)
VALUES ('exotel_secure_calling_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
RESET app.via_admin_rpc;
