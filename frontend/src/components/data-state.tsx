/**
 * Shared loading / error / empty states.
 *
 * Every page in this console reads live plant data, so "the backend is down"
 * and "the backend is up but not ready" are states an operator will actually
 * hit. They are shown explicitly rather than as a blank panel, because a blank
 * risk display reads as "no risk".
 */
import { AlertTriangle, Loader2, PlugZap } from "lucide-react";
import type { ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { API_BASE } from "@/lib/api";

export function Loading({ label = "Loading plant data" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-1 py-6 text-[12px] text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      {label}…
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const api = error instanceof ApiError ? error : null;
  const unreachable = api?.status === 0;
  const notReady = api?.isNotReady ?? false;

  const title = unreachable
    ? "Backend unreachable"
    : notReady
      ? "Backend not ready"
      : "Request failed";

  const detail = unreachable
    ? `No response from ${API_BASE}. Start the API with: python -m uvicorn sentinel.api.app:app --port 8000`
    : notReady
      ? `${api?.message ?? "The service is starting."} Run scripts/run_pipeline.py to produce the model and scoreboard.`
      : ((error as Error)?.message ?? "Unknown error");

  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
      <div className="flex items-center gap-2 text-[12px] font-medium text-destructive">
        {unreachable ? (
          <PlugZap className="h-3.5 w-3.5" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5" />
        )}
        {title}
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{detail}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 rounded-sm border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ label }: { label: string }) {
  return <p className="px-1 py-6 text-[12px] text-muted-foreground">{label}</p>;
}

/**
 * Renders the right state for a query. Keeps pages free of repeated
 * `isLoading ? … : error ? … :` ladders.
 */
export function QueryBoundary<T>({
  query,
  children,
  loadingLabel,
  emptyLabel,
  isEmpty,
}: {
  query: { data?: T; isPending: boolean; error: unknown; refetch?: () => void };
  children: (data: T) => ReactNode;
  loadingLabel?: string;
  emptyLabel?: string;
  isEmpty?: (data: T) => boolean;
}) {
  if (query.isPending) return <Loading label={loadingLabel} />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  if (query.data === undefined) return <Empty label={emptyLabel ?? "No data"} />;
  if (isEmpty?.(query.data)) return <Empty label={emptyLabel ?? "Nothing to show"} />;
  return <>{children(query.data)}</>;
}
