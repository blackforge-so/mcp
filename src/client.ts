// Thin typed HTTP client over the BlackForge public /v1 API. No caching, no
// retries, no plan logic — the API enforces entitlements and this client
// surfaces them. Uses native fetch (Node 20+).

import {
  BlackForgeApiError,
  type BlackForgeMeta,
  type CatalogResponse,
  type LatestResponse,
  type SeriesResponse,
  type UsageResponse,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.blackforge.so";

/** A successful response body paired with the BlackForge meta headers. */
export interface Result<T> {
  data: T;
  meta: BlackForgeMeta;
}

function readMeta(headers: Headers): BlackForgeMeta {
  const meta: BlackForgeMeta = {};
  const served = headers.get("x-blackforge-rows-served");
  const remaining = headers.get("x-blackforge-rows-remaining");
  const omitted = headers.get("x-blackforge-columns-omitted");
  const billed = headers.get("x-blackforge-blocks-billed");
  if (served !== null) meta.rowsServed = Number(served);
  if (remaining !== null) meta.rowsRemaining = Number(remaining);
  if (omitted) meta.columnsOmitted = omitted.split(",").map((c) => c.trim()).filter(Boolean);
  if (billed !== null) meta.blocksBilled = Number(billed);
  return meta;
}

export class BlackForgeClient {
  private baseUrl: string;
  private apiKey: string | undefined;

  constructor(opts?: { baseUrl?: string; apiKey?: string }) {
    const rawBase = opts?.baseUrl ?? process.env.BLACKFORGE_BASE_URL ?? DEFAULT_BASE_URL;
    this.baseUrl = rawBase.replace(/\/+$/, "");
    this.apiKey = opts?.apiKey ?? process.env.BLACKFORGE_API_KEY;
  }

  /** True when an API key is configured (needed for every route except catalog). */
  hasKey(): boolean {
    return Boolean(this.apiKey);
  }

  private async request<T>(
    path: string,
    params: Record<string, string | undefined>,
    opts?: { keyless?: boolean },
  ): Promise<Result<T>> {
    if (!opts?.keyless && !this.apiKey) {
      throw new BlackForgeApiError(
        0,
        "BLACKFORGE_API_KEY is not set. Get a key at app.blackforge.so → Keys, then set it in the server env.",
      );
    }

    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (!opts?.keyless && this.apiKey) headers["x-api-key"] = this.apiKey;

    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      throw new BlackForgeApiError(
        0,
        `Could not reach the BlackForge API at ${this.baseUrl}: ${(err as Error).message}`,
      );
    }

    const meta = readMeta(res.headers);

    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = (await res.json()) as { message?: string | string[] };
        if (body?.message) {
          message = Array.isArray(body.message) ? body.message.join("; ") : body.message;
        }
      } catch {
        // Non-JSON error body; keep the status text.
      }
      throw new BlackForgeApiError(res.status, message);
    }

    const data = (await res.json()) as T;
    return { data, meta };
  }

  catalog(): Promise<Result<CatalogResponse>> {
    return this.request<CatalogResponse>("/v1/catalog", {}, { keyless: true });
  }

  symbols(exchange: string): Promise<Result<string[]>> {
    return this.request<string[]>("/v1/symbols", { exchange });
  }

  latest(exchange: string, symbol: string, columns?: string[]): Promise<Result<LatestResponse>> {
    return this.request<LatestResponse>("/v1/latest", {
      exchange,
      symbol,
      columns: columns && columns.length ? columns.join(",") : undefined,
    });
  }

  series(args: {
    exchange: string;
    symbol: string;
    metric: string;
    from: string;
    to: string;
    interval: string;
  }): Promise<Result<SeriesResponse>> {
    return this.request<SeriesResponse>("/v1/series", { ...args });
  }

  usage(): Promise<Result<UsageResponse>> {
    return this.request<UsageResponse>("/v1/usage", {});
  }
}
