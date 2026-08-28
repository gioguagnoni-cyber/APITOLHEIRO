// APITOLHEIRO's server-owned ingestion. This function is invoked only by the
// Supabase Cron job; the public GitHub Pages dashboard never calls it.

type ProviderFixture = {
  fixture: { id: number; date: string; status: { short: string; long: string }; venue?: { name?: string | null } | null };
  league: { id: number; season: number; name: string; country?: string | null; logo?: string | null };
  teams: {
    home: { id: number; name: string; logo?: string | null; winner?: boolean | null };
    away: { id: number; name: string; logo?: string | null; winner?: boolean | null };
  };
  goals?: { home?: number | null; away?: number | null } | null;
};

type RecentMetrics = {
  total: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  venueTotal: number;
  venueWins: number;
  unavailable: boolean;
};

type Standing = { team: { id: number }; rank: number };
type StandingsResponse = { league?: { standings?: Standing[][] } };
type Prediction = {
  predictions?: {
    winner?: { id?: number | null };
    percent?: { home?: string | null; draw?: string | null; away?: string | null };
    goals?: { home?: string | number | null; away?: string | number | null };
  };
};
type OddsResponse = {
  bookmakers?: { name?: string; bets?: { name?: string; values?: { value?: string; odd?: string }[] }[] }[];
};
type Injury = { team?: { id?: number } };
type Lineup = { team?: { id?: number }; startXI?: unknown[] };

type Insight = {
  fixtureId: number;
  kickoff: string;
  favorite: "home" | "away";
  recommendedMarket: string;
  bookmaker: string | null;
  odds: number | null;
  impliedProbability: number | null;
  probability: number;
  dataConfidence: number;
  score: number;
  tier: 1 | 2 | 3 | 4;
  eligible: boolean;
  sourceUpdatedAt: string;
  metrics: Record<string, unknown>;
  reasons: string[];
  caveats: string[];
};

const API_BASE_URL = "https://v3.football.api-sports.io";
const DAILY_LIMIT = 90;
const MAX_REQUESTS_PER_RUN = 9;
const MAX_DETAILED_CANDIDATES = 1;
const PRIORITY_LEAGUES = new Set([2, 3, 39, 61, 71, 72, 73, 78, 88, 94, 128, 135, 140, 253]);
const PROVIDER = "api-football";

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const safeNumber = (value: string | number | null | undefined) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value || "");
  return Number.isFinite(parsed) ? parsed : null;
};

const utcNow = () => new Date().toISOString();
const usageDate = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

const cacheKeyFor = (path: string, query: Record<string, string | number | boolean>) =>
  [path, ...Object.entries(query).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`)].join("|");

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
    const values = Object.values(JSON.parse(modernKeys) as Record<string, string>).filter(Boolean);
    if (values[0]) return values[0];
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
};

const projectUrl = () => Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "") || "";

const databaseHeaders = (extra: Record<string, string> = {}) => {
  const key = firstServerKey();
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    ...extra,
  };
};

const databaseRequest = async <T>(path: string, init: RequestInit = {}) => {
  const response = await fetch(`${projectUrl()}/rest/v1/${path}`, {
    ...init,
    headers: { ...databaseHeaders(), ...(init.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Database request failed (${response.status}).`);
  if (response.status === 204) return null as T;
  return await response.json() as T;
};

const rpc = <T>(name: string, args: Record<string, unknown> = {}) =>
  databaseRequest<T>(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });

