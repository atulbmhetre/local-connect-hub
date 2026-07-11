import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initThemeFromStorage } from "./lib/theme";
import { checkAndStoreReferral } from "./lib/referral";
import { initSentry } from "./lib/sentry";
import { initPushNavigationListeners } from "./lib/pushNotifications";
import { restoreVendorLocationTracking } from "./lib/vendorBackgroundLocation";

initSentry();
initThemeFromStorage();
checkAndStoreReferral();
void initPushNavigationListeners();
void restoreVendorLocationTracking();

try {
  if (localStorage.getItem("aaspaas:large_text") === "true") {
    document.documentElement.classList.add("large-text");
  }
} catch {
  /* ignore */
}

createRoot(document.getElementById("root")!).render(<App />);
