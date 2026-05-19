import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LanguageProvider } from "@/lib/language";
import Index from "./pages/Index.tsx";
import VendorMode from "./pages/VendorMode.tsx";
import SettingsPage from "./pages/Settings.tsx";
import NotFound from "./pages/NotFound.tsx";
import RadarSearch from "./pages/RadarSearch.tsx";
import LiveTracking from "./pages/LiveTracking.tsx";
import MyOrders from "./pages/MyOrders.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <LanguageProvider>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/radar" element={<RadarSearch />} />
            <Route path="/track/:vendorId" element={<LiveTracking />} />
            <Route path="/tracking" element={<LiveTracking />} />
            <Route path="/tracking/:vendorId" element={<LiveTracking />} />
            <Route path="/vendor" element={<VendorMode />} />
            <Route path="/my-orders" element={<MyOrders />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </LanguageProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
