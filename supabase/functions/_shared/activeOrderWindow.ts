/**
 * Active-order age windows for edge call / notify relationship gates.
 *
 * Deno cannot import the Vite client module — keep numeric values identical to:
 *   src/lib/orders.ts → ACTIVE_ORDER_MAX_AGE_MS, SCHEDULED_ORDER_GRACE_MS
 */

/** Max age for an in-progress order to count as “active”. */
export const ACTIVE_ORDER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Extra lookback for scheduled appointment_time / delivery_slot_deadline when
 * deciding active linkage.
 */
export const SCHEDULED_ORDER_GRACE_MS = 24 * 60 * 60 * 1000;
