import { writeFileSync } from "node:fs";

const H =
  "Test_ID,Test_Case_Name,Prerequisites,Step_No,What_You_Do,What_Should_Happen,Platform,Priority,Pass_Fail,Notes";
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

// ========== FIRST OPEN ==========
const foPre =
  "1) Fresh install OR clear app data OR Chrome Incognito.\n2) Internet ON.\n3) Read every element before tapping.";

ui("FO-UI-01", "Welcome screen - check all UI elements", foPre, [
  {
    do: "Open the app or website for the first time.",
    expect:
      "A full-screen welcome / first-open screen appears (covers Home underneath).",
  },
  {
    do: "Find the choice for a NEW customer (explore / I am a customer / new user).",
    expect: "That choice is visible and tappable.",
  },
  {
    do: "Find the choice to REGISTER A BUSINESS / become a vendor.",
    expect: "That choice is visible and tappable.",
  },
  {
    do: "Find the choice for RETURNING users (I already have an account / bring back my account).",
    expect: "That choice is visible and tappable.",
  },
  {
    do: "Check layout and text.",
    expect: "No blank white screen. Labels readable. No crash.",
  },
]);

flow("FO-01", "New customer path from welcome", foPre, [
  {
    do: "Tap new customer / explore as customer.",
    expect: "Welcome closes. Home opens.",
  },
  {
    do: "Check bottom menu.",
    expect: "Home Feed Orders Settings visible. Vendor tab not required yet.",
  },
  {
    do: "Force-close app and reopen.",
    expect: "Welcome does NOT show again. Home opens directly.",
  },
]);

flow("FO-02", "New vendor path from welcome", foPre, [
  {
    do: "On a fresh welcome screen tap Register business.",
    expect: "Vendor sign-up form opens (not stuck on Home).",
  },
  {
    do: "Confirm Step 1 fields show.",
    expect: "Name phone UPI and work-from options are visible.",
  },
]);

flow(
  "FO-03",
  "Returning user - phone validation and restore customer",
  "1) Fresh install.\n2) Known EXISTING customer phone from tester.\n3) Also try invalid numbers.",
  [
    {
      do: "Tap returning / bring back account.",
      expect: "Phone entry screen with +91 style input.",
    },
    {
      do: "Enter 12345 and continue.",
      expect: "Error: need 10-digit Indian mobile starting 6-9.",
    },
    {
      do: "Enter 0123456789 and continue.",
      expect: "Error (must start with 6-9).",
    },
    {
      do: "Enter known valid customer phone and continue.",
      expect: "Restore succeeds. Home opens. Phone saved in Settings.",
    },
  ],
);

flow(
  "FO-04",
  "Returning user - phone not found",
  "1) Fresh install.\n2) Unused valid 10-digit phone.",
  [
    {
      do: "Bring back account. Enter unused phone. Continue.",
      expect:
        "Not found / start fresh. Does not pretend old account logged in.",
    },
  ],
);

flow(
  "FO-05",
  "Returning user - active vendor restore",
  "1) Fresh install.\n2) Active vendor phone from tester.",
  [
    {
      do: "Bring back with vendor phone.",
      expect: "Vendor tab appears in bottom menu.",
    },
    {
      do: "Open Vendor tab.",
      expect: "Vendor screen loads (online switch / orders area).",
    },
  ],
);

