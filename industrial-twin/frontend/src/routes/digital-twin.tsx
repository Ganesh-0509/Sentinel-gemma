import { createFileRoute } from "@tanstack/react-router";
import { Panel, Chip, StatusDot } from "@/components/panel";
import { ErrorState, Loading } from "@/components/data-state";
import PlantScene, {
  type LiveZone,
  type SelectedAsset,
  type TwinLayers,
} from "@/components/twin/plant-scene";
import { useZones, useTick, useClock, asShiftTime, riskPct, bandTone } from "@/lib/queries";
import type { ZoneState } from "@/lib/api-types";
import { Maximize2, RotateCw, Sun, Moon, SkipForward } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/digital-twin")({
  head: () => ({
    meta: [
      { title: "Plant Digital Twin · SentinelAI" },
      {
        name: "description",
        content:
          "Interactive 3D plant map with per-zone risk, gas, pressure, temperature and worker context, streamed live from the SentinelAI backend.",
      },
    ],
  }),
  component: DigitalTwinPage,
});

const LAYER_CONFIG: Array<{ key: keyof TwinLayers; label: string; colour: string }> = [
  { key: "heatmap", label: "Live Zone Risk", colour: "var(--color-destructive)" },
  { key: "zones", label: "Safety Zones", colour: "var(--color-primary)" },
  { key: "workers", label: "Crew in Zones", colour: "#a855f7" },
  { key: "routes", label: "Evacuation Routes", colour: "var(--color-success)" },
];

