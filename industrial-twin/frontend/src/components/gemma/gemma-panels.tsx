import { Chip, Panel } from "@/components/panel";
import type { GemmaNodeMeta, ToolReceipt, WorkflowResponse } from "@/lib/api-types";
import { motion } from "framer-motion";
import { Ban, BrainCircuit, Check, Gauge, Lightbulb, Zap } from "lucide-react";

/**
 * The Gemma layer, rendered for an operator rather than for a demo.
 *
 * The organising idea across these panels: a refused action is shown as
 * prominently as an executed one. Gemma 3 has no tool-calling template in
 * Ollama, so it proposes containment actions as JSON and the gate in
 * backend/agents/tools.py decides what runs — checking each proposal against the
 * deterministic permit verdict, not against the model's confidence. Hiding the
 * refusals would leave the console claiming the model acted autonomously while
 * concealing the part that makes that safe.
 */

const fmtArgs = (args: Record<string, unknown> | null | undefined) =>
  args
    ? Object.entries(args)
        .map(([k, v]) => `${k}=${typeof v === "string" ? `"${v}"` : String(v)}`)
        .join(", ")
    : "";

/** Did the model propose an argument the gate then replaced? */
function overridden(r: ToolReceipt): string[] {
  if (!r.arguments) return [];
  const proposed = Object.fromEntries(
    Object.entries(r.proposed ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return Object.entries(r.arguments)
    .filter(([k, v]) => k in proposed && String(proposed[k]) !== String(v))
    .map(([k]) => k);
}

export function ToolExecutionStream({ run }: { run: WorkflowResponse }) {
  const receipts = run.tool_executions;
  const ran = receipts.filter((r) => r.executed).length;
  const refused = receipts.length - ran;

  return (
    <Panel
      title="Containment Tool Stream"
      subtitle="Proposed by Gemma · authorised by the deterministic gate"
      actions={
        receipts.length > 0 && (
          <>
            <Chip tone="success">{ran} executed</Chip>
            {refused > 0 && <Chip tone="warn">{refused} refused</Chip>}
          </>
        )
      }
      className="lg:col-span-7"
      padded={false}
    >
      {receipts.length === 0 ? (
        <p className="px-4 py-6 text-[12px] leading-relaxed text-muted-foreground">
          No containment actions were proposed in this run. The agent only reaches this
          step on the emergency path — a zone whose permit was rejected by the interlocks,
          or whose compound risk crossed the emergency threshold.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {receipts.map((r, i) => {
            const changed = overridden(r);
            return (
              <motion.li
                key={`${r.tool}-${i}`}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.09 }}
                className="px-4 py-2.5"
              >
                <div className="flex items-start gap-2">
                  {r.executed ? (
                    <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                  ) : (
                    <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="mono break-all text-[11.5px] leading-relaxed">
                      <span
                        className={r.executed ? "text-success" : "text-warning line-through"}
                      >
                        {r.tool}
                      </span>
                      <span className="text-muted-foreground">
                        ({fmtArgs(r.arguments ?? r.proposed)})
                      </span>
                    </div>

                    {r.executed ? (
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <span className="text-success">
                          {String(r.result?.status ?? "EXECUTED")}
                        </span>
                        <span className="mono">{r.elapsed_ms.toFixed(1)} ms</span>
                        {/* Where the gate replaced a value the model supplied.
                            Worth surfacing: the model has offered permit numbers
                            and assembly points that do not exist, and the
                            substitution is the reason the action is safe to run. */}
                        {changed.length > 0 && (
                          <span
                            className="text-warning"
                            title={changed
                              .map((k) => `${k}: proposed "${r.proposed[k]}"`)
                              .join(" · ")}
                          >
                            {changed.length} argument{changed.length > 1 ? "s" : ""} corrected
                          </span>
                        )}
                      </div>
                    ) : (
                      <p className="mt-1 text-[11px] leading-relaxed text-warning">
                        Withheld — {r.refused_because}
                      </p>
                    )}
                  </div>
                </div>
              </motion.li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function GemmaReasoningPanel({ run }: { run: WorkflowResponse }) {
  const refl = run.gemma_reflection;
  const hasReasoning = Boolean(run.gemma_reasoning);

  if (!hasReasoning && !refl) return null;

  return (
    <Panel
      title="Agent Reasoning"
      subtitle="What Gemma concluded, and what it revised"
      actions={
        run.gemma_confidence != null && (
          <Chip tone="muted">
            <Gauge className="h-3 w-3" />
            {Math.round(run.gemma_confidence * 100)}% self-reported
          </Chip>
        )
      }
      className="lg:col-span-5"
    >
      <div className="space-y-2.5 text-[12px] leading-relaxed">
        {hasReasoning && (
          <div className="rounded-md border border-border bg-background/40 p-3">
            {run.gemma_reasoning}
          </div>
        )}

        {run.gemma_confidence != null && (
          /* Stated explicitly because it is the easiest thing to misread on this
             page: a high confidence sitting beside a refused action is not a
             contradiction, it is the gate working. */
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Confidence is the model's own estimate and is not an input to the safety
            gate. Authorisation is decided by the deterministic permit verdict and the
            interlocks.
          </p>
        )}

        {refl && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
              <BrainCircuit className="h-3.5 w-3.5" />
              Self-correction
              {/* Only shown when raised. A verdict chip on every run came from a
                  boolean the model filled inconsistently — it once read
                  "disputed" beside prose agreeing with the gate. */}
              {refl.disputes_refusal && (
                <Chip tone="warn" className="normal-case">
                  disputes a refusal — refusal stands
                </Chip>
              )}
            </div>
            {refl.correction && <p className="mb-1.5">{refl.correction}</p>}
            {refl.residual_risk && (
              <p className="text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">Residual risk:</span>{" "}
                {refl.residual_risk}
              </p>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

export function OperatorBriefingPanel({ run }: { run: WorkflowResponse }) {
  const b = run.gemma_briefing;
  if (!b) return null;
  return (
    <Panel
      title="Operator Briefing"
      subtitle="Model risk drivers, translated for the shift in-charge"
      className="lg:col-span-7"
    >
      <div className="space-y-2.5 text-[12px] leading-relaxed">
        <div className="flex items-start gap-2 rounded-md border border-border bg-background/40 p-3">
          <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span className="font-medium">{b.headline}</span>
        </div>
        {b.why_now && (
          <div>
            <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              Why now
            </div>
            <p>{b.why_now}</p>
          </div>
        )}
        {b.watch && (
          <div>
            <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              What to watch
            </div>
            <p>{b.watch}</p>
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * Per-node inference cost.
 *
 * `gen_ms` is reported separately from total latency because Ollama evicts an
 * idle model and charges the reload to whichever node runs next — which made one
 * 43-token answer measure 0.7 tok/s against ~10 tok/s warm. Showing the load
 * separately keeps the throughput figure honest and explains the first slow run
 * of a session instead of leaving it looking like the model is that slow.
 */
export function GemmaTelemetryStrip({ meta }: { meta: GemmaNodeMeta[] }) {
  if (meta.length === 0) return null;
  const total = meta.reduce((s, m) => s + m.latency_ms, 0);
  const tokens = meta.reduce((s, m) => s + m.eval_count, 0);

  return (
    <Panel
      title="Inference Telemetry"
      subtitle={`${meta.length} Gemma call${meta.length > 1 ? "s" : ""} · ${tokens} tokens generated`}
      actions={<Chip tone="info">{(total / 1000).toFixed(1)}s total</Chip>}
      className="lg:col-span-5"
      padded={false}
    >
      <ul className="divide-y divide-border text-[11px]">
        {meta.map((m, i) => (
          <li key={`${m.node}-${i}`} className="flex items-center gap-2 px-4 py-2">
            <span className="mono w-20 shrink-0 text-primary">{m.node}</span>
            <span className="mono shrink-0 text-foreground">{m.latency_ms} ms</span>
            {m.load_ms > 500 && (
              <span className="mono shrink-0 text-muted-foreground" title="Cold model load">
                +{(m.load_ms / 1000).toFixed(1)}s load
              </span>
            )}
            <span className="mono ml-auto shrink-0 text-muted-foreground">
              {m.eval_count} tok @ {m.tokens_per_s}/s
            </span>
            {m.truncated && (
              <span className="shrink-0 text-warning" title="Hit the output token cap">
                capped
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-1.5 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        <Check className="h-3 w-3 text-success" />
        {meta[0].model} on {meta[0].runtime} — no telemetry left this machine
      </div>
    </Panel>
  );
}
