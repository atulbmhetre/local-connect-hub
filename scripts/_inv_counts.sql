SELECT c.relname AS table_name,
       (xpath(
         '/row/c/text()',
         query_to_xml(format('select count(*)::bigint as c from public.%I', c.relname), false, true, '')
       ))[1]::text::bigint AS row_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relname;
