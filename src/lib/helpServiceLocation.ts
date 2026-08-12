export type HelpReachUiChoice = "home" | "shop" | null;
export type HelpServiceLocation = "customer_place" | "vendor_place";

/** Map Parchi Help UI choice to structured requests.service_location. */
export function resolveHelpServiceLocation(
  helpLocation: HelpReachUiChoice,
  opts: { canServeAtCustomer: boolean; canServeAtVendor: boolean },
): HelpServiceLocation | null {
  if (helpLocation === "home") return "customer_place";
  if (helpLocation === "shop") return "vendor_place";
  if (opts.canServeAtCustomer && !opts.canServeAtVendor) return "customer_place";
  if (!opts.canServeAtCustomer && opts.canServeAtVendor) return "vendor_place";
  return null;
}
