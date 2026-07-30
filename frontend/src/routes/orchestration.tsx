import { createFileRoute } from "@tanstack/react-router";
import { Chip, Panel } from "@/components/panel";
import {
  GemmaReasoningPanel,
  GemmaTelemetryStrip,
  OperatorBriefingPanel,
  ToolExecutionStream,
} from "@/components/gemma/gemma-panels";
import {
  riskPct,
  useGemmaStatus,
  useOrchestrator,
  useOrchestratorEnable,
} from "@/lib/queries";
import type {
  ChainLayer,
  ChainNodeState,
  OrchestratorRun,
  SensorAgent,
} from "@/lib/api-types";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  Cpu,
  Pause,
  Play,
  Radio,
  ShieldCheck,
} from "lucide-react";

export const Route = createFileRoute("/orchestration")({
  head: () => ({
    meta: [
      { title: "AI Orchestration · Sentinel-Gemma" },
      {
        name: "description",
        content:
          "Autonomous Gemma orchestration: sensor agents raise a hazard, Gemma plans containment, a deterministic gate authorises it.",
      },
    ],
  }),
  component: Orchestration,
});

/**
 * The autonomous orchestration console.
 *
 * Nothing on this page is triggered by the operator. The backend loop scans every
 * zone, picks the one that most needs attention, and runs the agent chain against
 * it — this view is a window onto that, not a control for it. There is no zone
 * picker and no run button, because a control room is not a query tool: the system
 * is supposed to notice, not to be asked.
 *
 * The layout follows the chain top to bottom, so the causality is visible rather
 * than described: sensor agents raise a hazard, retrieval establishes what the
 * standard requires, Gemma proposes containment, the gate authorises, and the
 * response layer issues actions.
 */

const LAYERS: { key: ChainLayer; title: string; note: string }[] = [
  { key: "sensor", title: "Sensor layer", note: "Deterministic — decides whether the agents run at all" },
  { key: "retrieval", title: "Retrieval layer", note: "Grounds the answer in the governing standard" },
  { key: "gemma", title: "Gemma agent layer", note: "Proposes, reflects, briefs — never authorises itself" },
  { key: "response", title: "Response layer", note: "Issues actions and the regulatory notification" },
];

const stateTone = (s: ChainNodeState["state"]) =>
  s === "running"
    ? "border-primary bg-primary/10 text-foreground"
    : s === "done"
      ? "border-success/40 bg-success/5 text-foreground"
      : "border-border bg-background/30 text-muted-foreground";

