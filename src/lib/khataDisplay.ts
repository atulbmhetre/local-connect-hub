import { strings } from "@/lib/strings";

export function maskPhoneLast4(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `••••${digits.slice(-4)}`;
}

/** Mask phone for display: •••• + last 4 characters of the stored value. */
export function maskPhone(phone: string): string {
  if (phone.length >= 4) return `••••${phone.slice(-4)}`;
  return "••••";
}

export function normalizePhoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function isSamePhone(a: string, b: string): boolean {
  const da = normalizePhoneDigits(a);
  const db = normalizePhoneDigits(b);
  return da.length > 0 && da === db;
}

export function feedAuthorLabel(phone: string, viewerPhone: string | null): string {
  if (viewerPhone && isSamePhone(phone, viewerPhone)) return "You";
  return maskPhone(phone);
}

export function khataPaymentModeLabel(mode: string, s: typeof strings.en): string {
  if (mode === "cash") return s.bill_cash;
  if (mode === "upi") return s.bill_upi;
  if (mode === "khata") return "Unpaid";
  if (mode === "paid") return "Paid";
  return mode;
}

/** khata_ledger.total_outstanding — unsettled while > 0 */
export function isKhataLedgerUnsettled(totalOutstanding: number): boolean {
  return Number(totalOutstanding) > 0;
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
