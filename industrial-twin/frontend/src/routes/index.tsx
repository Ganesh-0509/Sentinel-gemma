import { createFileRoute, Link } from "@tanstack/react-router";
import { Panel, Chip, StatusDot } from "@/components/panel";
import { ErrorState, Loading } from "@/components/data-state";
import {
  useAlerts,
  useClock,
  useHealth,
  useTick,
  useZoneHistory,
  useZones,
  asShiftTime,
  bandTone,
  priorityTone,
  riskPct,
} from "@/lib/queries";
import type { ZoneState } from "@/lib/api-types";
import { motion } from "framer-motion";
import { Activity, AlertTriangle, SkipForward, Users, Clock } from "lucide-react";
import { useMemo, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Operations Overview · SentinelAI" },
      {
        name: "description",
        content:
          "Live compound risk across the plant — zone telemetry, prioritised alerts and SHAP explanations from the SentinelAI backend.",
      },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const zonesQuery = useZones();
  const alertsQuery = useAlerts();
  const healthQuery = useHealth();
  const clockQuery = useClock();
  const tick = useTick();

  const zones = zonesQuery.data;
  const alerts = alertsQuery.data;

  const [focusId, setFocusId] = useState<string | null>(null);
  // Default focus: whichever zone the model currently rates highest.
  const focus: ZoneState | undefined = useMemo(() => {
    if (!zones?.length) return undefined;
    if (focusId) return zones.find((z) => z.zone_id === focusId) ?? zones[0];
    return [...zones].sort((a, b) => b.risk - a.risk)[0];
  }, [zones, focusId]);

  const historyQuery = useZoneHistory(focus?.zone_id, 90);

  const kpis = useMemo(() => {
    if (!zones?.length) return null;
    return {
      peak: riskPct(Math.max(...zones.map((z) => z.risk))),
      atRisk: zones.filter((z) => z.risk_band === "HIGH" || z.risk_band === "CRITICAL").length,
      workers: zones.reduce((sum, z) => sum + z.workers_in_zone, 0),
    };
  }, [zones]);

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-12">
      {/* ── KPI ROW ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:col-span-12 md:grid-cols-4">
        <KpiCard
          icon={Activity}
          label="Peak Compound Risk"
          value={kpis ? `${kpis.peak}%` : "—"}
          tone={!kpis ? "muted" : kpis.peak > 60 ? "danger" : kpis.peak > 30 ? "warn" : "success"}
          pending={zonesQuery.isPending}
        />
        <KpiCard
          icon={AlertTriangle}
          label="Zones at Risk"
          value={kpis ? String(kpis.atRisk) : "—"}
          tone={!kpis ? "muted" : kpis.atRisk > 0 ? "warn" : "success"}
          pending={zonesQuery.isPending}
        />
        <KpiCard
          icon={Users}
          label="Workers in Zones"
          value={kpis ? String(kpis.workers) : "—"}
          tone="muted"
          pending={zonesQuery.isPending}
        />
        <KpiCard
          icon={Clock}
          label="Plant Clock"
          value={clockQuery.data ? asShiftTime(clockQuery.data.minute) : "—"}
          tone="muted"
          pending={clockQuery.isPending}
        />
      </div>

      {/* ── ZONE RISK MAP ─────────────────────────────────────────────── */}
      <Panel
        title="Plant Risk Map"
        subtitle="Zone floor-plan position and compound risk, live from the backend"
        actions={
          <button
            onClick={() => tick.mutate(5)}
            disabled={tick.isPending}
            className="flex items-center gap-1 hover:text-foreground disabled:opacity-50"
          >
            <SkipForward className="h-3 w-3" /> Skip 5 min
          </button>
        }
        className="lg:col-span-8 min-h-[340px]"
      >
        {zonesQuery.isPending ? (
          <Loading label="Reading zone telemetry" />
        ) : zonesQuery.error ? (
          <ErrorState error={zonesQuery.error} onRetry={zonesQuery.refetch} />
        ) : (
          <div className="relative h-[288px] w-full overflow-hidden rounded-md border border-border bg-background/50 grid-bg">
            {zones?.map((z) => {
              const pct = riskPct(z.risk);
              const tone =
                pct > 60
                  ? "var(--color-destructive)"
                  : pct > 30
                    ? "var(--color-warning)"
                    : "var(--color-success)";
              return (
                <button
                  key={z.zone_id}
                  onClick={() => setFocusId(z.zone_id)}
                  title={z.name}
                  className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md border px-2 py-1 text-left"
                  style={{
                    left: `${z.x}%`,
                    top: `${z.y}%`,
                    borderColor: tone,
                    background: `color-mix(in oklch, ${tone} 14%, transparent)`,
                    boxShadow: focus?.zone_id === z.zone_id ? `0 0 0 1px ${tone}` : undefined,
                  }}
                >
                  <div className="text-[10px] font-medium leading-tight">{z.zone_id}</div>
                  <div className="mono text-[11px] font-semibold" style={{ color: tone }}>
                    {pct}%
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Panel>

      {/* ── ALERTS ────────────────────────────────────────────────────── */}
      <Panel
        title="Prioritised Alerts"
        subtitle={alerts ? `${alerts.length} active` : "Loading"}
        className="lg:col-span-4"
        bodyClassName="p-0"
      >
        {alertsQuery.isPending ? (
          <Loading label="Reading alert queue" />
        ) : alertsQuery.error ? (
          <div className="p-3">
            <ErrorState error={alertsQuery.error} onRetry={alertsQuery.refetch} />
          </div>
        ) : !alerts?.length ? (
          <p className="px-3 py-6 text-[12px] leading-relaxed text-muted-foreground">
            No zone is above the alert threshold right now. The plant clock is running — conditions
            will develop as the shift progresses.
          </p>
        ) : (
          <ul className="max-h-[288px] divide-y divide-border overflow-y-auto scrollbar-thin">
            {alerts.map((a) => (
              <li key={a.alert_id} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <StatusDot tone={priorityTone(a.priority)} />
                  <span className="flex-1 truncate text-[12px] font-medium">{a.zone_name}</span>
                  <Chip
                    tone={priorityTone(a.priority) === "muted" ? "muted" : priorityTone(a.priority)}
                  >
                    {a.priority}
                  </Chip>
                </div>
                <div className="mono mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>risk {riskPct(a.risk)}%</span>
                  {a.lead_time_min !== null && <span>· lead {a.lead_time_min}m</span>}
                </div>
                {a.drivers.length > 0 && (
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {a.drivers.slice(0, 2).join(" · ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* ── FOCUS ZONE TREND ──────────────────────────────────────────── */}
      <Panel
        title={focus ? `${focus.name} — Risk & Gas` : "Zone trend"}
        subtitle={focus ? `${focus.zone_id} · last 90 minutes` : undefined}
        className="lg:col-span-8 min-h-[280px]"
      >
        {historyQuery.isPending ? (
          <Loading label="Reading history" />
        ) : historyQuery.error ? (
          <ErrorState error={historyQuery.error} onRetry={historyQuery.refetch} />
        ) : (
          <ResponsiveContainer width="100%" height={224}>
            {/* risk is 0-1 and gas is 0-20 — plotted on one axis the risk line
                flatlines against the floor, so risk is scaled to a percentage. */}
            <AreaChart
              data={(historyQuery.data ?? []).map((r) => ({
                minute: r.minute,
                risk: riskPct(r.risk),
                gas_lel: r.gas_lel,
              }))}
            >
              <defs>
                <linearGradient id="riskFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-destructive)" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="var(--color-destructive)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="minute" stroke="var(--color-muted-foreground)" fontSize={10} />
              <YAxis stroke="var(--color-muted-foreground)" fontSize={10} />
              <Tooltip
                contentStyle={{
                  background: "var(--color-panel)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 6,
                  fontSize: 11,
                }}
              />
              <Area
                type="monotone"
                dataKey="risk"
                name="risk %"
                stroke="var(--color-destructive)"
                fill="url(#riskFill)"
                strokeWidth={1.5}
              />
              <Area
                type="monotone"
                dataKey="gas_lel"
                name="gas % LEL"
                stroke="var(--color-warning)"
                fill="transparent"
                strokeWidth={1.5}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Panel>

      {/* ── EXPLANATION + SYSTEM ──────────────────────────────────────── */}
      <div className="flex flex-col gap-3 lg:col-span-4">
        <Panel
          title="Why This Score"
          subtitle={focus ? `SHAP drivers · ${focus.zone_id}` : "SHAP drivers"}
        >
          {!focus ? (
            <Loading />
          ) : focus.drivers.length === 0 ? (
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              No attribution yet — the backend computes SHAP drivers only once a zone passes 25%
              risk. {focus.name} is at {riskPct(focus.risk)}%.
            </p>
          ) : (
            <ul className="space-y-2">
              {focus.drivers.map((d) => (
                <li key={d.feature}>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="truncate text-muted-foreground">{d.label}</span>
                    <span
                      className={`mono ${d.contribution > 0 ? "text-destructive" : "text-success"}`}
                    >
                      {d.contribution > 0 ? "+" : ""}
                      {d.contribution.toFixed(3)}
                    </span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full ${d.contribution > 0 ? "bg-destructive" : "bg-success"}`}
                      style={{ width: `${Math.min(100, Math.abs(d.contribution) * 400)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Zone Status" subtitle="All zones" bodyClassName="p-0">
          {zones && (
            <ul className="max-h-[180px] divide-y divide-border overflow-y-auto scrollbar-thin">
              {zones.map((z) => (
                <li
                  key={z.zone_id}
                  onClick={() => setFocusId(z.zone_id)}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px] ${
                    focus?.zone_id === z.zone_id ? "bg-primary/8" : "hover:bg-muted/30"
                  }`}
                >
                  <StatusDot tone={bandTone(z.risk_band)} />
                  <span className="flex-1 truncate">{z.name}</span>
                  {z.baseline_alarm && <Chip tone="warn">alarm</Chip>}
                  <span className="mono text-[11px] text-muted-foreground">{riskPct(z.risk)}%</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="System Health" subtitle="Backend status">
          {healthQuery.isPending ? (
            <Loading label="Checking backend" />
          ) : healthQuery.error ? (
            <ErrorState error={healthQuery.error} onRetry={healthQuery.refetch} />
          ) : (
            <ul className="space-y-1.5 text-[12px]">
              {(
                [
                  ["Service", healthQuery.data!.status, healthQuery.data!.status === "ok"],
                  ["Version", healthQuery.data!.version, true],
                  [
                    "Forecaster",
                    healthQuery.data!.model_loaded ? "loaded" : "missing",
                    healthQuery.data!.model_loaded,
                  ],
                  ["LLM backend", healthQuery.data!.llm_backend, true],
                  [
                    "Regulation chunks",
                    String(healthQuery.data!.regulation_chunks),
                    healthQuery.data!.regulation_chunks > 0,
                  ],
                ] as Array<[string, string, boolean]>
              ).map(([k, v, ok]) => (
                <li key={k} className="flex items-center gap-2">
                  <StatusDot tone={ok ? "success" : "warn"} />
                  <span className="flex-1 text-muted-foreground">{k}</span>
                  <span className="mono">{v}</span>
                </li>
              ))}
            </ul>
          )}
          <Link
            to="/evidence"
            className="mt-3 block rounded-md border border-border py-2 text-center text-[12px] text-muted-foreground hover:text-foreground"
          >
            View baseline comparison
          </Link>
        </Panel>
      </div>
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  tone,
  pending,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  tone: "success" | "warn" | "danger" | "muted";
  pending?: boolean;
}) {
  const colour =
    tone === "danger"
      ? "text-destructive"
      : tone === "warn"
        ? "text-warning"
        : tone === "success"
          ? "text-success"
          : "text-foreground";
  return (
    <div className="panel p-3">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <motion.div
        key={value}
        initial={{ opacity: 0.4 }}
        animate={{ opacity: 1 }}
        className={`mono mt-1 text-3xl font-semibold ${colour}`}
      >
        {pending ? "—" : value}
      </motion.div>
    </div>
  );
}
