import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { User, Store, Database, Trash2, Wrench } from "lucide-react";
import { toast } from "sonner";

const Settings = () => {
  const [role, setRole] = useState<string>("user");
  const [titleTaps, setTitleTaps] = useState(0);
  const [devOpen, setDevOpen] = useState(false);

  useEffect(() => {
    setRole(localStorage.getItem("aaspaas:role") ?? "user");
  }, []);

  const choose = (r: "user" | "vendor") => {
    localStorage.setItem("aaspaas:role", r);
    setRole(r);
    toast.success(`Role set to ${r}`);
  };

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
    setRole("user");
    toast("Local data cleared");
  };

  return (
    <AppShell>
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
        <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Default role</p>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <RoleBtn active={role === "user"} onClick={() => choose("user")} icon={<User className="h-5 w-5" />} label="Customer" />
          <RoleBtn active={role === "vendor"} onClick={() => choose("vendor")} icon={<Store className="h-5 w-5" />} label="Vendor" />
        </div>
        <p className="text-xs text-muted-foreground mt-3">Saved on this device.</p>
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

const RoleBtn = ({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) => (
  <button
    onClick={onClick}
    className={`rounded-2xl border-2 py-4 flex flex-col items-center gap-1 transition-all ${
      active ? "border-primary bg-primary/5 text-primary" : "border-border text-foreground"
    }`}
  >
    {icon}
    <span className="font-semibold text-sm">{label}</span>
  </button>
);

export default Settings;
