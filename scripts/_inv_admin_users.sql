SELECT au.user_id::text AS user_id,
       au.created_at AS admin_users_created_at,
       u.email,
       u.phone,
       u.created_at AS auth_created_at,
       u.last_sign_in_at
FROM public.admin_users au
LEFT JOIN auth.users u ON u.id = au.user_id
ORDER BY au.created_at;
