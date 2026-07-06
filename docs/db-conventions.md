# Database conventions (client ↔ Supabase)

## Direct table mutations are banned in `src/`

The anon Supabase client runs in **OTP-off** mode: identity comes from `localStorage` (`aaspaas:user_phone`), not from a JWT. Phase C RLS policies use `public.auth_user_phone()`, which returns **NULL** without a real auth session, so direct `.from(...).insert|update|delete|upsert(...)` calls **silently affect zero rows** or fail checks.

**Rule:** All writes from `src/**/*.{ts,tsx}` must go through **SECURITY DEFINER RPCs** that accept explicit identity params and verify ownership server-side.

ESLint enforces this (`no-restricted-syntax` on `supabase.from(...).insert|update|delete|upsert`). Do not add eslint-disable exceptions.

## SECURITY DEFINER RPC pattern

Follow existing migrations (e.g. `migrate_device_requests_phone`, `update_user_address`):

1. **`CREATE OR REPLACE FUNCTION public.<name>(...)`**
2. **`LANGUAGE plpgsql`**
3. **`SECURITY DEFINER`**
4. **`SET search_path = public`**
5. Validate identity params early (`NULLIF(trim(...), '')`, `RAISE EXCEPTION 'identity_required'`).
6. Verify row ownership (`WHERE ... AND user_phone = v_phone` or vendor phone match on `vendors`).
7. Perform the mutation inside the function body.
8. **`REVOKE ALL ON FUNCTION public.<name>(...) FROM PUBLIC;`**
9. **`GRANT EXECUTE ON FUNCTION public.<name>(...) TO anon, authenticated;`**

## Parameter naming

| Param | Use |
|-------|-----|
| `p_user_phone` | Customer / device owner phone (10-digit, no country prefix in app storage) |
| `p_vendor_phone` | Vendor row `vendors.phone` |
| `p_device_id` | Device-scoped identity when phone may be absent |
| `p_admin_phone` | Admin actions (also check `is_admin_phone()` inside RPC) |

Pass phones from `getUserPhone()` / vendor session — never rely on RLS + JWT for anon clients.

## Examples in this repo

| Operation | RPC |
|-----------|-----|
| Backfill request phone on device | `migrate_device_requests_phone(p_device_id, p_user_phone)` |
| Backfill saved neighbour phone on device | `migrate_saved_vendors_phone(p_device_id, p_user_phone)` |
| Edit/delete address | `update_user_address`, `delete_user_address` |
| Feed discovery radius | `set_feed_discovery_radius(p_user_phone, p_radius_km)` |
| Vendor self-update | `vendor_update_own(p_vendor_id, p_vendor_phone, p_patch)` |

## Migrations

Add new RPCs under `supabase/migrations/<timestamp>_<description>.sql`, then link and push:

```bash
supabase link --project-ref hhdylnhqdzfabsolwxdz --yes   # TEST
supabase db push --yes

supabase link --project-ref rpxsyeqskvhjmbkxnpmd --yes   # PROD
supabase db push --yes
```
