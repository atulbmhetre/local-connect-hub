import { useLanguage } from "@/lib/language";
import { useAppConfig } from "@/hooks/useAppConfig";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

const Landing = () => {
  const { s } = useLanguage();
  const { config } = useAppConfig();

  const handleDownload = async () => {
    const url = config.appBaseUrl;
    if (navigator.share) {
      try {
        await navigator.share({ url, title: s.appName, text: s.tagline });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    }
    await navigator.clipboard.writeText(url);
    toast.success(s.vendor_referLinkCopied);
  };

  const valueProps = [
    {
      icon: "🚨",
      title: s.landing_emergencyTitle,
      desc: s.landing_emergencyDesc,
    },
    {
      icon: "🛒",
      title: s.landing_deliveryTitle,
      desc: s.landing_deliveryDesc,
    },
    {
      icon: "✂️",
      title: s.landing_bookingTitle,
      desc: s.landing_bookingDesc,
    },
  ];

  return (
    <div className="min-h-screen bg-page-bg text-white flex flex-col">
      <main className="flex-1 w-full max-w-lg mx-auto px-5 py-10 flex flex-col">
        <header className="text-center mb-10">
          <h1 className="font-display text-xl font-bold text-brand">{s.appName}</h1>
          <p className="mt-3 text-lg text-gray-300">{s.tagline}</p>
        </header>

        <div className="space-y-4 flex-1">
          {valueProps.map((item) => (
            <div
              key={item.title}
              className="rounded-2xl border border-surface-border bg-surface p-5"
            >
              <p className="text-2xl mb-2" aria-hidden>
                {item.icon}
              </p>
              <p className="font-display font-bold text-lg">{item.title}</p>
              <p className="text-sm text-gray-400 mt-1 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>

        <div className="mt-10 space-y-4 text-center">
          <Button
            type="button"
            size="lg"
            onClick={() => void handleDownload()}
            className="w-full rounded-2xl bg-brand text-[#0b1f14] font-bold shadow-[0_0_20px_rgba(34,197,94,0.35)]"
          >
            {s.landing_downloadApp}
          </Button>
          <p className="text-sm text-gray-400">{s.landing_vendorRegister}</p>
        </div>
      </main>

      <footer className="py-6 text-center text-xs text-gray-500">
        {s.landing_copyright}
      </footer>
    </div>
  );
};

export default Landing;
