import { ReactNode } from "react";
import { APP_COLUMN_CLASS } from "@/lib/appColumn";
import {
  DESKTOP_CONTENT_WIDTH_CLASS,
  DESKTOP_MAIN_OFFSET_CLASS,
  isWebDesktopShell,
  useLgUp,
} from "@/lib/desktopShell";
import { cn } from "@/lib/utils";
import { BottomNav } from "./BottomNav";
import { DesktopSidebar } from "./DesktopSidebar";
import { GetTheAppCard } from "./GetTheAppCard";

type Props = {
  children: ReactNode;
  /** @deprecated Theme is controlled globally via ThemeProvider / Settings. */
  theme?: "light" | "dark";
};

export const AppShell = ({ children }: Props) => {
  const desktopShell = isWebDesktopShell();
  const lgUp = useLgUp();
  const showDesktopChrome = desktopShell && lgUp;

  return (
    <div className={cn("min-h-screen pb-24", desktopShell && "lg:pb-0")}>
      {showDesktopChrome ? <DesktopSidebar /> : null}
      <div className={cn(desktopShell && DESKTOP_MAIN_OFFSET_CLASS)}>
        <div className={cn(showDesktopChrome && "lg:flex lg:items-start")}>
          <div
            data-testid="app-shell-main"
            className={cn(
              APP_COLUMN_CLASS,
              "px-4 pt-8",
              desktopShell && "lg:px-8 lg:shrink-0",
              desktopShell && DESKTOP_CONTENT_WIDTH_CLASS,
            )}
          >
            {children}
          </div>
          {showDesktopChrome ? (
            <aside
              data-testid="get-the-app-rail"
              className="hidden lg:block min-w-0 flex-1 px-6 pt-8 xl:px-8"
            >
              <GetTheAppCard />
            </aside>
          ) : null}
        </div>
      </div>
      <BottomNav />
    </div>
  );
};
