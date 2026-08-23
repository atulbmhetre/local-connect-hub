import { writeFileSync } from "node:fs";

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

// ========== HOME ==========
ui(
  "HM-UI-01",
  "Home screen - check all UI elements",
  "1) Past welcome.\n2) Internet ON.\n3) Prefer customer session.",
  [
    { do: "Open Home.", expect: "Home content visible." },
    {
      do: "Check AI search box and placeholder.",
      expect: "Search input visible with placeholder text.",
    },
    {
      do: "On Android check mic button. On website confirm mic hidden.",
      expect: "Mic on App only. Hidden on Web.",
    },
    { do: "Check SOS button.", expect: "SOS visible and tappable." },
    {
      do: "Check category sections with icons and labels.",
      expect:
        "Category chips load in groups OR clear error banner if load failed.",
    },
    {
      do: "Check bottom nav Home Feed Orders Settings.",
      expect: "All four present and labeled.",
    },
    {
      do: "If vendor logged in check Vendor tab.",
      expect: "Vendor tab only when logged in as vendor.",
    },
    {
      do: "Check notification bell if present.",
      expect: "Bell icon visible in expected place.",
    },
    {
      do: "If first-visit welcome/explore card shows check it.",
      expect: "Card has explore/dismiss style actions.",
    },
    {
      do: "If saved neighbours section exists check it.",
      expect: "Tiles or empty state shown.",
    },
  ],
);

flow("HM-01", "Bottom navigation works", "1) Home open.", [
  {
    do: "Tap Feed then Orders then Settings then Home.",
    expect: "Each correct screen opens. No crash.",
  },
]);

flow(
  "HM-02",
  "Vendor tab visibility",
  "1) Customer-only session then vendor session.",
  [
    {
      do: "As customer-only check bottom menu.",
      expect: "No Vendor tab (register via Settings).",
    },
    {
      do: "Login as vendor. Check menu.",
      expect: "Vendor tab visible.",
    },
  ],
);

flow("HM-03", "Category chip opens Find vendors", "1) Categories loaded.", [
  {
    do: "Tap any category chip.",
    expect: "Find vendors opens for that category/mode.",
  },
]);

flow("HM-04", "AI search success", "1) Home. Internet ON.", [
  {
    do: "Type plumber and search.",
    expect: "Vendor list or category pick then list. No crash.",
  },
]);

flow("HM-05", "AI search wellness both choices", "1) Home.", [
  {
    do: "Search need a massage.",
    expect: "Both Therapist and Beautician offered.",
  },
  {
    do: "Pick one.",
    expect: "Vendor list for that category opens.",
  },
], "Both", "P2");

flow("HM-06", "AI search low confidence", "1) Home.", [
  {
    do: "Search vague nonsense text.",
    expect: "Suggestion sheet OR clear fallback. Not silent fail.",
  },
], "Both", "P2");

flow("HM-07", "Voice search app only", "1) Android app Home.", [
  {
    do: "Tap mic. Speak a need if permission allowed.",
    expect: "Voice starts search/classify. Website has no mic.",
  },
], "App", "P2");

flow("HM-08", "SOS button", "1) Home.", [
  {
    do: "Tap SOS.",
    expect: "SOS find-vendors view with emergency subtitle.",
  },
]);

flow(
  "HM-09",
  "Saved neighbour online and offline",
  "1) At least one saved vendor.",
  [
    {
      do: "View saved tile on Home.",
      expect: "Shows even if vendor offline.",
    },
    {
      do: "Tap offline saved vendor.",
      expect: "Toast/message only. No order form.",
    },
  ],
  "Both",
  "P2",
);

flow("HM-10", "Unsave vendor", "1) Saved vendor exists.", [
  {
    do: "Unsave / remove neighbour.",
    expect: "Removed from list. Possible confirmation banner.",
  },
], "Both", "P2");

flow("HM-11", "Desktop wide layout", "1) Chrome desktop wide window.", [
  {
    do: "Open Home.",
    expect: "Content centered in narrow column not full ultrawide stretch.",
  },
], "Web", "P2");

flow(
  "HM-12",
  "Categories load error handling",
  "1) Turn offline then open Home OR force API fail on TEST.",
  [
    {
      do: "Observe category area.",
      expect: "Clear error banner not silent empty grid.",
    },
  ],
  "Both",
  "P3",
);

