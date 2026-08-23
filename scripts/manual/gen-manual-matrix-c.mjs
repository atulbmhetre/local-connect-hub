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

// ========== MY ORDERS ==========
ui(
  "MO-UI-01",
  "My Orders screen - check all UI elements",
  "1) Customer with at least one past or active order if possible.\n2) Open My Orders tab.",
  [
    { do: "Open My Orders.", expect: "Orders list or empty state." },
    {
      do: "If orders exist check one card.",
      expect:
        "Shows vendor/shop status badge time/slot message actions as relevant.",
    },
    {
      do: "Check filters/sections if any (active vs past).",
      expect: "Sections make sense or single list is clear.",
    },
    {
      do: "On Sent order check available actions.",
      expect: "Cancel may show. Rate must NOT show.",
    },
    {
      do: "On Completed order check Rate and payment actions if unpaid.",
      expect: "Rate visible when fulfilled. Pay/I have paid if unpaid bill.",
    },
    {
      do: "Check tracking / Open maps if order supports it.",
      expect: "Tracking/maps entry when rules allow.",
    },
    {
      do: "Check Remove/Dismiss control when shown.",
      expect: "Dismiss only when rules allow.",
    },
  ],
);

flow(
  "MO-01",
  "Help order Sent to Accepted to Done",
  "1) Customer placed Help order.\n2) Vendor can accept on second device/session.",
  [
    { do: "Customer opens My Orders after place.", expect: "Status Sent." },
    {
      do: "Vendor Accepts. Customer refreshes.",
      expect: "Status Accepted.",
    },
    {
      do: "Vendor Marks done. Customer refreshes.",
      expect: "Completed/Fulfilled. Rate may appear.",
    },
  ],
);

