import { useState, type ReactNode } from "react";
import { AppSidebar } from "./sidebar";
import { TopBar } from "./topbar";

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <AppSidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {/* `min-h-full` on the page root lets short pages fill the viewport
            instead of leaving dead space below the panels; grid rows are auto,
            so the default `align-content: stretch` distributes the slack. */}
        <main className="flex-1 overflow-auto scrollbar-thin [&>*]:min-h-full">{children}</main>
      </div>
    </div>
  );
}
