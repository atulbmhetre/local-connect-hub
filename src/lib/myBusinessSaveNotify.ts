/**
 * Save-form fields that invalidate verification / force re-check.
 * Operational edits (brand, reach, modes, etc.) must not page admin.
 */
export function myBusinessSaveVerificationNotifyReasons(args: {
  phoneChanged: boolean;
  upiChanged: boolean;
}): string[] {
  const reasons: string[] = [];
  if (args.phoneChanged) reasons.push("phone");
  if (args.upiChanged) reasons.push("upi_id");
  return reasons;
}
