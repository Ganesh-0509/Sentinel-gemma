import { createFileRoute } from "@tanstack/react-router";
import { Panel, Chip, StatusDot } from "@/components/panel";
import { Empty, ErrorState, Loading, QueryBoundary } from "@/components/data-state";
import { AlertOctagon, ArrowRight, History, Loader2, Lock, Play, ShieldAlert } from "lucide-react";
import { useState } from "react";
import {
  asShiftTime,
  bandTone,
  priorityTone,
  riskPct,
  useAlertLog,
  useAlerts,
  useClock,
  useRunWorkflow,
  useZones,
} from "@/lib/queries";
import type { AlertEvent, AlertItem } from "@/lib/api-types";

export const Route = createFileRoute("/command-center")({
  head: () => ({
    meta: [
      { title: "Emergency Command Center · SentinelAI" },
      {
        name: "description",
        content:
          "Prioritised live alert queue with the multi-agent response workflow: permit decision, interlocks and actions.",
      },
    ],
  }),
  component: CommandCenter,
});

/**
 * Transition colours. `RAISED`/`ESCALATED` are the ones that cost someone
 * attention, so they carry the weight; a clear is deliberately quiet.
 */
const EVENT_TONE: Record<AlertEvent, "success" | "warn" | "danger" | "muted"> = {
  RAISED: "danger",
  ESCALATED: "danger",
  "DE-ESCALATED": "warn",
  CLEARED: "success",
};

