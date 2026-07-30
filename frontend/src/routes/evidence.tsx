import { createFileRoute } from "@tanstack/react-router";
import { Panel, Chip } from "@/components/panel";
import { QueryBoundary } from "@/components/data-state";
import { useScoreboard } from "@/lib/queries";
import type { ScoreboardResponse } from "@/lib/api-types";

export const Route = createFileRoute("/evidence")({
  head: () => ({
    meta: [
      { title: "Evidence Panel · Sentinel-Gemma" },
      {
        name: "description",
        content:
          "Baseline vs Sentinel-Gemma head-to-head across detection lead time, precision, recall, and false alarms.",
      },
    ],
  }),
  component: EvidencePanel,
});

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const mins = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} min`);

/** Signed delta in percentage points, always compound minus baseline. */
const ppDelta = (baseline: number, compound: number) => {
  const d = (compound - baseline) * 100;
  return `${d > 0 ? "+" : ""}${d.toFixed(1)} pp`;
};

const minDelta = (baseline: number | null, compound: number | null) => {
  if (baseline === null || compound === null) return "—";
  const d = compound - baseline;
  return `${d > 0 ? "+" : ""}${d.toFixed(1)} min`;
};

type Row = {
  metric: string;
  note?: string;
  baseline: string;
  compound: string;
  delta: string;
  /**
   * Which direction is better for this metric. Declared per row rather than
   * guessed from the metric name — name matching silently mislabels any metric
   * that gets renamed, and it cannot express "higher is better but the
   * baseline won".
   */
  better: "higher" | "lower";
  /** null when the two are tied or a value is missing. */
  compoundWins: boolean | null;
};

function buildRows(s: ScoreboardResponse): Row[] {
  const cmp = (baseline: number, compound: number, better: "higher" | "lower") =>
    baseline === compound ? null : better === "higher" ? compound > baseline : compound < baseline;

  const leadWins =
    s.matched_baseline_lead_min === null || s.matched_compound_lead_min === null
      ? null
      : cmp(s.matched_baseline_lead_min, s.matched_compound_lead_min, "higher");

  return [
    {
      metric: "Detection rate",
      note: `share of ${s.n_incident_episodes} incident episodes flagged before the event`,
      baseline: pct(s.baseline_detection_rate),
      compound: pct(s.compound_detection_rate),
      delta: ppDelta(s.baseline_detection_rate, s.compound_detection_rate),
      better: "higher",
      compoundWins: cmp(s.baseline_detection_rate, s.compound_detection_rate, "higher"),
    },
    {
      metric: "False-negative rate",
      note: "incident episodes that were never flagged",
      baseline: pct(s.baseline_false_negative_rate),
      compound: pct(s.compound_false_negative_rate),
      delta: ppDelta(s.baseline_false_negative_rate, s.compound_false_negative_rate),
      better: "lower",
      compoundWins: cmp(s.baseline_false_negative_rate, s.compound_false_negative_rate, "lower"),
    },
    {
      metric: "False-alarm rate",
      note: `share of ${s.n_safe_episodes} safe episodes that raised an alarm anyway`,
      baseline: pct(s.baseline_false_alarm_rate),
      compound: pct(s.compound_false_alarm_rate),
      delta: ppDelta(s.baseline_false_alarm_rate, s.compound_false_alarm_rate),
      better: "lower",
      compoundWins: cmp(s.baseline_false_alarm_rate, s.compound_false_alarm_rate, "lower"),
    },
    {
      metric: "Matched lead time",
      note: "mean warning ahead of the event, on episodes both models caught",
      baseline: mins(s.matched_baseline_lead_min),
      compound: mins(s.matched_compound_lead_min),
      delta: minDelta(s.matched_baseline_lead_min, s.matched_compound_lead_min),
      better: "higher",
      compoundWins: leadWins,
    },
  ];
}

function deltaTone(win: boolean | null): "success" | "danger" | "muted" {
  if (win === null) return "muted";
  return win ? "success" : "danger";
}

function EvidencePanel() {
  const scoreboard = useScoreboard();

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-12">
      <QueryBoundary query={scoreboard} loadingLabel="Loading evaluation scoreboard">
        {(s) => {
          const rows = buildRows(s);
          const leadRow = rows[rows.length - 1];
          const baselineKeepsLead = leadRow.compoundWins === false;

          return (
            <>
              <div className="lg:col-span-12 grid grid-cols-2 gap-3 md:grid-cols-4">
                {(
                  [
                    ["Episodes evaluated", s.n_episodes],
                    ["Incident episodes", s.n_incident_episodes],
                    ["Safe episodes", s.n_safe_episodes],
                    [
                      "Missed by baseline, caught by compound",
                      s.incidents_missed_by_baseline_caught_by_compound,
                    ],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="panel px-4 py-3">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {label}
                    </div>
                    <div className="mono mt-1 text-2xl font-semibold">{value}</div>
                  </div>
                ))}
              </div>

              <Panel
                title="Evidence · Compound model vs single-sensor baseline"
                subtitle={`Offline evaluation over ${s.n_episodes} replayed episodes · /api/v1/evaluation/scoreboard`}
                className="lg:col-span-12"
                padded={false}
              >
                <table className="w-full text-[12px]">
                  <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-6 py-3 text-left font-medium">Metric</th>
                      <th className="px-6 py-3 text-right font-medium">Baseline</th>
                      <th className="px-6 py-3 text-right font-medium">Compound</th>
                      <th className="px-6 py-3 text-right font-medium">Δ vs baseline</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((r) => (
                      <tr key={r.metric} className="hover:bg-accent/20">
                        <td className="px-6 py-3">
                          <div className="font-medium">{r.metric}</div>
                          {r.note && (
                            <div className="mt-0.5 text-[10px] text-muted-foreground">{r.note}</div>
                          )}
                        </td>
                        <td className="px-6 py-3 text-right mono text-muted-foreground">
                          {r.baseline}
                        </td>
                        <td className="px-6 py-3 text-right mono font-semibold text-foreground">
                          {r.compound}
                        </td>
                        <td className="px-6 py-3 text-right">
                          <Chip tone={deltaTone(r.compoundWins)}>{r.delta}</Chip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>

              {baselineKeepsLead && (
                <Panel title="Where the baseline wins" className="lg:col-span-7">
                  <p className="text-[12px] leading-relaxed text-muted-foreground">
                    On the episodes both models caught, the single-sensor baseline warns{" "}
                    <span className="mono text-foreground">{leadRow.baseline}</span> ahead of the
                    event versus <span className="mono text-foreground">{leadRow.compound}</span>{" "}
                    for the compound model — the baseline gets there first, and this page does not
                    dress that up as a win.
                  </p>
                  <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                    It buys that lead by tripping far more readily: it alarms on{" "}
                    <span className="mono text-foreground">{pct(s.baseline_false_alarm_rate)}</span>{" "}
                    of safe episodes against{" "}
                    <span className="mono text-foreground">{pct(s.compound_false_alarm_rate)}</span>{" "}
                    for the compound model. An earlier warning that fires on roughly every other
                    quiet shift is a warning operators learn to ignore, so the two numbers have to
                    be read together rather than separately.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Chip tone="success">
                      Baseline leads by{" "}
                      {(
                        (s.matched_baseline_lead_min ?? 0) - (s.matched_compound_lead_min ?? 0)
                      ).toFixed(1)}{" "}
                      min
                    </Chip>
                    <Chip tone="danger">
                      At {pct(s.baseline_false_alarm_rate)} false-alarm rate
                    </Chip>
                  </div>
                </Panel>
              )}

              <Panel
                title="Coverage"
                className={baselineKeepsLead ? "lg:col-span-5" : "lg:col-span-12"}
              >
                <p className="text-[12px] leading-relaxed text-muted-foreground">
                  The compound model caught{" "}
                  <span className="mono text-foreground">
                    {s.incidents_missed_by_baseline_caught_by_compound}
                  </span>{" "}
                  incident{s.incidents_missed_by_baseline_caught_by_compound === 1 ? "" : "s"} that
                  the baseline missed entirely, cutting the false-negative rate from{" "}
                  <span className="mono text-foreground">
                    {pct(s.baseline_false_negative_rate)}
                  </span>{" "}
                  to{" "}
                  <span className="mono text-foreground">
                    {pct(s.compound_false_negative_rate)}
                  </span>
                  .
                </p>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  Detection and false-negative rates are computed over the {s.n_incident_episodes}{" "}
                  incident episodes; the false-alarm rate over the {s.n_safe_episodes} safe
                  episodes. The remaining episodes of the {s.n_episodes} evaluated fall into neither
                  group and are excluded from both.
                </p>
              </Panel>
            </>
          );
        }}
      </QueryBoundary>
    </div>
  );
}
