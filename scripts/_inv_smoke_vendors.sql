SELECT id, phone, name, shop_name, created_at
FROM public.vendors
WHERE phone LIKE '9910%'
   OR shop_name ILIKE 'Smoke Shop%'
   OR shop_name ILIKE 'Smoke%'
   OR name ILIKE 'Smoke%'
   OR name ILIKE 'Multi Mode%'
ORDER BY created_at;
