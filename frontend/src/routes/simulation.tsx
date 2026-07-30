import { createFileRoute } from "@tanstack/react-router";
import { Panel, Chip, StatusDot } from "@/components/panel";
import { ErrorState, Loading } from "@/components/data-state";
import PlantScene, {
  type LiveZone,
  type SelectedAsset,
  type TwinLayers,
} from "@/components/twin/plant-scene";
import { useSimulation, useZones, riskPct, bandTone } from "@/lib/queries";
import type { SimulationRequest } from "@/lib/api-types";
import { Maximize2, RotateCw, Sun, Moon, RefreshCw, Loader2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/simulation")({
  head: () => ({
    meta: [
      { title: "What-If Simulation · Sentinel-Gemma" },
      {
        name: "description",
        content:
          "Counterfactual plant conditions scored by the trained compound-risk forecaster, projected onto the live 3D twin.",
      },
    ],
  }),
  component: WhatIfSimulation,
});

const DEFAULTS: Required<
  Pick<SimulationRequest, "gas_delta" | "pressure_delta" | "temperature_delta">
> & {
  hot_work: boolean | null;
  maintenance: boolean | null;
} = {
  gas_delta: 0,
  pressure_delta: 0,
  temperature_delta: 0,
  hot_work: null,
  maintenance: null,
};

const LAYER_CONFIG: Array<{ key: keyof TwinLayers; label: string; colour: string }> = [
  { key: "heatmap", label: "Simulated Risk", colour: "var(--color-destructive)" },
  { key: "zones", label: "Safety Zones", colour: "var(--color-primary)" },
  { key: "workers", label: "Crew in Zones", colour: "#a855f7" },
  { key: "routes", label: "Evacuation Routes", colour: "var(--color-success)" },
];

