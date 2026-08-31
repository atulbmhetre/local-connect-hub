import { parseInspectionFeeInput, formatVisitFeeAmount } from "./visitFee";

export function parseMinDeliveryOrderInput(raw: string): number | null {
  return parseInspectionFeeInput(raw);
}

export function formatMinDeliveryOrderAmount(
  value: number | null | undefined,
): number | null {
  return formatVisitFeeAmount(value);
}

export function deliveryCartSubtotal(
  selected: Record<string, number>,
  catalog: Array<{ id: string; price: number }>,
): number {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  let total = 0;
  for (const [id, qty] of Object.entries(selected)) {
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const price = Number(byId.get(id)?.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    total += qty * price;
  }
  return total;
}

export function meetsMinDeliveryOrder(
  subtotal: number,
  min: number | null | undefined,
): boolean {
  if (min == null || min <= 0) return true;
  return subtotal >= min;
}
