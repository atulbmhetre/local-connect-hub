SELECT LEFT(pg_get_functiondef(p.oid), 3000) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='vendor_record_khata_refund';
