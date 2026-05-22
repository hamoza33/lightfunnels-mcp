/**
 * GraphQL client for the Lightfunnels API.
 * Docs: https://developer.lightfunnels.com
 */

const DEFAULT_BASE_URL = "https://services.lightfunnels.com/api/v2";
const DEFAULT_TIMEOUT_MS = 30_000;
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const TRANSIENT_RETRY_BACKOFF_MS = [400, 1200];
const RATE_LIMIT_RETRY_BACKOFF_MS = [2000, 4000, 8000];

export interface LfClientOptions {
  /** Permanent OAuth access token from Lightfunnels. */
  token: string;
  /** Override GraphQL endpoint. Defaults to https://services.lightfunnels.com/api/v2 */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
}

export class LfApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors?: unknown[],
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "LfApiError";
  }
}

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; locations?: unknown[]; path?: unknown[] }>;
}

export class LfClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly token: string;

  constructor(opts: LfClientOptions) {
    if (!opts.token) {
      throw new Error(
        "LfClient: `token` is required. Obtain a permanent access token via the Lightfunnels OAuth flow.",
      );
    }
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async query<T = unknown>(
    gql: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    let attempt = 0;
    const maxAttempts = Math.max(TRANSIENT_RETRY_BACKOFF_MS.length, RATE_LIMIT_RETRY_BACKOFF_MS.length) + 1;
    let lastErr: unknown;

    while (attempt < maxAttempts) {
      try {
        return await this.rawQuery<T>(gql, variables);
      } catch (err) {
        lastErr = err;
        if (err instanceof LfApiError) {
          // Rate limit: retry with longer backoff
          const isRateLimit = err.errors?.some(
            (e) => typeof e === "object" && e !== null && (e as Record<string, unknown>).key === "rate_limit_reached",
          );
          if (isRateLimit && attempt < RATE_LIMIT_RETRY_BACKOFF_MS.length) {
            const wait = RATE_LIMIT_RETRY_BACKOFF_MS[attempt] ?? 4000;
            await new Promise((resolve) => setTimeout(resolve, wait));
            attempt += 1;
            continue;
          }
          // Transient HTTP errors
          if (
            (TRANSIENT_STATUSES.has(err.status) || err.status === 0) &&
            attempt < TRANSIENT_RETRY_BACKOFF_MS.length
          ) {
            const wait = TRANSIENT_RETRY_BACKOFF_MS[attempt] ?? 1000;
            await new Promise((resolve) => setTimeout(resolve, wait));
            attempt += 1;
            continue;
          }
        }
        throw err;
      }
    }
    throw lastErr ?? new LfApiError("query: unreachable", 0);
  }

  private async rawQuery<T = unknown>(
    gql: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const body = JSON.stringify({ query: gql, variables: variables ?? {} });

    let res: Response;
    try {
      res = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "User-Agent": "lightfunnels-mcp/0.1.0",
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if ((err as Error).name === "AbortError") {
        throw new LfApiError(
          `Request timed out after ${this.timeoutMs}ms`,
          0,
        );
      }
      throw new LfApiError(
        `Network error: ${(err as Error).message}`,
        0,
      );
    }
    clearTimeout(timeout);

    const text = await res.text();
    let parsed: GraphQLResponse<T> | undefined;
    if (text) {
      try {
        parsed = JSON.parse(text) as GraphQLResponse<T>;
      } catch {
        throw new LfApiError(
          `Invalid JSON response (HTTP ${res.status})`,
          res.status,
          undefined,
          text,
        );
      }
    }

    if (!res.ok) {
      const message =
        parsed?.errors?.[0]?.message ??
        `HTTP ${res.status} from Lightfunnels API`;
      throw new LfApiError(message, res.status, parsed?.errors, parsed);
    }

    if (parsed?.errors?.length) {
      throw new LfApiError(
        parsed.errors[0].message,
        200,
        parsed.errors,
        parsed,
      );
    }

    if (!parsed?.data) {
      throw new LfApiError("Empty response from Lightfunnels API", res.status);
    }

    return parsed.data;
  }
}
