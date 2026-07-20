// Shapes returned by the BlackForge public /v1 API. These mirror the API
// contract exactly; the server is a thin client and re-shapes nothing.

/** A single microstructure or enrichment measurement, as described by /v1/catalog. */
export interface CatalogMetric {
  key: string;
  label: string;
  family: string;
  unit: string;
  quoteRelative: boolean;
  nullable: boolean;
  description: string;
  howToRead: string;
  minPlan: string;
}

export interface CatalogVenue {
  venue: string;
  minPlan: string;
}

export interface CatalogResponse {
  venues: CatalogVenue[];
  metrics: CatalogMetric[];
}

/** Latest completed 5-minute window for one (exchange, symbol). `ts` is epoch ms (0 if none). */
export interface LatestResponse {
  ts: number;
  values: Record<string, number | null>;
}

export interface SeriesPoint {
  ts: number;
  value: number | null;
}

export interface SeriesResponse {
  metric: string;
  exchange: string;
  symbol: string;
  points: SeriesPoint[];
}

export interface UsageDay {
  date: string;
  count: number;
  lastAt: string;
}

export interface UsageResponse {
  days: UsageDay[];
  rowsRemaining?: number;
}

/**
 * The `X-BlackForge-*` response headers surfaced alongside a call. Each is
 * optional; the API only sets the ones relevant to a given route.
 */
export interface BlackForgeMeta {
  rowsServed?: number;
  rowsRemaining?: number;
  /** Columns dropped because the caller's plan does not include them. */
  columnsOmitted?: string[];
  blocksBilled?: number;
}

/** Thrown on any non-2xx API response. Carries the HTTP status and server message. */
export class BlackForgeApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BlackForgeApiError";
    this.status = status;
  }
}
