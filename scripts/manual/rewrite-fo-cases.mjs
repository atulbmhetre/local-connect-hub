import { readFileSync, writeFileSync } from "node:fs";

function parseCsv(text) {
  const rows = [];
  let i = 0;
  const len = text.length;
  while (i < len) {
    const row = [];
    while (i < len) {
      let cell = "";
      if (text[i] === '"') {
        i++;
        while (i < len) {
          if (text[i] === '"' && text[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          if (text[i] === '"') {
            i++;
            break;
          }
          cell += text[i++];
        }
      } else {
        while (
          i < len &&
          text[i] !== "," &&
          text[i] !== "\n" &&
          text[i] !== "\r"
        ) {
          cell += text[i++];
        }
      }
      row.push(cell);
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "\r") i++;
      if (text[i] === "\n") {
        i++;
        break;
      }
      break;
    }
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

function esc(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

const rows = parseCsv(readFileSync("docs/manual-test-matrix.csv", "utf8"));
const header = rows[0];
const rest = rows.slice(1).filter((r) => !String(r[0]).startsWith("FO-"));

const fo = [];
const add = (
  id,
  name,
  pre,
  step,
  do_,
  expect,
  plat = "Both",
  pri = "P1",
) => {
  fo.push([id, name, pre, String(step), do_, expect, plat, pri, "", ""]);
};

const PRE_FRESH =
  "Language = English. Fresh install OR clear app data OR Chrome Incognito. Internet ON.";

add(
  "FO-UI-01",
  "First screen UI - exact buttons visible",
  PRE_FRESH,
  1,
  "Open the app (or website) for the first time.",
  "A full-screen first-open overlay appears (covers Home).",
);
add(
  "FO-UI-01",
  "First screen UI - exact buttons visible",
  PRE_FRESH,
  2,
  "Look at the buttons on this first screen. Do not tap yet.",
  "Exactly 2 buttons with this exact English text: (1) I'm new here (2) I've used Aaspaas before. No third button on this screen.",
);

add(
  "FO-UI-02",
  "I'm new here screen UI - exact title and buttons",
  PRE_FRESH,
  1,
  "On the first screen tap: I'm new here",
  "Next screen opens. Exact title: How do you want to start?",
);
add(
  "FO-UI-02",
  "I'm new here screen UI - exact title and buttons",
  PRE_FRESH,
  2,
  "Check all controls on this screen. Do not tap Register or Use as customer yet.",
  "Exact controls: (1) Register your business (2) Use Aaspaas as a customer (3) Back",
);

add(
  "FO-UI-03",
  "I've used Aaspaas before screen UI - restore account",
  PRE_FRESH,
  1,
  "On the first screen tap: I've used Aaspaas before",
  "Restore screen opens (this is a second screen, not on the first screen).",
);
add(
  "FO-UI-03",
  "I've used Aaspaas before screen UI - restore account",
  PRE_FRESH,
  2,
  "Check every element on this screen.",
  "Exact title: Restore your account. Exact subtitle: Enter your mobile number. Phone row shows +91 and number box with placeholder 98765 43210. Exact primary button: Restore my account. Exact bottom link: Back.",
);

add(
  "FO-01",
  "New customer: I'm new here then Use Aaspaas as a customer",
  PRE_FRESH +
    " Prefer website for this case, OR on Android expect a notification screen after step 2.",
  1,
  "Tap: I'm new here",
  "Title shows: How do you want to start?",
);
add(
  "FO-01",
  "New customer: I'm new here then Use Aaspaas as a customer",
  PRE_FRESH +
    " Prefer website for this case, OR on Android expect a notification screen after step 2.",
  2,
  "Tap: Use Aaspaas as a customer",
  "Website: Home opens (search + categories + bottom menu). Android app: may show notification screen titled Stay updated on your orders before Home.",
);
add(
  "FO-01",
  "New customer: I'm new here then Use Aaspaas as a customer",
  PRE_FRESH +
    " Prefer website for this case, OR on Android expect a notification screen after step 2.",
  3,
  "If Android notification screen appears, tap: Not now (or Allow notifications).",
  "Home opens.",
);
add(
  "FO-01",
  "New customer: I'm new here then Use Aaspaas as a customer",
  PRE_FRESH +
    " Prefer website for this case, OR on Android expect a notification screen after step 2.",
  4,
  "Force-close and open the app/site again (same device, data kept).",
  "First-open screen does NOT appear again. Home opens directly.",
);

add(
  "FO-02",
  "New vendor: I'm new here then Register your business",
  PRE_FRESH,
  1,
  "Tap: I'm new here",
  "Title: How do you want to start?",
);
add(
  "FO-02",
  "New vendor: I'm new here then Register your business",
  PRE_FRESH,
  2,
  "Tap: Register your business",
  "Vendor registration screen opens (sign-up form). Not stuck on Home.",
);

add(
  "FO-03",
  "Restore account: invalid phone then valid customer phone",
  PRE_FRESH +
    " Ask tester for a known EXISTING customer phone that is not banned.",
  1,
  "Tap: I've used Aaspaas before",
  "Restore screen shows title Restore your account and button Restore my account.",
);
add(
  "FO-03",
  "Restore account: invalid phone then valid customer phone",
  PRE_FRESH +
    " Ask tester for a known EXISTING customer phone that is not banned.",
  2,
  "Enter 12345. Tap: Restore my account",
  "An error is shown. Account is not restored.",
);
add(
  "FO-03",
  "Restore account: invalid phone then valid customer phone",
  PRE_FRESH +
    " Ask tester for a known EXISTING customer phone that is not banned.",
  3,
  "Clear field. Enter 0123456789. Tap: Restore my account",
  "An error is shown (number must be a valid 10-digit Indian mobile starting 6-9).",
);
add(
  "FO-03",
  "Restore account: invalid phone then valid customer phone",
  PRE_FRESH +
    " Ask tester for a known EXISTING customer phone that is not banned.",
  4,
  "Enter the known existing customer phone. Tap: Restore my account",
  "Home opens (Android may show Stay updated on your orders first). Phone is saved in Settings identity.",
);

add(
  "FO-04",
  "Restore account: phone not found",
  PRE_FRESH +
    " Use a 10-digit unused phone starting 6-9 that is NOT in the system.",
  1,
  "Tap: I've used Aaspaas before. Enter unused phone. Tap: Restore my account",
  "Exact message: No account found. Starting fresh. Button Continue is shown.",
);
add(
  "FO-04",
  "Restore account: phone not found",
  PRE_FRESH +
    " Use a 10-digit unused phone starting 6-9 that is NOT in the system.",
  2,
  "Tap: Continue",
  "Flow continues toward Home (Android may show notification screen first).",
);

add(
  "FO-05",
  "Restore account: active vendor phone",
  PRE_FRESH + " Ask tester for an ACTIVE vendor phone.",
  1,
  "Tap: I've used Aaspaas before. Enter vendor phone. Tap: Restore my account",
  "Account restores. Bottom menu shows Vendor tab.",
);
add(
  "FO-05",
  "Restore account: active vendor phone",
  PRE_FRESH + " Ask tester for an ACTIVE vendor phone.",
  2,
  "Tap Vendor tab.",
  "Vendor screen loads (online switch / orders area).",
);

add(
  "FO-06",
  "Restore account: offline vendor phone",
  PRE_FRESH + " Vendor phone that exists but is offline.",
  1,
  "Tap: I've used Aaspaas before. Enter phone. Tap: Restore my account",
  "Vendor session still restores. Vendor tab works.",
  "Both",
  "P2",
);

add(
  "FO-07",
  "Restore account: hidden vendor phone",
  PRE_FRESH + " Vendor with discoverable off.",
  1,
  "Tap: I've used Aaspaas before. Enter phone. Tap: Restore my account",
  "Vendor session restores even if shop is hidden from public search.",
  "Both",
  "P2",
);

add(
  "FO-08",
  "Restore account: banned or deleted vendor",
  PRE_FRESH + " Banned or deleted vendor phone from tester.",
  1,
  "Tap: I've used Aaspaas before. Enter phone. Tap: Restore my account",
  "Customer may restore but vendor login is NOT restored. No normal Go online session for that banned/deleted vendor.",
  "Both",
  "P2",
);

add(
  "FO-09",
  "Restore account: banned customer blocked",
  PRE_FRESH + " Banned customer phone from tester.",
  1,
  "Tap: I've used Aaspaas before. Enter banned customer phone. Tap: Restore my account",
  "Restore blocked. Phone is not kept as a logged-in customer.",
  "Both",
  "P2",
);

add(
  "FO-10",
  "Restore account: phone is customer and vendor",
  PRE_FRESH + " Dual-role phone from tester.",
  1,
  "Tap: I've used Aaspaas before. Enter phone. Tap: Restore my account",
  "Both customer and vendor restored. Vendor tab appears.",
  "Both",
  "P2",
);

add(
  "FO-11",
  "Back from restore returns to first screen",
  PRE_FRESH,
  1,
  "Tap: I've used Aaspaas before",
  "Restore screen opens.",
);
add(
  "FO-11",
  "Back from restore returns to first screen",
  PRE_FRESH,
  2,
  "Tap: Back",
  "Returns to first screen with exactly: I'm new here and I've used Aaspaas before.",
  "Both",
  "P2",
);

add(
  "FO-12",
  "Back from How do you want to start returns to first screen",
  PRE_FRESH,
  1,
  "Tap: I'm new here",
  "Title: How do you want to start?",
);
add(
  "FO-12",
  "Back from How do you want to start returns to first screen",
  PRE_FRESH,
  2,
  "Tap: Back",
  "Returns to first screen with I'm new here and I've used Aaspaas before.",
  "Both",
  "P2",
);

add(
  "FO-13",
  "Android only: notification permission screen exact text",
  PRE_FRESH +
    " Use Android app. Path: I'm new here then Use Aaspaas as a customer.",
  1,
  "Reach the notification screen.",
  "Exact title: Stay updated on your orders. Body: Allow notifications so you never miss a vendor response or order update. Exact buttons: Allow notifications and Not now.",
  "App",
  "P2",
);
add(
  "FO-13",
  "Android only: notification permission screen exact text",
  PRE_FRESH +
    " Use Android app. Path: I'm new here then Use Aaspaas as a customer.",
  2,
  "Tap: Not now",
  "Home opens.",
  "App",
  "P2",
);

add(
  "FO-14",
  "Website: no Allow notifications screen after Use Aaspaas as a customer",
  PRE_FRESH + " Use Chrome website.",
  1,
  "Tap: I'm new here then Use Aaspaas as a customer",
  "Home opens. Screen titled Stay updated on your orders with Allow notifications does NOT appear on website.",
  "Web",
  "P2",
);

const out =
  [header, ...fo, ...rest].map((r) => r.map(esc).join(",")).join("\n") + "\n";
writeFileSync("docs/manual-test-matrix.csv", out);
console.log(
  "FO rewritten:",
  [...new Set(fo.map((r) => r[0]))].join(", "),
);
console.log("FO steps", fo.length, "total steps", fo.length + rest.length);
