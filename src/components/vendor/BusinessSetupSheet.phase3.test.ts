import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("BusinessSetupSheet Phase 3 UPI / base_type", () => {
  const src = readFileSync(resolve(__dirname, "BusinessSetupSheet.tsx"), "utf8");

  it("places base_type then UPI then optional QR after category and before reach", () => {
    const categoryIdx = src.indexOf("vendor_categories_label");
    const baseIdx = src.indexOf("reg_where_work_from");
    const upiIdx = src.indexOf("vendor_upi_label");
    const qrIdx = src.indexOf("vendor_upi_qr_label");
    const reachIdx = src.indexOf("my_business_category_reach");
    const photoIdx = src.indexOf("add-business-shop-photo");
    expect(categoryIdx).toBeGreaterThan(-1);
    expect(baseIdx).toBeGreaterThan(categoryIdx);
    expect(upiIdx).toBeGreaterThan(baseIdx);
    expect(qrIdx).toBeGreaterThan(upiIdx);
    expect(reachIdx).toBeGreaterThan(qrIdx);
    expect(photoIdx).toBeGreaterThan(reachIdx);
  });

  it("requires base_type and valid UPI to submit, without a dedicated GPS capture field", () => {
    expect(src).toContain("baseType !== \"\"");
    expect(src).toContain("upiFmtOk &&");
    expect(src).toContain("p_upi_id: upi.trim()");
    expect(src).toContain("p_base_type: baseType");
    expect(src).toContain("vendor_find_colocated_category");
    expect(src).toContain("beginShopPhotoFlow");
    expect(src).not.toContain("detectLocation");
    expect(src).not.toContain("vendor_capture_location");
  });

  it("does not write UPI / base_type onto vendors from the add-business RPC call", () => {
    const rpcSlice = src.slice(
      src.indexOf('supabase.rpc("vendor_update_categories"'),
      src.indexOf("if (vcError)"),
    );
    expect(rpcSlice).toContain("p_upi_id");
    expect(rpcSlice).toContain("p_base_type");
    expect(rpcSlice).not.toContain("from(\"vendors\")");
  });
});
