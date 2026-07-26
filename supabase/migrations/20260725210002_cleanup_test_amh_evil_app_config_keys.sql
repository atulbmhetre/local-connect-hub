-- Remove leftover AMH-05 security-test artifacts from TEST app_config.
-- Keys were inserted under an older whitelist path; current AMH-05 expects rejection
-- and never leaves rows. No product code references amh_evil_key_*.

SET app.via_admin_rpc = 'true';

DELETE FROM public.app_config
WHERE key LIKE 'amh_evil_key_%';

RESET app.via_admin_rpc;
