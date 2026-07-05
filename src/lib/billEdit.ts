import { supabase } from "@/lib/supabase";
import { formatKhataDate } from "@/lib/khataDisplay";

export type BillEditLineItem = {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
};

export type BillEditAuditRow = {
  id: string;
  bill_id: string;
  edited_at: string;
  reason: string | null;
  old_total: number;
  new_total: number;
};

export type VendorEditBillResult = {
  audit_id: string;
  bill: {
    id: string;
    total_amount: number;
    payment_mode: string;
    payment_status: string;
    request_id: string;
  };
  items: Array<{
    description: string;
    quantity: number;
    unit: string | null;
    unit_price: number;
    total_price: number;
  }>;
};

const BILL_EDIT_ERROR_CODES = [
  "late_edit_confirmation_required",
  "reason_required",
  "would_create_customer_credit",
  "items_required",
  "bill_void",
  "bill_not_found",
  "unauthorised",
] as const;

export type BillEditErrorCode = (typeof BILL_EDIT_ERROR_CODES)[number];

export function parseBillEditErrorCode(message: string): BillEditErrorCode | null {
  for (const code of BILL_EDIT_ERROR_CODES) {
    if (message.includes(code)) return code;
  }
  return null;
}

export function newBillEditLineItem(): BillEditLineItem {
  return {
    id: crypto.randomUUID(),
    description: "",
    quantity: 1,
    unit: "",
    unit_price: 0,
  };
}

export async function fetchBillLineItems(requestId: string): Promise<BillEditLineItem[]> {
  const { data, error } = await supabase
    .from("order_items")
    .select("description, quantity, unit, unit_price")
    .eq("request_id", requestId)
    .order("created_at", { ascending: true });

  if (error || !data?.length) return [newBillEditLineItem()];

  return data.map((row) => ({
    id: crypto.randomUUID(),
    description: row.description ?? "",
    quantity: Number(row.quantity) || 1,
    unit: row.unit ?? "",
    unit_price: Number(row.unit_price) || 0,
  }));
}

export async function fetchEditedBillIds(billIds: string[]): Promise<Set<string>> {
  if (billIds.length === 0) return new Set();
  const { data } = await supabase
    .from("bill_edit_audit")
    .select("bill_id")
    .in("bill_id", billIds);
  return new Set((data ?? []).map((row) => row.bill_id));
}

export async function fetchBillEditAudit(billId: string): Promise<BillEditAuditRow[]> {
  const { data, error } = await supabase
    .from("bill_edit_audit")
    .select("id, bill_id, edited_at, reason, old_total, new_total")
    .eq("bill_id", billId)
    .order("edited_at", { ascending: false });

  if (error || !data) return [];
  return data as BillEditAuditRow[];
}

export function formatBillEditAuditDate(iso: string): string {
  return formatKhataDate(iso);
}

export function computeCustomerCreditAmount(
  currentOutstanding: number,
  oldTotal: number,
  newTotal: number,
): number {
  const delta = newTotal - oldTotal;
  return Math.abs(currentOutstanding + delta);
}

export function toRpcBillItems(
  items: BillEditLineItem[],
): Array<{ name: string; quantity: number; unit_price: number; unit: string | null }> {
  return items
    .filter((i) => i.description.trim() && i.unit_price > 0)
    .map((i) => ({
      name: i.description.trim(),
      quantity: i.quantity,
      unit_price: i.unit_price,
      unit: i.unit.trim() || null,
    }));
}
