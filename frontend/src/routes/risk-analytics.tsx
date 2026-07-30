import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Panel, Chip } from "@/components/panel";
import { QueryBoundary } from "@/components/data-state";
import { ZoneSelect } from "@/components/zone-select";
import { riskiestZoneId } from "@/lib/zones";
import { riskPct, useZoneHistory, useZones } from "@/lib/queries";
import type { RiskBand, ZoneState } from "@/lib/api-types";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export const Route = createFileRoute("/risk-analytics")({
  head: () => ({
    meta: [
      { title: "Risk Analytics · Sentinel-Gemma" },
      {
        name: "description",
        content:
          "Trend and distribution analytics across plant risk, alerts, and predictive accuracy.",
      },
    ],
  }),
  component: RiskAnalytics,
});

const TOOLTIP_STYLE = {
  background: "var(--color-panel)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 11,
} as const;

const BAND_ORDER: RiskBand[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const BAND_COLOR: Record<RiskBand, string> = {
  CRITICAL: "var(--color-destructive)",
  HIGH: "var(--color-warning)",
  MEDIUM: "var(--color-primary)",
  LOW: "var(--color-success)",
};

function bandDistribution(zones: ZoneState[]) {
  return BAND_ORDER.map((band) => ({
    name: band.charAt(0) + band.slice(1).toLowerCase(),
    band,
    value: zones.filter((z) => z.risk_band === band).length,
    color: BAND_COLOR[band],
  })).filter((d) => d.value > 0);
}

function RiskAnalytics() {
  const zones = useZones();
  const [selected, setSelected] = useState<string>();

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-12">
      <QueryBoundary
        query={zones}
        loadingLabel="Loading zone risk"
        emptyLabel="No zones reported"
        isEmpty={(z) => z.length === 0}
      >
        {(list) => {
          const zoneId = selected ?? riskiestZoneId(list);
          const dist = bandDistribution(list);
          const byRisk = [...list].sort((a, b) => b.risk - a.risk);

          return (
            <>
              <KpiRow zones={list} />

              <Panel
                title="Risk by Zone"
                subtitle={`Current model output across ${list.length} zones`}
                className="lg:col-span-8 min-h-[280px]"
              >
                <ResponsiveContainer>
                  <BarChart
                    data={byRisk.map((z) => ({
                      zone: z.zone_id,
                      risk: riskPct(z.risk),
                      band: z.risk_band,
                    }))}
                  >
                    <CartesianGrid
                      stroke="var(--color-grid-line)"
                      strokeDasharray="2 4"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="zone"
                      stroke="var(--color-muted-foreground)"
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      domain={[0, 100]}
                      unit="%"
                      stroke="var(--color-muted-foreground)"
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(v) => [`${Number(v)}%`, "Risk"]}
                    />
                    <Bar dataKey="risk" radius={[2, 2, 0, 0]}>
                      {byRisk.map((z) => (
                        <Cell key={z.zone_id} fill={BAND_COLOR[z.risk_band]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </Panel>

              <Panel
                title="Risk Band Distribution"
                subtitle="Zones per band, right now"
                className="lg:col-span-4 min-h-[280px]"
              >
                <div className="flex h-full items-center gap-4">
                  <ResponsiveContainer width="55%" height="100%">
                    <PieChart>
                      <Pie
                        data={dist}
                        dataKey="value"
                        innerRadius={45}
                        outerRadius={72}
                        paddingAngle={2}
                        stroke="var(--color-panel)"
                        strokeWidth={2}
                      >
                        {dist.map((d) => (
                          <Cell key={d.band} fill={d.color} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={TOOLTIP_STYLE} />
                    </PieChart>
                  </ResponsiveContainer>
                  <ul className="flex-1 space-y-1.5 text-[11px]">
                    {dist.map((d) => (
                      <li key={d.band} className="flex items-center justify-between">
                        <span className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-sm" style={{ background: d.color }} />
                          {d.name}
                        </span>
                        <span className="mono text-muted-foreground">
                          {d.value} ({Math.round((d.value / list.length) * 100)}%)
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Panel>

              <ZoneTimeseries zones={list} zoneId={zoneId} onSelect={setSelected} />
              <ZoneVibration zones={list} zoneId={zoneId} onSelect={setSelected} />

              <Panel
                title="Zone Readout"
                subtitle="Sorted by current risk"
                className="lg:col-span-4"
                padded={false}
              >
                <ul className="divide-y divide-border text-[12px]">
                  {byRisk.map((z) => (
                    <li key={z.zone_id} className="flex items-center justify-between px-4 py-2">
                      <div className="min-w-0">
                        <div className="mono text-[11px] text-muted-foreground">{z.zone_id}</div>
                        <div className="truncate font-medium">{z.name}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="mono font-semibold">{riskPct(z.risk)}%</span>
                        <Chip
                          tone={
                            z.risk_band === "CRITICAL"
                              ? "danger"
                              : z.risk_band === "HIGH" || z.risk_band === "MEDIUM"
                                ? "warn"
                                : "success"
                          }
                        >
                          {z.risk_band}
                        </Chip>
                      </div>
                    </li>
                  ))}
                </ul>
              </Panel>
            </>
          );
        }}
      </QueryBoundary>
    </div>
  );
}

/**
 * Vibration is the one signal that exists only in the history endpoint, not on
 * the live ZoneState, so it gets its own trace.
 */
function ZoneVibration({
  zones,
  zoneId,
  onSelect,
}: {
  zones: ZoneState[];
  zoneId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const history = useZoneHistory(zoneId);

  return (
    <Panel
      title="Vibration Trace"
      subtitle={zoneId ? `${zoneId} · equipment vibration index, last 90 minutes` : "Select a zone"}
      className="lg:col-span-12 min-h-[240px]"
      actions={zoneId && <ZoneSelect zones={zones} value={zoneId} onChange={onSelect} />}
    >
      <QueryBoundary
        query={history}
        loadingLabel="Loading vibration history"
        emptyLabel="No readings in this window"
        isEmpty={(h) => h.length === 0}
      >
        {(readings) => (
          <ResponsiveContainer>
            <ComposedChart data={readings}>
              <defs>
                <linearGradient id="vib" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                stroke="var(--color-grid-line)"
                strokeDasharray="2 4"
                vertical={false}
              />
              <XAxis
                dataKey="minute"
                stroke="var(--color-muted-foreground)"
                fontSize={10}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="var(--color-muted-foreground)"
                fontSize={10}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(v) => [`${Number(v).toFixed(3)}`, "Vibration"]}
                labelFormatter={(m) => `Minute ${m}`}
              />
              <Area
                dataKey="vibration"
                stroke="var(--color-primary)"
                strokeWidth={1.75}
                fill="url(#vib)"
                type="monotone"
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </QueryBoundary>
    </Panel>
  );
}

function ZoneTimeseries({
  zones,
  zoneId,
  onSelect,
}: {
  zones: ZoneState[];
  zoneId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const history = useZoneHistory(zoneId);

  return (
    <Panel
      title="Risk & Gas Timeseries"
      subtitle={zoneId ? `${zoneId} · last 90 minutes of the replayed episode` : "Select a zone"}
      className="lg:col-span-8 min-h-[280px]"
      actions={zoneId && <ZoneSelect zones={zones} value={zoneId} onChange={onSelect} />}
    >
      <QueryBoundary
        query={history}
        loadingLabel="Loading zone history"
        emptyLabel="No readings in this window"
        isEmpty={(h) => h.length === 0}
      >
        {(readings) => (
          <ResponsiveContainer>
            <ComposedChart
              data={readings.map((r) => ({
                minute: r.minute,
                risk: riskPct(r.risk),
                gas: r.gas_lel,
              }))}
            >
              <defs>
                <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-destructive)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="var(--color-destructive)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                stroke="var(--color-grid-line)"
                strokeDasharray="2 4"
                vertical={false}
              />
              <XAxis
                dataKey="minute"
                stroke="var(--color-muted-foreground)"
                fontSize={10}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                yAxisId="risk"
                domain={[0, 100]}
                unit="%"
                stroke="var(--color-muted-foreground)"
                fontSize={10}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                yAxisId="gas"
                orientation="right"
                stroke="var(--color-muted-foreground)"
                fontSize={10}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(v, name) => [
                  name === "risk" ? `${Number(v)}%` : `${Number(v)} % LEL`,
                  name === "risk" ? "Risk" : "Gas",
                ]}
                labelFormatter={(m) => `Minute ${m}`}
              />
              <Area
                yAxisId="risk"
                dataKey="risk"
                stroke="var(--color-destructive)"
                strokeWidth={1.75}
                fill="url(#rg)"
                type="monotone"
                isAnimationActive={false}
              />
              <Line
                yAxisId="gas"
                dataKey="gas"
                stroke="var(--color-warning)"
                strokeWidth={1.5}
                dot={false}
                type="monotone"
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </QueryBoundary>
    </Panel>
  );
}

function KpiRow({ zones }: { zones: ZoneState[] }) {
  const peak = zones.reduce((a, b) => (b.risk > a.risk ? b : a));
  const mean = zones.reduce((sum, z) => sum + z.risk, 0) / zones.length;
  const kpis: [string, string, "success" | "warn" | "danger"][] = [
    [
      "Mean Zone Risk",
      `${riskPct(mean)}%`,
      mean >= 0.5 ? "danger" : mean >= 0.25 ? "warn" : "success",
    ],
    [
      "Peak Zone Risk",
      `${riskPct(peak.risk)}%`,
      peak.risk >= 0.5 ? "danger" : peak.risk >= 0.25 ? "warn" : "success",
    ],
    [
      "Baseline Alarms Firing",
      `${zones.filter((z) => z.baseline_alarm).length}`,
      zones.some((z) => z.baseline_alarm) ? "warn" : "success",
    ],
    ["Workers Across Zones", `${zones.reduce((n, z) => n + z.workers_in_zone, 0)}`, "success"],
  ];
  return (
    <div className="lg:col-span-12 grid grid-cols-2 gap-3 md:grid-cols-4">
      {kpis.map(([label, value, tone]) => (
        <div key={label} className="panel px-4 py-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="mono text-2xl font-semibold">{value}</span>
            {label === "Peak Zone Risk" && <Chip tone={tone}>{peak.zone_id}</Chip>}
          </div>
        </div>
      ))}
    </div>
  );
}
