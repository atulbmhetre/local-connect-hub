import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initThemeFromStorage } from "./lib/theme";
import { checkAndStoreReferral } from "./lib/referral";

initThemeFromStorage();
checkAndStoreReferral();

createRoot(document.getElementById("root")!).render(<App />);
