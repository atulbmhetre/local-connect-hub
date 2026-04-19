import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { User, Store, Database, Trash2 } from "lucide-react";
import { toast } from "sonner";

const Settings = () => {
  const [role, setRole] = useState<string>("user");

  useEffect(() => {
    setRole(localStorage.getItem("aaspaas:role") ?? "user");
  }, []);

  const choose = (r: "user" | "vendor") => {
    localStorage.setItem("aaspaas:role", r);
    setRole(r);
    toast.success(`Role set to ${r}`);
  };

  const reset = () => {
    localStorage.removeItem("aaspaas:role");
    localStorage.removeItem("aaspaas:vendor_id");
    setRole("user");
    toast("Local data cleared");
  };

  return (
    <AppShell>
      <header className="mb-6">
        <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Settings</p>
        <h1 className="font-display text-3xl font-bold mt-1">Make it yours.</h1>
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

      <button
        onClick={reset}
        className="w-full rounded-2xl bg-destructive/10 text-destructive py-4 font-semibold flex items-center justify-center gap-2"
      >
        <Trash2 className="h-4 w-4" /> Reset local data
      </button>
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
