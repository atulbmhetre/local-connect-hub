import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.join(
  root,
  "supabase",
  "migrations",
  "20260829200001_vendor_upi_mutate_rate_limit.sql",
);

function readFn(name) {
  return fs.readFileSync(path.join(root, `_prod_fn_${name}.sql`), "utf8").replace(/\r\n/g, "\n").trimEnd();
}

function injectSnapshotAndLimit(sql) {
  if (sql.includes("v_upi_fp_before")) return sql;
  sql = sql.replace(
    /\nBEGIN\n/,
    `\n  v_upi_fp_before text;\nBEGIN\n  v_upi_fp_before := public._vendor_upi_fingerprint(p_vendor_id);\n\n`,
  );
  sql = sql.replace(
    /\nEND;\n\$function\$\s*$/,
    `\n  PERFORM public._rate_limit_vendor_upi_if_changed(p_vendor_id, v_upi_fp_before);\nEND;\n$function$`,
  );
  return sql;
}

let verify = readFn("vendor_verify_upi");
if (!verify.includes("vendor_upi_mutate")) {
  verify = verify.replace(
    `  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF NULLIF(trim(COALESCE(v_saved, '')), '') IS DISTINCT FROM v_input THEN`,
    `  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_unauthorized';
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'vendor_upi_mutate',
    'vendor_id',
    p_vendor_id::text,
    5,
    86400
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  IF NULLIF(trim(COALESCE(v_saved, '')), '') IS DISTINCT FROM v_input THEN`,
  );
}

const own = injectSnapshotAndLimit(readFn("vendor_update_own"));
const cats = injectSnapshotAndLimit(readFn("vendor_update_categories"));

const helpers = `-- Split from 20260829190001: UPI-mutating rate limit only (5/day per vendor_id).
-- No SMS, no insert_bill_with_items phone gate (those stay in 190001, held for
-- the client rebuild). GPS/active patches do not count — only fingerprint
-- changes. vendor_update_profile_and_categories is a wrapper of own+categories;
-- a transaction GUC counts once.
--
-- On TEST, 190001 already installed SMS+_finish on own/categories. Replacing
-- those bodies here would strip SMS, so own/categories are skipped when
-- _finish_vendor_upi_mutation already exists.

CREATE OR REPLACE FUNCTION public._vendor_upi_fingerprint(p_vendor_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT md5(
    COALESCE((
      SELECT NULLIF(btrim(v.upi_id), '')
      FROM public.vendors v
      WHERE v.id = p_vendor_id
    ), '')
    || chr(1)
    || COALESCE((
      SELECT NULLIF(btrim(v.upi_qr_payee_id), '')
      FROM public.vendors v
      WHERE v.id = p_vendor_id
    ), '')
    || chr(1)
    || COALESCE((
      SELECT string_agg(
        vc.category_id::text
          || '='
          || COALESCE(NULLIF(btrim(vc.upi_id), ''), '')
          || '/'
          || COALESCE(NULLIF(btrim(vc.upi_qr_payee_id), ''), ''),
        ','
        ORDER BY vc.category_id
      )
      FROM public.vendor_categories vc
      WHERE vc.vendor_id = p_vendor_id
        AND (
          NULLIF(btrim(vc.upi_id), '') IS NOT NULL
          OR NULLIF(btrim(vc.upi_qr_payee_id), '') IS NOT NULL
        )
    ), '')
  );
$$;

CREATE OR REPLACE FUNCTION public._rate_limit_vendor_upi_if_changed(
  p_vendor_id uuid,
  p_old_fp text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public._vendor_upi_fingerprint(p_vendor_id) IS NOT DISTINCT FROM p_old_fp THEN
    RETURN;
  END IF;

  IF current_setting('aaspaas.upi_mutate_done', true) = '1' THEN
    RETURN;
  END IF;

  IF NOT public.check_and_log_rate_limit(
    'vendor_upi_mutate',
    'vendor_id',
    p_vendor_id::text,
    5,
    86400
  ) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  PERFORM set_config('aaspaas.upi_mutate_done', '1', true);
END;
$$;

COMMENT ON FUNCTION public._rate_limit_vendor_upi_if_changed(uuid, text) IS
  '5 UPI-mutating writes per vendor_id per 24h. No-op when fingerprint unchanged.';

REVOKE ALL ON FUNCTION public._vendor_upi_fingerprint(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._rate_limit_vendor_upi_if_changed(uuid, text) FROM PUBLIC;
`;

function sqlLiteral(s) {
  return s.replace(/'/g, "''");
}

const migration = `${helpers}

-- ── vendor_verify_upi: shared 5/day bucket (safe to replace on TEST) ─────────

${verify};

-- ── vendor_update_own / vendor_update_categories: PROD only ──────────────────
-- Skip when TEST already has the SMS finish helper from 190001.

DO $guard$
BEGIN
  IF to_regprocedure('public._finish_vendor_upi_mutation(uuid, text, text)') IS NOT NULL THEN
    RAISE NOTICE 'skip own/categories rate-limit rewrite (_finish_vendor_upi_mutation present)';
    RETURN;
  END IF;

  EXECUTE $own$
${own}
  $own$;

  EXECUTE $cats$
${cats}
  $cats$;
END;
$guard$;
`;

fs.writeFileSync(out, migration);
console.log("wrote", out, migration.length);
