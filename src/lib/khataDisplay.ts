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

export function formatKhataDate(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