function SensorCard({ s, isTarget }: { s: SensorAgent; isTarget: boolean }) {
  const alerting = s.state === "alerting";
  return (
    <motion.div
      layout
      animate={
        // Only the zone actually being analysed pulses. Pulsing every alerting
        // zone made the row read as "everything is on fire", which is the alarm
        // fatigue this project exists to remove.
        isTarget ? { scale: [1, 1.02, 1] } : { scale: 1 }
      }
      transition={isTarget ? { duration: 1.6, repeat: Infinity } : { duration: 0.2 }}
      className={`relative rounded-md border px-2.5 py-2 ${
        isTarget
          ? "border-destructive bg-destructive/10"
          : alerting
            ? "border-warning/50 bg-warning/5"
            : s.state === "elevated"
              ? "border-border bg-background/50"
              : "border-border bg-background/30"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="mono text-[11px] font-semibold text-foreground">{s.zone_id}</span>
        <span
          className={`mono text-[11px] font-semibold ${
            s.risk >= 0.85
              ? "text-destructive"
              : s.risk >= 0.5
                ? "text-warning"
                : "text-muted-foreground"
          }`}
        >
          {riskPct(s.risk)}%
        </span>
      </div>
      <div className="mono mt-1 text-[10px] leading-tight text-muted-foreground">
        {s.gas_lel.toFixed(2)} %LEL {s.gas_trend > 0 ? "↑" : s.gas_trend < 0 ? "↓" : "→"}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {s.hot_work_active && (
          <span className="rounded-sm bg-destructive/15 px-1 text-[9px] uppercase text-destructive">
            hot work
          </span>
        )}
        {s.workers_in_zone > 0 && (
          <span className="rounded-sm bg-muted/60 px-1 text-[9px] uppercase text-muted-foreground">
            {s.workers_in_zone} crew
          </span>
        )}
      </div>
      {isTarget && (
        <div className="mono mt-1 flex items-center gap-1 text-[9px] uppercase tracking-wider text-destructive">
          <Radio className="h-2.5 w-2.5" /> analysing
        </div>
      )}
    </motion.div>
  );
}

function ChainLayerRow({
  layer,
  nodes,
  activeNode,
}: {
  layer: (typeof LAYERS)[number];
  nodes: ChainNodeState[];
  activeNode: string | null;
}) {
  if (nodes.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground">
          {layer.title}
        </span>
        <span className="text-[10px] text-muted-foreground">{layer.note}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {nodes.map((n) => (
          <motion.div
            key={n.node}
            layout
            className={`rounded-md border px-2.5 py-2 transition-colors ${stateTone(n.state)}`}
            animate={
              n.node === activeNode
                ? { boxShadow: ["0 0 0 0 rgba(99,102,241,0)", "0 0 0 3px rgba(99,102,241,0.25)", "0 0 0 0 rgba(99,102,241,0)"] }
                : {}
            }
            transition={{ duration: 1.4, repeat: n.node === activeNode ? Infinity : 0 }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11.5px] font-medium">{n.label}</span>
              {n.state === "running" ? (
                <Activity className="h-3 w-3 shrink-0 animate-pulse text-primary" />
              ) : n.state === "done" ? (
                <span className="mono text-[10px] text-muted-foreground">
                  {n.ms > 0 ? `${n.ms} ms` : "—"}
                </span>
              ) : (
                <span className="mono text-[10px] text-muted-foreground">·</span>
              )}
            </div>
            <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{n.detail}</p>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function Arrow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5 pl-1 text-[10px] text-muted-foreground">
      <ArrowDown className="h-3 w-3 shrink-0 text-primary" />
      {label}
    </div>
  );
}

function LiveChain({ run }: { run: OrchestratorRun }) {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          <span className="text-[12px] font-semibold text-foreground">
            {run.zone_name} ({run.zone_id})
          </span>
          <Chip tone="danger">{riskPct(run.risk)}% risk</Chip>
          <span className="mono ml-auto text-[10px] text-muted-foreground">
            plant minute {run.minute} · {(run.elapsed_ms / 1000).toFixed(1)}s elapsed
          </span>
        </div>
        <p className="mono mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
          Dispatched on: {run.trigger}
        </p>
      </div>

      {LAYERS.map((layer, i) => (
        <div key={layer.key}>
          {i > 0 && (
            <Arrow
              label={
                layer.key === "retrieval"
                  ? "hazard confirmed — establish what the standard requires"
                  : layer.key === "gemma"
                    ? "verdict settled deterministically — hand to Gemma to plan"
                    : "proposals authorised or refused — issue actions"
              }
            />
          )}
          <ChainLayerRow
            layer={layer}
            nodes={run.nodes.filter((n) => n.layer === layer.key)}
            activeNode={run.active_node}
          />
        </div>
      ))}

      {run.error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
          Run failed: {run.error}. The deterministic interlocks are unaffected and still
          enforce.
        </p>
      )}
    </div>
  );
}

function Orchestration() {
  const orch = useOrchestrator();
  const gemma = useGemmaStatus();
  const toggle = useOrchestratorEnable();

  const d = orch.data;
  // The chain diagram follows whatever is executing; if nothing is, it shows the
  // last completed run so the page is never blank. The outcome panels always read
  // from `last_completed`, which is why they survive the next dispatch instead of
  // blanking out mid-read when the loop moves to the next zone.
  const run = d?.current ?? d?.last_completed ?? null;
  const done = d?.last_completed ?? null;
  const result = done?.result ?? null;
  const targetZone = d?.current?.running ? d.current.zone_id : null;
  const alerting = (d?.sensors ?? []).filter((s) => s.state === "alerting");

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-12">
      {/* ── TOP LAYER: the orchestrator itself ───────────────────────────── */}
      <Panel
        title="Autonomous Gemma Orchestration"
        subtitle="No zone is selected by hand — the loop scans, picks and dispatches on its own"
        actions={
          <>
            {gemma.data && (
              <Chip tone={gemma.data.available ? "info" : "warn"}>
                <Cpu className="h-3 w-3" />
                {gemma.data.model} · local
              </Chip>
            )}
            {d && (
              <button
                onClick={() => toggle.mutate(!d.enabled)}
                disabled={toggle.isPending}
                className="inline-flex h-6 items-center gap-1 rounded-sm border border-border px-2 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:opacity-40"
                title={
                  d.enabled
                    ? "Pause new dispatches. A run in flight finishes."
                    : "Resume autonomous dispatch."
                }
              >
                {d.enabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                {d.enabled ? "pause" : "resume"}
              </button>
            )}
          </>
        }
        className="lg:col-span-12"
      >
        {!d ? (
          <p className="text-[12px] text-muted-foreground">Connecting to the orchestrator…</p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px]">
            <div className="flex items-center gap-1.5">
              <span
                className={`relative flex h-2 w-2 ${d.enabled ? "" : "opacity-40"}`}
                aria-hidden
              >
                {d.enabled && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                )}
                <span
                  className={`relative inline-flex h-2 w-2 rounded-full ${
                    d.enabled ? "bg-success" : "bg-muted-foreground"
                  }`}
                />
              </span>
              <span className="font-semibold uppercase tracking-wider text-foreground">
                {d.enabled ? (d.busy ? "Analysing" : "Watching") : "Paused"}
              </span>
            </div>
            <span className="text-muted-foreground">
              <span className="mono text-foreground">{d.sensors.length}</span> zones monitored
            </span>
            <span className="text-muted-foreground">
              <span className="mono text-foreground">{alerting.length}</span> above the{" "}
              {Math.round(d.dispatch_threshold * 100)}% dispatch threshold
            </span>
            <span className="text-muted-foreground">
              <span className="mono text-foreground">{d.cycles}</span> scans ·{" "}
              <span className="mono text-foreground">{d.dispatched}</span> chains dispatched
            </span>
            {d.idle_reason && !d.busy && (
              /* A quiet plant is a real outcome. Saying which one stops an idle
                 console from reading as a broken one. */
              <span className="text-muted-foreground">Idle — {d.idle_reason}</span>
            )}
          </div>
        )}
      </Panel>

      {/* ── SENSOR AGENTS ────────────────────────────────────────────────── */}
      <Panel
        title="Sensor Agents"
        subtitle="Every zone, continuously. Deterministic detection decides what Gemma sees."
        className="lg:col-span-12"
      >
        {!d || d.sensors.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No zones reporting.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
            {d.sensors.map((s) => (
              <SensorCard key={s.zone_id} s={s} isTarget={s.zone_id === targetZone} />
            ))}
          </div>
        )}
      </Panel>

      {/* ── THE CHAIN ────────────────────────────────────────────────────── */}
      <Panel
        title="Agent Chain"
        subtitle={
          run
            ? run.running
              ? `Executing against ${run.zone_id}`
              : `Last completed run — ${run.zone_id}`
            : "Waiting for a zone to cross the dispatch threshold"
        }
        actions={
          run?.running ? (
            <Chip tone="warn">
              <Activity className="h-3 w-3" /> live
            </Chip>
          ) : run ? (
            <Chip tone="success">
              <ShieldCheck className="h-3 w-3" /> complete
            </Chip>
          ) : null
        }
        className="lg:col-span-7"
      >
        <AnimatePresence mode="wait">
          {run ? (
            <motion.div
              key={`${run.zone_id}-${run.minute}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <LiveChain run={run} />
            </motion.div>
          ) : (
            <p className="py-6 text-[12px] leading-relaxed text-muted-foreground">
              The chain runs when a zone crosses{" "}
              {d ? Math.round(d.dispatch_threshold * 100) : 50}% compound risk. Below that
              the graph deliberately stands down, so dispatching would spend a minute of
              inference to be told there was no triggering condition.
            </p>
          )}
        </AnimatePresence>
      </Panel>

      {/* ── RECENT RUNS ──────────────────────────────────────────────────── */}
      <Panel
        title="Dispatch History"
        subtitle={d ? `${d.history.length} completed` : undefined}
        className="lg:col-span-5"
        padded={false}
      >
        {!d || d.history.length === 0 ? (
          <p className="px-4 py-6 text-[12px] text-muted-foreground">
            No chain has completed yet this session.
          </p>
        ) : (
          <ul className="divide-y divide-border text-[11px]">
            {d.history.map((h, i) => (
              <li key={`${h.zone_id}-${h.minute}-${i}`} className="flex items-center gap-2 px-4 py-2">
                <span className="mono w-16 shrink-0 text-foreground">{h.zone_id}</span>
                <span
                  className={`mono w-10 shrink-0 ${
                    h.risk >= 0.85 ? "text-destructive" : "text-warning"
                  }`}
                >
                  {riskPct(h.risk)}%
                </span>
                {h.verdict && (
                  <span
                    className={`shrink-0 text-[10px] uppercase ${
                      h.verdict === "REJECTED" ? "text-destructive" : "text-warning"
                    }`}
                  >
                    {h.verdict}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {h.executed > 0 && <span className="text-success">{h.executed} ran</span>}
                  {h.executed > 0 && h.refused > 0 && " · "}
                  {h.refused > 0 && <span className="text-warning">{h.refused} refused</span>}
                </span>
                <span className="mono w-12 shrink-0 text-right text-muted-foreground">
                  {(h.elapsed_ms / 1000).toFixed(0)}s
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* ── OUTCOME: what the chain actually decided ───────────────────────
          Reads from `last_completed`, so while the orchestrator works on the next
          zone these panels still show the conclusion of the previous one. The
          banner names that zone, because it can differ from the one in the
          diagram above. */}
      {result && done && (
        <div className="lg:col-span-12">
          <p className="rounded-md border border-border bg-background/40 px-3 py-1.5 text-[11px] text-muted-foreground">
            Outcome of the last completed chain —{" "}
            <span className="mono text-foreground">
              {done.zone_name} ({done.zone_id})
            </span>{" "}
            at {riskPct(done.risk)}% risk, plant minute {done.minute}, completed in{" "}
            {(done.elapsed_ms / 1000).toFixed(0)}s
            {d?.current?.running ? " — a new chain is running above." : "."}
          </p>
        </div>
      )}
      {result && result.tool_executions.length > 0 && <ToolExecutionStream run={result} />}
      {result && <GemmaReasoningPanel run={result} />}
      {result?.gemma_briefing && <OperatorBriefingPanel run={result} />}
      {result && result.gemma_meta.length > 0 && (
        <GemmaTelemetryStrip meta={result.gemma_meta} />
      )}

      {result && result.actions.length > 0 && (
        <Panel
          title="Response Actions Issued"
          subtitle="Evacuation and containment steps for the shift in-charge"
          className="lg:col-span-7"
          padded={false}
        >
          <ol className="divide-y divide-border text-[12px]">
            {result.actions.map((a, i) => (
              <li key={a} className="flex gap-2 px-4 py-2.5 leading-relaxed">
                <span className="mono shrink-0 text-[10px] text-muted-foreground">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>{a}</span>
              </li>
            ))}
          </ol>
        </Panel>
      )}

      {result?.report && (
        <Panel
          title="Draft Regulatory Notification"
          subtitle="Generated by Gemma · pending human verification"
          className="lg:col-span-5"
        >
          <pre className="mono whitespace-pre-wrap rounded-md border border-border bg-background/40 p-3 text-[11px] leading-relaxed">
            {result.report}
          </pre>
        </Panel>
      )}
    </div>
  );
}
