// Settles immutable pre-match publications. Match-winner recommendations use
// the score at 90 minutes plus stoppage time; extra time and penalties do not
// change the settlement for this market.

type ProviderFixture = {
  fixture: { id: number; status: { short: string; long: string } };
  score?: { fulltime?: { home?: number | null; away?: number | null } | null } | null;
};
type PendingSnapshot = {
  id: string;
  favorite_side: "home" | "away";
  fixtures?: { provider_fixture_id?: number } | null;
};

const API_BASE_URL = "https://v3.football.api-sports.io";
const PROVIDER = "api-football";
const DAILY_LIMIT = 90;
const utcNow = () => new Date().toISOString();
const brtDate = (offsetDays = 0) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(Date.now() + offsetDays * 86_400_000));
const cacheKey = (path: string, query: Record<string, string>) => [path, ...Object.entries(query)
  .sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`)].join("|");

const constantTimeEquals = (left: string, right: string) => {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
};
const firstServerKey = () => {
  const modernKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modernKeys) {
    const value = Object.values(JSON.parse(modernKeys) as Record<string, string>).find(Boolean);
    if (value) return value;
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
};
const projectUrl = () => Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "") || "";
const databaseHeaders = () => {
  const key = firstServerKey();
  return { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };
};
const databaseRequest = async <T>(path: string, init: RequestInit = {}) => {
  const response = await fetch(`${projectUrl()}/rest/v1/${path}`, {
    ...init,
    headers: { ...databaseHeaders(), ...(init.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Database request failed (${response.status}).`);
  if (response.status === 204) return null as T;
  const text = await response.text();
  return text ? JSON.parse(text) as T : null as T;
};
const rpc = <T>(name: string, args: Record<string, unknown> = {}) =>
  databaseRequest<T>(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });

const getFixturesForSettlement = async (date: string, apiKey: string) => {
  const query = { date, timezone: "America/Sao_Paulo" };
  const key = cacheKey("fixtures", query);
  const cached = await databaseRequest<{ payload: ProviderFixture[]; expires_at: string }[]>(
    `provider_cache?select=payload,expires_at&provider=eq.${PROVIDER}&cache_key=eq.${encodeURIComponent(key)}&limit=1`,
  );
  if (cached[0] && new Date(cached[0].expires_at).getTime() > Date.now()) return cached[0].payload;

  const quota = await rpc<{ allowed: boolean }[]>("reserve_api_quota", {
    p_provider: PROVIDER, p_usage_date: brtDate(), p_limit: DAILY_LIMIT, p_count: 1,
  });
  if (!quota[0]?.allowed) throw new Error("The daily API-Football budget was reached.");
  const response = await fetch(`${API_BASE_URL}/fixtures?${new URLSearchParams(query)}`, {
    headers: { "x-apisports-key": apiKey }, signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`API-Football returned HTTP ${response.status}.`);
  const body = await response.json() as { response?: ProviderFixture[]; errors?: Record<string, string> | string[] };
  if (body.errors && Object.keys(body.errors).length) throw new Error("API-Football rejected the settlement request.");
  const payload = body.response || [];
  await databaseRequest("provider_cache?on_conflict=provider,cache_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      provider: PROVIDER, cache_key: key, payload, fetched_at: utcNow(),
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    }),
  });
  return payload;
};

Deno.serve(async (request) => {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  if (!projectUrl() || !firstServerKey()) return Response.json({ error: "Server configuration is incomplete." }, { status: 503 });
  try {
    const received = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const refreshSecret = await rpc<string | null>("get_cron_refresh_secret");
    if (!received || !refreshSecret || !constantTimeEquals(received, refreshSecret)) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }
    const targetDate = brtDate(-1);
    const pending = await databaseRequest<PendingSnapshot[]>(
      `published_analysis_snapshots?select=id,favorite_side,fixtures(provider_fixture_id)&target_date=eq.${targetDate}&settlement_status=eq.pending`,
    );
    if (!pending.length) return Response.json({ ok: true, targetDate, settled: 0, pending: 0 });
    const apiKey = await rpc<string | null>("get_api_football_key");
    if (!apiKey) return Response.json({ error: "API-Football is not configured." }, { status: 503 });
    const providerFixtures = await getFixturesForSettlement(targetDate, apiKey);
    const byId = new Map(providerFixtures.map((fixture) => [fixture.fixture.id, fixture]));
    let settled = 0;
    for (const snapshot of pending) {
      const fixtureId = snapshot.fixtures?.provider_fixture_id;
      const fixture = fixtureId ? byId.get(fixtureId) : undefined;
      if (!fixture) continue;
      const status = fixture.fixture.status.short;
      const fulltime = fixture.score?.fulltime;
      let update: Record<string, unknown> | null = null;
      if (["FT", "AET", "PEN"].includes(status) && typeof fulltime?.home === "number" && typeof fulltime.away === "number") {
        const green = snapshot.favorite_side === "home" ? fulltime.home > fulltime.away : fulltime.away > fulltime.home;
        update = {
          settlement_status: green ? "green" : "red", home_score_90: fulltime.home, away_score_90: fulltime.away,
          provider_status: status, settled_at: utcNow(),
          settlement_note: "Mercado 1X2 liquidado pelos 90 minutos mais acréscimos.",
        };
      } else if (["PST", "CANC", "ABD", "AWD", "WO"].includes(status)) {
        update = { settlement_status: "void", provider_status: status, settled_at: utcNow(), settlement_note: "Jogo não teve placar elegível para o mercado publicado." };
      }
      if (update) {
        await databaseRequest(`published_analysis_snapshots?id=eq.${snapshot.id}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(update),
        });
        settled += 1;
      }
    }
    return Response.json({ ok: true, targetDate, settled, pending: pending.length - settled });
  } catch (error) {
    console.error("APITOLHEIRO settlement failed", error instanceof Error ? error.message : "Unknown error");
    return Response.json({ error: "Settlement run failed." }, { status: 500 });
  }
});