function WhatIfSimulation() {
  const shellRef = useRef<HTMLDivElement>(null);

  const [gas, setGas] = useState(DEFAULTS.gas_delta);
  const [pressure, setPressure] = useState(DEFAULTS.pressure_delta);
  const [temp, setTemp] = useState(DEFAULTS.temperature_delta);
  const [hotWork, setHotWork] = useState<boolean | null>(DEFAULTS.hot_work);
  const [maint, setMaint] = useState<boolean | null>(DEFAULTS.maintenance);

  const [layers, setLayers] = useState<TwinLayers>({
    heatmap: true,
    zones: true,
    workers: true,
    routes: false,
  });
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [resetSignal, setResetSignal] = useState(0);
  const [asset, setAsset] = useState<SelectedAsset | null>(null);

  const zonesQuery = useZones();

  const request: SimulationRequest = useMemo(
    () => ({
      gas_delta: gas,
      pressure_delta: pressure,
      temperature_delta: temp,
      hot_work: hotWork,
      maintenance: maint,
    }),
    [gas, pressure, temp, hotWork, maint],
  );

  const sim = useSimulation(request);
  const results = sim.data;

  const touched = gas !== 0 || pressure !== 0 || temp !== 0 || hotWork !== null || maint !== null;

  // Plot the simulated risk onto the 3D site, keeping each zone's real position.
  const liveZones: LiveZone[] | null = useMemo(() => {
    if (!results || !zonesQuery.data) return null;
    const byId = new Map(zonesQuery.data.map((z) => [z.zone_id, z]));
    return results.map((r) => {
      const z = byId.get(r.zone_id);
      return {
        zone_id: r.zone_id,
        name: r.name,
        x: z?.x ?? 50,
        y: z?.y ?? 50,
        risk: r.simulated_risk,
        gas_lel: r.gas_lel,
        workers_in_zone: z?.workers_in_zone ?? 0,
        baseline_alarm: r.baseline_alarm,
      };
    });
  }, [results, zonesQuery.data]);

  const peak = results?.length
    ? results.reduce((a, b) => (b.simulated_risk > a.simulated_risk ? b : a))
    : null;

  const handleSelect = useCallback((a: SelectedAsset | null) => setAsset(a), []);
  const toggleLayer = (key: keyof TwinLayers) =>
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));

  const resetAll = () => {
    setGas(0);
    setPressure(0);
    setTemp(0);
    setHotWork(null);
    setMaint(null);
  };

  const goFullscreen = () => {
    const el = shellRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  };

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-12">
      {/* ── CONTROLS ──────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 lg:col-span-4">
        <Panel
          title="What-If Conditions"
          subtitle="Scored by the trained compound-risk forecaster"
          actions={
            <>
              {sim.isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
              <button onClick={resetAll} className="flex items-center gap-1 hover:text-foreground">
                <RefreshCw className="h-3 w-3" /> Reset
              </button>
            </>
          }
        >
          <div className="space-y-4">
            <Slider
              label="Gas offset"
              value={gas}
              onChange={setGas}
              min={-10}
              max={20}
              step={0.5}
              suffix=" %LEL"
            />
            <Slider
              label="Pressure offset"
              value={pressure}
              onChange={setPressure}
              min={-3}
              max={3}
              step={0.1}
              suffix=" bar"
            />
            <Slider
              label="Temperature offset"
              value={temp}
              onChange={setTemp}
              min={-30}
              max={40}
              step={1}
              suffix=" °C"
            />
          </div>

          <div className="mt-4 space-y-2">
            <TriToggle label="Hot-work permit" value={hotWork} onChange={setHotWork} />
            <TriToggle label="Maintenance active" value={maint} onChange={setMaint} />
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Offsets ramp in over the model&rsquo;s feature window and are re-scored server-side by
            the same LightGBM forecaster used for live risk — not a client-side approximation.
          </p>
        </Panel>

        <Panel
          title="Zone Risk — Actual vs Simulated"
          subtitle={touched ? "Overrides applied" : "No overrides — matches live risk"}
          bodyClassName="p-0"
        >
          {sim.isPending ? (
            <Loading label="Scoring counterfactual" />
          ) : sim.error ? (
            <div className="p-3">
              <ErrorState error={sim.error} onRetry={sim.refetch} />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {results?.map((r) => {
                const before = riskPct(r.baseline_risk);
                const after = riskPct(r.simulated_risk);
                const d = after - before;
                return (
                  <li key={r.zone_id} className="flex items-center gap-2 px-3 py-2 text-[12px]">
                    <StatusDot tone={bandTone(r.risk_band)} />
                    <span className="flex-1 truncate">{r.name}</span>
                    <span className="mono text-[11px] text-muted-foreground">{before}%</span>
                    <span className="text-muted-foreground">→</span>
                    <span
                      className={`mono w-9 text-right font-semibold ${
                        after > 60
                          ? "text-destructive"
                          : after > 30
                            ? "text-warning"
                            : "text-success"
                      }`}
                    >
                      {after}%
                    </span>
                    <span
                      className={`mono w-11 text-right text-[10px] ${
                        d > 0
                          ? "text-destructive"
                          : d < 0
                            ? "text-success"
                            : "text-muted-foreground"
                      }`}
                    >
                      {d > 0 ? "+" : ""}
                      {d}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        {peak && peak.drivers.length > 0 && (
          <Panel title="Why — Highest Zone" subtitle={`SHAP drivers · ${peak.zone_id}`}>
            <ul className="space-y-1.5">
              {peak.drivers.map((d) => (
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
          </Panel>
        )}
      </div>

      {/* ── 3D RESULT ─────────────────────────────────────────────────── */}
      <Panel
        title="Simulated Plant State"
        subtitle={peak ? `Peak ${riskPct(peak.simulated_risk)}% · ${peak.name}` : "Live 3D twin"}
        actions={
          <>
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
              <RotateCw className="h-3 w-3" /> View
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
            <div className="absolute right-3 top-3 w-[210px] rounded-md border border-border bg-background/90 p-3 backdrop-blur">
              <div className="text-[12px] font-semibold">{asset.name}</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                {asset.type}
              </div>
            </div>
          )}

          <span className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-border bg-background/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur">
            Column height = simulated zone risk
          </span>

          {touched && (
            <Chip tone="warn" className="absolute bottom-3 right-3">
              counterfactual
            </Chip>
          )}
        </div>
      </Panel>
    </div>
  );
}

/** null = leave the zone's real value alone; true/false = force it. */
function TriToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const opts: Array<{ v: boolean | null; t: string }> = [
    { v: null, t: "As-is" },
    { v: true, t: "On" },
    { v: false, t: "Off" },
  ];
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="flex overflow-hidden rounded-sm border border-border">
        {opts.map((o) => (
          <button
            key={String(o.v)}
            onClick={() => onChange(o.v)}
            className={`px-2 py-1 text-[10px] transition-colors ${
              value === o.v
                ? "bg-primary/20 text-foreground"
                : "text-muted-foreground hover:bg-muted/40"
            }`}
          >
            {o.t}
          </button>
        ))}
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step: number;
  suffix: string;
}) {
  return (
    <div>
      <div className="flex justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className={`mono ${value !== 0 ? "text-foreground" : "text-muted-foreground"}`}>
          {value > 0 ? "+" : ""}
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        className="mt-1 w-full accent-primary"
      />
    </div>
  );
}
