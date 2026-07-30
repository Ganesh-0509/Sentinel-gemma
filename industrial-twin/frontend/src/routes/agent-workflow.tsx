import { createFileRoute } from "@tanstack/react-router";
import { Panel, Chip } from "@/components/panel";
import { ErrorState, Loading, QueryBoundary } from "@/components/data-state";
import { priorityTone, riskPct, useRunWorkflow, useZones } from "@/lib/queries";
import type { PermitStatus } from "@/lib/api-types";
import { motion } from "framer-motion";
import { FileText, Play } from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/agent-workflow")({
  head: () => ({
    meta: [
      { title: "Agent Workflow · SentinelAI" },
      {
        name: "description",
        content:
          "Live view of the multi-agent orchestration monitoring, deciding, and acting on plant risk.",
      },
    ],
  }),
  component: AgentWorkflow,
});

const statusTone = (s: PermitStatus): "success" | "warn" | "danger" =>
  s === "APPROVED" ? "success" : s === "CONDITIONAL" ? "warn" : "danger";

/**
 * The risk at which the graph hands off from RiskMonitor to the rest of the
 * chain — `ESCALATE_RISK` in backend/agents/graph.py. Below it the workflow
 * deliberately stands down and no permit, compliance or orchestration agent
 * runs, so those panels have nothing to show. That is a real outcome, not a
 * failure, and the page now says which one it is getting.
 */
const ESCALATE_RISK = 0.5;

/** A run stood down when the permit agent never got a turn. */
const stoodDown = (run: { permit_decision: unknown } | undefined) =>
  Boolean(run) && run!.permit_decision === null;

function StandDownNote({ what }: { what: string }) {
  return (
    <p className="text-[12px] leading-relaxed text-muted-foreground">
      <span className="text-foreground">Not invoked.</span> Risk stayed below the{" "}
      {Math.round(ESCALATE_RISK * 100)}% escalation threshold, so the chain stood down at the risk
      monitor and {what} never ran. Pick a zone above the threshold to see the full chain.
    </p>
  );
}

/** Trace lines arrive as "[AgentName] message"; split the tag for the timeline. */
function splitTrace(line: string): { agent: string | null; message: string } {
  const m = /^\[([^\]]+)\]\s*(.*)$/s.exec(line);
  return m ? { agent: m[1], message: m[2] } : { agent: null, message: line };
}

