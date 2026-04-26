import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Database, Trash2, Wrench } from "lucide-react";
import { toast } from "sonner";

const Settings = () => {
  const [titleTaps, setTitleTaps] = useState(0);
  const [devOpen, setDevOpen] = useState(false);

  // Hidden gesture: tap the page title 7× to unlock the developer menu.
  const tapTitle = () => {
    const next = titleTaps + 1;
    setTitleTaps(next);
    if (next >= 7) {
      setDevOpen(true);
      setTitleTaps(0);
      toast("Developer menu unlocked");
    }
  };

  const reset = () => {
    if (!window.confirm("Clear all locally stored Aaspaas data on this device?")) return;
    localStorage.removeItem("aaspaas:role");
    localStorage.removeItem("aaspaas:vendor_id");
    toast("Local data cleared");
  };

  return (
    <AppShell theme="light">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Settings</p>
        <h1
          onClick={tapTitle}
          className="font-display text-3xl font-bold mt-1 select-none cursor-default"
        >
          Make it yours.
        </h1>
      </header>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">
          Switch role
        </p>
        <p className="text-sm text-muted-foreground">
          Use the bottom navigation — <span className="font-semibold text-foreground">Home</span> for help,{" "}
          <span className="font-semibold text-foreground">Vendor</span> to earn.
        </p>
      </section>

      <section className="rounded-3xl bg-card border border-border shadow-card p-5 mb-5">
        <div className="flex items-center gap-3">
          <Database className="h-5 w-5 text-secondary" />
          <div>
            <p className="font-semibold">Connected to Supabase</p>
            <p className="text-xs text-muted-foreground break-all">rpxsyeqskvhjmbkxnpmd.supabase.co</p>
          </div>
        </div>
      </section>

      {devOpen && (
        <section className="rounded-3xl bg-card border-2 border-dashed border-destructive/40 p-5 animate-fade-up">
          <div className="flex items-center gap-2 mb-3">
            <Wrench className="h-4 w-4 text-destructive" />
            <p className="text-xs uppercase tracking-wider text-destructive font-semibold">Developer menu</p>
          </div>
          <button
            onClick={reset}
            className="w-full rounded-2xl bg-destructive/10 text-destructive py-4 font-semibold flex items-center justify-center gap-2"
          >
            <Trash2 className="h-4 w-4" /> Reset local data
          </button>
          <button
            onClick={() => setDevOpen(false)}
            className="w-full mt-2 text-xs text-muted-foreground underline"
          >
            Hide developer menu
          </button>
        </section>
      )}
    </AppShell>
  );
};

export default Settings;
