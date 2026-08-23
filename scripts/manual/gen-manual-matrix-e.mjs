import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Run parts A-D by importing their side effects via spawning is messy;
// instead reload JSON parts after running scripts separately.
// This file only writes Admin+Legal+combine when JSON parts exist.

const rows = [];
const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
function add(id, name, pre, step, do_, expect, plat = "Both", pri = "P1") {
  rows.push(
    [id, name, pre, step, do_, expect, plat, pri, "", ""].map(esc).join(","),
  );
}
function ui(id, name, pre, items, plat = "Both") {
  items.forEach((it, i) =>
    add(id, name, pre, i + 1, it.do, it.expect, plat, "P1"),
  );
}
function flow(id, name, pre, steps, plat = "Both", pri = "P1") {
  steps.forEach((s, i) =>
    add(id, name, pre, i + 1, s.do, s.expect, plat, pri),
  );
}

// ========== ADMIN ==========
ui(
  "AD-UI-01",
  "Admin panel - check all UI elements",
  "1) Login as admin.\n2) Open Settings admin /admin area.",
  [
    { do: "Open admin area.", expect: "Admin tools visible." },
    {
      do: "Check vendor list / filters.",
      expect: "Vendor list with filters/search.",
    },
    {
      do: "Open one vendor verify sheet.",
      expect:
        "Checklist items for photo GPS UPI selfie style checks visible.",
    },
    {
      do: "Check pending categories section.",
      expect: "Pending list with approve/reject.",
    },
    {
      do: "Check ban/unban controls.",
      expect: "Ban requires reason field.",
    },
    {
      do: "Check App Health metrics.",
      expect: "Numeric metrics cards/rows.",
    },
    {
      do: "Check warn-user entry if present.",
      expect: "Warn action available.",
    },
  ],
);

flow(
  "AD-01",
  "Non-admin cannot access admin",
  "1) Normal customer/vendor account.",
  [
    {
      do: "Try open admin settings URL/area.",
      expect: "Hidden in UI and blocked by server if forced.",
    },
  ],
);

flow(
  "AD-02",
  "Admin verify vendor all checks",
  "1) Admin.\n2) Vendor ready for verify.",
  [
    {
      do: "Pass checklist and verify.",
      expect: "Top-tier / verified badge applied.",
    },
  ],
);