const upsert = async <T extends { id: string }>(table: string, conflictColumns: string, row: Record<string, unknown>) => {
  const value = await databaseRequest<T[]>(`${table}?on_conflict=${encodeURIComponent(conflictColumns)}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row),
  });
  if (!value?.[0]) throw new Error(`Could not persist ${table}.`);
  return value[0];
};

class ApiFootballClient {
  private requestsThisRun = 0;
  private providerThrottled = false;

  async get<T>(path: string, query: Record<string, string | number | boolean>, ttlMinutes: number, apiKey: string): Promise<T> {
    const cacheKey = cacheKeyFor(path, query);
    const cacheQuery = new URLSearchParams({
      select: "payload,expires_at",
      provider: `eq.${PROVIDER}`,
      cache_key: `eq.${cacheKey}`,
      limit: "1",
    });
    const cached = await databaseRequest<{ payload: T; expires_at: string }[]>(`provider_cache?${cacheQuery}`);
    if (cached[0] && new Date(cached[0].expires_at).getTime() > Date.now()) return cached[0].payload;
    if (this.providerThrottled) throw new Error("The provider throttled this run.");
    if (this.requestsThisRun >= MAX_REQUESTS_PER_RUN) throw new Error("The per-run API budget was reached.");

    const reservation = await rpc<{ allowed: boolean }[]>("reserve_api_quota", {
      p_provider: PROVIDER,
      p_usage_date: usageDate(),
      p_limit: DAILY_LIMIT,
      p_count: 1,
    });
    if (!reservation[0]?.allowed) throw new Error("The daily API budget was reached.");
    this.requestsThisRun += 1;

    const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
    const response = await fetch(`${API_BASE_URL}/${path}?${params}`, {
      headers: { "x-apisports-key": apiKey },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 429) {
      this.providerThrottled = true;
      throw new Error("API-Football returned HTTP 429.");
    }
    if (!response.ok) throw new Error(`API-Football returned HTTP ${response.status}.`);

    const body = await response.json() as { response?: T; errors?: Record<string, string> | string[] };
    if (body.errors && Object.keys(body.errors).length) throw new Error("API-Football rejected a data request.");
    const payload = body.response as T;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    await databaseRequest("provider_cache?on_conflict=provider,cache_key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ provider: PROVIDER, cache_key: cacheKey, payload, fetched_at: utcNow(), expires_at: expiresAt }),
    });
    return payload;
  }

  async optional<T>(path: string, query: Record<string, string | number | boolean>, ttlMinutes: number, apiKey: string) {
    try {
      return await this.get<T>(path, query, ttlMinutes, apiKey);
    } catch (error) {
      console.warn("Optional API-Football input unavailable", { path, message: error instanceof Error ? error.message : "Unknown" });
      return null;
    }
  }
}

const fixtureResult = (fixture: ProviderFixture, teamId: number) => {
  const isHome = fixture.teams.home.id === teamId;
  const team = isHome ? fixture.teams.home : fixture.teams.away;
  const other = isHome ? fixture.teams.away : fixture.teams.home;
  return {
    isHome,
    decided: team.winner === true ? "win" : other.winner === true ? "loss" : "draw",
    goalsFor: (isHome ? fixture.goals?.home : fixture.goals?.away) || 0,
    goalsAgainst: (isHome ? fixture.goals?.away : fixture.goals?.home) || 0,
  };
};

const recentMetrics = (fixtures: ProviderFixture[] | null, teamId: number, upcomingIsHome: boolean): RecentMetrics | null => {
  if (!fixtures?.length) return null;
  const complete = fixtures.filter((fixture) => ["FT", "AET", "PEN"].includes(fixture.fixture.status.short));
  const build = (items: ReturnType<typeof fixtureResult>[]) => ({
    wins: items.filter((item) => item.decided === "win").length,
    draws: items.filter((item) => item.decided === "draw").length,
    losses: items.filter((item) => item.decided === "loss").length,
    goalsFor: items.reduce((total, item) => total + item.goalsFor, 0),
    goalsAgainst: items.reduce((total, item) => total + item.goalsAgainst, 0),
  });
  const all = complete.slice(0, 10).map((fixture) => fixtureResult(fixture, teamId));
  const venue = complete.filter((fixture) => fixtureResult(fixture, teamId).isHome === upcomingIsHome).slice(0, 5).map((fixture) => fixtureResult(fixture, teamId));
  const allSummary = build(all);
  const venueSummary = build(venue);
  return { total: all.length, ...allSummary, venueTotal: venue.length, venueWins: venueSummary.wins, unavailable: all.length === 0 };
};

const venueMetrics = (metrics: RecentMetrics | null): RecentMetrics | null => metrics && {
  total: metrics.venueTotal,
  wins: metrics.venueWins,
  draws: 0,
  losses: Math.max(0, metrics.venueTotal - metrics.venueWins),
  goalsFor: 0,
  goalsAgainst: 0,
  venueTotal: metrics.venueTotal,
  venueWins: metrics.venueWins,
  unavailable: metrics.venueTotal === 0,
};

const tablePositions = (payload: StandingsResponse[] | null) => new Map(
  (payload?.flatMap((item) => item.league?.standings?.flat() || []) || []).map((standing) => [standing.team.id, standing.rank]),
);

const findOdds = (payload: OddsResponse[] | null, favorite: "home" | "away") => {
  const wanted = favorite === "home" ? ["Home", "1"] : ["Away", "2"];
  for (const entry of payload || []) for (const bookmaker of entry.bookmakers || []) {
    const market = bookmaker.bets?.find((bet) => /match winner|winner/i.test(bet.name || ""));
    const value = market?.values?.find((candidate) => wanted.includes(candidate.value || ""));
    const odds = safeNumber(value?.odd);
    if (odds) return { odds, bookmaker: bookmaker.name || null };
  }
  return { odds: null, bookmaker: null };
};

const strengthLabel = (position: number | null) => {
  if (!position) return "indisponível";
  if (position >= 17) return "muito baixa";
  if (position >= 12) return "baixa";
  if (position >= 7) return "média";
  if (position >= 4) return "alta";
  return "muito alta";
};

const isKickoffNear = (kickoff: string) => {
  const minutes = (new Date(kickoff).getTime() - Date.now()) / 60_000;
  return minutes >= -15 && minutes <= 90;
};

const fixturePriority = (fixture: ProviderFixture) => {
  if (PRIORITY_LEAGUES.has(fixture.league.id)) return 100;
  return ["Brazil", "Argentina", "England", "Spain", "Italy", "Germany", "France", "Portugal"].includes(fixture.league.country || "") ? 50 : 0;
};

const tierFor = (probability: number, confidence: number): 1 | 2 | 3 | 4 => {
  if (probability >= 75 && confidence >= 0.65) return 1;
  if (probability >= 68) return 2;
  if (probability >= 60) return 3;
  return 4;
};

const apiPercent = (prediction: Prediction[] | null, favorite: "home" | "away") => safeNumber(
  favorite === "home" ? prediction?.[0]?.predictions?.percent?.home : prediction?.[0]?.predictions?.percent?.away,
);

const predictedGoalDifference = (prediction: Prediction[] | null, favorite: "home" | "away") => {
  const home = safeNumber(prediction?.[0]?.predictions?.goals?.home);
  const away = safeNumber(prediction?.[0]?.predictions?.goals?.away);
  if (home === null || away === null) return null;
  return favorite === "home" ? home - away : away - home;
};

const chooseFavorite = (fixture: ProviderFixture, prediction: Prediction[] | null, homePosition: number | null, awayPosition: number | null, homeRecent: RecentMetrics | null, awayRecent: RecentMetrics | null) => {
  const winner = prediction?.[0]?.predictions?.winner?.id;
  if (winner === fixture.teams.home.id) return "home" as const;
  if (winner === fixture.teams.away.id) return "away" as const;
  if (homePosition && awayPosition && homePosition !== awayPosition) return homePosition < awayPosition ? "home" as const : "away" as const;
  const homeRate = homeRecent?.total ? homeRecent.wins / homeRecent.total : 0.5;
  const awayRate = awayRecent?.total ? awayRecent.wins / awayRecent.total : 0.5;
  return homeRate >= awayRate ? "home" as const : "away" as const;
};

const buildInsight = (fixture: ProviderFixture, positions: Map<number, number>, prediction: Prediction[] | null, oddsPayload: OddsResponse[] | null, homeRecent: RecentMetrics | null, awayRecent: RecentMetrics | null, injuries: Injury[] | null, lineups: Lineup[] | null): Insight => {
  const homePosition = positions.get(fixture.teams.home.id) || null;
  const awayPosition = positions.get(fixture.teams.away.id) || null;
  const favorite = chooseFavorite(fixture, prediction, homePosition, awayPosition, homeRecent, awayRecent);
  const favoriteTeam = favorite === "home" ? fixture.teams.home : fixture.teams.away;
  const opponentTeam = favorite === "home" ? fixture.teams.away : fixture.teams.home;
  const favoriteRecent = favorite === "home" ? homeRecent : awayRecent;
  const favoritePosition = favorite === "home" ? homePosition : awayPosition;
  const opponentPosition = favorite === "home" ? awayPosition : homePosition;
  const favoriteInjuries = (injuries || []).filter((injury) => injury.team?.id === favoriteTeam.id).length;
  const opponentInjuries = (injuries || []).filter((injury) => injury.team?.id === opponentTeam.id).length;
  const confirmedLineup = (lineups || []).some((lineup) => lineup.team?.id === favoriteTeam.id && (lineup.startXI?.length || 0) >= 11);
  const lineupStatus = confirmedLineup ? "confirmada" : lineups ? "pendente" : "indisponível";
  const predictionProbability = apiPercent(prediction, favorite);
  const { odds, bookmaker } = findOdds(oddsPayload, favorite);
  const formRate = favoriteRecent?.total ? favoriteRecent.wins / favoriteRecent.total : null;
  const venueRate = favoriteRecent?.venueTotal ? favoriteRecent.venueWins / favoriteRecent.venueTotal : null;
  const tableGap = favoritePosition && opponentPosition ? opponentPosition - favoritePosition : null;
  const tableScore = tableGap === null ? null : clamp(0.5 + tableGap / 30);
  const marketProbability = odds ? 1 / odds : null;
  const injuryScore = injuries ? clamp(0.58 + (opponentInjuries - favoriteInjuries) * 0.05) : null;
  const lineupScore = lineupStatus === "confirmada" ? 0.8 : lineupStatus === "pendente" ? 0.56 : null;
  const observedGoalDifference = favoriteRecent?.total ? (favoriteRecent.goalsFor - favoriteRecent.goalsAgainst) / favoriteRecent.total : null;
  const xgProxy = predictedGoalDifference(prediction, favorite) ?? observedGoalDifference;
  const xgScore = xgProxy === null ? null : clamp(0.5 + xgProxy / 3);
  const inputs: Array<[number | null, number]> = [
    [predictionProbability === null ? null : predictionProbability / 100, 0.24], [formRate, 0.18], [venueRate, 0.11],
    [tableScore, 0.16], [marketProbability, 0.08], [injuryScore, 0.07], [lineupScore, 0.07], [xgScore, 0.09],
  ];
  const availableWeight = inputs.reduce((total, [value, weight]) => total + (value === null ? 0 : weight), 0);
  const dataScore = inputs.reduce((total, [value, weight]) => total + (value === null ? 0 : value * weight), 0);
  const normalizedScore = availableWeight ? dataScore / availableWeight : 0.5;
  const probability = Math.round(clamp(normalizedScore * 0.78 + (marketProbability ?? normalizedScore) * 0.22, 0.38, 0.92) * 100);
  const confidence = Math.round(availableWeight * 100) / 100;
  const oddsInRange = odds !== null && odds >= 1.3 && odds <= 2.9;
  return {
    fixtureId: fixture.fixture.id,
    kickoff: fixture.fixture.date,
    favorite,
    recommendedMarket: favorite === "home" ? "Vitória mandante" : "Vitória visitante",
    bookmaker,
    odds,
    impliedProbability: marketProbability ? Math.round(marketProbability * 100) : null,
    probability,
    dataConfidence: confidence,
    score: Math.round(normalizedScore * 100),
    tier: tierFor(probability, confidence),
    eligible: probability >= 75 && oddsInRange && confidence >= 0.65,
    sourceUpdatedAt: utcNow(),
    metrics: {
      last10: favoriteRecent,
      venueLast5: venueMetrics(favoriteRecent),
      tableGap,
      opponentStrength: strengthLabel(opponentPosition),
      xg: { value: xgProxy === null ? null : Math.round(xgProxy * 100) / 100, mode: xgProxy === null ? "indisponível" : "proxy", label: xgProxy === null ? "Sem xG ou proxy disponível" : "Proxy de criação recente" },
      lineup: { status: lineupStatus, unavailableCount: injuries ? favoriteInjuries : null },
    },
    reasons: [
      formRate !== null ? `Forma recente: ${favoriteRecent?.wins} vitórias nos últimos ${favoriteRecent?.total}.` : null,
      venueRate !== null ? `Recorte de mando: ${favoriteRecent?.venueWins} vitórias em ${favoriteRecent?.venueTotal}.` : null,
      tableGap !== null ? `Diferença de tabela: ${tableGap >= 0 ? "+" : ""}${tableGap} posições.` : null,
      odds ? `Odd observada: ${odds.toFixed(2)}.` : null,
      predictionProbability !== null ? `Previsão externa usada como um dos sinais: ${predictionProbability}%.` : null,
    ].filter((value): value is string => Boolean(value)),
    caveats: [
      xgProxy === null ? "xG indisponível; o modelo não inventa esse indicador." : "Indicador de criação em modo proxy; não equivale a xG oficial.",
      lineupStatus !== "confirmada" ? "Escalação ainda não confirmada." : null,
      oddsInRange ? null : "Odd fora da faixa operacional de 1,30–2,90 ou indisponível.",
    ].filter((value): value is string => Boolean(value)),
  };
};

const persistInsight = async (fixture: ProviderFixture, insight: Insight) => {
  const home = await upsert<{ id: string }>("teams", "provider_team_id", { provider_team_id: fixture.teams.home.id, name: fixture.teams.home.name, logo_url: fixture.teams.home.logo || null });
  const away = await upsert<{ id: string }>("teams", "provider_team_id", { provider_team_id: fixture.teams.away.id, name: fixture.teams.away.name, logo_url: fixture.teams.away.logo || null });
  const competition = await upsert<{ id: string }>("competitions", "provider_league_id,season", {
    provider_league_id: fixture.league.id, season: fixture.league.season, name: fixture.league.name,
    country: fixture.league.country || null, logo_url: fixture.league.logo || null,
  });
  const savedFixture = await upsert<{ id: string }>("fixtures", "provider_fixture_id", {
    provider_fixture_id: fixture.fixture.id, competition_id: competition.id, home_team_id: home.id, away_team_id: away.id,
    kickoff_at: fixture.fixture.date, status_short: fixture.fixture.status.short, status_long: fixture.fixture.status.long,
    venue_name: fixture.fixture.venue?.name || null,
  });
  await upsert<{ id: string }>("fixture_analyses", "fixture_id", {
    fixture_id: savedFixture.id, model_version: "v1.0", probability: insight.probability, confidence: insight.dataConfidence,
    model_score: insight.score, tier: insight.tier, eligible: insight.eligible, favorite_side: insight.favorite,
    recommended_market: insight.recommendedMarket, bookmaker: insight.bookmaker, odds: insight.odds,
    implied_probability: insight.impliedProbability, metrics: insight.metrics, reasons: insight.reasons, caveats: insight.caveats,
    analyzed_at: insight.sourceUpdatedAt,
  });
};

const runDailyAnalysis = async (apiKey: string) => {
  const run = await databaseRequest<{ id: string }[]>("ingestion_runs", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ provider: PROVIDER, run_type: "daily_analysis", started_at: utcNow(), status: "running" }),
  });
  const runId = run[0]?.id;
  if (!runId) throw new Error("Could not start the ingestion audit record.");
  const client = new ApiFootballClient();
  try {
    const fixtures = await client.get<ProviderFixture[]>("fixtures", { date: usageDate(), timezone: "America/Sao_Paulo" }, 20, apiKey);
    const scheduled = fixtures.filter((fixture) => ["NS", "TBD"].includes(fixture.fixture.status.short) && new Date(fixture.fixture.date).getTime() >= Date.now() - 15 * 60_000)
      .sort((left, right) => fixturePriority(right) - fixturePriority(left) || new Date(left.fixture.date).getTime() - new Date(right.fixture.date).getTime())
      .slice(0, MAX_DETAILED_CANDIDATES);
    const insights: Insight[] = [];
    for (const fixture of scheduled) {
      const standings = await client.optional<StandingsResponse[]>("standings", { league: fixture.league.id, season: fixture.league.season }, 60, apiKey);
      const prediction = await client.optional<Prediction[]>("predictions", { fixture: fixture.fixture.id }, 60, apiKey);
      const odds = await client.optional<OddsResponse[]>("odds", { fixture: fixture.fixture.id }, 180, apiKey);
      const homeFixtures = await client.optional<ProviderFixture[]>("fixtures", { team: fixture.teams.home.id, last: 20 }, 360, apiKey);
      const awayFixtures = await client.optional<ProviderFixture[]>("fixtures", { team: fixture.teams.away.id, last: 20 }, 360, apiKey);
      const injuries = await client.optional<Injury[]>("injuries", { fixture: fixture.fixture.id }, 240, apiKey);
      const lineups = isKickoffNear(fixture.fixture.date) ? await client.optional<Lineup[]>("fixtures/lineups", { fixture: fixture.fixture.id }, 15, apiKey) : null;
      const insight = buildInsight(fixture, tablePositions(standings), prediction, odds, recentMetrics(homeFixtures, fixture.teams.home.id, true), recentMetrics(awayFixtures, fixture.teams.away.id, false), injuries, lineups);
      await persistInsight(fixture, insight);
      insights.push(insight);
    }
    await databaseRequest(`ingestion_runs?id=eq.${runId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "completed", completed_at: utcNow(), records_written: insights.length }),
    });
    return insights;
  } catch (error) {
    await databaseRequest(`ingestion_runs?id=eq.${runId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "failed", completed_at: utcNow(), error_message: error instanceof Error ? error.message : "Unknown error" }),
    });
    throw error;
  }
};

Deno.serve(async (request) => {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  if (!projectUrl() || !firstServerKey()) return Response.json({ error: "Server configuration is incomplete." }, { status: 503 });
  try {
    const received = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    if (!received) return Response.json({ error: "Unauthorized." }, { status: 401 });
    const refreshSecret = await rpc<string | null>("get_cron_refresh_secret");
    if (!refreshSecret || !constantTimeEquals(received, refreshSecret)) return Response.json({ error: "Unauthorized." }, { status: 401 });
    const apiKey = await rpc<string | null>("get_api_football_key");
    if (!apiKey) return Response.json({ error: "API-Football is not configured." }, { status: 503 });
    const candidates = await runDailyAnalysis(apiKey);
    return Response.json({ ok: true, analyzed: candidates.length, generatedAt: utcNow() });
  } catch (error) {
    console.error("APITOLHEIRO refresh failed", error instanceof Error ? error.message : "Unknown error");
    return Response.json({ error: "Analysis run failed." }, { status: 500 });
  }
});
