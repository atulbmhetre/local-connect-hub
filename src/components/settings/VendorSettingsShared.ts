export type MenuItem = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  unit: string | null;
  is_available: boolean;
  sort_order: number;
  category_id?: string | null;
  image_url?: string | null;
};

export type VendorActiveOffer = {
  id: string;
  content: string;
  expires_at: string | null;
};

export type OfferTargetAudience = "customers" | "vendors" | "both";

export function offerCategoryModeChipLabel(
  mode: string,
  s: {
    category_chip_mode_help: string;
    category_chip_mode_delivery: string;
    category_chip_mode_booking: string;
    category_chip_mode_appointment: string;
  },
): string {
  const m = String(mode ?? "").trim().toLowerCase();
  if (m === "help") return s.category_chip_mode_help;
  if (m === "delivery") return s.category_chip_mode_delivery;
  if (m === "booking") return s.category_chip_mode_booking;
  if (m === "appointment") return s.category_chip_mode_appointment;
  return mode;
}

export function offerDateInputMin() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function offerDateToStartIso(dateStr: string) {
  const [y, m, day] = dateStr.split("-").map(Number);
  const d = new Date(y, m - 1, day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function offerDateToEndIso(dateStr: string) {
  const [y, m, day] = dateStr.split("-").map(Number);
  const d = new Date(y, m - 1, day);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}
