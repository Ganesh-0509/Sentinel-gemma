import { AlertTriangle, RotateCw } from "lucide-react";
import { asShiftTime, riskPct, useAlerts, useClock, useHealth, useZones } from "@/lib/queries";

/**
 * The console header.
 *
 * Everything here is wired to the backend. An earlier version showed a static
 * "Live" badge, a hardcoded SCADA latency and the browser's wall clock — which
 * ticked convincingly while the plant data behind it was frozen. A header that
 * looks alive when the system is not is worse than no header, so each indicator
 * now reflects real state or is absent.
 */
export function TopBar() {
  const clock = useClock();
  const health = useHealth();
  const zones = useZones();
  const alerts = useAlerts();

  const running = clock.data?.running ?? false;
  const minute = clock.data?.minute ?? 0;
  const episodeMinutes = clock.data?.episode_minutes ?? 240;
  const laps = clock.data?.laps ?? 0;

  // Reachability is what the operator needs first: a stale number is worse than
  // a visible "disconnected".
  const reachable = !clock.isError && !health.isError;
  const ready = health.data?.status === "ok";
  const critical = (alerts.data ?? []).filter((a) => a.priority === "CRITICAL").length;
  const peak = Math.max(0, ...(zones.data ?? []).map((z) => z.risk));

  const link = !reachable
    ? { tone: "danger" as const, label: "Disconnected" }
    : !ready
      ? { tone: "warn" as const, label: "Degraded" }
      : running
        ? { tone: "success" as const, label: "Live" }
        : { tone: "warn" as const, label: "Clock stopped" };

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-panel px-4">
      <div className="flex items-center gap-2 text-xs">
        <span
          className={`flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
            link.tone === "success"
              ? "bg-success/15 text-success"
              : link.tone === "warn"
                ? "bg-warning/15 text-warning"
                : "bg-destructive/15 text-destructive"
          }`}
        >
          {link.tone === "success" && (
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
            </span>
          )}
          {link.label}
        </span>
        <span className="text-muted-foreground">Vizag Steel Plant · 8 monitored zones</span>
      </div>

      {/* ── PLANT CLOCK — the single shared clock every page follows ─────── */}
      <div className="ml-auto flex items-center gap-4 text-[11px] text-muted-foreground">
        {critical > 0 && (
          <div className="flex items-center gap-1.5 rounded-sm bg-destructive/15 px-2 py-1 text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span className="mono font-semibold">{critical} critical</span>
          </div>
        )}

        {zones.data && (
          <div className="flex items-center gap-1.5">
            <span className="uppercase tracking-wider">Peak risk</span>
            <span
              className={`mono font-semibold ${
                peak >= 0.85 ? "text-destructive" : peak >= 0.6 ? "text-warning" : "text-foreground"
              }`}
            >
              {riskPct(peak)}%
            </span>
          </div>
        )}

        <div className="flex items-center gap-2 rounded-md border border-border bg-background/50 px-2.5 py-1">
          <div className="leading-tight">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
              Plant clock
            </div>
            <div className="mono text-[13px] font-semibold text-foreground">
              {asShiftTime(minute)}
            </div>
          </div>
          <div className="leading-tight border-l border-border pl-2.5">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Minute</div>
            <div className="mono text-[13px] text-foreground">
              {minute}
              <span className="text-muted-foreground">/{episodeMinutes - 1}</span>
            </div>
          </div>
          {laps > 0 && (
            <div
              className="flex items-center gap-1 border-l border-border pl-2.5 text-muted-foreground"
              title={`The episode has replayed ${laps} time(s) since the backend started`}
            >
              <RotateCw className="h-3 w-3" />
              <span className="mono text-[11px]">{laps}</span>
            </div>
          )}
        </div>

        {health.data && (
          <div className="flex items-center gap-1.5" title="Language-model backend in use">
            <span className="uppercase tracking-wider">LLM</span>
            <span className="mono text-foreground">{health.data.llm_backend}</span>
          </div>
        )}
      </div>
    </header>
  );
}
