import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronLeft, ChevronsRight, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { primaryNav, secondaryNav, type NavItem } from "@/lib/nav";
import { cn } from "@/lib/utils";

export function AppSidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-primary/15 text-primary">
          <ShieldCheck className="h-4 w-4" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight">SentinelAI</div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Industrial Safety
            </div>
          </div>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto scrollbar-thin px-2 py-3">
        {!collapsed && <SectionLabel>Operations</SectionLabel>}
        <div className="space-y-0.5">
          {primaryNav.map((item) => (
            <NavRow key={item.to} item={item} active={pathname === item.to} collapsed={collapsed} />
          ))}
        </div>
        <div className="my-3 h-px bg-border" />
        {!collapsed && <SectionLabel>Investigation</SectionLabel>}
        <div className="space-y-0.5">
          {secondaryNav.map((item) => (
            <NavRow key={item.to} item={item} active={pathname === item.to} collapsed={collapsed} />
          ))}
        </div>
      </nav>

      <div className="border-t border-border p-2">
        {!collapsed && (
          <div className="mb-2 rounded-md border border-border bg-panel px-3 py-2">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Plant</div>
            <div className="mt-0.5 text-sm font-medium">Vizag Steel Plant</div>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-success pulse-dot" /> SCADA link healthy
            </div>
          </div>
        )}
        <button
          onClick={onToggle}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-panel py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          {collapsed ? (
            <ChevronsRight className="h-3.5 w-3.5" />
          ) : (
            <>
              <ChevronLeft className="h-3.5 w-3.5" /> Collapse
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
      {children}
    </div>
  );
}

function NavRow({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className={cn(
        "group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors",
        active
          ? "bg-primary/12 text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
      )}
      title={collapsed ? item.title : undefined}
    >
      <Icon className={cn("h-4 w-4 shrink-0", active && "text-primary")} />
      {!collapsed && <span className="flex-1 truncate">{item.title}</span>}
      {!collapsed && item.status === "live" && (
        <span className="h-1.5 w-1.5 rounded-full bg-success pulse-dot" />
      )}
      {!collapsed && item.status === "critical" && (
        <span className="h-1.5 w-1.5 rounded-full bg-destructive pulse-dot" />
      )}
    </Link>
  );
}
