-- KB-11: Remove unused payments_enabled app_config key.
DELETE FROM public.app_config WHERE key = 'payments_enabled';