// ========== FIND VENDORS / RADAR ==========
ui(
  "RD-UI-01",
  "Find vendors screen - check all UI elements",
  "1) Open from a category.\n2) Allow location when asked.",
  [
    { do: "Open Find vendors.", expect: "Screen loads." },
    { do: "Check back control.", expect: "Returns toward Home." },
    { do: "Check search input.", expect: "Search box visible." },
    {
      do: "Check Help vs Delivery / mode controls if shown.",
      expect: "Mode is clear.",
    },
    {
      do: "Check results area.",
      expect: "Cards OR empty state OR location-required message.",
    },
    {
      do: "On a vendor card check name distance online dot trust badge Order button.",
      expect: "Those elements present when vendors exist.",
    },
    {
      do: "Check save/favourite control on card if present.",
      expect: "Save control visible or consistently placed.",
    },
  ],
);

flow("RD-01", "Allow location loads vendors", "1) GPS available.", [
  {
    do: "Allow location on Find vendors.",
    expect: "Vendors load or honest empty state. Not infinite spinner only.",
  },
]);

flow("RD-02", "Deny location", "1) Deny location permission.", [
  {
    do: "Open Find vendors.",
    expect: "Location required/denied message. Cards not shown normally.",
  },
]);

flow("RD-03", "Help mode empty search", "1) Location on. Help mode.", [
  {
    do: "Clear search. Stay Help mode.",
    expect: "Help vendors only.",
  },
], "Both", "P2");

flow("RD-04", "Delivery mode filter", "1) Location on.", [
  {
    do: "Switch to Delivery mode.",
    expect: "Delivery/booking vendors shown.",
  },
]);

flow("RD-05", "Search kirana", "1) Location on.", [
  { do: "Search kirana.", expect: "Grocery-type resolve / vendors." },
], "Both", "P2");

flow("RD-06", "Search Hindi alias mikanik", "1) Location on.", [
  { do: "Search mikanik.", expect: "Mechanic vendors." },
], "Both", "P2");

flow("RD-07", "Search ambulance shows 108", "1) Location on.", [
  {
    do: "Search ambulance.",
    expect: "108 government panel plus matching vendors.",
  },
], "Both", "P2");

flow("RD-08", "Search pharmacy shows 104 hint", "1) Location on.", [
  {
    do: "Search pharmacy.",
    expect: "Vendors plus soft 104 helpline hint.",
  },
], "Both", "P2");

flow("RD-09", "Online vendor can order", "1) Online vendor on list.", [
  {
    do: "Confirm green online. Tap Order.",
    expect: "Order form opens.",
  },
]);

flow("RD-10", "Offline vendor cannot order", "1) Offline vendor on list.", [
  { do: "Try Order.", expect: "Blocked." },
]);

