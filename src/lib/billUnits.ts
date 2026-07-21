/**
 * Sensible default unit options for bill line items (BillSheet + BillEditSheet).
 * Values are what get stored in bill_items.unit; kg/g/L/ml read the same in
 * EN/HI/MR, the rest take localized labels. Historical bills with free-text
 * units (e.g. from AI voice/image parsing) are preserved by prepending the
 * current value as an extra option at render time.
 */
export function billUnitOptions(s: {
  bill_unitPiece: string;
  bill_unitDozen: string;
  bill_unitPacket: string;
  bill_unitMeter: string;
}): { value: string; label: string }[] {
  return [
    { value: "kg", label: "kg" },
    { value: "g", label: "g" },
    { value: "litre", label: "L" },
    { value: "ml", label: "ml" },
    { value: "pc", label: s.bill_unitPiece },
    { value: "dozen", label: s.bill_unitDozen },
    { value: "pkt", label: s.bill_unitPacket },
    { value: "m", label: s.bill_unitMeter },
  ];
}
