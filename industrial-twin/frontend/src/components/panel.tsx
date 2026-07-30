import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  padded = true,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  padded?: boolean;
}) {
  return (
    <section className={cn("panel flex min-h-0 flex-col", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <div className="min-w-0">
            {title && (
              <h3 className="truncate text-[13px] font-semibold tracking-tight text-foreground">
                {title}
              </h3>
            )}
            {subtitle && <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p>}
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
              {actions}
            </div>
          )}
        </header>
      )}
      <div className={cn("min-h-0 flex-1", padded && "p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function StatusDot({
  tone = "success",
}: {
  tone?: "success" | "warn" | "danger" | "muted";
}) {
  const map = {
    success: "bg-success",
    warn: "bg-warning",
    danger: "bg-destructive",
    muted: "bg-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-block h-1.5 w-1.5 rounded-full",
        map[tone],
        tone !== "muted" && "pulse-dot",
      )}
    />
  );
}

export function Chip({
  children,
  tone = "muted",
  className,
}: {
  children: ReactNode;
  tone?: "muted" | "success" | "warn" | "danger" | "info";
  className?: string;
}) {
  const map = {
    muted: "bg-muted/60 text-muted-foreground border-border",
    success: "bg-success/15 text-success border-success/30",
    warn: "bg-warning/15 text-warning border-warning/30",
    danger: "bg-destructive/15 text-destructive border-destructive/30",
    info: "bg-primary/15 text-primary border-primary/30",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        map[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
