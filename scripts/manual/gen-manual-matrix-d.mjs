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

// ========== BILL / KHATA ==========
ui(
  "BL-UI-01",
  "Bill sheet - check all UI elements",
  "1) Vendor opens bill on a fulfilled order.",
  [
    { do: "Open bill sheet.", expect: "Bill form opens." },
    {
      do: "Check amount and items fields.",
      expect: "Amount/items editable.",
    },
    {
      do: "Check payment mode Cash UPI Khata.",
      expect: "Modes available as designed.",
    },
    {
      do: "Check Save Mark paid Add to khata controls.",
      expect: "Relevant actions visible.",
    },
    {
      do: "If edited before check Edited badge / history entry.",
      expect: "History access visible when edited.",
    },
  ],
);

flow(
  "BL-01",
  "Create unpaid bill then mark paid",
  "1) TEST fulfilled order.",
  [
    {
      do: "Create bill with amount as unpaid.",
      expect: "Bill saved unpaid.",
    },
    {
      do: "Mark paid cash or UPI.",
      expect: "Status paid.",
    },
  ],
);

flow(
  "BL-02",
  "Edit fresh unpaid bill without reason",
  "1) Fresh unpaid bill.",
  [
    {
      do: "Change amount and save.",
      expect: "Saves without forcing reason.",
    },
  ],
);

flow(
  "BL-03",
  "Edit paid bill requires reason",
  "1) Paid bill.",
  [
    {
      do: "Change amount save without reason.",
      expect: "Blocked. Asks reason.",
    },
    {
      do: "Enter reason and confirm if asked.",
      expect: "Saves. History shows old to new.",
    },
  ],
);

