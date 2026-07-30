import { createFileRoute } from "@tanstack/react-router";
import { Panel, Chip, StatusDot } from "@/components/panel";
import { QueryBoundary } from "@/components/data-state";
import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { bandTone, riskPct, useClock, useZone, useZoneHistory, useZones } from "@/lib/queries";
import type { ZoneReading, ZoneState } from "@/lib/api-types";

export const Route = createFileRoute("/incident-investigation")({
  head: () => ({
    meta: [
      { title: "Incident Investigation · SentinelAI" },
      {
        name: "description",
        content:
          "Post-hoc review of a zone episode: risk trajectory, SHAP contributing factors, and model vs baseline alarm.",
      },
    ],
  }),
  component: IncidentInvestigation,
});

/** The full precomputed episode is 240 minutes. */
const EPISODE_WINDOW = 240;

function IncidentInvestigation() {
  const zones = useZones();
  const clock = useClock();
  const [zoneId, setZoneId] = useState<string | undefined>(undefined);

  const zoneList = zones.data ?? [];
  const activeZoneId =
    zoneId ?? [...zoneList].sort((a, b) => b.risk - a.risk)[0]?.zone_id ?? undefined;

  const zone = useZone(activeZoneId);
  const history = useZoneHistory(activeZoneId, EPISODE_WINDOW);
  const minute = clock.data?.minute ?? 0;

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-12">
      {/* ── ZONE UNDER INVESTIGATION ─────────────────────────────────── */}
      <Panel
        title="Zone Under Investigation"
        subtitle={`Episode reviewed up to minute ${minute}`}
        className="lg:col-span-3 min-h-[520px]"
        padded={false}
        bodyClassName="overflow-y-auto scrollbar-thin"
      >
        <QueryBoundary
          query={zones}
          loadingLabel="Loading zones"
          emptyLabel="No zones reported"
          isEmpty={(z: ZoneState[]) => z.length === 0}
        >
          {(data) => (
            <ul className="text-[12px]">
              {data.map((z) => (
                <li key={z.zone_id}>
                  <button
                    onClick={() => setZoneId(z.zone_id)}
                    className={`flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left transition-colors ${
                      z.zone_id === activeZoneId
                        ? "border-primary bg-primary/8 text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <StatusDot tone={bandTone(z.risk_band)} />
                    <span className="min-w-0 flex-1 truncate">{z.name}</span>
                    <span className="mono text-[11px]">{riskPct(z.risk)}%</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </Panel>

      {/* ── CONTRIBUTING FACTORS (real SHAP) ─────────────────────────── */}
      <Panel
        title="Contributing Factors"
        subtitle="SHAP attribution from the compound-risk model at the current minute"
        className="lg:col-span-5"
      >
        <QueryBoundary query={zone} loadingLabel="Loading zone state">
          {(z) => {
            const total = z.drivers.reduce((s, d) => s + Math.abs(d.contribution), 0);
            if (z.drivers.length === 0) {
              return (
                <p className="text-[12px] leading-relaxed text-muted-foreground">
                  The model reports no attributed drivers for {z.name} at minute {minute} — risk is
                  below the explanation threshold. Advance the plant clock to a minute where this
                  zone is elevated.
                </p>
              );
            }
            return (
              <ul className="space-y-2 text-[12px]">
                {z.drivers.map((d) => {
                  const pct = total > 0 ? (Math.abs(d.contribution) / total) * 100 : 0;
                  const raises = d.contribution > 0;
                  return (
                    <li key={d.feature}>
                      <div className="flex justify-between text-[11px] text-muted-foreground">
                        <span>
                          {d.label} <span className="mono opacity-60">({d.feature})</span>
                        </span>
                        <span className="mono text-foreground">
                          {raises ? "+" : ""}
                          {d.contribution.toFixed(3)} · {pct.toFixed(0)}%
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-muted">
                        <div
                          className={`h-full ${raises ? "bg-destructive" : "bg-success"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
                <li className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
                  Bars are each driver&apos;s share of total absolute SHAP contribution. Red raises
                  predicted risk, green lowers it.
                </li>
              </ul>
            );
          }}
        </QueryBoundary>
      </Panel>

      {/* ── MODEL VS BASELINE ────────────────────────────────────────── */}
      <Panel title="Model vs Baseline Alarm" className="lg:col-span-4">
        <QueryBoundary query={zone} loadingLabel="Loading zone state">
          {(z) => (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-border bg-background/40 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Compound Model
                  </div>
                  <div
                    className={`mono mt-1 text-3xl font-semibold ${
                      z.risk_band === "CRITICAL"
                        ? "text-destructive"
                        : z.risk_band === "HIGH" || z.risk_band === "MEDIUM"
                          ? "text-warning"
                          : "text-foreground"
                    }`}
                  >
                    {riskPct(z.risk)}%
                  </div>
                  <Chip tone={bandTone(z.risk_band)} className="mt-1">
                    {z.risk_band}
                  </Chip>
                </div>
                <div className="rounded-md border border-border bg-background/40 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Single-Sensor Alarm
                  </div>
                  <div
                    className={`mono mt-1 text-3xl font-semibold ${
                      z.baseline_alarm ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {z.baseline_alarm ? "FIRING" : "SILENT"}
                  </div>
                  <Chip tone={z.baseline_alarm ? "danger" : "muted"} className="mt-1">
                    {z.gas_lel.toFixed(2)}% LEL
                  </Chip>
                </div>
              </div>

              <p className="text-[12px] leading-relaxed text-muted-foreground">
                {z.risk >= 0.5 && !z.baseline_alarm
                  ? `The compound model is at ${riskPct(z.risk)}% while the conventional single-sensor alarm is still silent — this is the lead time a point gas detector cannot give.`
                  : z.baseline_alarm
                    ? "Both the model and the conventional gas alarm agree a hazard is present."
                    : "Neither the model nor the conventional alarm indicates a developing hazard in this zone."}
              </p>

              <div>
                <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Operational Context
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Chip tone={z.maintenance_active ? "warn" : "muted"}>
                    Maintenance {z.maintenance_active ? "active" : "none"}
                  </Chip>
                  <Chip tone={z.hot_work_active ? "danger" : "muted"}>
                    Hot work {z.hot_work_active ? "active" : "none"}
                  </Chip>
                  <Chip tone={z.in_changeover ? "warn" : "muted"}>
                    {z.in_changeover ? "In changeover" : "Steady state"}
                  </Chip>
                  <Chip tone={z.night_shift ? "info" : "muted"}>
                    {z.night_shift ? "Night shift" : "Day shift"}
                  </Chip>
                  <Chip tone={z.workers_in_zone > 0 ? "warn" : "muted"}>
                    {z.workers_in_zone} in zone
                  </Chip>
                  {z.lead_time_min !== null && (
                    <Chip tone="warn">{z.lead_time_min} min lead time</Chip>
                  )}
                </div>
              </div>
            </div>
          )}
        </QueryBoundary>
      </Panel>

      {/* ── EPISODE TRAJECTORY ───────────────────────────────────────── */}
      <Panel
        title="What Actually Happened"
        subtitle={`Risk and gas across the ${EPISODE_WINDOW}-minute episode`}
        className="lg:col-span-12 min-h-[300px]"
      >
        <QueryBoundary
          query={history}
          loadingLabel="Loading episode history"
          emptyLabel="No readings for this zone"
          isEmpty={(h: ZoneReading[]) => h.length === 0}
        >
          {(readings) => {
            const peak = readings.reduce((a, b) => (b.risk > a.risk ? b : a), readings[0]);
            return (
              <>
                <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
                  {[
                    { l: "Peak Risk", v: `${riskPct(peak.risk)}%` },
                    { l: "Peak At Minute", v: String(peak.minute) },
                    {
                      l: "Peak Gas % LEL",
                      v: Math.max(...readings.map((r) => r.gas_lel)).toFixed(2),
                    },
                    {
                      l: "Peak Pressure",
                      v: Math.max(...readings.map((r) => r.pressure)).toFixed(2),
                    },
                    {
                      l: "Peak Temp °C",
                      v: Math.max(...readings.map((r) => r.temperature)).toFixed(1),
                    },
                  ].map((s) => (
                    <div
                      key={s.l}
                      className="rounded-md border border-border bg-background/40 p-2.5"
                    >
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {s.l}
                      </div>
                      <div className="mono mt-1 text-xl font-semibold">{s.v}</div>
                    </div>
                  ))}
                </div>

                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={readings.map((r) => ({
                        minute: r.minute,
                        risk: +(r.risk * 100).toFixed(1),
                        gas: r.gas_lel,
                      }))}
                      margin={{ top: 4, right: 8, bottom: 0, left: -18 }}
                    >
                      <defs>
                        <linearGradient id="invRiskG" x1="0" y1="0" x2="0" y2="1">
                          <stop
                            offset="0%"
                            stopColor="var(--color-destructive)"
                            stopOpacity={0.55}
                          />
                          <stop
                            offset="100%"
                            stopColor="var(--color-destructive)"
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        stroke="var(--color-border)"
                        strokeDasharray="2 4"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="minute"
                        tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                        stroke="var(--color-border)"
                        tickLine={false}
                      />
                      <YAxis
                        domain={[0, 100]}
                        tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                        stroke="var(--color-border)"
                        tickLine={false}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "var(--color-background)",
                          border: "1px solid var(--color-border)",
                          borderRadius: 6,
                          fontSize: 11,
                        }}
                        labelFormatter={(m) => `Minute ${m}`}
                      />
                      <ReferenceLine
                        x={minute}
                        stroke="var(--color-primary)"
                        strokeDasharray="3 3"
                        label={{ value: "now", fontSize: 10, fill: "var(--color-primary)" }}
                      />
                      <Area
                        name="Risk %"
                        dataKey="risk"
                        stroke="var(--color-destructive)"
                        strokeWidth={1.75}
                        fill="url(#invRiskG)"
                        type="monotone"
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </>
            );
          }}
        </QueryBoundary>
      </Panel>
    </div>
  );
}
