import { ReactNode } from "react";
import { BottomNav } from "./BottomNav";

type Props = {
  children: ReactNode;
  /** @deprecated Theme is controlled globally via ThemeProvider / Settings. */
  theme?: "light" | "dark";
};

export const AppShell = ({ children }: Props) => {
  return (
    <div className="min-h-screen pb-24">
      <div className="mx-auto max-w-md px-5 pt-8">{children}</div>
      <BottomNav />
    </div>
  );
};