flow(
  "RD-11",
  "Trust badges unverified vs verified",
  "1) One unverified and one verified vendor if available.",
  [
    {
      do: "Compare badges on both cards.",
      expect:
        "Unverified shows verification-only. Verified shows Verified + level.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "RD-12",
  "Pending location review vendor",
  "1) Vendor pending location review on TEST.",
  [
    {
      do: "Search that vendor.",
      expect: "Hidden or degraded per product rules.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "RD-13",
  "Active order badge on card",
  "1) You have open order with a vendor on list.",
  [
    {
      do: "Find that vendor card.",
      expect: "Active order badge visible.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "RD-14",
  "Tight service radius hides vendor",
  "1) TEST: vendor 5km radius customer about 8km away.",
  [{ do: "Search that category.", expect: "Vendor hidden." }],
  "Both",
  "P2",
);

flow(
  "RD-15",
  "Wide service radius shows vendor",
  "1) Same customer. Vendor 50km radius.",
  [{ do: "Search.", expect: "Vendor visible." }],
  "Both",
  "P2",
);

flow("RD-16", "Save and unsave from card", "1) Vendor card available.", [
  {
    do: "Save vendor then unsave.",
    expect: "Saved state toggles. Home neighbours update.",
  },
], "Both", "P2");

// ========== ORDER FORMS ==========
ui(
  "PS-UI-01",
  "Help order form - check all UI elements",
  "1) Online Help vendor.\n2) Tap Order.",
  [
    { do: "Open Help order form.", expect: "Sheet/form opens." },
    { do: "Check close/cancel control.", expect: "Can dismiss form." },
    {
      do: "Check Come to me / Visit shop choices if shown.",
      expect: "Help-where options visible.",
    },
    { do: "Check message box.", expect: "Message input visible." },
    {
      do: "Check photo attach if shown.",
      expect: "Photo control allows gallery/camera as designed.",
    },
    {
      do: "Check payment options if shown.",
      expect: "UPI Cash Khata as vendor allows.",
    },
    { do: "Check Submit button.", expect: "Submit visible." },
    {
      do: "If low-trust vendor check confirmation checkbox area.",
      expect: "Extra confirm UI present for low trust.",
    },
  ],
);

ui(
  "PS-UI-02",
  "Delivery order form - check all UI elements",
  "1) Online Delivery vendor.\n2) Tap Order.",
  [
    { do: "Open Delivery order form.", expect: "Form opens." },
    {
      do: "Check address field / saved addresses.",
      expect: "Address entry or picker visible.",
    },
    {
      do: "Check delivery slot picker.",
      expect: "Slot choices visible.",
    },
    {
      do: "Check menu items panel if vendor has menu.",
      expect: "Menu items listed or panel hidden if none.",
    },
    { do: "Check message Submit payment photo.", expect: "Core controls present." },
  ],
);

ui(
  "PS-UI-03",
  "Booking order form - check all UI elements",
  "1) Online Appointment vendor.\n2) Tap Order.",
  [
    { do: "Open Booking order form.", expect: "Form opens." },
    {
      do: "Check appointment date/time controls.",
      expect: "Date/time or slot picker visible.",
    },
    {
      do: "Check come-to-me vs visit-shop if booking supports it.",
      expect: "Choices match product rules.",
    },
    { do: "Check message and Submit.", expect: "Both visible." },
  ],
);

flow(
  "PS-01",
  "Place Help order happy path",
  "1) TEST.\n2) Online Help vendor.\n3) Location allowed.",
  [
    {
      do: "Open Order. Choose come-to-me or visit-shop. Type message. Submit.",
      expect: "Order placed. Success feedback.",
    },
    {
      do: "Open My Orders.",
      expect: "New order with Sent (or similar) status.",
    },
  ],
);

flow(
  "PS-02",
  "Help low-trust confirmation",
  "1) Low-trust vendor on TEST.",
  [
    {
      do: "Try submit without confirmation checkbox.",
      expect: "Blocked.",
    },
    {
      do: "Tick confirm and submit.",
      expect: "Order placed.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "PS-03",
  "Close Help form without submit",
  "1) Order form open.",
  [
    {
      do: "Type message then close form without submit.",
      expect: "No new order in My Orders.",
    },
  ],
  "Both",
  "P3",
);

flow(
  "PS-04",
  "Place Delivery order with address and slot",
  "1) TEST delivery vendor online.\n2) Customer phone if addresses need it.",
  [
    {
      do: "Enter address. Pick future slot. Message. Submit.",
      expect: "Order in My Orders with slot shown.",
    },
  ],
);

flow(
  "PS-05",
  "Delivery past slot rejected",
  "1) Delivery form open.",
  [
    {
      do: "Pick an expired/past slot if UI allows. Submit.",
      expect: "Rejected with clear error.",
    },
  ],
);

flow(
  "PS-06",
  "Delivery menu items scoped",
  "1) Vendor with menu for that category.",
  [
    {
      do: "Open order form and view menu panel.",
      expect: "Only that business/category menu items shown.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "PS-07",
  "Place Booking order future time",
  "1) TEST appointment vendor online.",
  [
    {
      do: "Pick future appointment. Submit.",
      expect: "Booking order in My Orders pending.",
    },
  ],
);

flow(
  "PS-08",
  "Booking past time rejected",
  "1) Booking form open.",
  [
    {
      do: "Pick past date/time. Submit.",
      expect: "Rejected with error.",
    },
  ],
);

flow(
  "PS-09",
  "Payment block on old unpaid UPI",
  "1) Customer has unpaid UPI bill older than 48h (TEST seed).",
  [
    {
      do: "Open any vendor Order form and try submit.",
      expect: "Blocked with unpaid bill message and path to My Orders.",
    },
  ],
);

flow(
  "PS-10",
  "Attach photo on order form",
  "1) Order form open.",
  [
    {
      do: "Attach a photo from gallery.",
      expect: "Photo attached preview. Form still usable.",
    },
  ],
  "Both",
  "P2",
);

writeFileSync("docs/_mtm_rows_b.json", JSON.stringify(rows), "utf8");
console.log("partB", rows.length);
