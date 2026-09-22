export type VendorAmountDue = {
  amount_paise: number;
  base_paise: number;
  waiveoff_percent: number;
  months_remaining: number;
  is_free: boolean;
};

export function isWaiveoffActive(due: VendorAmountDue | null | undefined): boolean {
  return !!due && due.months_remaining > 0 && due.waiveoff_percent > 0;
}

export function formatRupeesFromPaise(paise: number): string {
  const rupees = Math.round(paise) / 100;
  if (!Number.isFinite(rupees)) return "0";
  return Number.isInteger(rupees) ? String(rupees) : rupees.toFixed(2);
}

export function fillAmountTemplate(
  template: string,
  vars: { amount: string; percent: string; months: string },
): string {
  return template
    .replace("{amount}", vars.amount)
    .replace("{percent}", vars.percent)
    .replace("{months}", vars.months);
}

export function parseVendorAmountDue(raw: unknown): VendorAmountDue | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const amount = Number(row.amount_paise);
  const base = Number(row.base_paise);
  const percent = Number(row.waiveoff_percent);
  const months = Number(row.months_remaining);
  if (![amount, base, percent, months].every(Number.isFinite)) return null;
  return {
    amount_paise: amount,
    base_paise: base,
    waiveoff_percent: percent,
    months_remaining: months,
    is_free: row.is_free === true || amount === 0,
  };
}
