-- 1) FK references to order_items.id (not request_id)
SELECT
  tc.table_schema,
  tc.table_name,
  kcu.column_name AS referencing_column,
  ccu.table_name AS referenced_table,
  ccu.column_name AS referenced_column,
  tc.constraint_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND ccu.table_schema = 'public'
  AND ccu.table_name = 'order_items'
  AND ccu.column_name = 'id';

-- Also check pg_catalog for any FK pointing at order_items.id
SELECT
  conrelid::regclass AS referencing_table,
  a.attname AS referencing_column,
  confrelid::regclass AS referenced_table,
  af.attname AS referenced_column,
  con.conname AS constraint_name
FROM pg_constraint con
JOIN pg_attribute a ON a.attnum = ANY (con.conkey) AND a.attrelid = con.conrelid
JOIN pg_attribute af ON af.attnum = ANY (con.confkey) AND af.attrelid = con.confrelid
WHERE con.contype = 'f'
  AND con.confrelid = 'public.order_items'::regclass
  AND af.attname = 'id';

-- khata_ledger column constraints
SELECT
  con.conname,
  pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = 'public'
  AND rel.relname = 'khata_ledger';
