import { useEffect } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LanguageProvider } from "@/lib/language";
import { ThemeProvider } from "@/lib/theme";
import Index from "./pages/Index.tsx";
import VendorMode from "./pages/VendorMode.tsx";
import SettingsPage from "./pages/Settings.tsx";
import NotFound from "./pages/NotFound.tsx";
import RadarSearch from "./pages/RadarSearch.tsx";
import LiveTracking from "./pages/LiveTracking.tsx";
import MyOrders from "./pages/MyOrders.tsx";
import Landing from "./pages/Landing.tsx";
import PrivacyPolicy from "./pages/PrivacyPolicy.tsx";
import { ReferralRedirect } from "@/components/ReferralRedirect";

const queryClient = new QueryClient();

function NativeBackButtonHandler() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let removeListener: (() => void) | undefined;

    void CapacitorApp.addListener("backButton", () => {
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
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <NativeBackButtonHandler />
          <LanguageProvider>
            <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/r/:code" element={<ReferralRedirect />} />
            <Route path="/landing" element={<Landing />} />
            <Route path="/radar" element={<RadarSearch />} />
            <Route path="/track/:vendorId" element={<LiveTracking />} />
            <Route path="/tracking" element={<LiveTracking />} />
            <Route path="/tracking/:vendorId" element={<LiveTracking />} />
            <Route path="/vendor" element={<VendorMode />} />
            <Route path="/my-orders" element={<MyOrders />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/privacy" element={<PrivacyPolicy />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
            </Routes>
          </LanguageProvider>
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