flow(
  "MO-02",
  "Help overdue indicator",
  "1) Help order Accepted for more than about 2 hours (TEST seed).",
  [
    {
      do: "Open My Orders card.",
      expect: "Overdue warning/indicator visible.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "MO-03",
  "Customer cancel Help before vendor starts",
  "1) Help order Accepted. Vendor has NOT started.",
  [
    {
      do: "Customer Cancels.",
      expect: "Cancel succeeds. Status Cancelled.",
    },
  ],
);

flow(
  "MO-04",
  "Customer cannot cancel Help after vendor starts",
  "1) Help order Accepted. Vendor tapped Started.",
  [
    {
      do: "Customer tries Cancel.",
      expect: "Cancel blocked with explanation.",
    },
  ],
);

flow(
  "MO-05",
  "Delivery order status flow",
  "1) Delivery order placed. Vendor can accept.",
  [
    {
      do: "Watch statuses Sent then Seen then Accepted then Done.",
      expect: "Badges update. Slot remains visible on card.",
    },
  ],
);

flow(
  "MO-06",
  "Delivery overdue slot indicator",
  "1) Accepted delivery past slot deadline (TEST).",
  [
    {
      do: "Open card.",
      expect: "Overdue indicator for slot.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "MO-07",
  "Delivery cancel rules ASAP vs morning",
  "1) Know ASAP accepted order and morning-slot order on TEST.",
  [
    {
      do: "Try cancel ASAP accepted delivery.",
      expect: "Usually blocked.",
    },
    {
      do: "Try cancel morning slot before window per rules.",
      expect: "Allowed or blocked exactly per product rule (note result).",
    },
  ],
);

flow(
  "MO-08",
  "Booking status confirmed and declined",
  "1) Two booking orders or repeat test.",
  [
    {
      do: "Vendor confirms one booking. Customer checks My Orders.",
      expect: "Confirmed status + appointment time.",
    },
    {
      do: "Vendor declines other. Customer checks.",
      expect: "Declined/cancelled. Notification received if enabled.",
    },
  ],
);

flow(
  "MO-09",
  "Booking overdue appointment indicator",
  "1) Confirmed booking past appointment time.",
  [{ do: "Open card.", expect: "Overdue indicator." }],
  "Both",
  "P2",
);

flow(
  "MO-10",
  "I have paid clears UPI block",
  "1) Blocked by unpaid UPI >48h.",
  [
    {
      do: "In My Orders tap I have paid on that bill.",
      expect: "Block clears. New orders allowed.",
    },
  ],
);

flow(
  "MO-11",
  "Old cash bill never blocks",
  "1) Unpaid cash bill older than 48h.",
  [
    {
      do: "Try place a new order.",
      expect: "NOT blocked by cash bill age.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "MO-12",
  "Disputed bill does not re-block",
  "1) Bill marked disputed on TEST.",
  [
    {
      do: "Try place new order.",
      expect: "Not blocked again by that disputed bill.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "MO-13",
  "Pay Now / UPI panel",
  "1) Unpaid UPI bill on order.",
  [
    {
      do: "Open Pay now / UPI payment UI.",
      expect: "QR or UPI app open path. Web has fallback.",
    },
  ],
);

flow("MO-14", "Open live tracking from order", "1) Active trackable order.", [
  {
    do: "Tap Track / live map entry.",
    expect: "Tracking map page loads.",
  },
], "Both", "P2");

flow("MO-15", "Rate completed order", "1) Fulfilled order.", [
  {
    do: "Tap Rate. Try submit with no stars.",
    expect: "Submit disabled or error.",
  },
  {
    do: "Select stars and submit.",
    expect: "Rating saved.",
  },
]);

flow("MO-16", "Skip rating", "1) Rating sheet open.", [
  {
    do: "Tap Skip.",
    expect: "Closes. No rating saved.",
  },
], "Both", "P2");

flow(
  "MO-17",
  "No rate on Sent or Cancelled",
  "1) Sent order and Cancelled order.",
  [
    {
      do: "Inspect both cards.",
      expect: "No Rate button.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "MO-18",
  "Dismiss cancelled order without unpaid bill",
  "1) Cancelled order no unpaid cash/UPI.",
  [
    {
      do: "Dismiss/Remove.",
      expect: "Removed from list.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "MO-19",
  "Cannot dismiss with unpaid bill",
  "1) Order with unpaid cash/UPI bill.",
  [
    {
      do: "Try Dismiss.",
      expect: "Blocked until paid or moved to khata.",
    },
  ],
);

// ========== VENDOR MODE ==========
ui(
  "VM-UI-01",
  "Vendor main screen - check all UI elements",
  "1) Logged in as vendor.\n2) Open Vendor tab.",
  [
    { do: "Open Vendor screen.", expect: "Header Vendor mode / tagline." },
    {
      do: "Check back-to-home control.",
      expect: "Back control visible.",
    },
    {
      do: "Check Online / Go live switch and status badge.",
      expect: "Online switch and status text/badge visible.",
    },
    {
      do: "Check notification bell.",
      expect: "Bell visible.",
    },
    {
      do: "Check incoming orders list or empty state.",
      expect: "Orders list OR No orders yet message.",
    },
    {
      do: "Check service mode label area.",
      expect: "Help / Delivery / Booking label makes sense.",
    },
    {
      do: "On website confirm no native 5-step permission tour.",
      expect: "Native onboarding skipped on Web.",
    },
  ],
);

flow(
  "VM-01",
  "Go online and offline",
  "1) Vendor not banned.\n2) Location allowed.",
  [
    {
      do: "Tap Go online.",
      expect: "Status Online. Location sharing starts.",
    },
    { do: "Tap Go offline.", expect: "Status Offline." },
  ],
);

flow(
  "VM-02",
  "Cannot silent offline with active accepted job",
  "1) Vendor has Accepted active order.",
  [
    {
      do: "Try Go offline.",
      expect: "Warned or blocked. Cannot disappear silently.",
    },
  ],
);

flow(
  "VM-03",
  "Offline with today sent delivery notifies customer",
  "1) Today sent delivery order exists.",
  [
    {
      do: "Vendor goes offline.",
      expect: "Customer notified.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "VM-04",
  "Offline with tomorrow delivery does not notify",
  "1) Tomorrow delivery order only.",
  [
    {
      do: "Vendor goes offline.",
      expect: "Customer NOT notified for tomorrow-only case.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "VM-05",
  "Offline with pending Help notifies customer",
  "1) Pending Help request.",
  [
    {
      do: "Vendor goes offline.",
      expect: "Customer notified.",
    },
  ],
  "Both",
  "P2",
);

flow("VM-06", "Banned vendor cannot go online", "1) Banned vendor login.", [
  {
    do: "Try Go online.",
    expect: "Blocked. Banned badge/message.",
  },
]);

flow(
  "VM-07",
  "Unverified vendor can still go online with nudge",
  "1) Unverified vendor.",
  [
    {
      do: "Go online.",
      expect: "Nudge/warning shown but can go online.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "VM-08",
  "Draft vendor missing GPS amber banner",
  "1) Vendor missing location data.",
  [
    {
      do: "Open Vendor screen.",
      expect: "Amber/yellow warning banner.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "VM-09",
  "Website Help vendor location while tab visible",
  "1) Help vendor on Chrome.\n2) Go online.",
  [
    {
      do: "Stay on tab visible.",
      expect: "Location can update (heartbeat).",
    },
    {
      do: "Switch to another tab/minimize.",
      expect: "Updates pause while hidden.",
    },
  ],
  "Web",
  "P2",
);

flow("VM-10", "Empty incoming orders state", "1) Vendor with no orders.", [
  {
    do: "Open Vendor.",
    expect: "No orders yet empty state.",
  },
], "Both", "P2");

flow(
  "VM-11",
  "Native onboarding tour app only",
  "1) New vendor on Android after register.",
  [
    {
      do: "Observe permission tour if shown.",
      expect: "Steps for notifications/location/camera etc. Skipped on Web.",
    },
  ],
  "App",
  "P2",
);

flow("VM-12", "New order increments bell", "1) Vendor online. Customer places order.", [
  {
    do: "Watch vendor bell after new order.",
    expect: "Badge/count increases.",
  },
]);

// ========== INCOMING ORDERS ==========
ui(
  "IO-UI-01",
  "Incoming order card - check all UI elements",
  "1) Vendor has at least one incoming order of each mode if possible.",
  [
    {
      do: "Open a Help order card.",
      expect:
        "Shows customer message status Accept Decline category chip.",
    },
    {
      do: "Open a Delivery order card.",
      expect: "Shows address/slot Open in Maps when allowed Accept/Done.",
    },
    {
      do: "Open a Booking order card.",
      expect: "Shows appointment time Confirm Decline.",
    },
    {
      do: "Check Load more if many orders.",
      expect: "Load more control or paging works.",
    },
    {
      do: "On fulfilled card check Flag customer if present.",
      expect: "Flag only on fulfilled not on Sent.",
    },
  ],
);

flow(
  "IO-01",
  "Help accept start done",
  "1) Help order Sent to this vendor.",
  [
    {
      do: "Accept order.",
      expect: "Status Accepted. Customer notified.",
    },
    {
      do: "Mark started if available then Mark done.",
      expect: "Completed. Customer notified.",
    },
  ],
);

flow(
  "IO-02",
  "Help vendor cancel needs reason",
  "1) Cancellable Help order.\n2) Cancel reasons configured.",
  [
    {
      do: "Cancel without reason.",
      expect: "Blocked if reason required.",
    },
    {
      do: "Pick reason and cancel.",
      expect: "Cancelled successfully.",
    },
  ],
);

flow(
  "IO-03",
  "Delivery bulk seen then accept done",
  "1) Delivery order Sent.",
  [
    {
      do: "Open vendor orders tab (bulk seen).",
      expect: "Sent becomes Seen. Customer NOT notified for bulk seen.",
    },
    {
      do: "Accept then Mark done.",
      expect: "Customer notified on accept and done.",
    },
  ],
);

flow(
  "IO-04",
  "Booking confirm and decline",
  "1) Two booking orders or repeat.",
  [
    {
      do: "Confirm one.",
      expect: "Confirmed. Customer notified.",
    },
    {
      do: "Decline other.",
      expect: "Declined. Customer notified.",
    },
  ],
);

flow(
  "IO-05",
  "Soft overlap note for close appointments",
  "1) Two active appointments within about 30 minutes.",
  [
    {
      do: "Open one appointment card.",
      expect:
        "Soft note about another appointment nearby. Actions still work.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "IO-06",
  "Load more older orders",
  "1) Vendor with more than one page of orders (TEST seed).",
  [
    {
      do: "Scroll / Load more.",
      expect: "Older orders appear not silently dropped.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "IO-07",
  "Category chip matches order",
  "1) Order with known category.",
  [
    {
      do: "Check chip on card.",
      expect: "Matches order category.",
    },
  ],
  "Both",
  "P2",
);

flow(
  "IO-08",
  "Open in Maps delivery with coordinates",
  "1) Delivery order with GPS coords.\n2) Android preferred.",
  [
    {
      do: "Tap Open in Maps.",
      expect: "Maps opens to coordinates.",
    },
  ],
  "App",
  "P2",
);

flow(
  "IO-09",
  "Open in Maps address only",
  "1) Delivery order address no coords.",
  [
    {
      do: "Tap Open in Maps.",
      expect: "Address search link opens.",
    },
  ],
  "App",
  "P2",
);

flow(
  "IO-10",
  "No Maps when customer will come to shop",
  "1) Booking where customer visits shop.",
  [
    {
      do: "Inspect vendor card actions.",
      expect: "Open in Maps NOT shown for vendor.",
    },
  ],
  "App",
  "P2",
);

flow(
  "IO-11",
  "Flag customer only on fulfilled",
  "1) One Sent and one Fulfilled order.",
  [
    {
      do: "Compare Flag button.",
      expect: "Only on fulfilled.",
    },
  ],
  "Both",
  "P2",
);

writeFileSync("docs/_mtm_rows_c.json", JSON.stringify(rows), "utf8");
console.log("partC", rows.length);