flow(
  "AD-03",
  "Admin unverify vendor",
  "1) Verified vendor.",
  [
    {
      do: "Unverify / remove verification.",
      expect: "Verification reset. Action logged.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "AD-04",
  "Approve pending category",
  "1) Pending category exists.",
  [
    {
      do: "Approve.",
      expect: "Category active. Vendor notified if linked.",
    },
  ],
);

flow(
  "AD-05",
  "Reject pending category",
  "1) Another pending category.",
  [
    {
      do: "Reject.",
      expect: "Stays inactive. Vendor notified.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "AD-06",
  "Ban vendor requires reason then unban",
  "1) Disposable vendor on TEST.",
  [
    {
      do: "Try ban without reason.",
      expect: "Blocked.",
    },
    {
      do: "Ban with reason.",
      expect: "Banned badge. Cannot go online. Audit recorded.",
    },
    {
      do: "Unban.",
      expect: "Restored. Vendor notified.",
    },
  ],
);

flow(
  "AD-07",
  "App Health metrics look valid",
  "1) Admin App Health.",
  [
    {
      do: "Read metrics including stuck orders.",
      expect: "Numbers look valid not blank/NaN.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "AD-08",
  "Warn user language aware",
  "1) Hindi user and English user on TEST.",
  [
    {
      do: "Admin warns both.",
      expect: "Each gets notification in their language (default English if unset).",
    },
  ],
  "Both",
  "P2",
);

flow(
  "AD-09",
  "Dev phone / admin gate",
  "1) Non-admin.\n2) Try secret admin unlock gestures if product has 7-tap.",
  [
    {
      do: "Attempt unlock as non-admin.",
      expect: "No admin phone override / PIN path for non-admin.",
    },
  ],
  "Both",
  "P2",
);

// ========== ACCOUNT DELETION ==========
ui(
  "DL-UI-01",
  "Delete account UI - check elements",
  "1) Settings scrolled to danger zone.",
  [
    {
      do: "Find Delete account.",
      expect: "At bottom not in casual main flow.",
    },
    {
      do: "Open confirmation.",
      expect: "Warning copy explains consequences.",
    },
    {
      do: "For vendor check scheduled deletion messaging.",
      expect: "30-day schedule explained not instant wipe.",
    },
  ],
);

flow(
  "DL-01",
  "Customer delete full path",
  "1) TEST disposable customer.",
  [
    {
      do: "Confirm delete.",
      expect: "Fresh install state. Phone anonymised. Devices cleared.",
    },
  ],
);

flow(
  "DL-02",
  "Vendor schedule delete cancel and grace rules",
  "1) TEST disposable vendor.",
  [
    {
      do: "Start delete.",
      expect: "Scheduled 30-day UI.",
    },
    {
      do: "Try Go online during grace.",
      expect: "Blocked.",
    },
    {
      do: "Cancel deletion.",
      expect: "Normal account restored. Can go online.",
    },
  ],
);

flow(
  "DL-03",
  "Dual role deletion",
  "1) Account that is customer + vendor on TEST.",
  [
    {
      do: "Delete account.",
      expect: "Both customer and vendor rules applied as designed.",
    },
  ],
  "Both",
  "P2",
);

// ========== CATEGORIES ==========
ui(
  "CAT-UI-01",
  "Categories visibility UI checks",
  "1) Home and Find vendors.\n2) Switch languages.",
  [
    {
      do: "On Home list visible categories.",
      expect: "Only active categories shown.",
    },
    {
      do: "Switch language EN HI MR.",
      expect: "Category labels translate.",
    },
  ],
);

flow(
  "CAT-01",
  "Inactive category hidden",
  "1) Known inactive category on TEST.",
  [
    {
      do: "Search Home chips and Find vendors for it.",
      expect: "Not offered as active.",
    },
  ],
);

flow(
  "CAT-02",
  "Vendor suggested category waits admin",
  "1) Just suggested new category in registration.",
  [
    {
      do: "Check it is not fully live until admin approves.",
      expect: "Pending until AD-04.",
    },
  ],
  "Both",
  "P2",
);

// ========== LANDING LEGAL WEB ==========
ui(
  "LG-UI-01",
  "Landing and legal pages - check all UI elements",
  "1) Website browser.",
  [
    {
      do: "Open /landing.",
      expect: "Landing loads with download / vendor CTA content.",
    },
    {
      do: "Open /privacy-policy.html.",
      expect: "Title Privacy Policy. Full readable policy text.",
    },
    {
      do: "Open /terms-of-service.html.",
      expect: "Title Terms of Service. Full readable terms text.",
    },
    {
      do: "From app Settings open Privacy.",
      expect: "In-app privacy bridge/link works.",
    },
  ],
  "Web",
);

flow(
  "LG-01",
  "Production website no Capacitor crash",
  "1) Production site or build:prod preview.\n2) Desktop Chrome.",
  [
    {
      do: "Open Home Find vendors Order form Settings Vendor find-account Feed.",
      expect:
        "All load. No white crash. Native-only mic/tour hidden on web.",
    },
  ],
  "Web",
  "P1",
);

flow(
  "LG-02",
  "Firebase messaging service worker present",
  "1) Website root.",
  [
    {
      do: "Open /firebase-messaging-sw.js.",
      expect: "File loads (not 404).",
    },
  ],
  "Web",
  "P2",
);

// ========== MAPS EXTRA ==========
ui(
  "MP-UI-01",
  "Open in Maps button visibility rules UI",
  "1) Several order types prepared on TEST.",
  [
    {
      do: "Delivery with coords - vendor side.",
      expect: "Maps button visible.",
    },
    {
      do: "Delivery address only - vendor side.",
      expect: "Maps button visible (address search).",
    },
    {
      do: "Delivery no coords no address.",
      expect: "Maps button hidden.",
    },
    {
      do: "Help with coords - helper/vendor side.",
      expect: "Maps button visible.",
    },
    {
      do: "Help without coords.",
      expect: "Maps button hidden.",
    },
    {
      do: "Booking customer visits shop - vendor side.",
      expect: "Maps button hidden for vendor.",
    },
    {
      do: "Booking customer visits shop - customer side.",
      expect: "Customer may see Maps to vendor location when coords exist.",
    },
  ],
  "App",
);

// ========== NETWORK / EDGE ==========
ui(
  "NW-UI-01",
  "Network error UI elements",
  "1) Ability to toggle airplane mode.",
  [
    {
      do: "Turn offline. Trigger a load (orders/categories).",
      expect: "Retry / network banner or toast appears.",
    },
    {
      do: "If fatal error screen ever shows check Reload button.",
      expect: "Reload label in current language.",
    },
  ],
);

flow("NW-01", "Offline then recover", "1) Online then airplane mode.", [
  {
    do: "Perform action offline then go online and retry.",
    expect: "Retry works. No permanent freeze.",
  },
], "Both", "P2");

flow(
  "NW-02",
  "Order expiry notifies once",
  "1) TEST order that expires / near deadline tooling.",
  [
    {
      do: "Observe expiry notification.",
      expect: "Customer notified once per rules.",
    },
  ],
  "Both",
  "P3",
);

flow(
  "NW-03",
  "OTP currently off identity path",
  "1) Any phone save/restore flow.",
  [
    {
      do: "Complete phone identity without SMS OTP.",
      expect: "Works via saved phone on device (OTP not required now).",
    },
  ],
  "Both",
  "P2",
);

flow(
  "NW-04",
  "AI search overload handled",
  "1) Rapid many searches if rate limit can trigger on TEST.",
  [
    {
      do: "Burst search many times.",
      expect: "Graceful limit message not crash.",
    },
  ],
  "Both",
  "P3",
);

writeFileSync("docs/_mtm_rows_e.json", JSON.stringify(rows), "utf8");
console.log("partE", rows.length);
