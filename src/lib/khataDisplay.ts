import type { StringBundle } from "@/lib/strings";
import { isSamePhone, normalizePhoneDigits } from "@/lib/indianPhone";

export { isSamePhone, normalizePhoneDigits } from "@/lib/indianPhone";

export function maskPhoneLast4(phone: string): string {
  const digits = normalizePhoneDigits(phone) ?? phone.replace(/\D/g, "");
  return `••••${digits.slice(-4)}`;
}

/** Mask phone for display: •••• + last 4 of canonical national digits when possible. */
export function maskPhone(phone: string): string {
  const digits = normalizePhoneDigits(phone) ?? phone.replace(/\D/g, "");
  if (digits.length >= 4) return `••••${digits.slice(-4)}`;
  return "••••";
}

export function feedAuthorLabel(phone: string, viewerPhone: string | null): string {
  if (viewerPhone && isSamePhone(phone, viewerPhone)) return "You";
  return maskPhone(phone);
}

export function khataPaymentModeLabel(mode: string, s: StringBundle): string {
  if (mode === "cash") return s.bill_cash;
  if (mode === "upi") return s.bill_upi;
  if (mode === "khata") return s.khata_modeUnpaid;
  if (mode === "paid") return s.khata_modePaid;
  return mode;
}

/** Display-only business / payment / refund chip for a khata line. */
export type KhataTxBusinessChip =
  | { kind: "business"; emoji: string; label: string }
  | { kind: "payment" }
  | { kind: "refund" }
  | { kind: "none" };

export function resolveKhataTxBusinessChip(
  tx: {
    request_id?: string | null;
    category_label?: string | null;
    category_emoji?: string | null;
    payment_mode: string;
  },
): KhataTxBusinessChip {
  const label = tx.category_label != null ? String(tx.category_label).trim() : "";
  if (tx.request_id && label) {
    const emoji =
      tx.category_emoji != null && String(tx.category_emoji).trim() !== ""
        ? String(tx.category_emoji).trim()
        : "✨";
    return { kind: "business", emoji, label };
  }
  if (tx.payment_mode === "paid") return { kind: "payment" };
  if (!tx.request_id) return { kind: "refund" };
  return { kind: "none" };
}

/** Positive = customer owes vendor; negative = vendor owes customer (refund due); 0 = settled. */
export function khataOutstandingColorClass(
  outstanding: number,
  amberLimit: number,
  redLimit: number,
): string {
  if (outstanding < 0) return "text-blue-400";
  if (redLimit > 0 && outstanding >= redLimit) return "text-red-400";
  if (amberLimit > 0 && outstanding >= amberLimit) return "text-amber-400";
  return "text-green-400";
}

/** khata_ledger.total_outstanding — unsettled while non-zero (includes customer credit). */
export function isKhataLedgerUnsettled(totalOutstanding: number): boolean {
  return Number(totalOutstanding) !== 0;
}

export function formatKhataBalanceDisplay(
  outstanding: number,
  s: StringBundle,
  amberLimit = 0,
  redLimit = 0,
): { text: string; colorClass: string } {
  const colorClass = khataOutstandingColorClass(outstanding, amberLimit, redLimit);
  if (outstanding < 0) {
    return {
      text: s.khata_refundDueAmount.replace("{amount}", Math.abs(outstanding).toFixed(2)),
      colorClass,
    };
  }
  return {
    text: `₹${outstanding.toFixed(2)}`,
    colorClass,
  };
}

export function mapKhataRefundError(message: string, s: StringBundle): string {
  if (message.includes("no_customer_credit")) return s.khata_errNoCustomerCredit;
  if (message.includes("amount_exceeds_credit")) return s.khata_errAmountExceedsCredit;
  if (message.includes("invalid_amount")) return s.khata_errInvalidAmount;
  return message;
}

export function filterKhataLedgerByOutstanding<T extends { total_outstanding: number }>(
  entries: T[],
  showFullHistory: boolean,
): T[] {
  if (showFullHistory) return entries;
  return entries.filter((e) => isKhataLedgerUnsettled(e.total_outstanding));
}

export function filterKhataTransactionsForDisplay<
  T extends { payment_mode: string },
>(transactions: T[], showFullHistory: boolean): T[] {
  if (showFullHistory) return transactions;
  return transactions.filter((tx) => tx.payment_mode !== "paid");
}

/** Chronological ASC in; current-cycle rows newest-first out. */
export function currentCycleTransactions<
  T extends { amount: number; payment_mode: string },
>(chronologicalAsc: T[]): T[] {
  if (chronologicalAsc.length === 0) return [];

  let balance = 0;
  let lastSettlementIndex = -1;

  for (let i = 0; i < chronologicalAsc.length; i++) {
    const tx = chronologicalAsc[i];
    const amt = Number(tx.amount);
    if (!Number.isFinite(amt)) continue;

    if (tx.payment_mode === "paid") {
      balance -= amt;
      if (balance <= 0) {
        lastSettlementIndex = i;
      }
    } else {
      balance += amt;
    }
  }

  const cycle =
    lastSettlementIndex < 0 ? chronologicalAsc : chronologicalAsc.slice(lastSettlementIndex + 1);

  return [...cycle].reverse();
}

export function formatKhataDate(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Postgres `date` or ISO date string → `YYYY-MM-DD` for `<input type="date">`. */
export function ledgerCycleStartInputValue(value: string | null | undefined): string {
  if (!value?.trim()) return new Date().toISOString().slice(0, 10);
  return value.trim().slice(0, 10);
}

export function formatLedgerCycleStartLabel(dateStr: string): string {
  const normalized = ledgerCycleStartInputValue(dateStr);
  return new Date(`${normalized}T12:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Start of local calendar day for filtering `created_at >= cycle start`. */
export function ledgerCycleStartIso(dateStr: string | null | undefined): string {
  const normalized = ledgerCycleStartInputValue(dateStr);
  return new Date(`${normalized}T00:00:00`).toISOString();
}