function AgentWorkflow() {
  const zones = useZones();
  const [zoneId, setZoneId] = useState("");
  const workflow = useRunWorkflow();

  // Default to the highest-risk zone, not the first alphabetically: that is the
  // one the chain will actually have something to say about.
  useEffect(() => {
    if (!zoneId && zones.data?.length) {
      const hottest = [...zones.data].sort((a, b) => b.risk - a.risk)[0];
      setZoneId(hottest.zone_id);
    }
  }, [zoneId, zones.data]);

  const run = workflow.data;
  const selected = zones.data?.find((z) => z.zone_id === zoneId);
  const escalating = (zones.data ?? []).filter((z) => z.risk >= ESCALATE_RISK);

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-12">
      <Panel
        title="Agent Orchestration"
        subtitle="Runs the full agent chain against one zone's current state"
        actions={run?.priority && <Chip tone={priorityTone(run.priority)}>{run.priority}</Chip>}
        className="lg:col-span-8 min-h-[420px]"
      >
        <QueryBoundary
          query={zones}
          loadingLabel="Loading zones"
          emptyLabel="No zones reported"
          isEmpty={(z) => z.length === 0}
        >
          {(list) => (
            <div className="space-y-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[220px] flex-1">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Zone
                  </div>
                  {/* Sorted by risk, with the live figure on each option: the
                      chain only does something above the escalation threshold,
                      so which zone you pick is the single thing that decides
                      whether this page has anything to show. */}
                  <select
                    value={zoneId}
                    onChange={(e) => {
                      setZoneId(e.target.value);
                      workflow.reset();
                    }}
                    className="h-9 w-full rounded-md border border-border bg-background/50 px-2 text-[12px] focus:outline-none"
                  >
                    {[...list]
                      .sort((a, b) => b.risk - a.risk)
                      .map((z) => (
                        <option key={z.zone_id} value={z.zone_id}>
                          {z.risk >= ESCALATE_RISK ? "▲" : "·"} {riskPct(z.risk)}% — {z.zone_id} ·{" "}
                          {z.name}
                        </option>
                      ))}
                  </select>
                </div>
                <button
                  onClick={() => zoneId && workflow.mutate(zoneId)}
                  disabled={!zoneId || workflow.isPending}
                  className="inline-flex h-9 items-center gap-1 rounded-md bg-primary px-3 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
                >
                  <Play className="h-3 w-3" /> Run workflow
                </button>
              </div>

              {/* Say up front what this run will do. Without it, picking a calm
                  zone produces a two-line trace and four empty panels, which
                  reads as a broken page rather than a quiet plant. */}
              {selected &&
                (selected.risk >= ESCALATE_RISK ? (
                  <p className="rounded-md border border-warning/40 bg-warning/10 p-2.5 text-[11px] leading-relaxed text-warning">
                    <span className="font-medium">
                      {selected.zone_id} is at {riskPct(selected.risk)}% risk
                    </span>{" "}
                    — above the {Math.round(ESCALATE_RISK * 100)}% escalation threshold, so this run
                    will go through the full chain: permit interlocks, grounded compliance lookup,
                    and either advisory controls or emergency orchestration.
                  </p>
                ) : (
                  <p className="rounded-md border border-border bg-background/40 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {selected.zone_id} is at {riskPct(selected.risk)}% risk
                    </span>{" "}
                    — below the {Math.round(ESCALATE_RISK * 100)}% escalation threshold, so the
                    chain will stand down at the risk monitor and the permit, compliance and
                    orchestration agents will not run.{" "}
                    {escalating.length > 0 ? (
                      <>
                        Currently above the threshold:{" "}
                        <span className="mono text-foreground">
                          {escalating.map((z) => `${z.zone_id} (${riskPct(z.risk)}%)`).join(", ")}
                        </span>
                        .
                      </>
                    ) : (
                      <>
                        No zone is above it at this plant minute — advance the clock from Live
                        Replay, or raise gas on Simulation Controls, to drive one over.
                      </>
                    )}
                  </p>
                ))}

              {workflow.isPending ? (
                <Loading label="Running agent chain" />
              ) : workflow.error ? (
                <ErrorState error={workflow.error} onRetry={() => workflow.reset()} />
              ) : !run ? (
                <p className="px-1 py-6 text-[12px] text-muted-foreground">
                  Select a zone and run the workflow to see the real execution trace.
                </p>
              ) : (
                <div className="border-t border-border pt-3">
                  <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Execution trace · {run.zone_id}
                  </div>
                  <ol className="space-y-0">
                    {run.trace.map((line, i) => {
                      const { agent, message } = splitTrace(line);
                      return (
                        <motion.li
                          key={i}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.08 }}
                          className="relative flex gap-3 pb-3 pl-1 last:pb-0"
                        >
                          <div className="flex flex-col items-center">
                            <span className="mono grid h-6 w-6 shrink-0 place-items-center rounded-md border border-primary/40 bg-primary/10 text-[10px] text-primary">
                              {i + 1}
                            </span>
                            {i < run.trace.length - 1 && (
                              <span className="mt-1 w-px flex-1 bg-border" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1 rounded-md border border-border bg-background/40 px-3 py-2">
                            {agent && <div className="mono text-[11px] text-primary">{agent}</div>}
                            {/* pre-wrap, not pre-line: agent messages are
                                indented bullet lists and pre-line collapses the
                                indentation that makes them readable. */}
                            <div className="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed">
                              {message}
                            </div>
                          </div>
                        </motion.li>
                      );
                    })}
                  </ol>
                </div>
              )}
            </div>
          )}
        </QueryBoundary>
      </Panel>

      <div className="space-y-3 lg:col-span-4">
        <Panel
          title="Permit Decision"
          actions={
            run?.permit_decision && (
              <Chip tone={statusTone(run.permit_decision.status)}>
                {run.permit_decision.status}
              </Chip>
            )
          }
        >
          {run?.permit_decision ? (
            <div className="space-y-2 text-[12px]">
              <ol className="list-decimal space-y-1 pl-4 leading-relaxed">
                {run.permit_decision.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ol>
              {run.permit_decision.checks.length > 0 && (
                <details className="rounded-md border border-border bg-background/40 p-2">
                  <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-muted-foreground">
                    Interlocks evaluated ({run.permit_decision.checks.length})
                  </summary>
                  <ul className="mono mt-1.5 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                    {run.permit_decision.checks.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </details>
              )}
              {run.permit_decision.citations.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {run.permit_decision.citations.map((c) => (
                    <span
                      key={c}
                      className="inline-flex items-center gap-1 rounded-sm border border-border bg-background px-2 py-0.5 text-[11px]"
                    >
                      <FileText className="h-3 w-3 text-primary" />
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : stoodDown(run) ? (
            <StandDownNote what="the permit agent" />
          ) : (
            <p className="text-[12px] text-muted-foreground">
              {run ? "No permit was evaluated in this run." : "Run the workflow to populate."}
            </p>
          )}
        </Panel>

        <Panel
          title="Interlocks"
          subtitle={run ? `${run.interlocks.length} tripped` : undefined}
          padded={false}
        >
          {run && run.interlocks.length > 0 ? (
            <ul className="divide-y divide-border text-[12px]">
              {run.interlocks.map((i) => (
                <li key={i} className="flex gap-2 px-4 py-2.5 leading-relaxed text-destructive">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive pulse-dot" />
                  <span>{i}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-[12px] text-muted-foreground">
              {stoodDown(run)
                ? "Not evaluated — the chain stood down before the permit agent."
                : run
                  ? "No standing interlocks tripped."
                  : "Run the workflow to populate."}
            </p>
          )}
        </Panel>

        <Panel
          title="Actions"
          subtitle={run ? `${run.actions.length} initiated` : undefined}
          padded={false}
        >
          {run && run.actions.length > 0 ? (
            <ol className="divide-y divide-border text-[12px]">
              {run.actions.map((a, i) => (
                <li key={a} className="flex gap-2 px-4 py-2.5 leading-relaxed">
                  <span className="mono shrink-0 text-[10px] text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>{a}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="px-4 py-6 text-[12px] text-muted-foreground">
              {run ? "No actions initiated." : "Run the workflow to populate."}
            </p>
          )}
        </Panel>
      </div>

      {/* Keep the slot on the page when the chain stood down. Removing the
          panel entirely is what made a quiet plant look like a broken page. */}
      {stoodDown(run) && (
        <Panel
          title="Compliance Check"
          subtitle="Grounded regulatory lookup"
          className="lg:col-span-7"
        >
          <StandDownNote what="the compliance agent" />
        </Panel>
      )}

      {run?.compliance && (
        <Panel
          title="Compliance Check"
          subtitle={run.compliance.question}
          actions={
            <>
              <Chip tone="info">{run.compliance.backend}</Chip>
              <Chip tone={run.compliance.grounded ? "success" : "warn"}>
                {run.compliance.grounded ? "Grounded" : "Ungrounded"}
              </Chip>
            </>
          }
          className="lg:col-span-7"
        >
          <div
            className={`rounded-md border p-3 text-[12px] leading-relaxed whitespace-pre-line ${
              run.compliance.grounded
                ? "border-border bg-background/40"
                : "border-warning/40 bg-warning/10"
            }`}
          >
            {run.compliance.answer}
          </div>
          {run.compliance.citations.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {run.compliance.citations.map((c) => (
                <span
                  key={`${c.standard}-${c.section}`}
                  className="inline-flex items-center gap-1 rounded-sm border border-border bg-background px-2 py-0.5 text-[11px]"
                >
                  <FileText className="h-3 w-3 text-primary" />
                  {c.standard} § {c.section}
                  <span className="mono text-[10px] text-muted-foreground">
                    {c.score.toFixed(4)}
                  </span>
                </span>
              ))}
            </div>
          )}
        </Panel>
      )}

      {stoodDown(run) && (
        <Panel
          title="Draft Regulatory Notification"
          subtitle="Emergency path only"
          className="lg:col-span-5"
        >
          <StandDownNote what="the emergency orchestrator" />
        </Panel>
      )}

      {run?.report && (
        <Panel
          title="Draft Regulatory Notification"
          subtitle="Pending human verification"
          className="lg:col-span-5"
        >
          <pre className="mono whitespace-pre-wrap rounded-md border border-border bg-background/40 p-3 text-[11px] leading-relaxed">
            {run.report}
          </pre>
        </Panel>
      )}
    </div>
  );
}
