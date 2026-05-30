import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function SettingsPageHeader({
  title,
  subtitle,
  onTitleClick,
}: {
  title: string;
  subtitle: string;
  onTitleClick?: () => void;
}) {
  return (
    <div className="px-4 pt-6 pb-2">
      <h1
        onClick={onTitleClick}
        className={cn(
          "text-2xl font-bold text-foreground",
          onTitleClick && "select-none cursor-default",
        )}
      >
        {title}
      </h1>
      <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
    </div>
  );
}

export function SettingsSectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-4 pt-6 pb-2 text-xs font-bold uppercase tracking-widest text-brand",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "mx-4 rounded-2xl border border-surface-border bg-surface overflow-hidden mb-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SettingsRow({
  label,
  sublabel,
  children,
  className,
}: {
  label: ReactNode;
  sublabel?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-4 py-3.5 border-b border-surface-border last:border-0",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {sublabel != null && sublabel !== false && (
          <p className="text-xs text-muted-foreground mt-0.5">{sublabel}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SettingsCollapsible({
  label,
  badge,
  open,
  onToggle,
  children,
  headerClassName,
}: {
  label: ReactNode;
  badge?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  headerClassName?: string;
}) {
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "w-full flex items-center justify-between gap-2 px-4 py-3 text-left active:opacity-90",
          headerClassName,
        )}
      >
        <span className="text-xs font-bold uppercase tracking-widest text-brand">{label}</span>
        <div className="flex items-center gap-2 shrink-0">
          {badge}
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        </div>
      </button>
      {open && <SettingsCard className="mt-0">{children}</SettingsCard>}
    </div>
  );
}