flow(
  "BL-04",
  "Late edit dialog for backdated paid bill",
  "1) Older paid bill on TEST.",
  [
    {
      do: "Edit and save.",
      expect: "Late-edit confirm dialog then succeeds.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "BL-05",
  "Khata over-correction credit dialog",
  "1) Khata bill edit that over-corrects.",
  [
    {
      do: "Save over-correction.",
      expect: "Credit dialog shows amount. Confirm succeeds.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "BL-06",
  "Edited badge opens history",
  "1) Bill edited at least once.",
  [
    {
      do: "Tap Edited badge.",
      expect: "History shows old and new total plus reason.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "BL-07",
  "Add bill to khata clears orphan for dismiss",
  "1) Unpaid cash bill blocking dismiss.",
  [
    {
      do: "Add to khata.",
      expect: "Dismiss becomes allowed afterward.",
    },
  ],
  "Both",
  "P2",
);

ui(
  "KH-UI-01",
  "Khata ledger screen - check all UI elements",
  "1) Vendor with khata activity.\n2) Open Ledger.",
  [
    { do: "Open Ledger.", expect: "Ledger page loads." },
    {
      do: "Check balance / outstanding.",
      expect: "Balance number visible.",
    },
    {
      do: "Check transaction rows.",
      expect: "Rows show amount mode note business label chip.",
    },
  ],
);

flow(
  "KH-01",
  "Ledger balance matches transactions",
  "1) Known khata history.",
  [
    {
      do: "Compare listed balance vs transaction sum logic.",
      expect: "Balance matches (ask tester if unsure).",
    },
  ],
  "Both",
  "P2",
);

flow(
  "KH-02",
  "Transaction business chip correct",
  "1) Multi-category vendor with bills on different businesses.",
  [
    {
      do: "Check chips on rows.",
      expect: "Correct category/business label each row.",
    },
  ],
  "Both",
  "P2",
);

// ========== RATING ==========
ui(
  "RT-UI-01",
  "Rating sheet - check all UI elements",
  "1) Open Rate on fulfilled order.",
  [
    { do: "Open rating sheet.", expect: "Sheet opens." },
    { do: "Check 5 stars.", expect: "All 5 stars visible." },
    { do: "Check Submit button.", expect: "Submit visible disabled until star." },
    { do: "Check Skip.", expect: "Skip visible." },
    {
      do: "Check comment box if present.",
      expect: "Optional comment field.",
    },
  ],
);

flow("RT-01", "Submit 5-star and 1-star ratings", "1) Two fulfilled orders.", [
  {
    do: "Rate one order 5 stars submit.",
    expect: "Saved.",
  },
  {
    do: "Rate other 1 star submit.",
    expect: "Saved with 1 star.",
  },
]);

flow("RT-02", "Duplicate rating blocked", "1) Already rated order.", [
  {
    do: "Try rate again.",
    expect: "Blocked.",
  },
], "Both", "P2");

flow(
  "RT-03",
  "Vendor reply to review",
  "1) Vendor has a customer review.",
  [
    {
      do: "Open review and reply.",
      expect: "Reply saved. Customer can see reply.",
    },
  ],
  "Both",
  "P2",
);

// ========== LIVE TRACKING ==========
ui(
  "LT-UI-01",
  "Live tracking page - check all UI elements",
  "1) Open tracking for an active Help/delivery order.",
  [
    { do: "Open tracking page.", expect: "Map area loads." },
    {
      do: "Check vendor/helper marker.",
      expect: "Marker visible when location available.",
    },
    {
      do: "Check stopped/stale indicator area.",
      expect: "Stopped state can appear when vendor not moving.",
    },
    {
      do: "Check back navigation.",
      expect: "Can leave tracking page.",
    },
  ],
);

flow("LT-01", "Map updates while vendor moves", "1) Vendor online moving (TEST/real).", [
  {
    do: "Watch map for a minute.",
    expect: "Position updates over time.",
  },
], "Both", "P2");

flow(
  "LT-02",
  "Maps button hidden when completed or cancelled",
  "1) Completed and cancelled orders.",
  [
    {
      do: "Check Open in Maps on those cards.",
      expect: "Maps button not shown.",
    },
  ],
  "Both",
  "P2",
);

// ========== FEED ==========
ui(
  "FD-UI-01",
  "Local Feed screen - check all UI elements",
  "1) Open Feed tab.\n2) Allow location.",
  [
    { do: "Open Feed.", expect: "Feed list or empty state." },
    {
      do: "Check post cards types.",
      expect:
        "Announcement Offer Recommendation layouts distinguishable when present.",
    },
    {
      do: "As vendor check create post entry if available.",
      expect: "Create control for vendor. Customer cannot create vendor offers.",
    },
    {
      do: "Check linked shop on recommendation/offer.",
      expect: "Tap opens vendor when linked.",
    },
  ],
);

flow("FD-01", "Feed loads by radius", "1) Location on.", [
  {
    do: "Open Feed.",
    expect: "Posts within discovery radius or empty state. No crash.",
  },
]);

flow(
  "FD-02",
  "Banned vendor offers excluded",
  "1) Banned vendor posted offer on TEST.",
  [
    {
      do: "Browse Feed as customer nearby.",
      expect: "Banned vendor offer not shown.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "FD-03",
  "Feed notifications toggle off",
  "1) Settings Local Feed.",
  [
    {
      do: "Turn feed notifications OFF.",
      expect: "Announcements suppressed for this device.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "FD-04",
  "Feed notifications on app",
  "1) Android app Settings.",
  [
    {
      do: "Turn ON and allow OS permission.",
      expect: "Permission granted. No crash.",
    },
  ],
  "App",
  "P2",
);

flow(
  "FD-05",
  "Feed notifications on website",
  "1) Chrome website Settings.",
  [
    {
      do: "Turn ON and allow browser notifications.",
      expect: "Browser permission path works.",
    },
  ],
  "Web",
  "P2",
);

flow(
  "FD-06",
  "Vendor creates offer linked to shop",
  "1) Vendor logged in.",
  [
    {
      do: "Create offer post linked to shop.",
      expect: "Appears in feed. Tap opens vendor.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "FD-07",
  "Customer cannot post vendor offers",
  "1) Customer-only session.",
  [
    {
      do: "Look for create vendor offer.",
      expect: "Not available to customer.",
    },
  ],
  "Both",
  "P2",
);

// ========== SETTINGS CUSTOMER ==========
ui(
  "SC-UI-01",
  "Settings customer - check all UI elements",
  "1) Open Settings as customer.",
  [
    { do: "Open Settings.", expect: "Settings heading/tagline visible." },
    {
      do: "Check Register your business card if not vendor.",
      expect: "Register business entry visible for non-vendors.",
    },
    {
      do: "Expand My Account / My Identity.",
      expect: "Phone add/change and device id info visible.",
    },
    {
      do: "Check Account standing.",
      expect: "Standing row/badge visible.",
    },
    {
      do: "Check Delivery addresses section.",
      expect: "List or empty + add address.",
    },
    {
      do: "Check Preferences theme language large text voice.",
      expect: "Theme language large text present. Voice on App.",
    },
    {
      do: "Check Local Feed radius and notification toggles.",
      expect: "Both controls present.",
    },
    {
      do: "Check Privacy policy and Help support links.",
      expect: "Both links present.",
    },
    {
      do: "Scroll to Clear my data and Delete account.",
      expect: "Both near bottom not in main casual flow.",
    },
  ],
);

flow("SC-01", "Add and change phone", "1) Settings My Identity.", [
  {
    do: "Add valid phone.",
    expect: "Phone saved/shown registered.",
  },
  {
    do: "Change phone if offered.",
    expect: "Updates (OTP currently off uses local path).",
  },
]);

flow(
  "SC-02",
  "Restore known number from identity",
  "1) Known existing phone.",
  [
    {
      do: "Enter known number path that offers restore.",
      expect: "Restore offered/works.",
    },
  ],
  "Both",
  "P2",
);

flow("SC-03", "Account standing badge", "1) Good and if possible warned user.", [
  {
    do: "Open standing.",
    expect: "Correct good/warned/banned display.",
  },
], "Both", "P2");

flow(
  "SC-04",
  "Add edit delete delivery address",
  "1) Phone saved (required to save address).",
  [
    {
      do: "Add address Save.",
      expect: "Appears in list.",
    },
    {
      do: "Edit then delete.",
      expect: "Edit saves. Delete removes.",
    },
  ],
);

flow(
  "SC-05",
  "Address save without phone blocked",
  "1) No phone on device.",
  [
    {
      do: "Try save address.",
      expect: "Blocked. Asks for phone.",
    },
  ],
  "Both",
  "P2",
);

flow("SC-06", "Theme and language", "1) Preferences open.", [
  {
    do: "Toggle dark/light. Reopen app.",
    expect: "Theme persists.",
  },
  {
    do: "Switch English Hindi Marathi.",
    expect: "UI strings change each time.",
  },
], "Both", "P2");

flow("SC-07", "Large text toggle", "1) Preferences.", [
  {
    do: "Turn large text on then off.",
    expect: "Text size changes.",
  },
], "Both", "P3");

flow("SC-08", "Voice input language app only", "1) Android Settings.", [
  {
    do: "Change voice input language options.",
    expect: "Options work on App. Not required on Web.",
  },
], "App", "P3");

flow("SC-09", "Feed discovery radius save", "1) Local Feed settings.", [
  {
    do: "Change radius Save.",
    expect: "Saved toast/message. Feed uses new radius.",
  },
], "Both", "P2");

flow("SC-10", "Open privacy and help", "1) Settings.", [
  {
    do: "Open Privacy policy.",
    expect: "Privacy page or canonical link works.",
  },
  {
    do: "Open Help and support.",
    expect: "Help page loads.",
  },
], "Both", "P2");

flow(
  "SC-11",
  "Clear my data",
  "1) TEST disposable session.",
  [
    {
      do: "Confirm Clear my data.",
      expect: "Local/server scoped data cleared per product rules.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "SC-12",
  "Customer delete account",
  "1) TEST disposable customer only.",
  [
    {
      do: "Delete account read warning confirm.",
      expect: "Fresh first-time state. Phone anonymised.",
    },
  ],
);

flow("SC-13", "Register business from Settings", "1) Non-vendor.", [
  {
    do: "Tap Register your business.",
    expect: "Opens vendor sign-up.",
  },
]);

// ========== SETTINGS VENDOR / MY BUSINESS ==========
ui(
  "SV-UI-01",
  "My Business - check all UI elements",
  "1) Logged in as vendor.\n2) Settings My Business.",
  [
    {
      do: "Open My Business tab.",
      expect: "Visible for vendors. Hidden for customer-only.",
    },
    {
      do: "If multi-category check accordion per business.",
      expect: "Each business separate section.",
    },
    {
      do: "Check shop photo re-verify UPI menu cancel reasons note offers radius modes.",
      expect: "Those sections present for a business.",
    },
    {
      do: "Check Refer and Earn if enabled.",
      expect: "Code and credits OR section hidden if disabled.",
    },
  ],
);

flow(
  "SV-01",
  "Edit radius modes cancel reasons note",
  "1) Vendor My Business.",
  [
    {
      do: "Edit radius or modes or reasons or note. Save. Reopen.",
      expect: "Changes persist.",
    },
  ],
);

flow(
  "SV-02",
  "Re-verify shop photo GPS rules",
  "1) At shop location.",
  [
    {
      do: "Re-verify shop photo.",
      expect: "Same GPS match rules as registration.",
    },
  ],
);

flow(
  "SV-03",
  "Menu add edit photo from gallery",
  "1) Delivery business supports menu.",
  [
    {
      do: "Add item with photo from gallery. Edit. Save.",
      expect: "Saved. Error toast if save fails (not silent).",
    },
  ],
  "Both",
  "P2",
);

flow(
  "SV-04",
  "Per-category offers and notes",
  "1) Multi-category vendor.",
  [
    {
      do: "Set different note/offer per category.",
      expect: "Each stays independent.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "SV-05",
  "Update UPI and QR",
  "1) My Business payment section.",
  [
    {
      do: "Update UPI invalid then valid. Optional QR.",
      expect: "Invalid blocked. Valid saves.",
    },
  ],
);

flow(
  "SV-06",
  "Refer and Earn code and pending credits",
  "1) referral_enabled true.",
  [
    {
      do: "Open Refer and Earn.",
      expect: "Code shown. Pending credits labeled pending payout if any.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "SV-07",
  "Refer and Earn hidden when disabled",
  "1) referral_enabled false on TEST.",
  [
    {
      do: "Open Settings vendor areas.",
      expect: "Refer and Earn not shown.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "SV-08",
  "Customer has no Refer and Earn",
  "1) Customer-only.",
  [
    {
      do: "Search Settings for Refer and Earn.",
      expect: "Not present.",
    },
  ],
  "Both",
  "P2",
);

// ========== REFERRALS ==========
ui(
  "RF-UI-01",
  "Referral deep link and registration field UI",
  "1) Know code CODE.\n2) Fresh browser.",
  [
    {
      do: "Open /r/CODE.",
      expect: "App opens. Code stored.",
    },
    {
      do: "Open vendor registration referral field.",
      expect: "Code prefilled uppercase.",
    },
  ],
);

flow(
  "RF-01",
  "Vendor referral creates credits",
  "1) TEST with referrals on.\n2) New vendor uses referrer code.",
  [
    {
      do: "Complete new vendor registration with referrer code.",
      expect: "Referrer gets staged credits (three stages).",
    },
  ],
  "Both",
  "P2",
);

flow(
  "RF-02",
  "User referral credit",
  "1) Customer referral path if product supports.",
  [
    {
      do: "Complete flow that credits referrer vendor.",
      expect: "One credit to referrer.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "RF-03",
  "Duplicate referral blocked",
  "1) Same pair already rewarded.",
  [
    {
      do: "Try refer again.",
      expect: "Graceful block. No double credit.",
    },
  ],
  "Both",
  "P3",
);

// ========== NOTIFICATIONS ==========
ui(
  "NT-UI-01",
  "Notification bell panel - check all UI elements",
  "1) Have at least one notification.",
  [
    { do: "Open bell.", expect: "Panel/list opens." },
    {
      do: "Check unread badge before open.",
      expect: "Badge when unread > 0.",
    },
    {
      do: "Check list order.",
      expect: "Newest first.",
    },
    {
      do: "Check mark all read if available.",
      expect: "Control present.",
    },
  ],
);

flow(
  "NT-01",
  "Order notification deep link to My Orders",
  "1) Vendor accepts customer order. Notifications on.",
  [
    {
      do: "Tap order notification from bell or push.",
      expect: "Opens My Orders.",
    },
  ],
);

flow(
  "NT-02",
  "Vendor notification deep link to Vendor",
  "1) New order for vendor.",
  [
    {
      do: "Tap vendor new-order notification.",
      expect: "Opens Vendor screen.",
    },
  ],
);

flow(
  "NT-03",
  "Feed notification deep link",
  "1) Feed notification exists.",
  [
    {
      do: "Tap feed notification.",
      expect: "Opens Feed.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "NT-04",
  "Expired order notification routes My Orders",
  "1) Expired order notification.",
  [
    {
      do: "Tap it.",
      expect: "Opens My Orders.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "NT-05",
  "Notification copy accept confirm decline",
  "1) Create accept delivery confirm booking decline booking events.",
  [
    {
      do: "Read each customer notification text.",
      expect:
        "Accept has vendor/slot. Confirm has datetime. Decline has clear message.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "NT-06",
  "Hindi user gets Hindi notification",
  "1) User language Hindi. Admin warn or system notify.",
  [
    {
      do: "Trigger notification.",
      expect: "Hindi text.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "NT-07",
  "Near-deadline warning only once",
  "1) TEST near-deadline cron path.",
  [
    {
      do: "Run/observe two cycles for same pair.",
      expect: "Only one near-deadline warning per customer+vendor pair.",
    },
  ],
  "Both",
  "P3",
);

flow(
  "NT-08",
  "Mark all read clears badge",
  "1) Unread notifications exist.",
  [
    {
      do: "Mark all read.",
      expect: "Badge clears.",
    },
  ],
);

flow(
  "NT-09",
  "Website push permission and test",
  "1) Chrome website. Firebase configured.",
  [
    {
      do: "Allow notifications from Settings feed toggle then request test if available.",
      expect: "Token saved path works. Test notification can arrive.",
    },
  ],
  "Web",
  "P2",
);

writeFileSync("docs/_mtm_rows_d.json", JSON.stringify(rows), "utf8");
console.log("partD", rows.length);
