import { config } from "./config";
import { getSupabaseAdmin } from "./supabase-server";

type ApiSportsEnvelope<T> = {
  response: T;
  errors?: Record<string, string> | string[];
};

type CacheRow = {
  payload: unknown;
  expires_at: string;
};

const provider = "api-football";

const usageDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const cacheKeyFor = (path: string, query: Record<string, string | number | boolean>) =>
  [path, ...Object.entries(query).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => key + "=" + value)].join("|");

export class ApiFootballClient {
  private requestsThisRun = 0;
  private providerThrottled = false;

  private async reserveQuota() {
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      throw new Error("Supabase server configuration is unavailable.");
    }

    const { data, error } = await supabase.rpc("reserve_api_quota", {
      p_provider: provider,
      p_usage_date: usageDate(),
      p_limit: Number.isFinite(config.dailyLimit) ? Math.min(Math.max(config.dailyLimit, 1), 100) : 90,
      p_count: 1,
    });

    if (error) {
      console.error("API quota reservation failed", { code: error.code, message: error.message });
      throw new Error("Could not reserve API quota.");
    }

    const reservation = Array.isArray(data) ? data[0] : data;
    if (!reservation?.allowed) {
      throw new Error("Daily API-Football budget reached. Cached data remains available.");
    }
  }

  async get<T>(
    path: string,
    query: Record<string, string | number | boolean>,
    ttlMinutes: number,
  ): Promise<T> {
    if (!config.apiFootballKey) {
      throw new Error("API_FOOTBALL_KEY is not configured.");
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      throw new Error("Supabase server configuration is unavailable.");
    }

    const cacheKey = cacheKeyFor(path, query);
    const { data: cached } = await supabase
      .from("provider_cache")
      .select("payload, expires_at")
      .eq("provider", provider)
      .eq("cache_key", cacheKey)
      .maybeSingle<CacheRow>();

    if (cached && new Date(cached.expires_at).getTime() > Date.now()) {
      return cached.payload as T;
    }

    if (this.providerThrottled) {
      throw new Error("API-Football temporarily throttled this ingestion run.");
    }

    const runLimit = Number.isFinite(config.maxApiRequestsPerRun)
      ? Math.max(1, config.maxApiRequestsPerRun)
      : 9;
    if (this.requestsThisRun >= runLimit) {
      throw new Error("Per-run API-Football budget reached.");
    }

    await this.reserveQuota();
    this.requestsThisRun += 1;

    const params = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    );
    const response = await fetch(config.apiFootballBaseUrl + "/" + path + "?" + params.toString(), {
      headers: { "x-apisports-key": config.apiFootballKey },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });

    if (response.status === 429) {
      this.providerThrottled = true;
      throw new Error("API-Football returned HTTP 429.");
    }

    if (!response.ok) {
      throw new Error("API-Football returned HTTP " + response.status + ".");
    }

    const body = (await response.json()) as ApiSportsEnvelope<T>;
    if (body.errors && Object.keys(body.errors).length > 0) {
      const providerMessage = Array.isArray(body.errors)
        ? body.errors.join("; ")
        : Object.values(body.errors).join("; ");
      throw new Error("API-Football could not complete this data request: " + providerMessage.slice(0, 280));
    }

    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    const { error: cacheError } = await supabase.from("provider_cache").upsert(
      {
        provider,
        cache_key: cacheKey,
        payload: body.response,
        fetched_at: new Date().toISOString(),
        expires_at: expiresAt,
      },
      { onConflict: "provider,cache_key" },
    );

    if (cacheError) {
      console.error("Provider cache write failed", cacheError.message);
    }

    return body.response;
  }

  async getOptional<T>(
    path: string,
    query: Record<string, string | number | boolean>,
    ttlMinutes: number,
  ): Promise<T | null> {
    try {
      return await this.get<T>(path, query, ttlMinutes);
    } catch (error) {
      console.warn("Optional API-Football input unavailable", {
        path,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }
  }
}

export const getTodayUsage = async () => {
  const supabase = getSupabaseAdmin();
  if (!supabase) return 0;

  const { data } = await supabase
    .from("api_usage_daily")
    .select("requests_made")
    .eq("provider", provider)
    .eq("usage_date", usageDate())
    .maybeSingle<{ requests_made: number }>();

  return data?.requests_made || 0;
};
