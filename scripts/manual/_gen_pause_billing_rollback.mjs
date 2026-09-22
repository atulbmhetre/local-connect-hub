/**
 * One-shot: assemble scripts/manual/rollback-pause-billing.sql from last
 * pre-pause function bodies on main. Does not apply anything.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mig = (name) => path.join(root, "supabase", "migrations", name);

function extract(file, startIncl, endIncl) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  return lines.slice(startIncl - 1, endIncl).join("\n").trimEnd() + "\n";
}

const parts = [];
parts.push(`-- ROLLBACK for pause/billing (20260921* / 20260922*).
-- NOT APPLIED. Restores last main/PROD bodies (through 20260916120001)
-- of the six rewritten RPCs and DISABLEs the new vendor_categories triggers.
-- Does not drop tables/columns (pause_credit_days, vendor_billing_pauses, etc.).
-- TEST syntax-check: wrap in BEGIN; … ROLLBACK;

BEGIN;

-- ── Disable pause/billing triggers (no-op if missing) ──────────────────────
DO $disable$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'vendor_categories_pause_history_trg',
    'vendor_categories_billing_pause_trg',
    'vendor_categories_pause_reminder_trg',
    'vendor_categories_pause_block_trg'
  ]
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_trigger g
      JOIN pg_class c ON c.oid = g.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'vendor_categories'
        AND g.tgname = t
        AND NOT g.tgisinternal
    ) THEN
      EXECUTE format('ALTER TABLE public.vendor_categories DISABLE TRIGGER %I', t);
    END IF;
  END LOOP;
END;
$disable$;

`);

parts.push("-- ── admin_update_app_config from 20260916120001 ──\n");
parts.push(
  extract(mig("20260916120001_upi_vpa_verification_dormant.sql"), 22, 91),
);

parts.push(`
-- ── vendor_update_category_profile from 20260831140001 (RETURNS void) ──
DROP FUNCTION IF EXISTS public.vendor_update_category_profile(uuid, text, uuid, jsonb);

`);
parts.push(extract(mig("20260831140001_min_delivery_order_amount.sql"), 266, 370));

parts.push("\n-- ── create_customer_request from 20260905290001 ──\n");
parts.push(
  extract(
    mig("20260905290001_create_customer_request_drop_dead_active_checks.sql"),
    6,
    260,
  ),
);

parts.push("\n-- ── spawn_due_recurring_orders from 20260905280001 ──\n");
parts.push(extract(mig("20260905280001_state_machine_high_gaps.sql"), 441, 553));

parts.push("\n-- ── get_radar_category_mode_matches from 20260830120001 ──\n");
parts.push(
  extract(mig("20260830120001_vendor_category_pause_and_inspection_fee.sql"), 32, 63),
);

parts.push("\n-- ── _resolve_booking_category from 20260830120001 ──\n");
parts.push(
  extract(mig("20260830120001_vendor_category_pause_and_inspection_fee.sql"), 70, 215),
);

parts.push(`
-- Leave COMMIT commented so a mistaken run stops in an open transaction.
-- COMMIT;
ROLLBACK;
`);

const out = path.join(root, "scripts", "manual", "rollback-pause-billing.sql");
fs.writeFileSync(out, parts.join("\n"), "utf8");
console.log("wrote", out, "bytes", fs.statSync(out).size);