function DigitalTwinPage() {
  const shellRef = useRef<HTMLDivElement>(null);

  const zonesQuery = useZones();
  const clockQuery = useClock();
  const tick = useTick();

  const [layers, setLayers] = useState<TwinLayers>({
    heatmap: true,
    zones: true,
    workers: true,
    routes: false,
  });
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [resetSignal, setResetSignal] = useState(0);
  const [asset, setAsset] = useState<SelectedAsset | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const zones = zonesQuery.data;
  const selected: ZoneState | undefined = useMemo(
    () => zones?.find((z) => z.zone_id === selectedId) ?? zones?.[0],
    [zones, selectedId],
  );

  // Project backend zones onto the 3D site.
  const liveZones: LiveZone[] | null = useMemo(
    () =>
      zones?.map((z) => ({
        zone_id: z.zone_id,
        name: z.name,
        x: z.x,
        y: z.y,
        risk: z.risk,
        gas_lel: z.gas_lel,
        workers_in_zone: z.workers_in_zone,
        baseline_alarm: z.baseline_alarm,
      })) ?? null,
    [zones],
  );

  const handleSelect = useCallback((a: SelectedAsset | null) => setAsset(a), []);

  const toggleLayer = (key: keyof TwinLayers) =>
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));

  const goFullscreen = () => {
    const el = shellRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  };

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-12">
      <Panel
        title="Plant Digital Twin"
        subtitle={
          clockQuery.data
            ? `Live 3D site model · plant clock ${asShiftTime(clockQuery.data.minute)} (min ${clockQuery.data.minute})`
            : "Live 3D site model"
        }
        actions={
          <>
            <button
              onClick={() => tick.mutate(5)}
              disabled={tick.isPending}
              className="flex items-center gap-1 hover:text-foreground disabled:opacity-50"
              title="Skip the plant clock forward 5 minutes"
            >
              <SkipForward className="h-3 w-3" /> +5m
            </button>
            <button
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              className="flex items-center gap-1 hover:text-foreground"
              title="Toggle scene lighting"
            >
              {theme === "dark" ? <Sun className="h-3 w-3" /> : <Moon className="h-3 w-3" />}
              {theme === "dark" ? "Day" : "Night"}
            </button>
            <button
              onClick={() => setResetSignal((n) => n + 1)}
              className="flex items-center gap-1 hover:text-foreground"
              title="Reset camera"
            >
              <RotateCw className="h-3 w-3" /> Reset
            </button>
            <button onClick={goFullscreen} className="hover:text-foreground" title="Fullscreen">
              <Maximize2 className="h-3 w-3" />
            </button>
          </>
        }
        className="lg:col-span-8 min-h-[620px]"
        bodyClassName="p-0"
      >
        <div
          ref={shellRef}
          className="relative h-full min-h-[560px] w-full overflow-hidden rounded-b-md bg-background"
        >
          <PlantScene
            layers={layers}
            theme={theme}
            resetSignal={resetSignal}
            liveZones={liveZones}
            onSelectAsset={handleSelect}
            className="h-full w-full"
          />

          <div className="absolute left-3 top-3 w-[178px] rounded-md border border-border bg-background/85 p-2.5 backdrop-blur">
            <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              Overlays
            </div>
            {LAYER_CONFIG.map((item) => {
              const active = layers[item.key];
              return (
                <button
                  key={item.key}
                  onClick={() => toggleLayer(item.key)}
                  className={`mb-1 flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[11px] transition-colors ${
                    active
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted/40"
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{
                      background: active ? item.colour : "var(--color-muted-foreground)",
                      opacity: active ? 1 : 0.4,
                    }}
                  />
                  {item.label}
                </button>
              );
            })}
          </div>

          {asset && (
            <div className="absolute right-3 top-3 w-[220px] rounded-md border border-border bg-background/90 p-3 backdrop-blur">
              <div className="text-[12px] font-semibold">{asset.name}</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                {asset.type}
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                Plant structure from the 3D site model. Risk figures come from the backend zones
                listed alongside.
              </p>
            </div>
          )}

          <span className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-border bg-background/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur">
            Drag to orbit · scroll to zoom · column height = live zone risk
          </span>
        </div>
      </Panel>

      <div className="flex flex-col gap-3 lg:col-span-4">
        <Panel
          title="Live Zones"
          subtitle={zones ? `${zones.length} zones from the backend` : "Loading"}
          bodyClassName="p-0"
        >
          {zonesQuery.isPending ? (
            <Loading label="Reading plant telemetry" />
          ) : zonesQuery.error ? (
            <div className="p-3">
              <ErrorState error={zonesQuery.error} onRetry={zonesQuery.refetch} />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {zones?.map((z) => (
                <li
                  key={z.zone_id}
                  onClick={() => setSelectedId(z.zone_id)}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-[12px] ${
                    selected?.zone_id === z.zone_id ? "bg-primary/8" : "hover:bg-muted/30"
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

        {selected && (
          <Panel title={selected.name} subtitle={`${selected.zone_id} · zone detail`}>
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-background/40 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    Compound Risk
                  </span>
                  <Chip
                    tone={
                      bandTone(selected.risk_band) === "muted"
                        ? "muted"
                        : bandTone(selected.risk_band)
                    }
                  >
                    {selected.risk_band}
                  </Chip>
                </div>
                <div className="mono mt-1 text-4xl font-semibold">{riskPct(selected.risk)}%</div>
                {selected.lead_time_min !== null && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Predicted threshold crossing in{" "}
                    <span className="mono text-foreground">{selected.lead_time_min} min</span>
                  </p>
                )}
              </div>

              <dl className="grid grid-cols-2 gap-2 text-[12px]">
                {(
                  [
                    ["Gas % LEL", selected.gas_lel.toFixed(2)],
                    [
                      "Gas trend",
                      `${selected.gas_trend > 0 ? "+" : ""}${selected.gas_trend.toFixed(3)}`,
                    ],
                    ["Pressure", `${selected.pressure.toFixed(2)} bar`],
                    ["Temperature", `${selected.temperature.toFixed(1)} °C`],
                    ["Anomaly score", selected.anomaly_score.toFixed(2)],
                    ["Workers", String(selected.workers_in_zone)],
                  ] as Array<[string, string]>
                ).map(([k, v]) => (
                  <div
                    key={k}
                    className="rounded-md border border-border bg-background/40 px-2.5 py-1.5"
                  >
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {k}
                    </div>
                    <div className="mono mt-0.5 font-semibold">{v}</div>
                  </div>
                ))}
              </dl>

              <div className="flex flex-wrap gap-1">
                {selected.maintenance_active && <Chip tone="warn">maintenance</Chip>}
                {selected.hot_work_active && <Chip tone="danger">hot work</Chip>}
                {selected.night_shift && <Chip tone="info">night shift</Chip>}
                {selected.in_changeover && <Chip tone="info">changeover</Chip>}
                <Chip tone={selected.baseline_alarm ? "warn" : "muted"}>
                  baseline {selected.baseline_alarm ? "alarming" : "silent"}
                </Chip>
              </div>

              {selected.drivers.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Why this score (SHAP)
                  </div>
                  <ul className="space-y-1">
                    {selected.drivers.map((d) => (
                      <li key={d.feature} className="flex items-center gap-2 text-[11px]">
                        <span className="flex-1 truncate text-muted-foreground">{d.label}</span>
                        <span
                          className={`mono ${d.contribution > 0 ? "text-destructive" : "text-success"}`}
                        >
                          {d.contribution > 0 ? "+" : ""}
                          {d.contribution.toFixed(3)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