function CommandCenter() {
  const alerts = useAlerts();
  const zones = useZones();
  const clock = useClock();
  const workflow = useRunWorkflow();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Scope the history to the selected zone by default: an investigator asking
  // "what happened in Blast Furnace 2" does not want the other seven zones.
  const [logAllZones, setLogAllZones] = useState(false);

  const queue = alerts.data ?? [];
  // The backend returns the queue already prioritised; the top item is the one
  // the control room should be looking at unless an operator picked another.
  const selected: AlertItem | undefined = queue.find((a) => a.alert_id === selectedId) ?? queue[0];
  const zone = zones.data?.find((z) => z.zone_id === selected?.zone_id);
  const minute = clock.data?.minute ?? 0;

  const result = workflow.data;
  const resultIsForSelection = result?.zone_id === selected?.zone_id;

  const logZone = logAllZones ? undefined : selected?.zone_id;
  const alertLog = useAlertLog(logZone);

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-12">
      {/* ── ALERT QUEUE ──────────────────────────────────────────────── */}
      <Panel
        title={
          <span className="flex items-center gap-2">
            <AlertOctagon className="h-4 w-4 text-destructive" /> Alert Queue
          </span>
        }
        subtitle={`Plant minute ${minute} · ${queue.length} open alert${queue.length === 1 ? "" : "s"}`}
        className="lg:col-span-4 max-h-[calc(100vh-100px)]"
        padded={false}
        bodyClassName="overflow-y-auto scrollbar-thin"
      >
        <QueryBoundary
          query={alerts}
          loadingLabel="Loading alert queue"
          emptyLabel={`No alerts raised at plant minute ${minute}. Advance the clock from Live Replay or Simulation Controls.`}
          isEmpty={(a: AlertItem[]) => a.length === 0}
        >
          {(data) => (
            <ul className="divide-y divide-border">
              {data.map((a) => {
                const active = a.alert_id === selected?.alert_id;
                return (
                  <li key={a.alert_id}>
                    <button
                      onClick={() => setSelectedId(a.alert_id)}
                      className={`flex w-full flex-col gap-1.5 border-l-2 px-4 py-2.5 text-left transition-colors ${
                        active
                          ? "border-destructive bg-destructive/8"
                          : "border-transparent hover:bg-muted/40"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <StatusDot tone={priorityTone(a.priority)} />
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                          {a.zone_name}
                        </span>
                        <Chip tone={priorityTone(a.priority)}>{a.priority}</Chip>
                      </div>
                      <div className="mono flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span>{a.alert_id}</span>
                        <span className="text-foreground">{riskPct(a.risk)}% risk</span>
                        <span>score {a.score.toFixed(3)}</span>
                        {a.lead_time_min !== null && <span>{a.lead_time_min} min lead</span>}
                      </div>
                      {a.drivers.length > 0 && (
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          {a.drivers.join(" · ")}
                        </p>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </QueryBoundary>
      </Panel>

      <div className="flex flex-col gap-3 lg:col-span-8">
        {/* ── SELECTED ALERT ─────────────────────────────────────────── */}
        <Panel
          title={
            selected ? (
              <span
                className={`flex items-center gap-2 ${
                  selected.priority === "CRITICAL" ? "text-destructive" : ""
                }`}
              >
                <ShieldAlert className="h-4 w-4" /> {selected.priority} · {selected.zone_name}
              </span>
            ) : (
              "No alert selected"
            )
          }
          subtitle={
            selected
              ? `${selected.alert_id} · raised ${new Date(selected.raised_at).toLocaleTimeString()}`
              : undefined
          }
          actions={
            selected && (
              <button
                onClick={() => workflow.mutate(selected.zone_id)}
                disabled={workflow.isPending}
                className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
              >
                {workflow.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Play className="h-3 w-3" />
                )}
                Run response workflow
              </button>
            )
          }
        >
          {!selected ? (
            <Empty label="Nothing in the queue right now." />
          ) : (
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Model Risk
                </div>
                <div
                  className={`mono mt-1 text-5xl font-semibold ${
                    selected.priority === "CRITICAL" ? "text-destructive" : "text-warning"
                  }`}
                >
                  {riskPct(selected.risk)}%
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Chip tone={priorityTone(selected.priority)}>{selected.priority}</Chip>
                  {zone && <Chip tone={bandTone(zone.risk_band)}>{zone.risk_band}</Chip>}
                </div>
                <div className="mono mt-2 text-[11px] text-muted-foreground">
                  priority score {selected.score.toFixed(3)}
                  {selected.lead_time_min !== null && ` · ${selected.lead_time_min} min lead time`}
                </div>
              </div>

              <div className="md:col-span-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Why this alert fired
                </div>
                {selected.drivers.length > 0 ? (
                  <ul className="mt-2 space-y-1 text-[12px]">
                    {selected.drivers.map((d) => (
                      <li key={d} className="flex items-start gap-2">
                        <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[12px] text-muted-foreground">
                    No contextual drivers reported for this alert.
                  </p>
                )}

                {zone && (
                  <>
                    <div className="mt-4 grid grid-cols-4 gap-2">
                      {[
                        { l: "Gas % LEL", v: zone.gas_lel.toFixed(2) },
                        { l: "Pressure", v: zone.pressure.toFixed(2) },
                        { l: "Temp °C", v: zone.temperature.toFixed(1) },
                        { l: "Workers", v: String(zone.workers_in_zone) },
                      ].map((s) => (
                        <div
                          key={s.l}
                          className="rounded-md border border-border bg-background/40 p-2"
                        >
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            {s.l}
                          </div>
                          <div className="mono mt-0.5 text-lg font-semibold">{s.v}</div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {zone.maintenance_active && <Chip tone="warn">Maintenance</Chip>}
                      {zone.hot_work_active && <Chip tone="danger">Hot Work</Chip>}
                      {zone.in_changeover && <Chip tone="warn">Changeover</Chip>}
                      {zone.night_shift && <Chip tone="info">Night Shift</Chip>}
                      <Chip tone={zone.baseline_alarm ? "danger" : "muted"}>
                        Baseline alarm {zone.baseline_alarm ? "firing" : "silent"}
                      </Chip>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </Panel>

        {/* ── WORKFLOW OUTPUT ────────────────────────────────────────── */}
        <Panel
          title="Multi-Agent Response"
          subtitle={
            resultIsForSelection && result
              ? `Orchestrated for ${result.zone_id} · priority ${result.priority ?? "n/a"}`
              : "Run the workflow to get the agent-generated response for this zone"
          }
        >
          {workflow.isPending ? (
            <Loading label="Running risk, permit, compliance and orchestration agents" />
          ) : workflow.error ? (
            <ErrorState error={workflow.error} onRetry={() => workflow.reset()} />
          ) : !result || !resultIsForSelection ? (
            <Empty label="No workflow result for the selected zone yet." />
          ) : result.permit_decision === null ? (
            // Alerts are raised from 35% risk, but the agent chain only
            // escalates at 50%. A zone in that band returns a trace and nothing
            // else, which looked like a failed run — so name the outcome.
            <div className="space-y-3">
              <p className="rounded-md border border-border bg-background/40 p-3 text-[12px] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">Chain stood down.</span> This zone is
                alerting at {riskPct(selected.risk)}% but sits below the 50% risk at which the
                workflow escalates, so the permit, compliance and orchestration agents were
                deliberately not invoked. The alert stays in the queue and the risk model keeps
                scoring it every plant minute.
              </p>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Agent Trace
                </div>
                <ol className="mono mt-2 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                  {result.trace.map((t, i) => (
                    <li
                      key={i}
                      className="whitespace-pre-wrap rounded-sm border border-border bg-background/40 px-2 py-1.5"
                    >
                      {t}
                    </li>
                  ))}
                </ol>
              </div>
              {result.actions.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Standing instructions ({result.actions.length})
                  </div>
                  <ul className="mt-2 space-y-1 text-[12px]">
                    {result.actions.map((a, i) => (
                      <li
                        key={i}
                        className="rounded-md border border-border bg-background/40 px-2.5 py-1.5 leading-relaxed"
                      >
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Agent Trace
                </div>
                <ol className="mono mt-2 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                  {result.trace.map((t, i) => (
                    <li
                      key={i}
                      className="whitespace-pre-wrap rounded-sm border border-border bg-background/40 px-2 py-1.5"
                    >
                      {t}
                    </li>
                  ))}
                </ol>

                {result.permit_decision && (
                  <div className="mt-3 rounded-md border border-border bg-background/40 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Permit Decision
                      </span>
                      <Chip
                        tone={
                          result.permit_decision.status === "REJECTED"
                            ? "danger"
                            : result.permit_decision.status === "CONDITIONAL"
                              ? "warn"
                              : "success"
                        }
                      >
                        {result.permit_decision.status}
                      </Chip>
                    </div>
                    <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                      {result.permit_decision.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                    {result.permit_decision.citations.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {result.permit_decision.citations.map((c) => (
                          <Chip key={c} tone="info">
                            {c}
                          </Chip>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Actions ({result.actions.length})
                  </div>
                  {result.actions.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-[12px]">
                      {result.actions.map((a, i) => (
                        <li
                          key={i}
                          className="flex items-start gap-2 rounded-md border border-border bg-background/40 px-2.5 py-1.5"
                        >
                          <span className="mono mt-0.5 shrink-0 text-[10px] text-muted-foreground">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <span className="leading-relaxed">{a}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-[12px] text-muted-foreground">
                      No actions initiated — the orchestrator judged monitoring sufficient.
                    </p>
                  )}
                </div>

                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Interlocks ({result.interlocks.length})
                  </div>
                  {result.interlocks.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-[12px]">
                      {result.interlocks.map((lock, i) => (
                        <li
                          key={i}
                          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/8 px-2.5 py-1.5 text-destructive"
                        >
                          <Lock className="mt-0.5 h-3 w-3 shrink-0" />
                          <span className="leading-relaxed">{lock}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-[12px] text-muted-foreground">
                      No deterministic interlock tripped.
                    </p>
                  )}
                </div>

                {result.compliance && (
                  <div className="rounded-md border border-border bg-background/40 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Compliance
                      </span>
                      <Chip tone={result.compliance.grounded ? "success" : "warn"}>
                        {result.compliance.grounded ? "grounded" : "ungrounded"} ·{" "}
                        {result.compliance.backend}
                      </Chip>
                    </div>
                    <p className="mt-1.5 text-[11px] italic text-muted-foreground">
                      {result.compliance.question}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed">
                      {result.compliance.answer}
                    </p>
                    {result.compliance.citations.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {result.compliance.citations.map((c, i) => (
                          <Chip key={i} tone={c.is_official ? "success" : "muted"}>
                            {c.standard} {c.section}
                          </Chip>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </Panel>
      </div>

      {/* ── ALERT LOG ──────────────────────────────────────────────────
          The queue above is a view of the current plant minute only. An alert
          that rose and cleared between two polls left no trace at all, which
          is what made the console feel like it was throwing history away. The
          backend now records every transition once per plant minute, whether
          or not anyone is watching, and this is that record. */}
      <Panel
        title={
          <span className="flex items-center gap-2">
            <History className="h-4 w-4 text-primary" /> Alert Log
          </span>
        }
        subtitle={
          logZone
            ? `Every transition recorded for ${logZone} — raised, escalated, cleared`
            : "Every alert transition across all zones, newest first"
        }
        className="lg:col-span-12 max-h-[420px]"
        padded={false}
        bodyClassName="overflow-y-auto scrollbar-thin"
        actions={
          <div className="flex items-center gap-1">
            {(["zone", "all"] as const).map((mode) => {
              const active = (mode === "all") === logAllZones;
              return (
                <button
                  key={mode}
                  onClick={() => setLogAllZones(mode === "all")}
                  disabled={mode === "zone" && !selected}
                  className={`rounded-sm border px-2 py-0.5 text-[10px] uppercase tracking-wider disabled:opacity-40 ${
                    active
                      ? "border-primary/40 bg-primary/15 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {mode === "all" ? "All zones" : "Selected zone"}
                </button>
              );
            })}
          </div>
        }
      >
        <QueryBoundary
          query={alertLog}
          loadingLabel="Loading alert history"
          isEmpty={(l) => l.length === 0}
          emptyLabel={
            logZone
              ? `Nothing recorded for ${logZone} yet. The log fills as the plant clock advances.`
              : "No transitions recorded yet. The log fills as the plant clock advances."
          }
        >
          {(entries) => (
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-panel text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-3 py-2 text-left font-medium">Shift time</th>
                  <th className="px-3 py-2 text-left font-medium">Event</th>
                  <th className="px-3 py-2 text-left font-medium">Zone</th>
                  <th className="px-3 py-2 text-left font-medium">Priority</th>
                  <th className="px-3 py-2 text-right font-medium">Risk</th>
                  <th className="px-3 py-2 text-left font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map((e) => (
                  <tr
                    key={e.seq}
                    onClick={() => setSelectedId(e.alert_id)}
                    className="cursor-pointer transition-colors hover:bg-muted/40"
                  >
                    <td className="mono whitespace-nowrap px-3 py-1.5 text-[11px] text-muted-foreground">
                      {asShiftTime(e.minute)}
                      {e.lap > 0 && <span className="ml-1 opacity-60">·r{e.lap}</span>}
                    </td>
                    <td className="px-3 py-1.5">
                      <Chip tone={EVENT_TONE[e.event]}>{e.event}</Chip>
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="font-medium">{e.zone_name}</span>
                      <span className="mono ml-1.5 text-[10px] text-muted-foreground">
                        {e.zone_id}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-1.5">
                        <StatusDot tone={priorityTone(e.priority)} />
                        {e.priority}
                      </span>
                    </td>
                    <td className="mono px-3 py-1.5 text-right font-semibold">
                      {riskPct(e.risk)}%
                    </td>
                    <td className="px-3 py-1.5 text-[11px] text-muted-foreground">
                      {e.note || e.drivers.join(" · ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </QueryBoundary>
      </Panel>
    </div>
  );
}
