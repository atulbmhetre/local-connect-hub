import { strings } from "@/lib/strings";

export function maskPhoneLast4(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `••••${digits.slice(-4)}`;
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
