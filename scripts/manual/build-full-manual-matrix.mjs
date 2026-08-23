/**
 * Builds docs/manual-test-matrix.csv from exact English UI copy (strings.ts).
 * Run: node scripts/manual/build-full-manual-matrix.mjs
 */
import { writeFileSync } from "node:fs";

const H = [
  "Test_ID",
  "Test_Case_Name",
  "Prerequisites",
  "Step_No",
  "What_You_Do",
  "What_Should_Happen",
  "Platform",
  "Priority",
  "Pass_Fail",
  "Notes",
];

const rows = [];
const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;

function add(id, name, pre, step, act, exp, plat = "Both", pri = "P1") {
  rows.push([id, name, pre, String(step), act, exp, plat, pri, "", ""]);
}

function caseSteps(id, name, pre, steps, plat = "Both", pri = "P1") {
  steps.forEach((s, i) => add(id, name, pre, i + 1, s[0], s[1], plat, pri));
}

const EN = "Language = English.";
const FRESH = `${EN} Fresh install OR clear app data OR Chrome Incognito. Internet ON.`;
const TEST = "Prefer TEST environment so live customers are not affected.";
const CUST = `${EN} Past first-open (Home visible). Internet ON.`;
const VEND = `${EN} Logged in as vendor. ${TEST}`;

// ===================== FIRST OPEN =====================
caseSteps(
  "FO-UI-01",
  "UI: first screen exact buttons",
  FRESH,
  [
    ["Open app/website first time.", "Full-screen first-open overlay covers Home."],
    [
      "Do not tap. Read buttons.",
      "Exactly 2 buttons: I'm new here | I've used Aaspaas before. No third button.",
    ],
  ],
);

caseSteps(
  "FO-UI-02",
  "UI: I'm new here second screen exact text",
  FRESH,
  [
    ["Tap: I'm new here", "Title: How do you want to start?"],
    [
      "Do not tap main actions yet. List controls.",
      "Controls: Register your business | Use Aaspaas as a customer | Back",
    ],
  ],
);

caseSteps(
  "FO-UI-03",
  "UI: I've used Aaspaas before restore screen exact text",
  FRESH,
  [
    ["Tap: I've used Aaspaas before", "Restore screen opens (second screen)."],
    [
      "Check all elements.",
      "Title: Restore your account. Subtitle: Enter your mobile number. +91 + placeholder 98765 43210. Button: Restore my account. Link: Back",
    ],
  ],
);

caseSteps("FO-01", "Happy: new customer to Home", `${FRESH} Prefer Web, or finish Not now on Android.`, [
  ["Tap: I'm new here", "Title: How do you want to start?"],
  [
    "Tap: Use Aaspaas as a customer",
    "Web: Home opens. Android: may show Stay updated on your orders then Home.",
  ],
  ["If Android notification screen: tap Not now", "Home opens."],
  ["Force-close and reopen (data kept).", "First-open does NOT show again."],
]);

caseSteps("FO-02", "Happy: new vendor registration entry", FRESH, [
  ["Tap: I'm new here then Register your business", "Vendor registration opens (Step 1 of 2 / Your account)."],
]);

caseSteps(
  "FO-03",
  "Negative: restore invalid phones then valid customer",
  `${FRESH} Known EXISTING non-banned customer phone from tester.`,
  [
    ["Tap: I've used Aaspaas before. Enter 12345. Tap: Restore my account", "Error. Not restored."],
    ["Enter 0123456789. Tap: Restore my account", "Error (must be 10-digit starting 6-9)."],
    [
      "Enter known customer phone. Tap: Restore my account",
      "Restored. Home (Android may show Stay updated on your orders first).",
    ],
  ],
);

caseSteps(
  "FO-04",
  "Edge: restore phone not found",
  `${FRESH} Unused valid phone starting 6-9.`,
  [
    [
      "I've used Aaspaas before → enter unused phone → Restore my account",
      "Exact: No account found. Starting fresh. Button: Continue",
    ],
    ["Tap: Continue", "Continues toward Home."],
  ],
);

caseSteps(
  "FO-05",
  "Happy: restore active online-capable vendor",
  `${FRESH} ACTIVE vendor phone.`,
  [
    ["Restore with vendor phone.", "Vendor tab appears in bottom nav."],
    ["Tap Vendor", "Vendor screen loads."],
  ],
);

caseSteps(
  "FO-06",
  "Edge: restore offline vendor (is_active false)",
  `${FRESH} Offline vendor phone.`,
  [["Restore with that phone.", "Vendor session restored; Vendor tab works."]],
  "Both",
  "P2",
);

caseSteps(
  "FO-07",
  "Edge: restore hidden vendor (discoverable false)",
  `${FRESH} Hidden vendor phone.`,
  [["Restore.", "Vendor session restored even if not in public search."]],
  "Both",
  "P2",
);

