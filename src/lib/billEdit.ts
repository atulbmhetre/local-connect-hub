import { supabase } from "@/lib/supabase";
import { captureError } from "@/lib/sentry";
import { formatKhataDate } from "@/lib/khataDisplay";
import { safeRandomUUID } from "@/lib/safeRandomUUID";

export type BillEditLineItem = {
  id: string;
  description: string;
  /** Draft text while editing; clamped to ≥1 on blur / submit. */
  quantity: string;
  unit: string;
  /** Draft text while editing; parsed on blur / submit. */
  unit_price: string;
  /** Present when line was added from vendor menu catalog (UI only). */
  menu_item_id?: string | null;
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
    id: safeRandomUUID(),
    description: "",
    quantity: "1",
    unit: "",
    unit_price: "",
  };
}

export function parseBillQuantity(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

export function parseBillUnitPrice(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export async function fetchBillLineItems(
  requestId: string,
  vendorId: string,
  vendorPhone: string,
): Promise<BillEditLineItem[]> {
  const phone = vendorPhone.trim();
  if (!phone) return [newBillEditLineItem()];

  const { data, error } = await supabase.rpc("get_vendor_bill_line_items", {
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_request_id: requestId,
  });

  if (error) {
    captureError(error, { scope: "billEdit.fetchBillLineItems", requestId, vendorId });
    return [newBillEditLineItem()];
  }
  if (!data?.length) return [newBillEditLineItem()];

  return data.map((row: {
    description: string | null;
    quantity: number | null;
    unit: string | null;
    unit_price: number | null;
  }) => ({
    id: safeRandomUUID(),
    description: row.description ?? "",
    quantity: String(Number(row.quantity) || 1),
    unit: row.unit ?? "",
    unit_price: (() => {
      const price = Number(row.unit_price) || 0;
      return price > 0 ? String(price) : "";
    })(),
  }));
}

export async function fetchEditedBillIds(
  billIds: string[],
  vendorId: string,
  vendorPhone: string,
): Promise<Set<string>> {
  if (billIds.length === 0) return new Set();
  const phone = vendorPhone.trim();
  if (!phone) return new Set();

  const { data, error } = await supabase.rpc("get_vendor_edited_bill_ids", {
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_bill_ids: billIds,
  });
  if (error) {
    captureError(error, { scope: "billEdit.fetchEditedBillIds", vendorId });
  }
  return new Set((data ?? []).map((row: { bill_id: string }) => row.bill_id));
}

export async function fetchBillEditAudit(
  billId: string,
  vendorId: string,
  vendorPhone: string,
): Promise<BillEditAuditRow[]> {
  const phone = vendorPhone.trim();
  if (!phone) return [];

  const { data, error } = await supabase.rpc("get_vendor_bill_edit_audit", {
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_bill_id: billId,
  });

  if (error) {
    captureError(error, { scope: "billEdit.fetchBillEditAudit", vendorId, billId });
    return [];
  }
  return (data ?? []) as BillEditAuditRow[];
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
    .filter((i) => i.description.trim() && parseBillUnitPrice(i.unit_price) > 0)
    .map((i) => ({
      name: i.description.trim(),
      quantity: parseBillQuantity(i.quantity),
      unit_price: parseBillUnitPrice(i.unit_price),
      unit: i.unit.trim() || null,
    }));
}
