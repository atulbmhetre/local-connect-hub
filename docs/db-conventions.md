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

Add new RPCs under `supabase/migrations/<timestamp>_<description>.sql`, then push via the enforced wrappers (see below).

### Deferred migrations (hard rule)

A migration is either ready for **both** TEST and PROD, or it must **not** exist under `supabase/migrations/`.

| Location | CLI behavior |
|----------|----------------|
| `supabase/migrations/` | Applied by `supabase db push` in strict timestamp order |
| `supabase/migrations-deferred/` | **Ignored** by the CLI — quarantine only |

**Do not** leave a version in `migrations/` that one environment must skip. That forces direct SQL + `migration repair` for every later push.

Track holds in `supabase/deferred-migrations.json` (version, path, reason, unblock criteria, which envs already applied it).

**Unblock path:** when the hold clears, add a **new** idempotent migration with a **fresh** timestamp. Do **not** move the deferred file back under the old version stamp (TEST may already have that stamp recorded; reusing it recreates chronological holes on PROD).

**Standing ban:** do not use `migration repair` + direct SQL to skip a pending local file as routine practice — keep deferred work out of `migrations/` instead.

### Enforced push (use these, not bare `db push`)

```bash
npm run db:push:test    # link TEST + preflight + db push
npm run db:push:prod    # link PROD + preflight + db push
```

`scripts/db-push.mjs` refuses to push if any version listed in `supabase/deferred-migrations.json` appears under `supabase/migrations/`. Preflight only:

```bash
node scripts/db-push.mjs test --preflight-only
node scripts/db-push.mjs prod --preflight-only
```

Project refs: TEST `hhdylnhqdzfabsolwxdz` · PROD `rpxsyeqskvhjmbkxnpmd`.
