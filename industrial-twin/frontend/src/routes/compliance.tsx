import { createFileRoute } from "@tanstack/react-router";
import { Panel, Chip } from "@/components/panel";
import { ErrorState, Loading, QueryBoundary } from "@/components/data-state";
import { useAskCompliance, useHealth } from "@/lib/queries";
import type { Citation, ComplianceResponse, Confidence, Provenance } from "@/lib/api-types";
import { Send, FileText, Sparkles, ShieldOff } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/compliance")({
  head: () => ({
    meta: [
      { title: "Compliance Assistant · SentinelAI" },
      {
        name: "description",
        content: "Cited answers about SOPs, OISD, Factory Act and site-specific procedures.",
      },
    ],
  }),
  component: Compliance,
});

type Turn = { question: string; answer: ComplianceResponse };

const provenanceTone = (p: Provenance): "success" | "info" | "warn" | "muted" =>
  p === "STATUTE" ? "success" : p === "OFFICIAL" ? "info" : p === "SUMMARY" ? "warn" : "muted";

/**
 * Three states, not two. "Grounded / not grounded" collapsed a declined answer,
 * a weak match, and a solid regulatory hit into one badge — so an answer built
 * on a 0.07 similarity looked identical to one built on 0.32.
 */
const CONFIDENCE_LABEL: Record<Confidence, { text: string; tone: "success" | "warn" | "muted" }> = {
  high: { text: "Grounded in a standard", tone: "success" },
  low: { text: "Weak match — read with care", tone: "warn" },
  none: { text: "Declined — nothing relevant", tone: "muted" },
};

function CitationRow({ c }: { c: Citation }) {
  return (
    <div className="rounded-md border border-border bg-panel px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="mono truncate text-[11px] text-muted-foreground">{c.standard}</span>
        <span className="mono shrink-0 text-[10px] text-muted-foreground">
          {c.score.toFixed(4)}
        </span>
      </div>
      <div className="mt-0.5 text-[12px] font-medium leading-snug">{c.section}</div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        <Chip tone={provenanceTone(c.provenance)}>{c.provenance.replace("_", " ")}</Chip>
        {c.is_official && <Chip tone="success">Official</Chip>}
        {/* Our own procedure is a legitimate source for "what does this system
            do" and a poor one for "what does the law require". Say which. */}
        {c.kind === "INTERNAL" && <Chip tone="muted">Internal SOP — not regulation</Chip>}
      </div>
    </div>
  );
}

function Compliance() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const ask = useAskCompliance();
  const health = useHealth();

  const send = () => {
    const question = input.trim();
    if (!question || ask.isPending) return;
    setInput("");
    ask.mutate(
      { question },
      { onSuccess: (answer) => setTurns((t) => [...t, { question, answer }]) },
    );
  };

  const latest = turns.at(-1)?.answer;

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-12">
      <Panel
        title="Compliance Assistant"
        subtitle="Retrieval-grounded answers over the regulation corpus"
        actions={latest && <Chip tone="info">{latest.backend}</Chip>}
        className="lg:col-span-8 min-h-[560px]"
        padded={false}
      >
        <div className="flex h-full flex-col">
          <div className="flex-1 space-y-3 overflow-auto scrollbar-thin p-4">
            {turns.length === 0 && !ask.isPending && (
              <p className="px-1 py-6 text-[12px] text-muted-foreground">
                Ask a question about permits, interlocks, gas testing or SOPs. Answers are drawn
                only from the indexed regulation corpus; if nothing relevant is retrieved the
                assistant declines rather than guessing.
              </p>
            )}

            {turns.map((t, i) => (
              <div key={i} className="space-y-3">
                <div className="flex justify-end gap-3">
                  <div className="max-w-[75%] rounded-md border border-primary/30 bg-primary/10 p-3 text-[12px] leading-relaxed">
                    {t.question}
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
                    {t.answer.confidence === "high" ? (
                      <Sparkles className="h-3.5 w-3.5" />
                    ) : (
                      <ShieldOff className="h-3.5 w-3.5" />
                    )}
                  </div>
                  <div
                    className={`max-w-[80%] rounded-md border p-3 text-[12px] leading-relaxed whitespace-pre-line ${
                      t.answer.confidence === "high"
                        ? "border-border bg-background/40"
                        : t.answer.confidence === "low"
                          ? "border-warning/40 bg-warning/10"
                          : "border-border bg-muted/30"
                    }`}
                  >
                    {t.answer.confidence !== "high" && (
                      <div className="mb-2 flex items-center gap-2 not-italic">
                        <Chip tone={CONFIDENCE_LABEL[t.answer.confidence].tone}>
                          {CONFIDENCE_LABEL[t.answer.confidence].text}
                        </Chip>
                      </div>
                    )}
                    {t.answer.answer}

                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      <Chip tone="info">{t.answer.backend}</Chip>
                      <Chip tone={CONFIDENCE_LABEL[t.answer.confidence].tone}>
                        {CONFIDENCE_LABEL[t.answer.confidence].text}
                      </Chip>
                      {t.answer.citations.map((c) => (
                        <span
                          key={`${c.standard}-${c.section}`}
                          className="inline-flex items-center gap-1 rounded-sm border border-border bg-panel px-1.5 py-0.5 text-[10px]"
                        >
                          <FileText className="h-2.5 w-2.5 text-primary" />
                          {c.standard} § {c.section}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}

            {ask.isPending && <Loading label="Retrieving from the regulation corpus" />}
            {ask.error && <ErrorState error={ask.error} onRetry={() => ask.reset()} />}
          </div>

          <div className="border-t border-border p-3">
            <div className="flex items-center gap-2 rounded-md border border-border bg-background/50 px-3">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder="Ask about regulations, SOPs, or compliance…"
                className="h-10 w-full bg-transparent text-[12px] focus:outline-none"
              />
              <button
                onClick={send}
                disabled={ask.isPending || !input.trim()}
                className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </Panel>

      <div className="space-y-3 lg:col-span-4">
        <Panel
          title="Retrieved Passages"
          subtitle={
            latest
              ? `${latest.citations.length} citation(s) for the last answer`
              : "Ask a question to see sources"
          }
          padded={false}
        >
          {latest ? (
            latest.citations.length > 0 ? (
              <div className="space-y-2 p-4">
                {latest.citations.map((c) => (
                  <CitationRow key={`${c.standard}-${c.section}`} c={c} />
                ))}
              </div>
            ) : (
              <p className="px-4 py-6 text-[12px] text-muted-foreground">
                {latest.grounded
                  ? "The answer was grounded but the backend returned no citation list for it."
                  : "No passage cleared the relevance threshold, so no sources were cited."}
              </p>
            )
          ) : (
            <p className="px-4 py-6 text-[12px] text-muted-foreground">No query yet.</p>
          )}
        </Panel>

        <Panel title="Corpus & Model">
          <QueryBoundary query={health} loadingLabel="Checking service">
            {(h) => (
              <ul className="space-y-2 text-[12px]">
                {[
                  ["Service", h.status],
                  ["Version", h.version],
                  ["LLM backend", h.llm_backend],
                  ["Regulation chunks", String(h.regulation_chunks)],
                  ["Risk model loaded", h.model_loaded ? "yes" : "no"],
                ].map(([k, v]) => (
                  <li
                    key={k}
                    className="flex items-center justify-between border-b border-border pb-2 last:border-0"
                  >
                    <span className="text-muted-foreground">{k}</span>
                    <span className="mono font-medium">{v}</span>
                  </li>
                ))}
              </ul>
            )}
          </QueryBoundary>
        </Panel>
      </div>
    </div>
  );
}
