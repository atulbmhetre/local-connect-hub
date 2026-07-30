import { Suspense, lazy, useEffect, type ReactNode } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import * as Sentry from "@sentry/react";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LanguageProvider } from "@/lib/language";
import { ThemeProvider } from "@/lib/theme";
import { strings, type Language } from "@/lib/strings";
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";
import Landing from "./pages/Landing.tsx";
import PrivacyPolicy from "./pages/PrivacyPolicy.tsx";
import LocalFeed from "./pages/LocalFeed.tsx";
import LiveTracking from "./pages/LiveTracking.tsx";
import { ReferralRedirect } from "@/components/ReferralRedirect";
import { PushNavigationBridge } from "@/components/PushNavigationBridge";
import { tryHandleFirstOpenBack } from "@/lib/firstOpenBackBridge";

const SettingsPage = lazy(() => import("./pages/Settings.tsx"));
const HelpSupport = lazy(() => import("./pages/HelpSupport.tsx"));
const LedgerView = lazy(() => import("./pages/LedgerView.tsx"));
const RadarSearch = lazy(() => import("./pages/RadarSearch.tsx"));
const MyOrders = lazy(() => import("./pages/MyOrders.tsx"));
const VendorMode = lazy(() => import("./pages/VendorMode.tsx"));

const queryClient = new QueryClient();

const RELOAD_LABEL: Record<Language, string> = {
  en: "Reload",
  hi: "पुनः लोड करें",
  mr: "पुन्हा लोड करा",
};

function readStoredLanguage(): Language {
  try {
    const stored = localStorage.getItem("aaspaas:language");
    return stored === "hi" || stored === "mr" ? stored : "en";
  } catch {
    return "en";
  }
}

function SentryErrorFallback() {
  const lang = readStoredLanguage();
  const copy = strings[lang];

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center bg-background">
      <p className="text-base text-foreground">{copy.firstopen_restore_error}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-2xl bg-brand px-5 py-2.5 text-sm font-semibold text-page-bg"
      >
        {RELOAD_LABEL[lang]}
      </button>
    </div>
  );
}

function RouteSuspense({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

function NativeBackButtonHandler() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let removeListener: (() => void) | undefined;

    void CapacitorApp.addListener("backButton", () => {
      if (tryHandleFirstOpenBack()) return;
      const path = window.location.pathname;
      if (path === "/" || path === "") {
        void CapacitorApp.exitApp();
      } else {
        window.history.back();
      }
    }).then((handle) => {
      removeListener = () => void handle.remove();
    });

    return () => {
      removeListener?.();
    };
  }, []);

  return null;
}

const App = () => (
  <Sentry.ErrorBoundary fallback={<SentryErrorFallback />}>
    <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <PushNavigationBridge />
          <NativeBackButtonHandler />
          <LanguageProvider>
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/r/:code" element={<ReferralRedirect />} />
              <Route path="/landing" element={<Landing />} />
              <Route
                path="/radar"
                element={
                  <RouteSuspense>
                    <RadarSearch />
                  </RouteSuspense>
                }
              />
              <Route path="/feed" element={<LocalFeed />} />
              <Route path="/track/:vendorId" element={<LiveTracking />} />
              <Route path="/tracking" element={<LiveTracking />} />
              <Route path="/tracking/:vendorId" element={<LiveTracking />} />
              <Route
                path="/vendor"
                element={
                  <RouteSuspense>
                    <VendorMode />
                  </RouteSuspense>
                }
              />
              <Route
                path="/ledger"
                element={
                  <RouteSuspense>
                    <LedgerView />
                  </RouteSuspense>
                }
              />
              <Route
                path="/my-orders"
                element={
                  <RouteSuspense>
                    <MyOrders />
                  </RouteSuspense>
                }
              />
              <Route
                path="/settings"
                element={
                  <RouteSuspense>
                    <SettingsPage />
                  </RouteSuspense>
                }
              />
              <Route
                path="/settings/help"
                element={
                  <RouteSuspense>
                    <HelpSupport />
                  </RouteSuspense>
                }
              />
              <Route path="/privacy" element={<PrivacyPolicy />} />
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </LanguageProvider>
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
    </QueryClientProvider>
  </Sentry.ErrorBoundary>
);

export default App;
