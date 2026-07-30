/**
 * Typed client for the SentinelAI backend.
 *
 * Base URL comes from VITE_API_URL so the console can point at a deployed API
 * without a rebuild. The backend returns RFC-7807-style problem details, so
 * `ApiError` carries the `title` the server sent rather than a generic message.
 */
import type {
  AlertItem,
  AlertLogEntry,
  ClockResponse,
  ComplianceResponse,
  HealthResponse,
  PermitDecisionResponse,
  PermitRequestBody,
  ProximateHazard,
  ScoreboardResponse,
  SiteGeoResponse,
  VisionResponse,
  SimulationRequest,
  SimulationResult,
  WorkflowResponse,
  ZoneReading,
  ZoneState,
} from "./api-types";

export const API_BASE: string =
  (import.meta.env?.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ??
  "http://127.0.0.1:8000";

const PREFIX = "/api/v1";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public path?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** 503 means the service is up but not ready (no model, no corpus). */
  get isNotReady() {
    return this.status === 503;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${PREFIX}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch {
    // Network-level failure: the API isn't reachable at all.
    throw new ApiError(0, `Cannot reach the SentinelAI API at ${API_BASE}`, path);
  }

  if (!res.ok) {
    let title = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.title) title = body.title;
      else if (body?.detail) title = body.detail;
    } catch {
      /* non-JSON error body — keep the status line */
    }
    throw new ApiError(res.status, title, path);
  }

  return (await res.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const api = {
  // ---------------------------------------------------------------- system
  health: () => request<HealthResponse>("/health"),
  gemmaStatus: () => request<GemmaStatus>("/gemma/status"),

  // ----------------------------------------------------------------- plant
  zones: () => request<ZoneState[]>("/zones"),
  zone: (zoneId: string) => request<ZoneState>(`/zones/${encodeURIComponent(zoneId)}`),
  zoneHistory: (zoneId: string, window = 90) =>
    request<ZoneReading[]>(`/zones/${encodeURIComponent(zoneId)}/history?window=${window}`),

  // ----------------------------------------------------------------- clock
  clock: () => request<ClockResponse>("/clock"),
  siteGeo: () => request<SiteGeoResponse>("/site/geo"),
  proximity: (zoneId: string, radiusM?: number) =>
    request<ProximateHazard[]>(
      `/zones/${encodeURIComponent(zoneId)}/proximity` + (radiusM ? `?radius_m=${radiusM}` : ""),
    ),
  vision: () => request<VisionResponse>("/vision"),
  tick: (steps = 1) => post<ClockResponse>(`/clock/tick?steps=${steps}`),
  setClock: (minute: number) => post<ClockResponse>(`/clock/set?minute=${minute}`),

  // ---------------------------------------------------------------- alerts
  alerts: () => request<AlertItem[]>("/alerts"),
  /**
   * Append-only alert history, newest first. `/alerts` describes only the
   * current plant minute, so an alert that rose and cleared between two polls
   * is invisible there — this is the record of what actually happened.
   */
  alertLog: (limit = 200, zoneId?: string) =>
    request<AlertLogEntry[]>(
      `/alerts/log?limit=${limit}` + (zoneId ? `&zone_id=${encodeURIComponent(zoneId)}` : ""),
    ),

  // --------------------------------------------------------------- permits
  evaluatePermit: (body: PermitRequestBody) =>
    post<PermitDecisionResponse>("/permits/evaluate", {
      use_ai_risk: true,
      machine_id: "",
      ...body,
    }),

  // ------------------------------------------------------------ compliance
  ask: (question: string, topK = 4) =>
    post<ComplianceResponse>("/compliance/ask", { question, top_k: topK }),

  // -------------------------------------------------------------- workflow
  runWorkflow: (zoneId: string) =>
    post<WorkflowResponse>(`/workflow/run/${encodeURIComponent(zoneId)}`),

  // ------------------------------------------------------------ simulation
  /** Re-score every zone under what-if overrides, using the trained model. */
  simulate: (body: SimulationRequest) => post<SimulationResult[]>("/simulate", body),

  // ------------------------------------------------------------ evaluation
  scoreboard: () => request<ScoreboardResponse>("/evaluation/scoreboard"),
};
