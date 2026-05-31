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

export type SettingsActiveGroup = "account" | "shop";

export function defaultSettingsActiveGroup(vendorId: string | null | undefined): SettingsActiveGroup {
  return vendorId?.trim() ? "shop" : "account";
}

/** Top-level settings group (MY ACCOUNT / MY SHOP). */
export function SettingsParentCollapsible({
  label,
  open,
  onToggle,
  children,
}: {
  label: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mx-4 mb-4 rounded-2xl border-2 border-brand/25 bg-surface shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "w-full flex items-center justify-between gap-3 px-4 py-4 text-left active:opacity-90",
          open && "border-b-2 border-brand/20",
        )}
      >
        <span className="text-sm font-extrabold uppercase tracking-widest text-foreground flex-1 min-w-0 text-left">
          {label}
        </span>
        <ChevronDown
          className={cn(
            "h-5 w-5 text-foreground/70 shrink-0 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>
      {open && <div className="px-2 pb-3 pt-1">{children}</div>}
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
  nested = false,
}: {
  label: ReactNode;
  badge?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  headerClassName?: string;
  /** Inside a parent group — tighter layout, no outer horizontal margin on card. */
  nested?: boolean;
}) {
  return (
    <div className={cn("mb-1", nested && "mb-2 last:mb-0")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "w-full flex items-center justify-between gap-2 text-left active:opacity-90",
          nested ? "px-3 py-2.5" : "px-4 py-3",
          headerClassName,
        )}
      >
        <span className="text-xs font-bold uppercase tracking-widest text-brand flex-1 min-w-0 text-left">
          {label}
        </span>
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
      {open && (
        <SettingsCard className={cn("mt-0", nested && "mx-0 mb-0 border-surface-border")}>
          {children}
        </SettingsCard>
      )}
    </div>
  );
}
