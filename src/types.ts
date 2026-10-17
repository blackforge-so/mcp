// Shapes returned by the BlackForge public /v1 API. These mirror the API
// contract exactly; the server is a thin client and re-shapes nothing.

/**
 * One entry of the quality-flag decode table. The API serves this table ONCE,
 * on the `qualityFlags` metric of /v1/catalog, as a `bits` array. Clients must
 * never hardcode a copy of it — read it from the catalog or fall back to raw
 * masks. Every field is optional here because the client only consumes it
 * opportunistically and must not break if the shape grows.
 */
export interface QualityBit {
  /** Bit index, 0-30 (19 bits served today). */
  bit?: number;
  /** The bit's mask, i.e. 1 << bit. Either this or `bit` identifies the flag. */
  mask?: number;
  /** Machine name, e.g. BOOK_DESYNCED. */
  name?: string;
  label?: string;
  description?: string;
  /** Column families whose figures this flag calls into question. */
  contaminates?: string[];
}

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
  /** Only on the `qualityFlags` metric: the 16-bit decode table. */
  bits?: QualityBit[];
  /** Series intervals the metric is served at, e.g. ["1m", "5m", "1h", "1d"]. */
  intervals?: string[];
  /** Present where the 5m/1h/1d value is a rollup of minute values: how it is rolled up. */
  rollupNote?: string;
}

export interface CatalogVenue {
  venue: string;
  minPlan: string;
}

export interface CatalogResponse {
  venues: CatalogVenue[];
  metrics: CatalogMetric[];
  /** When the one-minute rows start (ISO), null before the switch. */
  availableFrom?: { "1m": string | null };
}

/**
 * The per-row data-quality assessment that sits beside `values` on /v1/latest.
 *
 * STRICTLY OPTIONAL. The API does not serve it yet, so every consumer must
 * treat its absence as normal and render nothing at all in that case.
 * `flags` and `contaminates` arrive already decoded, as strings — the client
 * passes them through and interprets nothing.
 */
export interface QualityAssessment {
  /** Bitwise OR of the quality flags on the row. 0 = clean. */
  raw: number;
  /** Bitwise AND across the underlying windows. */
  all: number;
  /** Decoded flag names, e.g. ["BOOK_DESYNCED"]. Server-provided. */
  flags?: string[];
  /** Column families the flags call into question. Server-provided. */
  contaminates?: string[];
  observedAt?: number;
}

/** Latest completed bucket (1m on Ultra/PAYG, 5m otherwise) for one (exchange, symbol). `ts` is epoch ms (0 if none). */
export interface LatestResponse {
  ts: number;
  values: Record<string, number | null>;
  /** Optional: absent on every response until the quality rail ships. */
  quality?: QualityAssessment;
}

export interface SeriesPoint {
  ts: number;
  value: number | null;
  /** Bitwise OR of the quality flags over the native windows in this bucket. */
  quality?: number;
  /** Bitwise AND of the quality flags over the native windows in this bucket. */
  qualityAll?: number;
}

export interface SeriesResponse {
  metric: string;
  exchange: string;
  symbol: string;
  points: SeriesPoint[];
  /** True when the range held more buckets than one response carries; the newest are returned. */
  truncated?: boolean;
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
