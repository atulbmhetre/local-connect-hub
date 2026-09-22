# Pause credit vs Razorpay paid periods

Do **not** turn `PAYMENTS_ENABLED` on until the items below are decided.
This note is documentation only: no Razorpay API or webhook changes shipped
with Phase 2.

## What Phase 2 already does

- Fully paused accounts (no approved, unpaused business) open a
  `vendor_billing_pauses` window.
- Closing a **qualifying** window adds `days` to `vendors.pause_credit_days`.
- Trial end used by `check-vendor-subscriptions` is
  `created_at + vendor_trial_days + pause_credit_days`
  (`vendor_effective_trial_end`), not `trial_ends_at`.
- Trial→grace and grace→expired are skipped while a billing window is open.

## What is not decided (ACTIVE paid)

For vendors with `subscription_status = 'active'`, Razorpay owns the charge
calendar. `razorpay-webhook` writes `vendors.subscription_current_period_end`
from the subscription entity (`current_end` / period end). That column is
**webhook-authoritative**: any local “move next charge by credited days”
update will be overwritten on the next subscription webhook.

Before enabling payments, product/engineering must choose one of:

1. **Do not extend paid periods with pause credit.** Credit applies only
   while the vendor is still on trial (current Phase 2 behaviour). Paid
   pause is freeze-of-enforcement only (open window skips expiry jobs);
   Razorpay still charges on its schedule.
2. **Pause the Razorpay subscription** for the open window (API pause /
   halt), then resume on close. Next charge then follows Razorpay’s paused
   subscription rules, not a local date patch.
3. **Update Razorpay’s next charge / period end via API** when a window
   qualifies, then let webhooks echo the new
   `subscription_current_period_end`. Never write that column from the
   pause trigger alone.
4. **Issue a customer-balance / delayed invoice** for credited days instead
   of moving `current_period_end`.

## Other gates

- Idempotency: a webhook must not clobber a just-extended period if option
  3 is chosen; correlate pause close `id` with Razorpay notes/metadata.
- `pause_min_credit_days` / `pause_min_live_days` must match whatever
  Razorpay pause minimums (if any) you rely on.
- Refund vs skip-next-invoice if a charge already fired during an open
  window (race between pause and Razorpay cron).
- `check-vendor-subscriptions` remains dormant (`PAYMENTS_ENABLED = false`)
  until this policy is implemented and TEST-proven.
