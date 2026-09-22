# Waive-off vs Razorpay charges

Do **not** turn `PAYMENTS_ENABLED` / `payments_enabled` on until the items
below are implemented so each Razorpay charge equals `vendor_amount_due`
for that vendor (reduced amount, or zero when `is_free`).

This note is documentation only. Phase 6 does **not** change
`razorpay-webhook` or checkout. Local maths live in SQL
`vendor_amount_due(p_vendor_id)`.

Sources checked 2026-09-21:

- [Update a Subscription](https://razorpay.com/docs/api/payments/subscriptions/update-subscription/)
- [Create Subscription Offers](https://razorpay.com/docs/payments/subscriptions/offers/create/)
- [About Offers](https://razorpay.com/docs/payments/subscriptions/offers)
- [Link an Offer](https://razorpay.com/docs/api/payments/subscriptions/link-offer)
- [Pause a Subscription](https://razorpay.com/docs/api/payments/subscriptions/pause-subscription)

## What Phase 6 already does (app, not Razorpay)

- `vendor_amount_due` = `vendor_subscription_price` in paise ×
  `(100 - waiveoff_percent) / 100`, rounded to the nearest paisa, clamped
  to `[0, base_paise]`. Active only while `waiveoff_months_remaining > 0`.
- 100% waive-off → `amount_paise = 0`, `is_free = true`.
- Vendor billing and admin show that due amount when a waive-off is active.
- Checkout still sends `parseInt(vendor_subscription_price) * 100` (flat).
- `razorpay-webhook` still decrements `waiveoff_months_remaining` on
  `subscription.charged` only, not on `subscription.payment_failed`.

## What Razorpay must do so the charge matches `vendor_amount_due`

1. **Reduced (non-zero) amount per vendor**
   - Attach a Subscription Offer (percentage or flat) whose after-discount
     invoice equals `vendor_amount_due.amount_paise`, **or** switch the
     subscription to a plan whose `item.amount` is that value.
   - **Confirmed:** Offers support percentage and flat discounts; they can
     run for a limited number of cycles.
     ([create offers](https://razorpay.com/docs/payments/subscriptions/offers/create/))
   - **Confirmed:** An offer can be linked on create or via
     `PATCH /v1/subscriptions/:id` with `offer_id`.
     ([update subscription](https://razorpay.com/docs/api/payments/subscriptions/update-subscription/))
   - **Confirmed:** Linking/updating an offer on an **active** subscription
     applies at **end of the current cycle**, not immediately.
     ([link offer](https://razorpay.com/docs/api/payments/subscriptions/link-offer))
   - **Unconfirmed in our integration:** we do not create offers, plans, or
     call PATCH today. A mapping from each `(percent, months_remaining)` to
     an `offer_id` (or per-vendor plan) is not built.

2. **Discounted amount must stay ≥ ₹1 for INR**
   - **Confirmed:** Razorpay rejects an offer that would take the per-cycle
     charge below ₹1 (`400` “Discounted amount less than minimum payment
     amount”).
     ([link-offer errors](https://razorpay.com/docs/api/payments/subscriptions/link-offer),
     [about offers](https://razorpay.com/docs/payments/subscriptions/offers)
     “Offers can only be applied if the chargeable amount after applying
     the Offer is greater than ₹1.”)
   - **Implication:** a **100% waive-off cannot be a ₹0 Razorpay invoice**.
     Use pause / skip / credit (below), not a 100% offer.

3. **100% waive-off (`is_free`) — nothing charged**
   - **Confirmed:** `POST /v1/subscriptions/{id}/pause` with
     `{ "pause_at": "now" }` pauses an **active** subscription. Feature may
     need enabling (`400` “pause is not allowed, feature is not enabled”).
     ([pause](https://razorpay.com/docs/api/payments/subscriptions/pause-subscription))
   - **Unconfirmed:** whether pausing one month, then resume, is accepted
     as “a free month that completes a billing cycle” for our
     `waiveoff_months_remaining` rule. Pause does not emit
     `subscription.charged`; local months would **not** decrement unless we
     add a settled, TEST-proven path (out of Phase 6 scope).
   - **Unconfirmed:** issuing a ₹0 invoice or skipping the next invoice.
     Invoice APIs fetched in docs list fetch/list, not skip-next-charge.

4. **`waiveoff_months_remaining` only after a completed waive-off cycle**
   - **Rule:** decrement by 1 only when the cycle completed **under** the
     waive-off: paid at the reduced amount, **or** a free month at 100%.
     Never on a failed payment.
   - **Confirmed in our webhook (dormant):** `subscription.charged`
     decrements; `subscription.payment_failed` does not.
   - **Unconfirmed vs Razorpay:** that `subscription.charged` always means
     the invoice amount was the waived amount (not the full plan amount).
     Must verify payload `amount` / invoice lines against
     `vendor_amount_due` before enabling payments.
   - **Unconfirmed:** decrementing for a 100% free month without a
     `charged` event (pause/skip). Not implemented.

5. **Checkout must not keep charging the flat price**
   - Today: `VendorSettings` checkout `amount: parseInt(price) * 100`.
   - **Unconfirmed / not done:** Standard Checkout must create the
     subscription with the matching plan/offer so authorisation and later
     recurrences equal `vendor_amount_due`. Changing checkout is deferred
     until this note is settled.

6. **Admin apply / expire of waive-off must update Razorpay**
   - **Confirmed:** offer changes on active subs are `cycle_end` only.
   - **Unconfirmed:** applying waive-off mid-cycle, clearing it when
     months hit 0, or changing `vendor_subscription_price` in `app_config`
     will not move Razorpay until we PATCH plan/offer. Local display will
     already show the new `vendor_amount_due`.

## Other gates

- Idempotency: do not decrement months twice for the same Razorpay
  payment/invoice id.
- `check-vendor-subscriptions` remains dormant while
  `PAYMENTS_ENABLED` is false.
- Pause-credit (Phase 2) and waive-off can both apply; Razorpay still
  needs one charge calendar. See `docs/PAUSE_BILLING_RAZORPAY_NOTE.md`.
