import { ReactNode, useEffect } from "react";
import { BottomNav } from "./BottomNav";

type Props = {
  children: ReactNode;
  /**
   * Visual theme for this screen. Vendor Mode runs in dark to make the
   * role-switch unmistakable; Customer screens stay light.
   */
  theme?: "light" | "dark";
};

export const AppShell = ({ children, theme = "light" }: Props) => {
  // Toggle the global `.dark` class on <html> so every Tailwind token
  // (bg-background, text-foreground, borders, cards) flips together.
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    return () => root.classList.remove("dark");
  }, [theme]);

  return (
    <div className="min-h-screen pb-24">
      <div className="mx-auto max-w-md px-5 pt-8">{children}</div>
      <BottomNav />
    </div>
  );
};
