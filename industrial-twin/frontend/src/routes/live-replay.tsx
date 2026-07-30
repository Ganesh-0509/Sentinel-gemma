import { createFileRoute } from "@tanstack/react-router";
import { Panel, Chip, StatusDot } from "@/components/panel";
import { Loading, QueryBoundary } from "@/components/data-state";
import { RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  asShiftTime,
  bandTone,
  riskPct,
  useClock,
  useSetClock,
  useZoneHistory,
  useZones,
} from "@/lib/queries";
import type { ZoneState } from "@/lib/api-types";

export const Route = createFileRoute("/live-replay")({
  head: () => ({
    meta: [
      { title: "Live Incident Replay · SentinelAI" },
      {
        name: "description",
        content:
          "Replay the plant episode minute by minute against the live plant clock, with real risk and gas traces.",
      },
    ],
  }),
  component: LiveReplay,
});

const HISTORY_WINDOW = 120;

function LiveReplay() {
  const clock = useClock();
  const zones = useZones();
  const setClock = useSetClock();

  const [zoneId, setZoneId] = useState<string | undefined>(undefined);

  const zoneList = zones.data ?? [];
  // Default to whichever zone is currently carrying the most risk.
  const activeZoneId =
    zoneId ?? [...zoneList].sort((a, b) => b.risk - a.risk)[0]?.zone_id ?? undefined;

  const history = useZoneHistory(activeZoneId, HISTORY_WINDOW);
  const minute = clock.data?.minute ?? 0;
  const lastMinute = (clock.data?.episode_minutes ?? 240) - 1;
  const laps = clock.data?.laps ?? 0;

  // There is no play/pause. The backend advances the clock from the moment it
  // starts and wraps at the end of the episode, so the plant is always running
  // and these controls only seek within it — the clock carries on from wherever
  // it lands.
  const jump = (to: number) => setClock.mutate(Math.max(0, Math.min(lastMinute, to)));

  const activeZone = zoneList.find((z) => z.zone_id === activeZoneId);
  const progress = (minute / lastMinute) * 100;

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-12">
      {/* ── ZONE SELECTOR + LIVE SNAPSHOT ────────────────────────────── */}
      <Panel
        title="Plant Zones"
        subtitle={`Snapshot at minute ${minute} · ${asShiftTime(minute)}`}
        className="lg:col-span-5 max-h-[calc(100vh-100px)]"
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
            <ul className="divide-y divide-border">
              {data.map((z) => {
                const selected = z.zone_id === activeZoneId;
                return (
                  <li key={z.zone_id}>
                    <button
                      onClick={() => setZoneId(z.zone_id)}
                      className={`flex w-full items-center gap-3 border-l-2 px-4 py-2.5 text-left transition-colors ${
                        selected
                          ? "border-primary bg-primary/8"
                          : "border-transparent hover:bg-muted/40"
                      }`}
                    >
                      <StatusDot tone={bandTone(z.risk_band)} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-medium">{z.name}</div>
                        <div className="mono text-[11px] text-muted-foreground">
                          {z.zone_id} · {z.gas_lel.toFixed(2)}% LEL · {z.gas_trend > 0 ? "+" : ""}
                          {z.gas_trend.toFixed(3)}/min
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div
                          className={`mono text-[15px] font-semibold ${
                            z.risk_band === "CRITICAL"
                              ? "text-destructive"
                              : z.risk_band === "HIGH" || z.risk_band === "MEDIUM"
                                ? "text-warning"
                                : "text-foreground"
                          }`}
                        >
                          {riskPct(z.risk)}%
                        </div>
                        <Chip tone={bandTone(z.risk_band)} className="mt-0.5">
                          {z.risk_band}
                        </Chip>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </QueryBoundary>
      </Panel>

      <div className="flex flex-col gap-3 lg:col-span-7">
        {/* ── RISK / GAS TRACE ───────────────────────────────────────── */}
        <Panel
          title="Risk & Gas Trace"
          subtitle={
            activeZone
              ? `${activeZone.name} · last ${HISTORY_WINDOW} min of the episode`
              : "Select a zone"
          }
          actions={
            activeZone && (
              <Chip tone={bandTone(activeZone.risk_band)}>{riskPct(activeZone.risk)}% risk</Chip>
            )
          }
          className="min-h-[280px]"
        >
          <QueryBoundary
            query={history}
            loadingLabel="Loading zone history"
            emptyLabel="No readings in this window"
            isEmpty={(h) => h.length === 0}
          >
            {(readings) => (
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
                      <linearGradient id="riskG" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-destructive)" stopOpacity={0.6} />
                        <stop offset="100%" stopColor="var(--color-destructive)" stopOpacity={0} />
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
                      yAxisId="risk"
                      domain={[0, 100]}
                      tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                      stroke="var(--color-border)"
                      tickLine={false}
                    />
                    <YAxis yAxisId="gas" orientation="right" hide />
                    <Tooltip
                      contentStyle={{
                        background: "var(--color-background)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 6,
                        fontSize: 11,
                      }}
                      labelFormatter={(m) => `Minute ${m} · ${asShiftTime(Number(m))}`}
                    />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Area
                      yAxisId="risk"
                      name="Risk %"
                      dataKey="risk"
                      stroke="var(--color-destructive)"
                      strokeWidth={1.75}
                      fill="url(#riskG)"
                      type="monotone"
                      isAnimationActive={false}
                    />
                    <Line
                      yAxisId="gas"
                      name="Gas % LEL"
                      dataKey="gas"
                      stroke="var(--color-primary)"
                      strokeWidth={1.25}
                      dot={false}
                      type="monotone"
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </QueryBoundary>
        </Panel>

        {/* ── SENSOR SNAPSHOT ────────────────────────────────────────── */}
        <Panel
          title="Sensor Snapshot"
          subtitle={activeZone ? `${activeZone.zone_id} at minute ${minute}` : undefined}
        >
          {activeZone ? (
            <div className="grid grid-cols-3 gap-3">
              {[
                { l: "Gas % LEL", v: activeZone.gas_lel.toFixed(2) },
                {
                  l: "Gas Trend /min",
                  v: `${activeZone.gas_trend > 0 ? "+" : ""}${activeZone.gas_trend.toFixed(3)}`,
                },
                { l: "Pressure (bar)", v: activeZone.pressure.toFixed(2) },
                { l: "Temp (°C)", v: activeZone.temperature.toFixed(1) },
                { l: "Anomaly Score", v: activeZone.anomaly_score.toFixed(2) },
                { l: "Workers", v: String(activeZone.workers_in_zone) },
              ].map((s) => (
                <div key={s.l} className="rounded-md border border-border bg-background/40 p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {s.l}
                  </div>
                  <div className="mono mt-1 text-xl font-semibold">{s.v}</div>
                </div>
              ))}
            </div>
          ) : (
            <Loading label="Waiting for zone data" />
          )}

          {activeZone && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {activeZone.maintenance_active && <Chip tone="warn">Maintenance</Chip>}
              {activeZone.hot_work_active && <Chip tone="danger">Hot Work</Chip>}
              {activeZone.in_changeover && <Chip tone="warn">Changeover</Chip>}
              {activeZone.night_shift && <Chip tone="info">Night Shift</Chip>}
              <Chip tone={activeZone.baseline_alarm ? "danger" : "muted"}>
                Baseline alarm {activeZone.baseline_alarm ? "firing" : "silent"}
              </Chip>
              {activeZone.lead_time_min !== null && (
                <Chip tone="warn">{activeZone.lead_time_min} min lead</Chip>
              )}
            </div>
          )}
        </Panel>

        {/* ── TRANSPORT ──────────────────────────────────────────────── */}
        <Panel
          title="Plant Clock"
          subtitle="Runs continuously from backend startup — every page follows it. Seek to jump; it keeps running."
          actions={
            <span className="mono flex items-center gap-2">
              {clock.data?.running && (
                <span className="flex items-center gap-1 text-success">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
                  </span>
                  running
                </span>
              )}
              <span>
                minute {minute} / {lastMinute}
              </span>
            </span>
          }
        >
          <div className="flex items-center gap-3">
            <button
              onClick={() => jump(0)}
              title="Jump to the start of the shift"
              className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => jump(minute - 10)}
              title="Back 10 minutes"
              className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground hover:text-foreground"
            >
              <SkipBack className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => jump(minute + 10)}
              title="Forward 10 minutes"
              className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground hover:text-foreground"
            >
              <SkipForward className="h-3.5 w-3.5" />
            </button>

            <div className="ml-2 flex-1">
              <input
                type="range"
                min={0}
                max={lastMinute}
                step={1}
                value={minute}
                onChange={(e) => jump(Number(e.target.value))}
                aria-label="Episode minute"
                className="w-full accent-[var(--color-primary)]"
              />
              <div className="relative mt-1 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="mono mt-1.5 flex justify-between text-[10px] text-muted-foreground">
                <span>{asShiftTime(0)}</span>
                <span className="text-foreground">{asShiftTime(minute)}</span>
                <span>{asShiftTime(lastMinute)}</span>
              </div>
            </div>

            <div className="shrink-0 text-right leading-tight">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Rate</div>
              <div className="mono text-[11px] text-foreground">
                {clock.data ? `${clock.data.seconds_per_minute}s / min` : "—"}
              </div>
              {laps > 0 && (
                <div
                  className="mono text-[10px] text-muted-foreground"
                  title="Completed replays of the shift since the backend started"
                >
                  replay {laps + 1}
                </div>
              )}
            </div>
          </div>

          {setClock.error && (
            <p className="mt-2 text-[11px] text-destructive">
              Clock command failed: {setClock.error.message}
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}