caseSteps(
  "FO-08",
  "Negative: restore banned/deleted vendor",
  `${FRESH} Banned or deleted vendor phone.`,
  [
    [
      "Restore.",
      "Customer may restore; vendor login NOT restored for banned/deleted.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "FO-09",
  "Negative: restore banned customer",
  `${FRESH} Banned customer phone.`,
  [["Restore.", "Blocked. Phone not kept as logged-in customer."]],
  "Both",
  "P2",
);

caseSteps(
  "FO-10",
  "Edge: restore dual-role phone",
  `${FRESH} Phone is customer AND vendor.`,
  [["Restore.", "Both roles restored. Vendor tab appears."]],
  "Both",
  "P2",
);

caseSteps("FO-11", "UI nav: Back from restore", FRESH, [
  ["I've used Aaspaas before → Back", "First screen again: I'm new here | I've used Aaspaas before."],
], "Both", "P2");

caseSteps("FO-12", "UI nav: Back from How do you want to start", FRESH, [
  ["I'm new here → Back", "First screen: I'm new here | I've used Aaspaas before."],
], "Both", "P2");

caseSteps(
  "FO-13",
  "UI: Android notification screen exact text",
  `${FRESH} Android app. Path I'm new here → Use Aaspaas as a customer.`,
  [
    [
      "Reach notification screen.",
      "Title: Stay updated on your orders. Body about never miss vendor response. Buttons: Allow notifications | Not now",
    ],
    ["Tap: Not now", "Home opens."],
  ],
  "App",
  "P2",
);

caseSteps(
  "FO-14",
  "Edge: website skips native notification screen",
  `${FRESH} Chrome website.`,
  [
    [
      "I'm new here → Use Aaspaas as a customer",
      "Home opens. Stay updated on your orders / Allow notifications does NOT appear.",
    ],
  ],
  "Web",
  "P2",
);

caseSteps(
  "FO-15",
  "Negative: restore with empty phone",
  FRESH,
  [
    [
      "I've used Aaspaas before → leave phone empty → Restore my account",
      "Error / cannot restore. Stays on Restore your account.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "FO-16",
  "Edge: restore timeout message",
  `${FRESH} Simulate very slow network if possible.`,
  [
    [
      "Restore with valid phone while network extremely slow.",
      "May show: Connection is too slow. Please try again. OR Something went wrong. Please try again.",
    ],
  ],
  "Both",
  "P3",
);

// ===================== VENDOR REG =====================
const VR =
  `${EN} Open vendor sign-up: Settings → Register your business on AasPaas OR first-open Register your business. Not already a vendor. ${TEST}`;

caseSteps("VR-UI-01", "UI: registration Step 1 Your account exact labels", VR, [
  ["Open Step 1.", "Shows Step 1 of 2 and Your account."],
  [
    "List fields/labels without filling.",
    "Your Name | Phone (required) placeholder +91 98xxxxxxxx | UPI ID placeholder name@okbank | UPI QR Code (optional) / Upload your bank-provided UPI QR code | Where do you work from? options Shop / Home / No fixed place | Selfie | Next | and link Already registered? Find my account | or separator",
  ],
  [
    "Tap Shop under Where do you work from?",
    "Shows 📍 Capture Shop Location (and location help). Home/No fixed place change GPS UI accordingly.",
  ],
]);

caseSteps(
  "VR-UI-02",
  "UI: registration Step 2 Your business exact labels",
  `${VR} Complete Step 1 enough to reach Step 2.`,
  [
    ["Reach Step 2.", "Step 2 of 2 and Your business. Hint: Next: set up your first business."],
    [
      "List key controls.",
      "Category describe / Find | Browse manual | Shop Name or brand | Where can customers reach you? At their place / At my place / Both | radius if needed | availability | cancel reasons | Note for customers (optional) | Shop photo for this business | Register me (or final submit) | Back",
    ],
  ],
);

caseSteps("VR-01", "Negative: UPI format", VR, [
  ["Enter abc in UPI ID, leave field.", "Error about invalid UPI (must look like handle@bank)."],
  ["Enter test@okhdfcbank, leave field.", "UPI error clears."],
]);

caseSteps(
  "VR-02",
  "Negative: duplicate phone",
  `${VR} Phone already registered as vendor.`,
  [
    [
      "Fill Step 1 with duplicate phone and continue/register.",
      "Duplicate handling. Already registered? Find my account highlighted or usable.",
    ],
  ],
);

caseSteps("VR-03", "Negative: Shop without location cannot Next", VR, [
  [
    "Choose Shop. Fill name/phone/UPI/selfie. Do NOT capture location. Tap Next.",
    "Cannot proceed until location captured.",
  ],
  [
    "Tap: 📍 Capture Shop Location. Allow GPS.",
    "Shows Location set (with coordinates).",
  ],
]);

caseSteps("VR-04", "Permutation: work from Home", VR, [
  [
    "Choose Home.",
    "Shows Home copy: I work from home — location stays private. Capture location required.",
  ],
], "Both", "P2");

caseSteps("VR-05", "Permutation: No fixed place", VR, [
  [
    "Choose No fixed place.",
    "No shop capture button required the same way. Copy about move around / GPS for distance.",
  ],
], "Both", "P2");

caseSteps("VR-06", "Negative: Next without selfie (App)", VR, [
  ["On Android fill other Step 1 fields without selfie. Tap Next.", "Blocked until selfie."],
  ["Capture selfie.", "Preview shows; Next can enable."],
], "App", "P1");

caseSteps("VR-07", "Optional: UPI QR upload", VR, [
  [
    "Tap UPI QR upload; pick valid QR image.",
    "UPI fills OR clear failure (QR upload failed / invalid).",
  ],
], "Both", "P2");

caseSteps("VR-08", "Happy: AI find category", `${VR} On Step 2.`, [
  [
    "Type I repair mobile phones. Tap Find category.",
    "Suggestion appears (We think you mean / Confirm style).",
  ],
  ["Confirm category.", "Category selected."],
]);

caseSteps("VR-09", "Edge: manual browse + max categories", `${VR} Step 2.`, [
  ["Browse manual; select one category.", "Selected."],
  ["Try exceed max categories.", "Further selection blocked at max."],
], "Both", "P2");

caseSteps("VR-10", "Edge: suggest new category pending admin", `${VR} Step 2.`, [
  [
    "Describe unusual business until new category suggested; confirm; finish register if possible.",
    "Pending admin approval path (not fully live until admin approves).",
  ],
], "Both", "P2");

caseSteps("VR-11", "Negative: empty Shop Name", `${VR} Shop base, Step 2.`, [
  ["Leave Shop Name empty; try Register me.", "Validation blocks."],
]);

caseSteps("VR-12", "Permutation: reach At their place needs radius", `${VR} Step 2 + category.`, [
  [
    "Choose At their place under Where can customers reach you?",
    "Service radius chips appear and are required.",
  ],
  ["Choose At my place.", "Radius may hide."],
  ["Choose Both.", "Radius required for travel part."],
]);

caseSteps(
  "VR-13",
  "Permutation: availability Help vs Delivery vs Appointment",
  `${VR} Step 2.`,
  [
    ["Pick help-style category; set Help availability.", "Saved for that category."],
    ["On another run: delivery category + Delivery.", "Delivery mode set."],
    ["On another run: booking category + Appointment/Booking.", "Booking mode set."],
  ],
);

caseSteps("VR-14", "Edge: cancel reason 60 and note 100 limits", `${VR} Step 2.`, [
  ["Type >60 chars in a cancel reason.", "Capped at 60."],
  ["Type >100 chars in Note for customers (optional).", "Capped at 100."],
], "Both", "P2");

caseSteps(
  "VR-15",
  "Happy: shop photo GPS match",
  `${VR} ${TEST} Location already set at place A.`,
  [["Capture shop photo at same place.", "Photo accepted. Shop photo for this business complete."]],
);

caseSteps(
  "VR-16",
  "Negative+edge: GPS mismatch then Submit for review",
  `${VR} ${TEST} Photo far from location.`,
  [
    ["Fail GPS match twice.", "After 2 fails Submit for review appears."],
    [
      "Tap Submit for review and finish register.",
      "Registers with pending location review note.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "VR-17",
  "Happy path: Shop + Help vendor full register",
  `${VR} Unused phone. At shop. Valid UPI.`,
  [
    ["Complete Step 1 Shop+location+selfie → Next", "Step 2 Your business."],
    [
      "Category + Shop Name + reach + availability + photo → Register me",
      "Success. Vendor screen / Ready to Help area. May show You're registered! Now go live...",
    ],
  ],
);

caseSteps("VR-18", "Permutation: Delivery vendor register", `${VR} Unused phone.`, [
  ["Register with Delivery availability category.", "Vendor can later take delivery orders."],
]);

caseSteps("VR-19", "Permutation: Appointment/Booking vendor register", `${VR} Unused phone.`, [
  ["Register with booking/appointment availability.", "Vendor can later take bookings."],
]);

caseSteps(
  "VR-20",
  "Multi-business: register first then add second business",
  `${VEND} Single business already. Open Settings → My Business.`,
  [
    ["Add second business/category with its own shop photo.", "Second business section appears separately."],
    [
      "Confirm each business has own photo/note/menu as applicable.",
      "Per-business data does not overwrite the other.",
    ],
  ],
);

caseSteps(
  "VR-21",
  "Edge: referral prefilled; cannot use own code",
  `${FRESH} Open /r/OTHERCODE then start Register your business. Referrals enabled.`,
  [
    ["Check Referral Code (optional).", "Prefilled uppercase."],
    ["On separate test try own code.", "Own code rejected / Referral code not found path."],
  ],
  "Both",
  "P2",
);

caseSteps("VR-22", "Negative: invalid phone on Step 1", VR, [
  [
    "Enter 123 in Phone (required). Try Next.",
    "Shows Enter a valid 10-digit Indian mobile number. / Invalid phone number",
  ],
]);

// ===================== VENDOR LOGIN =====================
const VL = `${EN} Vendor page without login. Tap Already registered? Find my account. ${TEST}`;

caseSteps("VL-UI-01", "UI: Find your vendor account exact text", VL, [
  [
    "Open find-account form.",
    "Title: Find your vendor account. Hint: Enter the phone number you registered with. Label Phone. Button: Find My Account. Link: ← Back to registration",
  ],
]);

caseSteps("VL-01", "Happy: find registered vendor", `${VL} Known vendor phone.`, [
  ["Enter phone. Tap: Find My Account", "Vendor screen loads."],
]);

caseSteps("VL-02", "Negative: unknown phone", VL, [
  [
    "Enter 9876500000. Find My Account",
    "Exact: No vendor found with this number. Please register first.",
  ],
]);

caseSteps("VL-03", "Negative: invalid format", VL, [
  ["Enter 123. Find My Account", "Enter a valid 10-digit Indian mobile number."],
], "Both", "P2");

caseSteps("VL-04", "Negative: banned vendor", `${VL} Banned vendor phone.`, [
  ["Find My Account", "Denied with reason; not fully logged in as live vendor."],
], "Both", "P2");

caseSteps(
  "VL-05",
  "Edge: hidden vendor find-account recovery",
  `${VL} Hidden vendor; device without stored phone.`,
  [["Find My Account with that phone.", "Session restores; no logout loop."]],
  "Both",
  "P2",
);

caseSteps("VL-06", "UI: Back to registration", VL, [
  ["Tap: ← Back to registration", "Returns to registration Step 1 form."],
], "Both", "P3");

// ===================== HOME =====================
caseSteps("HM-UI-01", "UI: Home exact chrome", CUST, [
  ["Open Home.", "Home visible."],
  [
    "Check search.",
    "Label/chip AI Search. Placeholder: Search for help (e.g., Mechanic, Ambulance, Key Maker)",
  ],
  [
    "Check SOS.",
    "SOS control; aria/label Emergency SOS. May show SOS / TAP FOR HELP styling.",
  ],
  [
    "Check bottom nav labels.",
    "Home | Local Feed | Orders | Settings. If vendor logged in also Vendor (may show ME·Online / ME·Offline).",
  ],
  ["Check categories.", "Category chips OR Couldn't load service categories. Please try again."],
  [
    "App vs Web mic.",
    "App may show Voice search. Web: mic hidden.",
  ],
]);

caseSteps("HM-01", "Happy: bottom nav", CUST, [
  [
    "Tap Local Feed → Orders → Settings → Home",
    "Each correct screen; labels match nav_*.",
  ],
]);

caseSteps("HM-02", "Permutation: Vendor tab only when vendor", CUST, [
  ["Customer-only: check nav.", "No Vendor tab (use Register your business on AasPaas in Settings)."],
  ["After vendor login: check nav.", "Vendor tab visible."],
]);

caseSteps("HM-03", "Happy: category opens Find vendors", CUST, [
  ["Tap a category chip.", "Find vendors / Live Radar style screen for that category."],
]);

caseSteps("HM-04", "Happy: AI search plumber", CUST, [
  [
    "Type plumber; submit.",
    "May show Finding best match... then vendors OR Did you mean one of these?",
  ],
]);

caseSteps("HM-05", "Edge: need a massage both candidates", CUST, [
  [
    "Search need a massage.",
    "Did you mean one of these? includes Therapist and Beautician (both).",
  ],
  ["Pick one.", "Vendor list for that category."],
], "Both", "P2");

caseSteps("HM-06", "Negative/edge: no match suggest sheet", CUST, [
  [
    "Search nonsense text.",
    "Did you mean one of these? and/or None of these / Describe what you need… / Search again — not silent fail.",
  ],
], "Both", "P2");

caseSteps("HM-07", "App: voice search", `${CUST} Android.`, [
  ["Tap Voice search mic; allow mic; speak.", "Search starts or Voice is not available on this device."],
], "App", "P2");

caseSteps("HM-08", "Happy: SOS", CUST, [
  [
    "Tap SOS.",
    "Emergency help nearby / Need delivery or a booking? Search by category above. (radar SOS copy)",
  ],
]);

caseSteps(
  "HM-09",
  "Permutation: saved neighbour online vs offline",
  `${CUST} At least one saved vendor.`,
  [
    ["View saved neighbour on Home.", "Tile visible even if offline."],
    [
      "If offline: tap tile.",
      "Toast/message; no full order when offline rules block.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps("HM-10", "Happy: unsave neighbour", `${CUST} Saved vendor.`, [
  ["Unsave/remove.", "Removed; may show Updates to your neighbourhood / Got it."],
], "Both", "P2");

caseSteps("HM-11", "Edge: desktop column", `${CUST} Wide Chrome.`, [
  ["Open Home.", "Content centered max-width column, not full ultrawide."],
], "Web", "P2");

caseSteps("HM-12", "Negative: categories offline", `${CUST} Airplane mode.`, [
  [
    "Reload Home.",
    "Couldn't load service categories. Please try again. (or similar)",
  ],
], "Both", "P3");

// ===================== FIND VENDORS / RADAR =====================
const RD = `${CUST} Open Find vendors from a category.`;

caseSteps("RD-UI-01", "UI: Find vendors exact chrome", RD, [
  ["Open Find vendors; allow location.", "Live Radar / scanning or results."],
  [
    "Check mode labels if shown.",
    "Help (Need someone now) | Delivery (Order for delivery) | Booking (Book appointment)",
  ],
  [
    "On a vendor card check.",
    "Name; Online/Currently offline; Order/Connect/Call; trust Verified/Unverified; distance text like X km away.",
  ],
  ["If location denied path.", "Location needed / Open settings / Try again"],
]);

caseSteps("RD-01", "Happy: allow location", RD, [
  [
    "Allow GPS.",
    "Cards OR No helpers found within {radius} km / No helpers found in your area yet...",
  ],
]);

caseSteps("RD-02", "Negative: deny location", `${RD} Deny location.`, [
  [
    "Open Find vendors.",
    "Location needed + body about permission. Try again / Open settings.",
  ],
]);

caseSteps("RD-03", "Permutation: Help mode filter", `${RD} Location on.`, [
  ["Select Help mode; empty search.", "Help vendors (🚶 Help pills)."],
], "Both", "P2");

caseSteps("RD-04", "Permutation: Delivery mode", `${RD} Location on.`, [
  ["Select Delivery.", "Delivery vendors; Delivery terms and charges are set by each vendor. may show."],
]);

caseSteps("RD-05", "Permutation: Booking mode", `${RD} Location on.`, [
  ["Select Booking.", "Booking vendors (📅 Booking)."],
], "Both", "P2");

caseSteps("RD-06", "Search kirana / mikanik", RD, [
  ["Search kirana.", "Grocery-type results or suggested category."],
  ["Search mikanik.", "Mechanic results."],
], "Both", "P2");

caseSteps("RD-07", "Edge: ambulance 108 / pharmacy 104", RD, [
  ["Search ambulance.", "108 Ambulance gov panel + vendors."],
  ["Search pharmacy.", "Vendors + Need medical advice? Call 104"],
], "Both", "P2");

caseSteps("RD-08", "Permutation: online Order works", `${RD} Online vendor.`, [
  ["Confirm online. Tap: Order", "Order form opens (Order to … / Book with …)."],
]);

caseSteps("RD-09", "Negative: offline Order blocked", `${RD} Offline vendor.`, [
  ["Tap Order on Currently offline vendor.", "Blocked / Currently offline."],
]);

caseSteps(
  "RD-10",
  "Permutation: trust Verified vs Unverified",
  `${RD} One verified one not.`,
  [
    [
      "Compare badges.",
      "Verified (+ Bronze/Silver/Gold/Diamond) vs Unverified / Warning: Identity Not Verified — connect at your own risk.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "RD-11",
  "Edge: pending location review / verification in progress",
  `${RD} Such vendor on TEST.`,
  [
    [
      "Find that vendor.",
      "Hidden/degraded OR Verification in Progress — Proceed with caution.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "RD-12",
  "Edge: radius 5km hide vs 50km show",
  `${RD} ${TEST} seeded distances.`,
  [
    ["Customer ~8km; vendor radius 5km.", "Vendor hidden."],
    ["Same customer; vendor radius 50km.", "Vendor visible."],
  ],
  "Both",
  "P2",
);

caseSteps("RD-13", "Happy: save vendor", `${RD} Online vendor.`, [
  [
    "Save as neighbour.",
    "Saved! Find them on your home screen. (or Could not save)",
  ],
], "Both", "P2");

caseSteps(
  "RD-14",
  "Edge: own vendor card shows You",
  `${RD} Search while logged in as that vendor.`,
  [["Find own card.", "• You label may appear."]],
  "Both",
  "P3",
);

caseSteps(
  "RD-15",
  "Permutation: pan-India bracket",
  `${RD} Pan-India radius setting if available.`,
  [["Select Pan-India 🇮🇳 bracket.", "🇮🇳 Ships across India section/badge can appear."]],
  "Both",
  "P3",
);

// ===================== ORDER FORMS (PARCHI) =====================
const PS = `${CUST} Online vendor. Tap Order. ${TEST}`;

caseSteps("PS-UI-01", "UI: Help order form exact elements", `${PS} Help vendor.`, [
  ["Open form.", "Title like Order to {shop}."],
  [
    "Check fields.",
    "Message required; Come to me / visit shop choices; Submit; optional photo; may show Share my location with helper.",
  ],
]);

caseSteps("PS-UI-02", "UI: Delivery order form exact elements", `${PS} Delivery vendor.`, [
  [
    "Open form.",
    "Delivery Address; slots: As soon as possible / Morning (before 12pm) / Afternoon (12–4pm) / Evening (after 4pm) / Tomorrow; menu if any; Submit.",
  ],
]);

caseSteps("PS-UI-03", "UI: Booking order form exact elements", `${PS} Booking vendor.`, [
  [
    "Open form.",
    "Title Book with {shop}; appointment date/time; Online — will confirm your booking shortly if online.",
  ],
]);

caseSteps("PS-01", "Happy: Help order", `${PS} Help vendor.`, [
  [
    "Choose come-to-me or visit; type message; Submit.",
    "Toast: ✅ Order sent! They will see it shortly.",
  ],
  ["Open Orders.", "Card shows 📤 Sent (or similar status)."],
]);

caseSteps("PS-02", "Negative: Help submit empty message", `${PS} Help.`, [
  ["Submit with empty message.", "Please type your order."],
]);

caseSteps("PS-03", "Negative: Help without where choice", `${PS} Help requiring where.`, [
  ["Submit without Come to me / visit them.", "Please choose where you need help — come to you or visit them."],
], "Both", "P2");

caseSteps("PS-04", "Edge: low-trust confirm checkbox", `${PS} Low-trust vendor.`, [
  ["Submit without confirm checkbox.", "Blocked."],
  ["Tick confirm; submit.", "Order sent."],
], "Both", "P2");

caseSteps("PS-05", "Happy: Delivery order", `${PS} Delivery.`, [
  [
    "Address + future slot + message; Submit.",
    "✅ Order sent! … Orders shows slot prefix 🕐",
  ],
]);

caseSteps("PS-06", "Negative: Delivery no address", `${PS} Delivery.`, [
  ["Submit without address.", "Please add a delivery address."],
]);

caseSteps("PS-07", "Negative: Delivery past/expired slot", `${PS} Delivery.`, [
  ["Pick expired morning slot if possible; Submit.", "Slot expired error (parchi_slot_expired)."],
]);

caseSteps("PS-08", "Happy: Booking future", `${PS} Booking.`, [
  ["Future datetime; Submit.", "📅 Booking requested! Status awaiting confirmation."],
]);

caseSteps("PS-09", "Negative: Booking past time", `${PS} Booking.`, [
  ["Past datetime; Submit.", "Appointment expired / Please select appointment date and time."],
]);

caseSteps(
  "PS-10",
  "Negative: payment block unpaid UPI >48h",
  `${CUST} Seeded unpaid UPI bill >48h. ${TEST}`,
  [
    [
      "Open any Order form; try submit.",
      "Payment block body naming shop/amount. Go to My Orders.",
    ],
  ],
);

caseSteps("PS-11", "Edge: close form without submit", PS, [
  ["Type message; close form.", "No new order in Orders."],
], "Both", "P3");

caseSteps("PS-12", "Edge: offline vendor banner on form", `${PS} Open form if offline still reachable.`, [
  [
    "Observe banner.",
    "Offline — will see when they return / offline booking copy as applicable.",
  ],
], "Both", "P2");

// ===================== MY ORDERS =====================
caseSteps("MO-UI-01", "UI: My orders exact chrome", `${CUST} Open Orders.`, [
  [
    "Open Orders.",
    "Heading: My orders. Empty: No active orders. + Search for a vendor… + Find Vendors → OR list of cards with status badges.",
  ],
]);

caseSteps(
  "MO-01",
  "Happy: Help Sent → Accepted → Fulfilled",
  `${CUST} Place Help order; vendor can act. ${TEST}`,
  [
    ["Customer Orders after place.", "📤 Sent"],
    ["Vendor accepts; customer refresh.", "Accepted state / vendor saw progression."],
    [
      "Vendor marks done; customer refresh.",
      "✅ Vendor fulfilled your order / ✅ Delivered! Tap to rate style.",
    ],
  ],
);

caseSteps(
  "MO-02",
  "Negative: cancel after I've Started",
  `${CUST} Help accepted; vendor tapped I've Started.`,
  [
    [
      "Customer Cancel Order.",
      "🔒 Cannot cancel — vendor is already on it",
    ],
  ],
);

caseSteps(
  "MO-03",
  "Happy: cancel Help before start",
  `${CUST} Help accepted; vendor NOT started.`,
  [
    [
      "Cancel Order → Yes, Cancel",
      "Cancelled. Vendor may get Order cancelled by customer.",
    ],
  ],
);

caseSteps(
  "MO-04",
  "Permutation: Delivery Seen then Accepted",
  `${CUST} Delivery order. ${TEST}`,
  [
    ["Vendor opens orders (bulk seen).", "Customer may show 👀 Vendor saw your order"],
    ["Vendor accepts/done.", "Statuses update; slot remains."],
  ],
);

caseSteps(
  "MO-05",
  "Permutation: Booking confirmed vs declined",
  `${CUST} Booking orders. ${TEST}`,
  [
    ["Vendor confirms.", "· ✅ Vendor confirmed"],
    ["Other order vendor declines.", "· ❌ Vendor declined"],
  ],
);

caseSteps("MO-06", "Happy: I have paid clears block", `${CUST} Blocked by unpaid UPI.`, [
  ["On bill tap I have paid (exact label as shown).", "Block clears; new orders allowed."],
]);

caseSteps("MO-07", "Edge: cash bill >48h does not block", `${CUST} Old unpaid cash. ${TEST}`, [
  ["Try new order.", "Not blocked by cash age."],
], "Both", "P2");

caseSteps("MO-08", "Edge: disputed bill no re-block", `${CUST} Disputed bill. ${TEST}`, [
  ["Try new order.", "Not re-blocked."],
], "Both", "P2");

caseSteps("MO-09", "Happy: rate fulfilled", `${CUST} Fulfilled order.`, [
  ["Tap rate.", "Stars; submit disabled until star."],
  ["Select stars; submit.", "Saved."],
  ["On another: Skip.", "Closes; no rating."],
]);

caseSteps("MO-10", "Negative: no rate on Sent/Cancelled", CUST, [
  ["Inspect Sent and Cancelled cards.", "No rate CTA."],
], "Both", "P2");

caseSteps("MO-11", "Negative: dismiss with unpaid bill", `${CUST} Unpaid cash/UPI on order.`, [
  [
    "Tap 🗑 Dismiss",
    "Blocked (dismissBlockedUnpaid copy).",
  ],
]);

caseSteps("MO-12", "Happy: dismiss cancelled without unpaid", `${CUST} Cancelled clean order.`, [
  ["Dismiss.", "Removed from list."],
], "Both", "P2");

caseSteps("MO-13", "Edge: expired order banner", `${CUST} Expired unaccepted order. ${TEST}`, [
  [
    "Open Orders.",
    "⏰ Expired — no vendor accepted / No vendor accepted your request in time...",
  ],
], "Both", "P2");

caseSteps("MO-14", "Edge: overdue Help/Delivery/Booking indicators", `${CUST} Seeded overdue. ${TEST}`, [
  ["Open each overdue type.", "Overdue / ⚠️ No response yet style indicators as designed."],
], "Both", "P2");

// ===================== VENDOR MODE ONLINE/OFFLINE =====================
caseSteps("VM-UI-01", "UI: Vendor screen exact chrome", VEND, [
  [
    "Open Vendor.",
    "Vendor header/tagline; status Ready to Help or Offline; Tap to Go Online / Tap to go offline; bell; incoming list or empty; Already registered link only if logged out.",
  ],
]);

caseSteps("VM-01", "Happy: go online then offline", `${VEND} Location allowed. Not banned.`, [
  ["Tap to Go Online", "Online. Nav may show ME·Online. Location sharing while live."],
  ["Tap to go offline", "Offline. ME·Offline."],
]);

caseSteps(
  "VM-02",
  "Negative: offline with active today orders dialog",
  `${VEND} Active accepted order today.`,
  [
    [
      "Try go offline.",
      "You have active orders for today / Please contact your customers... Buttons: Stay Online | Go Offline Anyway",
    ],
  ],
);

caseSteps(
  "VM-03",
  "Permutation: offline notifies for today delivery / pending help; not tomorrow-only",
  `${VEND} ${TEST} seeded orders.`,
  [
    ["Offline with today's sent delivery.", "Customer notified."],
    ["Offline with tomorrow-only delivery.", "Customer NOT notified."],
    ["Offline with pending Help.", "Customer notified."],
  ],
  "Both",
  "P2",
);

caseSteps("VM-04", "Negative: banned cannot go online", `${VEND} Banned.`, [
  ["Tap to Go Online", "Blocked; banned state."],
]);

caseSteps("VM-05", "Edge: unverified go online nudge", `${VEND} Unverified.`, [
  [
    "Go online.",
    "You're live! Complete verification in My Business to earn your trust badge.",
  ],
], "Both", "P2");

caseSteps("VM-06", "Edge: draft incomplete location banner", `${VEND} No location.`, [
  [
    "Open Vendor.",
    "Your profile is incomplete / Add your shop location... CTA Add Location",
  ],
], "Both", "P2");

caseSteps("VM-07", "Edge: photos required to go live", `${VEND} Missing photos.`, [
  [
    "Try go online.",
    "Photos required to go live / Retry your selfie and shop photo in My Business...",
  ],
], "Both", "P2");

caseSteps(
  "VM-08",
  "Edge: desktop live location copy",
  `${VEND} Web Help vendor online.`,
  [
    [
      "Go online on desktop.",
      "On a computer, live location updates only while this tab is open and visible.",
    ],
    ["Hide tab.", "Updates pause."],
  ],
  "Web",
  "P2",
);

caseSteps("VM-09", "Empty orders state", `${VEND} No orders.`, [
  ["Open Vendor.", "Empty / no orders messaging."],
], "Both", "P2");

caseSteps("VM-10", "Edge: subscription expired offline", `${VEND} Expired sub if enabled.`, [
  [
    "View subscription area.",
    "Subscription Expired / Your shop is currently offline. / Renew Subscription",
  ],
], "Both", "P3");

// ===================== INCOMING =====================
caseSteps("IO-UI-01", "UI: incoming cards by mode", `${VEND} One Help+Delivery+Booking if possible.`, [
  [
    "Inspect Help card.",
    "Accept/Decline; I've Started when accepted; category chip; Mark done.",
  ],
  ["Inspect Delivery.", "Address/slot; Open in Maps when allowed."],
  ["Inspect Booking.", "Confirm/Decline; appointment time; soft overlap note if ±30min."],
]);

caseSteps("IO-01", "Happy: Help accept → I've Started → done", `${VEND} Help sent.`, [
  ["Accept.", "Accepted; customer notified."],
  ["I've Started", "Customer notified; label Customer notified."],
  ["Mark done.", "Fulfilled; customer notified."],
]);

caseSteps("IO-02", "Happy/Negative: cancel with reason", `${VEND} Cancellable order.`, [
  ["Cancel without reason if required.", "Blocked."],
  ["Pick reason; cancel.", "Cancelled."],
]);

caseSteps("IO-03", "Permutation: Delivery bulk seen no customer ping", `${VEND} Delivery sent.`, [
  [
    "Open orders tab (bulk seen).",
    "Seen internally; customer NOT notified for bulk seen alone.",
  ],
  ["Accept then done.", "Customer notified those steps."],
]);

caseSteps("IO-04", "Permutation: Booking confirm/decline", `${VEND} Bookings.`, [
  ["Confirm one.", "Customer notified confirmation."],
  ["Decline other.", "Customer notified decline."],
]);

caseSteps(
  "IO-05",
  "Edge: soft overlap ±30 min",
  `${VEND} Two appointments within 30 minutes. ${TEST}`,
  [
    [
      "Open one card.",
      "Soft note about another appointment; Confirm/Decline still enabled.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps("IO-06", "Edge: Load more", `${VEND} Many orders. ${TEST}`, [
  ["Load more.", "Older orders appear."],
], "Both", "P2");

caseSteps("IO-07", "Negative: Flag only on fulfilled", VEND, [
  ["Compare Sent vs Fulfilled.", "Flag only on fulfilled."],
], "Both", "P2");

caseSteps(
  "IO-08",
  "Permutation: Open in Maps rules",
  `${VEND} App. Various order types. ${TEST}`,
  [
    ["Delivery with coords.", "Maps opens coords."],
    ["Delivery address only.", "Address search."],
    ["Delivery none.", "No Maps button."],
    ["Help with coords.", "Maps shown."],
    ["Booking customer visits shop — vendor.", "No Maps for vendor."],
  ],
  "App",
  "P2",
);

caseSteps(
  "IO-09",
  "Multi-business: category chip matches order business",
  `${VEND} Multi-category vendor; orders on different businesses. ${TEST}`,
  [
    ["Compare chips on two orders.", "Each chip matches that order's category/business."],
  ],
);

caseSteps(
  "IO-10",
  "Multi-business: stats/reputation not leaked across businesses",
  `${VEND} Cobbler+Carpenter style split. ${TEST}`,
  [
    [
      "Check Radar cards for each business.",
      "Helped/fulfilled counts scoped per business.",
    ],
  ],
  "Both",
  "P2",
);

// ===================== BILLS / KHATA =====================
caseSteps("BL-UI-01", "UI: Bill sheet controls", `${VEND} Open bill on fulfilled order.`, [
  ["Open bill.", "Amount/items; Cash/UPI/Khata; save; mark paid; history if edited."],
]);

caseSteps("BL-01", "Happy: create unpaid then mark paid", `${VEND} ${TEST}`, [
  ["Create unpaid bill.", "Saved unpaid."],
  ["Mark paid.", "Paid."],
]);

caseSteps("BL-02", "Happy: edit fresh unpaid no reason", VEND, [
  ["Edit amount; save.", "Saves without reason."],
]);

caseSteps("BL-03", "Negative: edit paid needs reason", VEND, [
  ["Edit paid without reason.", "Blocked."],
  ["Add reason; confirm.", "Saves; Edited history old→new."],
]);

caseSteps("BL-04", "Edge: late edit + khata over-correction dialogs", `${VEND} ${TEST}`, [
  ["Late edit paid.", "Late-edit dialog then success."],
  ["Khata over-correct.", "Credit dialog with amount."],
], "Both", "P2");

caseSteps("BL-05", "Happy: add to khata allows dismiss", VEND, [
  ["Add unpaid to khata.", "Dismiss becomes allowed."],
], "Both", "P2");

caseSteps("KH-UI-01", "UI: Ledger", `${VEND} Open Ledger.`, [
  ["Open Ledger.", "Balance + transaction rows with business chips."],
]);

caseSteps("KH-01", "Edge: multi-business khata chip labels", `${VEND} Multi-biz bills. ${TEST}`, [
  ["Check chips.", "Correct category per row."],
], "Both", "P2");

// ===================== RATINGS =====================
caseSteps("RT-UI-01", "UI: rating sheet", `${CUST} Rate fulfilled.`, [
  ["Open rate.", "5 stars; Submit disabled until star; Skip."],
]);

caseSteps("RT-01", "Happy: 5-star and 1-star", CUST, [
  ["Rate 5 submit.", "Saved."],
  ["Other order rate 1.", "Saved."],
]);

caseSteps("RT-02", "Negative: duplicate rating", CUST, [
  ["Rate same order again.", "Blocked."],
], "Both", "P2");

caseSteps("RT-03", "Happy: vendor reply", `${VEND} Has review.`, [
  ["Reply to review.", "Customer can see reply."],
], "Both", "P2");

// ===================== TRACKING =====================
caseSteps("LT-UI-01", "UI: Live Tracking", `${CUST} Open tracking.`, [
  ["Open Live Tracking.", "Header Live Tracking; map; markers; back."],
]);

caseSteps("LT-01", "Edge: maps hidden completed/cancelled", CUST, [
  ["Check completed/cancelled.", "No Open in Maps."],
], "Both", "P2");

// ===================== FEED =====================
caseSteps("FD-UI-01", "UI: Local Feed", `${CUST} Open Local Feed.`, [
  [
    "Open Local Feed.",
    "Posts or empty; vendor may create; customer cannot create vendor offers.",
  ],
]);

caseSteps("FD-01", "Happy: load by radius", CUST, [
  ["Open feed with location.", "Nearby posts or empty; no crash."],
]);

caseSteps("FD-02", "Negative: banned vendor offer hidden", `${CUST} ${TEST}`, [
  ["Browse near banned vendor offer.", "Offer not shown."],
], "Both", "P2");

caseSteps("FD-03", "Permutation: feed notifications on/off App vs Web", CUST, [
  ["Settings Local Feed: turn OFF notifications.", "Announcements suppressed for device."],
  ["App: turn ON + OS allow.", "Works."],
  ["Web: turn ON + browser allow.", "Works."],
], "Both", "P2");

caseSteps("FD-04", "Happy: vendor offer linked to shop", VEND, [
  ["Create offer linked to shop.", "Appears; tap opens vendor."],
], "Both", "P2");

// ===================== SETTINGS CUSTOMER =====================
caseSteps("SC-UI-01", "UI: Settings customer sections", CUST, [
  [
    "Open Settings; expand sections.",
    "My Account | My Identity | Account Standing | delivery addresses | Preferences (theme/language) | Local Feed | Privacy | Help | Register your business on AasPaas | Clear My Data | Delete Account at bottom.",
  ],
]);

caseSteps("SC-01", "Happy: add phone + address", CUST, [
  ["Add phone under My Identity.", "Registered — orders sync across devices (or similar)."],
  ["Add delivery address; Save.", "Listed."],
]);

caseSteps("SC-02", "Negative: address without phone", `${CUST} No phone.`, [
  ["Try save address.", "Phone required error."],
], "Both", "P2");

caseSteps("SC-03", "Permutation: theme + EN/HI/MR", CUST, [
  ["Toggle theme; reopen.", "Persists."],
  ["Switch English→Hindi→Marathi→English.", "Labels change each time."],
], "Both", "P2");

caseSteps("SC-04", "Happy: privacy + help", CUST, [
  ["Open Privacy policy.", "Opens privacy."],
  ["Open Help and support.", "FAQ loads."],
], "Both", "P2");

caseSteps("SC-05", "Danger: Clear My Data", `${CUST} ${TEST} disposable.`, [
  ["Clear My Data confirm.", "Data cleared per rules."],
], "Both", "P2");

caseSteps("SC-06", "Danger: Delete Account customer", `${CUST} ${TEST} disposable.`, [
  [
    "Delete Account → read Delete your account? → confirm",
    "Fresh first-open. Phone anonymised.",
  ],
]);

caseSteps("SC-07", "Happy: Register your business on AasPaas", CUST, [
  ["Tap Register your business on AasPaas", "Vendor registration opens."],
]);

caseSteps("SC-08", "Edge: feed discovery radius save", CUST, [
  ["Change Local Feed radius; save.", "Saved; feed uses radius."],
], "Both", "P2");

// ===================== MY BUSINESS / MULTI =====================
caseSteps("SV-UI-01", "UI: My Business", VEND, [
  [
    "Settings → My Business",
    "Visible for vendor only. Accordion per business if multi. Photo/UPI/menu/cancel reasons/note/offers/radius/Refer & Earn if enabled.",
  ],
]);

caseSteps("SV-01", "Happy: edit persist", VEND, [
  ["Edit radius/modes/reasons/note; save; reopen.", "Persists."],
]);

caseSteps("SV-02", "Permutation: multi-business independent edits", `${VEND} 2 businesses.`, [
  ["Change note on business A only.", "B unchanged."],
  ["Change menu on B only.", "A unchanged."],
]);

caseSteps("SV-03", "Happy: menu + gallery photo", VEND, [
  ["Add menu item + gallery photo; save.", "Saved or visible error toast (not silent)."],
], "Both", "P2");

caseSteps("SV-04", "Happy/Negative: UPI update", VEND, [
  ["Set invalid UPI.", "Blocked."],
  ["Set valid UPI.", "Saved."],
]);

caseSteps("SV-05", "Permutation: Refer & Earn on/off", VEND, [
  ["If referral_enabled: open Refer & Earn.", "🎁 Refer & Earn; code; Pending payout if any."],
  ["If disabled: section hidden.", "Hidden."],
  ["Customer-only: no Refer & Earn.", "Hidden."],
], "Both", "P2");

caseSteps("SV-06", "Edge: same shop detected reuse photo", `${VEND} Add business near existing. ${TEST}`, [
  [
    "Trigger same location.",
    "Same shop detected / Reuse shop photo / Capture new photo",
  ],
], "Both", "P2");

caseSteps(
  "SV-07",
  "Permutation: trust Bronze vs Unverified per business",
  `${VEND} One verified business one not. ${TEST}`,
  [
    [
      "Check Radar badges per category.",
      "Verified · Bronze (or tier) on verified business; Unverified on other.",
    ],
  ],
  "Both",
  "P2",
);

// ===================== REFERRALS =====================
caseSteps("RF-01", "Happy: /r/CODE prefills", `${FRESH} Code OTHER.`, [
  ["Open /r/OTHER", "App stores code."],
  ["Start registration; see Referral Code (optional).", "OTHER prefilled."],
], "Both", "P2");

caseSteps("RF-02", "Happy: vendor referral credits", `${TEST} Referrals on.`, [
  ["New vendor registers with referrer code.", "Referrer staged credits; may notify Referral bonus earned!"],
], "Both", "P2");

caseSteps("RF-03", "Negative: duplicate referral", `${TEST}`, [
  ["Reuse same referral pair.", "This referral code has already been used / graceful block."],
], "Both", "P3");

// ===================== NOTIFICATIONS =====================
caseSteps("NT-UI-01", "UI: bell panel", `${CUST} Has notifications.`, [
  ["Open bell.", "Newest first; unread badge; mark all read if present."],
]);

caseSteps("NT-01", "Happy: deep links", `${CUST}/${VEND} ${TEST}`, [
  ["Tap order notification.", "Opens My orders."],
  ["Tap vendor new-order notification.", "Opens Vendor."],
  ["Tap feed notification.", "Opens Local Feed."],
]);

caseSteps("NT-02", "Edge: copy accept/confirm/decline", `${TEST}`, [
  [
    "Trigger each.",
    "Accept/confirm/decline texts match vendor/slot/datetime rules.",
  ],
], "Both", "P2");

caseSteps("NT-03", "Permutation: Hindi notification", `${TEST} Hindi user.`, [
  ["Trigger warn/notify.", "Hindi text."],
], "Both", "P2");

caseSteps("NT-04", "Edge: near-deadline once", `${TEST}`, [
  ["Two cron cycles same pair.", "Only one near-deadline warning."],
], "Both", "P3");

caseSteps("NT-05", "Web push allow", `${CUST} Chrome.`, [
  ["Allow via Settings feed toggle; test if available.", "Token path works; notification can arrive."],
], "Web", "P2");

// ===================== ADMIN =====================
caseSteps("AD-UI-01", "UI: admin panel", `${EN} Admin login. ${TEST}`, [
  [
    "Open admin.",
    "Vendor list/filters; verify checklist UPI Format/Shop Photo/Selfie Photo/GPS/Admin Check; pending categories; ban reason; App Health.",
  ],
]);

caseSteps("AD-01", "Negative: non-admin blocked", CUST, [
  ["Open /settings/admin.", "No admin tools; server denies."],
]);

caseSteps("AD-02", "Happy: verify vendor", `${EN} Admin. ${TEST}`, [
  ["Pass checks; verify.", "Verified + tier badge."],
]);

caseSteps("AD-03", "Happy: unverify", `${EN} Admin. ${TEST}`, [
  ["Unverify.", "Reset; audited."],
], "Both", "P2");

caseSteps("AD-04", "Permutation: approve/reject category", `${EN} Admin. ${TEST}`, [
  ["Approve pending.", "Active; vendor notified."],
  ["Reject other.", "Inactive; vendor notified."],
]);

caseSteps("AD-05", "Happy/Negative: ban/unban", `${EN} Admin. ${TEST}`, [
  ["Ban without reason.", "Blocked."],
  ["Ban with reason.", "Banned; cannot go online."],
  ["Unban.", "Restored; notified."],
]);

caseSteps("AD-06", "Edge: App Health numbers", `${EN} Admin.`, [
  ["Open App Health.", "Valid numbers not blank/NaN."],
], "Both", "P2");

caseSteps(
  "AD-07",
  "Multi-business: admin verify one business only",
  `${EN} Admin. Multi-biz vendor. ${TEST}`,
  [
    [
      "Select business to verify; verify one.",
      "Only that business gains verification; other unchanged.",
    ],
  ],
);

// ===================== DELETION =====================
caseSteps("DL-UI-01", "UI: Delete Account", `${CUST} Scroll Settings bottom.`, [
  [
    "Open Delete Account.",
    "Delete your account? warning. Vendor: 30-day schedule messaging not instant wipe.",
  ],
]);

caseSteps("DL-01", "Happy: customer delete", `${CUST} ${TEST} disposable.`, [
  ["Confirm delete.", "Fresh first-open."],
]);

caseSteps("DL-02", "Permutation: vendor schedule / grace / cancel", `${VEND} ${TEST}`, [
  ["Start delete.", "30-day scheduled UI."],
  ["Try Tap to Go Online", "Blocked."],
  ["Cancel deletion.", "Normal; can go online."],
]);

caseSteps("DL-03", "Edge: dual-role delete", `${TEST} Dual role disposable.`, [
  ["Delete.", "Customer + vendor rules both apply."],
], "Both", "P2");

// ===================== CATEGORIES =====================
caseSteps("CAT-01", "Happy: only active categories on Home", CUST, [
  ["List Home chips.", "Only active."],
]);

caseSteps("CAT-02", "Permutation: labels EN/HI/MR", CUST, [
  ["Switch languages.", "Category names translate."],
], "Both", "P2");

caseSteps("CAT-03", "Edge: inactive hidden", `${CUST} ${TEST}`, [
  ["Search inactive category.", "Not offered as active chip."],
], "Both", "P2");

// ===================== LEGAL / WEB =====================
caseSteps("LG-UI-01", "UI: legal + landing pages", `${EN} Website.`, [
  ["Open /landing", "Landing with vendor CTA."],
  ["Open /privacy-policy.html", "Privacy Policy — Aaspaas Pro content."],
  ["Open /terms-of-service.html", "Terms of Service content."],
], "Web");

caseSteps("LG-01", "Happy: prod web no Capacitor crash", `${EN} Prod site or build:prod preview.`, [
  [
    "Home → Find vendors → Order form → Settings → Vendor find-account → Local Feed",
    "All load; no white crash; mic/native tour hidden on web.",
  ],
], "Web");

caseSteps("LG-02", "Edge: SW present", EN, [
  ["Open /firebase-messaging-sw.js", "Not 404."],
], "Web", "P2");

// ===================== NETWORK =====================
caseSteps("NW-01", "Negative: offline UX", CUST, [
  ["Airplane mode; open Orders/categories.", "Retry/network message; no silent freeze."],
  ["Back online; retry.", "Recovers."],
], "Both", "P2");

caseSteps("NW-02", "Edge: OTP off path", CUST, [
  ["Add/restore phone without SMS OTP.", "Works via device-saved phone (OTP not required now)."],
], "Both", "P2");

caseSteps("NW-03", "Edge: AI rate limit", CUST, [
  ["Burst many searches.", "Graceful limit; no crash."],
], "Both", "P3");

// =====================================================================
// FINISH PASS — wise extras per module (exact EN copy, not endless combos)
// =====================================================================

// ---- Incoming: exact button labels + status chips ----
caseSteps(
  "IO-UI-02",
  "UI: Incoming Orders heading and empty/status labels",
  `${VEND} Prefer empty then with orders.`,
  [
    [
      "Open Vendor with no orders.",
      "Heading: 📋 Incoming Orders. Empty text: No orders yet!",
    ],
    [
      "With orders, check status chips on cards.",
      "Statuses can show: New | Seen | Done ✅ (and accepted/fulfilled states as designed).",
    ],
    [
      "On Help/Delivery actionable card check primary buttons.",
      "Exact: ✅ Accept (or ✅ Accept Order) | Mark Done | I've Started when accepted.",
    ],
    [
      "On Booking pending card check buttons.",
      "Exact: ✅ Confirm | ❌ Decline. Decline sheet title: Decline Booking. Hint: Select a reason (shown to customer). Confirm Decline.",
    ],
  ],
);

caseSteps(
  "IO-11",
  "Happy: booking confirm toast and customer notify copy",
  `${VEND} Pending booking. ${TEST}`,
  [
    [
      "Tap: ✅ Confirm",
      "Toast: ✅ Appointment confirmed! Customer may get Booking confirmed / Your booking has been confirmed. See you soon!",
    ],
  ],
);

caseSteps(
  "IO-12",
  "Happy: booking decline with reason",
  `${VEND} Pending booking. ${TEST}`,
  [
    [
      "Tap: ❌ Decline → pick reason → Confirm Decline",
      "Toast: Booking declined. Customer notified with reason.",
    ],
  ],
);

caseSteps(
  "IO-13",
  "Negative: booking already actioned",
  `${VEND} Booking already confirmed. ${TEST}`,
  [
    [
      "Try Confirm or Decline again.",
      "This booking was already confirmed or declined. (or UI hides buttons)",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "IO-14",
  "Edge: soft overlap exact text",
  `${VEND} Two appointments within ±30 minutes. ${TEST}`,
  [
    [
      "Open one appointment card.",
      "Exact note: You have another appointment around this time. ✅ Confirm / ❌ Decline still work.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "IO-15",
  "Edge: same-day cancel warning on vendor",
  `${VEND} Same-day appointment cancel path. ${TEST}`,
  [
    [
      "Start cancel appointment same day.",
      "May show: ⚠️ Same-day cancellation — call customer first and/or 📞 Connect via AI-Bridge to Cancel",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "IO-16",
  "Happy: Help accept customer notify copy",
  `${VEND} Help Sent order. ${TEST}`,
  [
    [
      "Tap: ✅ Accept",
      "Customer notification style: Help is on the way! / Vendor accepted and is heading to you (or Order accepted path for delivery).",
    ],
    [
      "Tap: I've Started",
      "Shows Customer notified. Customer body like Your helper has started coming to you.",
    ],
    ["Tap: Mark Done", "Card can show Done ✅; customer gets fulfilled/rate path."],
  ],
);

caseSteps(
  "IO-17",
  "Edge: load more exact label",
  `${VEND} Many orders. ${TEST}`,
  [
    [
      "If more than one page, check load control.",
      "Text like: {count} more orders — load more then Loading more…",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "IO-18",
  "Permutation: location lines on incoming card",
  `${VEND} Help/Delivery with location tags. ${TEST}`,
  [
    [
      "Inspect location line on cards.",
      "May show: 🏠 Visit customer's location | 🏪 Will visit your shop | 📞 Location TBD | 📍 address | 🕐 slot",
    ],
  ],
  "Both",
  "P2",
);

// ---- Payments (customer) ----
caseSteps(
  "PAY-UI-01",
  "UI: unpaid bill block and Pay Now / I've Paid",
  `${CUST} Unpaid UPI bill on an order. ${TEST}`,
  [
    [
      "Open My orders and find unpaid bill actions.",
      "Exact actions include Pay Now and I've Paid (wording as on card/panel).",
    ],
    [
      "Try place a new order while unpaid UPI >48h.",
      "Block text includes unpaid bill amount from shop and tells you to Pay or tap \"I've Paid\" in My Orders. Button: Go to My Orders",
    ],
  ],
);

caseSteps(
  "PAY-01",
  "Happy: Pay Now opens UPI/QR panel",
  `${CUST} Unpaid bill. ${TEST}`,
  [
    [
      "Tap: Pay Now",
      "UPI/QR payment panel opens (scan/pay). Web uses browser-capable fallback.",
    ],
  ],
);

caseSteps(
  "PAY-02",
  "Happy: I've Paid clears proactive block",
  `${CUST} Blocked by unpaid UPI. ${TEST}`,
  [
    ["On My orders tap: I've Paid", "Block clears; can place new order."],
  ],
);

caseSteps(
  "PAY-03",
  "Edge: payment proof upload if shown",
  `${CUST} Pay flow offers proof photo. ${TEST}`,
  [
    [
      "Attach payment proof from gallery if UI offers it.",
      "Upload accepted or clear error; not silent fail.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "PAY-04",
  "Negative: still blocked if bill unpaid and I've Paid not used",
  `${CUST} Unpaid UPI >48h. ${TEST}`,
  [
    [
      "Do not tap I've Paid. Try Order submit again.",
      "Still blocked with unpaid bill message.",
    ],
  ],
);

// ---- Help & Support ----
caseSteps(
  "HS-UI-01",
  "UI: Help & Support page exact chrome",
  `${CUST} Settings → Help and support (or /settings/help).`,
  [
    [
      "Open Help & Support.",
      "Title: Help & Support. Subtitle: FAQ, feedback, and contact. Back control: Back",
    ],
    ["Scan FAQ list.", "Questions readable (restore account, orders, etc.). Expand one answer."],
  ],
);

caseSteps(
  "HS-01",
  "Happy: FAQ restore account answer useful",
  CUST,
  [
    [
      "Open FAQ about lost phone / restore account if listed.",
      "Answer explains restore via I've used Aaspaas before / phone.",
    ],
  ],
  "Both",
  "P2",
);

// ---- Feed thicken ----
caseSteps(
  "FD-UI-02",
  "UI: compose New post exact types",
  `${VEND} Or customer with phone. Open Local Feed → New post.`,
  [
    [
      "Open compose.",
      "Title: New post. Post type: Announcement | Recommendation | Offer (vendor). Placeholder for announcement: Share something with your neighbourhood... Button: Post. Close aria Close.",
    ],
    [
      "If location missing try Post.",
      "Your location is needed to post / Enable location to share with your community (or permission help steps).",
    ],
  ],
);

caseSteps(
  "FD-05",
  "Negative: empty post / max chars / phone required",
  `${CUST} Phone missing OR compose open.`,
  [
    ["Try Post with empty text.", "Write something to post OR Add your phone in Settings first"],
    ["Paste huge text over max.", "Max {n} characters style error."],
  ],
  "Both",
  "P2",
);

caseSteps(
  "FD-06",
  "Happy: Announcement posts",
  `${CUST} Phone + location. ${TEST}`,
  [
    [
      "Compose Announcement; Post.",
      "Posted! Feed shows post; empty state was No posts near you yet. Be the first to post! if first.",
    ],
  ],
);

caseSteps(
  "FD-07",
  "Happy: Recommendation with vendor search",
  `${CUST} Phone + location. ${TEST}`,
  [
    [
      "Type Recommendation; use Which vendor are you recommending? / Search vendors on Aaspaas or Not on Aaspaas yet.",
      "Can post recommendation; linked shop tap works if on app.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "FD-08",
  "Happy/Negative: reply and report",
  `${CUST} Existing post. ${TEST}`,
  [
    ["Tap Reply; Send empty.", "Blocked or no send."],
    ["Write reply; Send.", "Reply appears (or No replies yet before)."],
    [
      "Report post.",
      "Post reported OR You've already reported this post on second try.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "FD-09",
  "Edge: load more posts",
  `${CUST} Many posts. ${TEST}`,
  [
    [
      "Scroll; load more.",
      "{count} more posts — load more / Loading more… / note Posts are automatically removed after 7 days.",
    ],
  ],
  "Both",
  "P3",
);

caseSteps(
  "FD-10",
  "Edge: offer push copy when notifications on",
  `${CUST} Notifications on; vendor posts Offer nearby. ${TEST}`,
  [
    [
      "Vendor posts Offer; customer with notif on.",
      "Push may say New offer nearby / {shop} has a new offer for you",
    ],
  ],
  "Both",
  "P3",
);

// ---- Settings thicken ----
caseSteps(
  "SC-UI-02",
  "UI: Preferences exact labels",
  CUST,
  [
    [
      "Open Preferences.",
      "Language control labeled Language. Theme toggle present. Large text if shown. Voice input language on App.",
    ],
  ],
);

caseSteps(
  "SC-09",
  "Happy: Account Standing displays",
  CUST,
  [
    [
      "Open Account Standing.",
      "Shows standing status (good / warned / banned style) under My Account.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "SC-10",
  "Edge: Clear My Data exact entry",
  `${CUST} ${TEST} disposable.`,
  [
    [
      "Find Clear My Data near bottom; confirm.",
      "Clears scoped data; app usable after; not full account delete.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "SC-11",
  "UI: Connection privacy row",
  CUST,
  [
    [
      "Open Connection & Privacy style section.",
      "Privacy policy link; may show Database: Connected & Secure / TLS note.",
    ],
  ],
  "Both",
  "P2",
);

// ---- My Business / delivery fulfillment ----
caseSteps(
  "SV-08",
  "UI/Permutation: When should customer pay Prepaid vs Postpaid",
  `${VEND} Delivery business in My Business. ${TEST}`,
  [
    [
      "Find When should customer pay?",
      "Options: Prepaid | Postpaid. Save each; reopen persists.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "SV-09",
  "Negative: go live blocked until photos retried",
  `${VEND} Failed/missing selfie or shop photo.`,
  [
    [
      "Tap to Go Online",
      "Photos required to go live / Retry your selfie and shop photo in My Business before going live. CTA Retry photos",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "SV-10",
  "Happy: cancel reasons used on vendor cancel",
  `${VEND} Saved custom cancel reasons in My Business. ${TEST}`,
  [
    [
      "Cancel an order; open reason picker.",
      "Your saved reasons appear (and/or defaults).",
    ],
  ],
  "Both",
  "P2",
);

// ---- My Orders location lines ----
caseSteps(
  "MO-15",
  "Permutation: My orders location/appointment lines",
  `${CUST} Help+Booking+Delivery orders. ${TEST}`,
  [
    [
      "Inspect cards.",
      "May show: 🏠 They'll come to you | 🏪 You'll visit their shop | 📞 Location TBD | 📅 Around … | · ⏳ Awaiting confirmation | · ✅ Vendor confirmed",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "MO-16",
  "Happy/Negative: Cancel Booking confirm dialog",
  `${CUST} Booking awaiting/confirmed cancelable. ${TEST}`,
  [
    [
      "Tap Cancel Booking / Cancel Order",
      "Are you sure you want to cancel? / Are you sure you want to cancel this order? Buttons Yes, Cancel | Keep it",
    ],
    ["Tap Keep it", "Order remains."],
    ["Cancel again → Yes, Cancel", "Cancelled."],
  ],
);

caseSteps(
  "MO-17",
  "Edge: same-day booking cancel needs call path",
  `${CUST} Same-day booking. ${TEST}`,
  [
    [
      "Try cancel same-day booking.",
      "May show: ⚠️ Same-day changes require a call to the vendor first / 📞 Connect via AI-Bridge to Cancel",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "MO-18",
  "Edge: overdue accepted Help cancel hint",
  `${CUST} Help accepted many hours ago. ${TEST}`,
  [
    [
      "Open card.",
      "May show Accepted {hours}+ hours ago. Still waiting? You can cancel and try another vendor.",
    ],
  ],
  "Both",
  "P2",
);

// ---- Radar CTA labels ----
caseSteps(
  "RD-16",
  "Permutation: CTA Order vs Connect vs Call",
  `${RD} Different vendor types online.`,
  [
    [
      "Check card primary CTA.",
      "Exact labels among: Order | Connect | Call (and Book a Service / Send Order style where used).",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "RD-17",
  "Edge: vendor goes offline while on list",
  `${RD} ${TEST}`,
  [
    [
      "While list open, vendor goes offline; refresh/retry Order.",
      "Shows Currently offline / vendor went offline messaging; Order blocked.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "RD-18",
  "Happy: Back to home",
  RD,
  [
    ["Tap back / Back to home if shown.", "Returns Home."],
  ],
  "Both",
  "P3",
);

// ---- Parchi offline appointment too soon ----
caseSteps(
  "PS-13",
  "Negative: offline vendor appointment too soon",
  `${PS} Offline booking vendor; near-term slot. ${TEST}`,
  [
    [
      "Pick very soon appointment; Submit.",
      "Offline appointment-too-soon error/banner if product enforces it.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "PS-14",
  "Permutation: delivery slot exact labels",
  `${PS} Delivery form.`,
  [
    [
      "Open slot picker.",
      "As soon as possible | Morning (before 12pm) | Afternoon (12–4pm) | Evening (after 4pm) | Tomorrow (emoji variants OK).",
    ],
  ],
);

// ---- Vendor golive prompt after register ----
caseSteps(
  "VM-11",
  "UI: post-register go live prompt",
  `${EN} Just finished Register me on TEST.`,
  [
    [
      "After successful register.",
      "May show: You're registered! Now go live to receive orders. Then Tap to Go Online works.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "VM-12",
  "Permutation: Stay Online vs Go Offline Anyway",
  `${VEND} Active today orders dialog showing.`,
  [
    ["Tap: Stay Online", "Remains online."],
    ["Trigger dialog again; tap: Go Offline Anyway", "Goes offline after confirm path."],
  ],
  "Both",
  "P2",
);

// ---- Admin filters ----
caseSteps(
  "AD-08",
  "Permutation: admin vendor filters",
  `${EN} Admin. ${TEST}`,
  [
    [
      "Toggle filters.",
      "Show all vendors | Unverified & flagged only | Ready for review (green ready).",
    ],
    ["Open verify; Select business to verify if multi.", "Checklist: UPI Format, Shop Photo, Selfie Photo, GPS, Admin Check."],
  ],
);

caseSteps(
  "AD-09",
  "Happy: mark admin check passed/failed",
  `${EN} Admin verify sheet. ${TEST}`,
  [
    [
      "Tap Mark Admin Check Passed / Failed.",
      "Toast Admin check marked passed/failed; badge updates.",
    ],
  ],
  "Both",
  "P2",
);

// ---- Live tracking ----
caseSteps(
  "LT-02",
  "Happy: open tracking from active Help",
  `${CUST} Accepted Help with tracking. ${TEST}`,
  [
    ["Open Live Tracking from order.", "Header Live Tracking; map loads."],
  ],
);

caseSteps(
  "LT-03",
  "Edge: vendor stopped messaging on Home banner",
  `${CUST} Active Help; vendor stopped moving. ${TEST}`,
  [
    [
      "Check Home help banner if shown.",
      "On the way! and/or Your vendor seems to have stopped. Tap to check.",
    ],
  ],
  "Both",
  "P2",
);

// ---- Ratings vendor side ----
caseSteps(
  "RT-04",
  "UI: trust sheet from badge",
  `${CUST} Open verified vendor trust badge if tappable.`,
  [
    [
      "Open verification details.",
      "Title Verification details. Sub: Checks this vendor has completed. Checks GPS Location / Admin Review etc. Status Passed|Failed|Pending.",
    ],
  ],
  "Both",
  "P2",
);

// ---- Khata limits ----
caseSteps(
  "KH-02",
  "Negative: khata over limit confirm",
  `${VEND} Customer near khata limit. ${TEST}`,
  [
    [
      "Try bill to khata over limit.",
      "Confirm dialog about khata over limit (mentions customer masked phone).",
    ],
  ],
  "Both",
  "P2",
);

// ---- Referrals share ----
caseSteps(
  "RF-04",
  "Happy: copy/share referral",
  `${VEND} Referrals enabled.`,
  [
    [
      "Open Refer & Earn; Copy referral code / 📋 Copy Link / 📤 Share",
      "Copied! or Link copied! Share text includes Join me on Aaspaas Pro! Use my referral code…",
    ],
  ],
  "Both",
  "P2",
);

// ---- Landing exact ----
caseSteps(
  "LG-03",
  "UI: landing vendor line",
  `${EN} /landing`,
  [
    [
      "Read vendor CTA area.",
      "Includes For vendors: Register your shop and get customers (or current landing copy).",
    ],
  ],
  "Web",
  "P2",
);

// ---- Network error exact ----
caseSteps(
  "NW-04",
  "Edge: radar connection error",
  `${RD} Force network fail.`,
  [
    [
      "Trigger vendor fetch fail.",
      "Connection Error and/or Connection is too slow. Couldn't load categories — try again.",
    ],
  ],
  "Both",
  "P3",
);

caseSteps(
  "NW-05",
  "Edge: could not update order toasts",
  `${VEND} Kill network mid Accept.`,
  [
    [
      "Accept/Decline while offline.",
      "Could not update order / Could not update appointment / retry path.",
    ],
  ],
  "Both",
  "P3",
);

// ---- Multi-business wise set (complete module) ----
caseSteps(
  "MB-01",
  "Multi-business: add second category end-to-end",
  `${VEND} One business exists. ${TEST}`,
  [
    ["My Business → add second category/business with own Shop photo for this business.", "Second accordion section appears."],
    ["Place one Help order on biz A and one on biz B (two customer sessions or categories).", "Incoming chips match each business."],
  ],
);

caseSteps(
  "MB-02",
  "Multi-business: go online once serves both discoverable businesses",
  `${VEND} Two active discoverable businesses. ${TEST}`,
  [
    [
      "Tap to Go Online once.",
      "Vendor online; both businesses can appear in their category searches if other rules pass.",
    ],
  ],
);

caseSteps(
  "MB-03",
  "Multi-business: hide/disable one business if UI allows",
  `${VEND} ${TEST}`,
  [
    [
      "If product allows pause/hide one business, do it.",
      "Hidden business stops appearing in Radar; other still appears.",
    ],
  ],
  "Both",
  "P2",
);

caseSteps(
  "MB-04",
  "Multi-business: admin verifies only selected business",
  `${EN} Admin + multi-biz vendor. ${TEST}`,
  [
    [
      "Admin: Select business to verify → verify one only.",
      "That business Verified; other remains Unverified on Radar.",
    ],
  ],
);

// ---- Phone entry / identity edge ----
caseSteps(
  "ID-01",
  "Edge: order/save prompts phone context copy",
  `${CUST} No phone yet. Trigger phone sheet via save vendor or order if required.`,
  [
    [
      "When phone sheet opens read context.",
      "May show: Your number helps the vendor contact you and track your order. OR Save your number to keep your neighbourhood list across devices.",
    ],
  ],
  "Both",
  "P2",
);

// Write
const out = [H, ...rows].map((r) => r.map(esc).join(",")).join("\n") + "\n";
writeFileSync("docs/manual-test-matrix.csv", out, "utf8");

const ids = [...new Set(rows.map((r) => r[0]))];
const ui = ids.filter((id) => id.includes("-UI-"));
const areas = [...new Set(ids.map((id) => id.split("-")[0]))];
console.log(
  JSON.stringify(
    {
      steps: rows.length,
      cases: ids.length,
      ui_cases: ui.length,
      areas: areas.length,
      area_list: areas.join(","),
    },
    null,
    2,
  ),
);