flow(
  "FO-06",
  "Returning user - offline vendor still restores",
  "1) Fresh install.\n2) Vendor phone that is offline.",
  [
    {
      do: "Bring back with offline vendor phone.",
      expect: "Vendor session still restored. Vendor tab works.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "FO-07",
  "Returning user - hidden vendor still restores",
  "1) Fresh install.\n2) Vendor with discoverable off.",
  [
    {
      do: "Bring back with hidden vendor phone.",
      expect: "Vendor session restored even if not public in search.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "FO-08",
  "Returning user - banned or deleted vendor",
  "1) Fresh install.\n2) Banned or deleted vendor phone.",
  [
    {
      do: "Bring back with that phone.",
      expect:
        "Customer may restore but vendor controls NOT restored for banned/deleted vendor.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "FO-09",
  "Returning user - banned customer blocked",
  "1) Fresh install.\n2) Banned customer phone.",
  [
    {
      do: "Bring back with banned customer phone.",
      expect: "Blocked. Phone not saved as logged-in customer.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "FO-10",
  "Returning user - dual role same phone",
  "1) Fresh install.\n2) Phone that is both customer and vendor.",
  [
    {
      do: "Bring back with that phone.",
      expect: "Both customer and vendor restored together.",
    },
  ],
  "Both",
  "P2",
);

flow("FO-11", "Skip restore / start fresh", foPre, [
  {
    do: "If offered Skip or start fresh without phone use it.",
    expect: "Home opens with no restored phone.",
  },
  {
    do: "Reopen app.",
    expect: "Welcome not shown again.",
  },
], "Both", "P2");

flow(
  "FO-12",
  "Notification permission on Android app only",
  "1) Fresh install on Android app.\n2) Path that asks notifications.",
  [
    {
      do: "When notification step appears tap Allow.",
      expect: "OS permission dialog. Flow continues to Home after.",
    },
  ],
  "App",
  "P2",
);

flow(
  "FO-13",
  "Website skips native notification tour",
  "1) Fresh path on website Chrome.",
  [
    {
      do: "Complete welcome as new customer.",
      expect: "No Android-style notification tour. Goes to Home.",
    },
  ],
  "Web",
  "P2",
);

// ========== VENDOR REG ==========
const vrPre =
  "1) Open vendor sign-up (Settings > Register business OR welcome Register business).\n2) Not already logged in as vendor.\n3) Prefer TEST environment.";

ui("VR-UI-01", "Vendor sign-up Step 1 - check all UI elements", vrPre, [
  {
    do: "Open Step 1 (Your details).",
    expect: "Shows Step 1 of 2 or similar.",
  },
  { do: "Check Owner name field.", expect: "Name field with placeholder." },
  { do: "Check Phone field.", expect: "Phone field with +91 style entry." },
  { do: "Check UPI ID field.", expect: "UPI field visible." },
  {
    do: "Check UPI QR upload control.",
    expect: "Optional QR upload button visible.",
  },
  {
    do: "Check Work from: Shop Home No fixed place.",
    expect: "All three choices visible.",
  },
  {
    do: "Select Shop. Check Capture location.",
    expect: "Capture shop location button appears.",
  },
  {
    do: "Check Selfie capture.",
    expect: "Selfie capture button visible.",
  },
  {
    do: "Check Referral code field if referrals enabled.",
    expect: "Field visible OR hidden if feature off (be consistent).",
  },
  {
    do: "Check Next button.",
    expect: "Next visible (may look disabled until required filled).",
  },
]);

ui(
  "VR-UI-02",
  "Vendor sign-up Step 2 - check all UI elements",
  vrPre + "\n4) Complete Step 1 enough to reach Step 2 on TEST.",
  [
    { do: "Reach Step 2 Your business.", expect: "Step 2 title visible." },
    {
      do: "Check description box and Find category button.",
      expect: "Both visible.",
    },
    {
      do: "Check Browse categories manually.",
      expect: "Manual browse available.",
    },
    {
      do: "Check Shop name or Brand name field.",
      expect: "Matches Shop vs Home choice.",
    },
    {
      do: "Check Who travels options.",
      expect: "Customer comes / You go / Both visible.",
    },
    {
      do: "If you travel check service radius chips.",
      expect: "Radius options appear when needed.",
    },
    {
      do: "After picking category check Help Delivery Appointment availability.",
      expect: "Availability selectors visible.",
    },
    {
      do: "Check cancel reason fields (up to 4).",
      expect: "Up to 4 reason inputs.",
    },
    { do: "Check vendor note box.", expect: "Note box visible." },
    {
      do: "Check shop photo capture.",
      expect: "Shop photo / verify button visible.",
    },
    { do: "Check Register / Submit.", expect: "Final submit visible." },
  ],
);

flow("VR-01", "UPI format validation", vrPre, [
  {
    do: "Enter invalid UPI like abc and leave the field.",
    expect: "Inline error invalid UPI format.",
  },
  {
    do: "Enter valid UPI like test@okhdfcbank and leave field.",
    expect: "Error clears.",
  },
]);

flow(
  "VR-02",
  "Duplicate phone shows already registered",
  vrPre + "\n4) Use phone already registered as vendor.",
  [
    {
      do: "Fill Step 1 with duplicate phone and try continue/register.",
      expect:
        "Duplicate message. Already registered / Find account link shown or highlighted.",
    },
  ],
);

flow("VR-03", "Work from Shop requires location", vrPre, [
  {
    do: "Choose Shop. Skip location. Fill other fields. Try Next.",
    expect: "Cannot proceed until location captured.",
  },
  {
    do: "Tap Capture location. Allow GPS.",
    expect: "Shows Location set with coordinates.",
  },
]);

flow("VR-04", "Work from Home requires location", vrPre, [
  {
    do: "Choose Home. Capture location.",
    expect: "Location set. Home/private hint may show.",
  },
], "Both", "P2");

flow("VR-05", "No fixed place path", vrPre, [
  {
    do: "Choose No fixed place.",
    expect: "No shop GPS button. Visiting GPS hint may show.",
  },
], "Both", "P2");

flow("VR-06", "Selfie required on app", vrPre, [
  {
    do: "On Android app try Next without selfie.",
    expect: "Blocked until selfie captured.",
  },
  {
    do: "Capture selfie with front camera.",
    expect: "Preview shows. Next can enable when other fields OK.",
  },
], "App", "P1");

flow("VR-07", "Optional UPI QR upload", vrPre, [
  {
    do: "Upload a UPI QR image if available.",
    expect: "UPI fills from QR OR clear error if invalid QR.",
  },
], "Both", "P2");

flow(
  "VR-08",
  "AI find category from description",
  vrPre + "\n4) Reach Step 2.",
  [
    {
      do: "Type I repair mobile phones. Tap Find category.",
      expect: "Suggestion card with a category.",
    },
    {
      do: "Confirm suggestion.",
      expect: "Category shown as selected.",
    },
  ],
);

flow(
  "VR-09",
  "Manual category browse and max limit",
  vrPre + "\n4) Step 2.",
  [
    {
      do: "Browse manual. Select one category.",
      expect: "Category chip selected.",
    },
    {
      do: "Try select more than allowed maximum.",
      expect: "Extra selections blocked at max.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "VR-10",
  "Suggest brand new category",
  vrPre + "\n4) Step 2. Describe something not in list.",
  [
    {
      do: "Describe unusual business. Find category until new suggested.",
      expect:
        "Confirm new category. After register it waits for admin approval.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "VR-11",
  "Shop name required for shop base",
  vrPre + "\n4) Shop base + Step 2.",
  [
    {
      do: "Leave shop name empty. Try Register.",
      expect: "Validation blocks empty shop name.",
    },
  ],
);

flow(
  "VR-12",
  "Brand name for home base",
  vrPre + "\n4) Home base + Step 2.",
  [
    {
      do: "Enter brand name when home-based.",
      expect: "Accepted when other fields OK.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "VR-13",
  "Reach choice and radius",
  vrPre + "\n4) Step 2 category selected.",
  [
    {
      do: "Choose You go to customer. Set radius.",
      expect: "Radius required and selectable.",
    },
    {
      do: "Choose Customer comes to you.",
      expect: "Radius may hide if not needed.",
    },
  ],
);

flow(
  "VR-14",
  "Availability Help Delivery Appointment",
  vrPre + "\n4) Step 2 with category.",
  [
    {
      do: "Select Help only for a help category.",
      expect: "Help selected for that category.",
    },
    {
      do: "For delivery-capable category enable Delivery.",
      expect: "Delivery selected.",
    },
    {
      do: "For booking category enable Appointment.",
      expect: "Appointment selected.",
    },
  ],
);

flow(
  "VR-15",
  "Cancel reasons and vendor note limits",
  vrPre + "\n4) Step 2.",
  [
    {
      do: "Type more than 60 characters in a cancel reason.",
      expect: "Stops at 60 or shows limit.",
    },
    {
      do: "Type more than 100 characters in vendor note.",
      expect: "Stops at 100 or shows limit.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "VR-16",
  "Shop photo GPS must match location",
  "1) TEST preferred.\n2) Step 2 with location captured at place A.",
  [
    {
      do: "Take shop photo at the same place.",
      expect: "Photo accepted.",
    },
  ],
);

flow(
  "VR-17",
  "Shop photo GPS mismatch then submit for review",
  "1) TEST.\n2) Location at place A. Photo from far place B.",
  [
    {
      do: "Fail photo match twice.",
      expect: "After 2 fails Submit for review appears.",
    },
    {
      do: "Tap Submit for review and Register.",
      expect: "Registers with pending location review note.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "VR-18",
  "Full happy path shop Help vendor",
  "1) TEST.\n2) Unused phone.\n3) At shop with GPS.\n4) Valid UPI.",
  [
    {
      do: "Complete Step 1 Shop + location + selfie + Next.",
      expect: "Step 2 opens.",
    },
    {
      do: "Pick Help category shop name reach availability photo Register.",
      expect: "Success. Vendor screen shows Welcome / No orders yet.",
    },
  ],
);

flow(
  "VR-19",
  "Register Delivery category vendor",
  "1) TEST. Unused phone. Shop base.",
  [
    {
      do: "Complete registration with Delivery availability.",
      expect: "Vendor created. Can take delivery orders later.",
    },
  ],
);

flow(
  "VR-20",
  "Register Appointment category vendor",
  "1) TEST. Unused phone.",
  [
    {
      do: "Complete registration with Appointment availability.",
      expect: "Vendor created. Can take booking orders later.",
    },
  ],
);

flow(
  "VR-21",
  "Referral code prefilled and cannot use own",
  "1) Open /r/OTHERCODE first.\n2) Start registration.\n3) Referrals enabled.",
  [
    {
      do: "Check referral field.",
      expect: "Code prefilled uppercase.",
    },
    {
      do: "Try use own referral on a separate already-coded account test.",
      expect: "Own code rejected.",
    },
  ],
  "Both",
  "P2",
);

// ========== VENDOR LOGIN ==========
ui(
  "VL-UI-01",
  "Vendor find-account screen - check all UI elements",
  "1) Open Vendor without being logged in.\n2) Tap Already registered.",
  [
    {
      do: "Open find account form.",
      expect: "Title Find account / similar visible.",
    },
    { do: "Check phone input.", expect: "+91 and max 10 digits." },
    { do: "Check Submit / Find button.", expect: "Submit visible." },
    {
      do: "Check Back to registration.",
      expect: "Returns to sign-up form.",
    },
    {
      do: "Check error area before submit.",
      expect: "No error text until a failed submit.",
    },
  ],
);

flow(
  "VL-01",
  "Login success with registered phone",
  "1) Known vendor phone.\n2) Find account form open.",
  [
    {
      do: "Enter phone. Submit.",
      expect: "Vendor screen loads with orders area.",
    },
  ],
);

flow("VL-02", "Login unknown phone", "1) Find account open.", [
  {
    do: "Enter 9876500000. Submit.",
    expect: "No vendor found. Please register first. Stay on form.",
  },
]);

flow("VL-03", "Login invalid format", "1) Find account open.", [
  { do: "Enter 123. Submit.", expect: "Invalid phone message." },
], "Both", "P2");

flow(
  "VL-04",
  "Login banned vendor",
  "1) Banned vendor phone on TEST.",
  [
    {
      do: "Submit banned phone.",
      expect: "Login denied with reason.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "VL-05",
  "Hidden vendor recovers via find account",
  "1) Hidden vendor.\n2) Device without stored phone.",
  [
    {
      do: "Find account with that phone.",
      expect: "Session restores. No forced logout loop.",
    },
  ],
  "Both",
  "P2",
);

writeFileSync(
  "docs/_mtm_gen_partial.js",
  `export const partialCount = ${rows.length};\n`,
);
writeFileSync("docs/_mtm_rows_a.json", JSON.stringify(rows), "utf8");
console.log("partA", rows.length);
