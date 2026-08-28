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
  score?: { fulltime?: { home?: number | null; away?: number | null } | null } | null;
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
  fixture?: { id?: number | null } | null;
  bookmakers?: { name?: string; bets?: { name?: string; values?: { value?: string; odd?: string }[] }[] }[];
};
type Injury = { team?: { id?: number } };
type Lineup = { team?: { id?: number }; startXI?: unknown[] };
type StatsBombProfile = {
  team_key: string;
  team_name: string;
  matches_played: number;
  xg_for_per_match: number;
  xg_against_per_match: number;
  shots_for_per_match: number;
  shots_against_per_match: number;
  source_updated_at: string;
};
type StatsBombPrior = {
  score: number | null;
  metrics: Record<string, unknown>;
};
type FootballDataStanding = {
  position?: number;
  team?: { id?: number; name?: string | null } | null;
};
type FootballDataStandingsResponse = {
  standings?: Array<{ type?: string | null; table?: FootballDataStanding[] | null }> | null;
};
type FootballDataMatch = {
  utcDate?: string | null;
  status?: string | null;
  homeTeam?: { id?: number; name?: string | null } | null;
  awayTeam?: { id?: number; name?: string | null } | null;
  score?: { fullTime?: { home?: number | null; away?: number | null } | null } | null;
};
type FootballDataContext = {
  status: "confirmado" | "parcial" | "sem cobertura" | "não configurada" | "indisponível";
  label: string;
  competitionCode: string | null;
  homePosition: number | null;
  awayPosition: number | null;
  homeRecent: RecentMetrics | null;
  awayRecent: RecentMetrics | null;
  score: number | null;
  updatedAt: string | null;
};

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
type AiWorkerCredential = {
  provider: "openai" | "deepseek" | "google";
  api_key: string;
  model: string;
  enabled: boolean;
  max_reviews_per_run: number;
};
type AiReview = { summary: string; riskFlags: string[]; scoreDelta: number };

const API_BASE_URL = "https://v3.football.api-sports.io";
const DAILY_LIMIT = 90;
// The free API-Football plan has 100 daily calls. A scan intentionally leaves
// a safety margin for the result checker and provider retries; cached reads do
// not consume this budget. Every fixture still receives a transparent baseline
// Tier even if an optional prediction is unavailable near the cap.
const MAX_REQUESTS_PER_RUN = 82;
const PRIORITY_LEAGUES = new Set([2, 3, 39, 61, 71, 72, 73, 78, 88, 94, 128, 135, 140, 253]);
const PROVIDER = "api-football";
const FOOTBALL_DATA_PROVIDER = "football-data";
const FOOTBALL_DATA_BASE_URL = "https://api.football-data.org/v4";
const FOOTBALL_DATA_DAILY_LIMIT = 100;
const FOOTBALL_DATA_MAX_REQUESTS_PER_RUN = 30;
const FOOTBALL_DATA_COMPETITION_CODES: Record<number, string> = {
  2: "CL", 3: "EL", 39: "PL", 61: "FL1", 71: "BSA", 78: "BL1", 88: "DED",
  94: "PPL", 135: "SA", 140: "PD", 253: "MLS",
};

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const safeNumber = (value: string | number | null | undefined) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value || "");
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizedTeamKey = (name: string) => name
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .toLocaleLowerCase("en-US")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .replace(/\s+/g, "_");

const utcNow = () => new Date().toISOString();
const usageDate = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const brtDate = (offsetDays = 0) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(Date.now() + offsetDays * 86_400_000));

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
  const body = await response.text();
  return body ? JSON.parse(body) as T : null as T;
};

const rpc = <T>(name: string, args: Record<string, unknown> = {}) =>
  databaseRequest<T>(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });

const getStatsBombProfiles = async (teamNames: string[]) => {
  const keys = [...new Set(teamNames.map(normalizedTeamKey).filter(Boolean))];
  if (!keys.length) return new Map<string, StatsBombProfile>();
  const query = new URLSearchParams({
    select: "team_key,team_name,matches_played,xg_for_per_match,xg_against_per_match,shots_for_per_match,shots_against_per_match,source_updated_at",
    team_key: `in.(${keys.join(",")})`,
  });
  const rows = await databaseRequest<StatsBombProfile[]>(`statsbomb_team_profiles?${query}`);
  return new Map((rows || []).map((profile) => [profile.team_key, profile]));
};

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

class FootballDataClient {
  private requestsThisRun = 0;
  private providerUnavailable = false;

  async optional<T>(path: string, ttlMinutes: number, apiKey: string | null): Promise<T | null> {
    if (!apiKey || this.providerUnavailable) return null;
    const cacheKey = cacheKeyFor(path, {});
    const cacheQuery = new URLSearchParams({
      select: "payload,expires_at",
      provider: `eq.${FOOTBALL_DATA_PROVIDER}`,
      cache_key: `eq.${cacheKey}`,
      limit: "1",
    });
    try {
      const cached = await databaseRequest<{ payload: T; expires_at: string }[]>(`provider_cache?${cacheQuery}`);
      if (cached[0] && new Date(cached[0].expires_at).getTime() > Date.now()) return cached[0].payload;
      if (this.requestsThisRun >= FOOTBALL_DATA_MAX_REQUESTS_PER_RUN) return null;
      const reservation = await rpc<{ allowed: boolean }[]>("reserve_api_quota", {
        p_provider: FOOTBALL_DATA_PROVIDER,
        p_usage_date: usageDate(),
        p_limit: FOOTBALL_DATA_DAILY_LIMIT,
        p_count: 1,
      });
      if (!reservation[0]?.allowed) return null;
      this.requestsThisRun += 1;
      const response = await fetch(`${FOOTBALL_DATA_BASE_URL}/${path}`, {
        headers: { "X-Auth-Token": apiKey },
        signal: AbortSignal.timeout(12_000),
      });
      if ([401, 403, 404, 429].includes(response.status)) {
        this.providerUnavailable = true;
        return null;
      }
      if (!response.ok) throw new Error(`football-data.org returned HTTP ${response.status}.`);
      const payload = await response.json() as T;
      const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
      await databaseRequest("provider_cache?on_conflict=provider,cache_key", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ provider: FOOTBALL_DATA_PROVIDER, cache_key: cacheKey, payload, fetched_at: utcNow(), expires_at: expiresAt }),
      });
      return payload;
    } catch (error) {
      console.warn("Optional football-data.org input unavailable", { path, message: error instanceof Error ? error.message : "Unknown" });
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
  const complete = fixtures
    .filter((fixture) => ["FT", "AET", "PEN"].includes(fixture.fixture.status.short))
    .sort((left, right) => new Date(right.fixture.date).getTime() - new Date(left.fixture.date).getTime());
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

const comparableTeamName = (name: string) => normalizedTeamKey(name)
  .split("_")
  .filter((token) => !["fc", "cf", "sc", "ac", "afc", "the", "club", "de", "do", "da", "esporte"].includes(token))
  .join("_");

const sameTeam = (left: string | null | undefined, right: string) => {
  const a = comparableTeamName(left || "");
  const b = comparableTeamName(right);
  return Boolean(a && b && (a === b || a.startsWith(`${b}_`) || b.startsWith(`${a}_`)));
};

const footballDataTable = (payload: FootballDataStandingsResponse | null) =>
  payload?.standings?.find((standing) => standing.type === "TOTAL")?.table
  || payload?.standings?.[0]?.table
  || [];

const footballDataPosition = (table: FootballDataStanding[], teamName: string) =>
  table.find((standing) => sameTeam(standing.team?.name, teamName))?.position || null;

const footballDataRecent = (matches: FootballDataMatch[] | null, teamName: string, upcomingIsHome: boolean): RecentMetrics | null => {
  if (!matches?.length) return null;
  const complete = matches
    .filter((match) => match.status === "FINISHED")
    .sort((left, right) => new Date(right.utcDate || 0).getTime() - new Date(left.utcDate || 0).getTime());
  const toResult = (match: FootballDataMatch) => {
    const isHome = sameTeam(match.homeTeam?.name, teamName);
    const goalsFor = isHome ? match.score?.fullTime?.home : match.score?.fullTime?.away;
    const goalsAgainst = isHome ? match.score?.fullTime?.away : match.score?.fullTime?.home;
    const safeFor = typeof goalsFor === "number" ? goalsFor : 0;
    const safeAgainst = typeof goalsAgainst === "number" ? goalsAgainst : 0;
    return { isHome, goalsFor: safeFor, goalsAgainst: safeAgainst, decided: safeFor > safeAgainst ? "win" : safeFor < safeAgainst ? "loss" : "draw" };
  };
  const teamMatches = complete.filter((match) => sameTeam(match.homeTeam?.name, teamName) || sameTeam(match.awayTeam?.name, teamName));
  const all = teamMatches.slice(0, 10).map(toResult);
  const venue = teamMatches.filter((match) => toResult(match).isHome === upcomingIsHome).slice(0, 5).map(toResult);
  const summary = (items: ReturnType<typeof toResult>[]) => ({
    wins: items.filter((item) => item.decided === "win").length,
    draws: items.filter((item) => item.decided === "draw").length,
    losses: items.filter((item) => item.decided === "loss").length,
    goalsFor: items.reduce((total, item) => total + item.goalsFor, 0),
    goalsAgainst: items.reduce((total, item) => total + item.goalsAgainst, 0),
  });
  const aggregate = summary(all);
  const venueAggregate = summary(venue);
  return all.length ? {
    total: all.length, ...aggregate, venueTotal: venue.length, venueWins: venueAggregate.wins, unavailable: false,
  } : null;
};

const footballDataContext = async (client: FootballDataClient, apiKey: string | null, fixture: ProviderFixture): Promise<FootballDataContext> => {
  const competitionCode = FOOTBALL_DATA_COMPETITION_CODES[fixture.league.id] || null;
  if (!apiKey) return {
    status: "não configurada", label: "Chave server-side ainda não registrada no Vault", competitionCode,
    homePosition: null, awayPosition: null, homeRecent: null, awayRecent: null, score: null, updatedAt: null,
  };
  if (!competitionCode) return {
    status: "sem cobertura", label: "Competição sem mapeamento seguro na fonte oficial", competitionCode: null,
    homePosition: null, awayPosition: null, homeRecent: null, awayRecent: null, score: null, updatedAt: null,
  };
  const standings = await client.optional<FootballDataStandingsResponse>(`competitions/${competitionCode}/standings`, 90, apiKey);
  if (!standings) return {
    status: "indisponível", label: "Cobertura não disponível no plano ou na janela de consulta", competitionCode,
    homePosition: null, awayPosition: null, homeRecent: null, awayRecent: null, score: null, updatedAt: null,
  };
  const table = footballDataTable(standings);
  const homePosition = footballDataPosition(table, fixture.teams.home.name);
  const awayPosition = footballDataPosition(table, fixture.teams.away.name);
  const matches = await client.optional<FootballDataMatch[]>(`competitions/${competitionCode}/matches?status=FINISHED&limit=100`, 180, apiKey);
  const homeRecent = footballDataRecent(matches, fixture.teams.home.name, true);
  const awayRecent = footballDataRecent(matches, fixture.teams.away.name, false);
  const hasTable = homePosition !== null && awayPosition !== null;
  const hasForm = homeRecent?.total && awayRecent?.total;
  const score = hasTable && hasForm
    ? clamp(0.62 - Math.abs((homeRecent.wins / homeRecent.total) - (awayRecent.wins / awayRecent.total)) * 0.2)
    : null;
  return {
    status: hasTable && hasForm ? "confirmado" : "parcial",
    label: hasTable ? "Tabela oficial e forma recente por competição" : "Times não puderam ser associados com segurança à tabela oficial",
    competitionCode, homePosition, awayPosition, homeRecent, awayRecent, score, updatedAt: utcNow(),
  };
};

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

const statsBombPrior = (favorite: StatsBombProfile | undefined, opponent: StatsBombProfile | undefined): StatsBombPrior => {
  const favoriteMatches = safeNumber(favorite?.matches_played) || 0;
  const opponentMatches = safeNumber(opponent?.matches_played) || 0;
  if (!favorite) {
    return { score: null, metrics: { status: "sem cobertura", label: "Sem perfil histórico correspondente" } };
  }
  const favoriteXgFor = safeNumber(favorite.xg_for_per_match);
  const favoriteXgAgainst = safeNumber(favorite.xg_against_per_match);
  const opponentXgFor = safeNumber(opponent?.xg_for_per_match);
  const opponentXgAgainst = safeNumber(opponent?.xg_against_per_match);
  const metrics = {
    status: opponent && favoriteMatches >= 3 && opponentMatches >= 3 ? "histórico" : "parcial",
    label: opponent ? "Perfil histórico agregado" : "Somente o favorito possui perfil histórico",
    favoriteMatches,
    opponentMatches,
    xgForPerMatch: favoriteXgFor,
    xgAgainstPerMatch: favoriteXgAgainst,
    shotsForPerMatch: safeNumber(favorite.shots_for_per_match),
    sourceUpdatedAt: favorite.source_updated_at,
  };
  if (favoriteXgFor === null || favoriteXgAgainst === null || opponentXgFor === null || opponentXgAgainst === null || favoriteMatches < 3 || opponentMatches < 3) {
    return { score: null, metrics };
  }
  const expectedFor = (favoriteXgFor + opponentXgAgainst) / 2;
  const expectedAgainst = (favoriteXgAgainst + opponentXgFor) / 2;
  const difference = expectedFor - expectedAgainst;
  return {
    score: clamp(0.5 + difference / 3),
    metrics: { ...metrics, expectedDifferential: Math.round(difference * 100) / 100 },
  };
};

const parseAiJson = (value: string): AiReview | null => {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(trimmed) as { summary?: unknown; riskFlags?: unknown; scoreDelta?: unknown };
    const summary = typeof parsed.summary === "string" ? parsed.summary.replace(/\s+/g, " ").trim().slice(0, 360) : "";
    if (!summary) return null;
    const flags = Array.isArray(parsed.riskFlags) ? parsed.riskFlags.filter((flag): flag is string => typeof flag === "string").map((flag) => flag.replace(/\s+/g, " ").trim().slice(0, 120)).filter(Boolean).slice(0, 4) : [];
    const delta = safeNumber(parsed.scoreDelta as string | number | null | undefined) || 0;
    return { summary, riskFlags: flags, scoreDelta: clamp(delta, -0.02, 0.02) };
  } catch {
    return null;
  }
};

const reviewWithAi = async (credential: AiWorkerCredential, fixture: ProviderFixture, insight: Insight): Promise<AiReview | null> => {
  const evidence = {
    fixture: `${fixture.teams.home.name} x ${fixture.teams.away.name}`,
    league: fixture.league.name,
    kickoff: fixture.fixture.date,
    favorite: insight.favorite,
    probability: insight.probability,
    tier: insight.tier,
    odds: insight.odds,
    metrics: insight.metrics,
    caveats: insight.caveats,
  };
  const instruction = "Você é um revisor de risco de futebol. Use somente os fatos JSON recebidos. Não prometa resultado, não invente dados e não recomende stake. Retorne APENAS JSON válido com {summary:string,riskFlags:string[],scoreDelta:number}. scoreDelta é ajuste conservador entre -0.02 e 0.02; use 0 se a evidência não justificar ajuste.";
  const started = Date.now();
  let response: Response;
  if (credential.provider === "google") {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(credential.model)}:generateContent?key=${encodeURIComponent(credential.api_key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: `${instruction}\n\nDADOS:\n${JSON.stringify(evidence)}` }] }], generationConfig: { temperature: 0.1, responseMimeType: "application/json" } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Google AI returned HTTP ${response.status}.`);
    const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return parseAiJson(payload.candidates?.[0]?.content?.parts?.[0]?.text || "");
  }
  const endpoint = credential.provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : "https://api.openai.com/v1/chat/completions";
  response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential.api_key}` },
    body: JSON.stringify({
      model: credential.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: instruction }, { role: "user", content: JSON.stringify(evidence) }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${credential.provider} returned HTTP ${response.status}.`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  console.log("APITOLHEIRO AI review latency", { provider: credential.provider, elapsedMs: Date.now() - started });
  return parseAiJson(payload.choices?.[0]?.message?.content || "");
};

const applyAiReview = (insight: Insight, review: AiReview): Insight => {
  const probability = Math.round(clamp(insight.probability / 100 + review.scoreDelta, 0.38, 0.92) * 100);
  const score = Math.round(clamp(insight.score / 100 + review.scoreDelta, 0, 1) * 100);
  const oddsInRange = insight.odds !== null && insight.odds >= 1.3 && insight.odds <= 2.9;
  return {
    ...insight,
    probability,
    score,
    tier: tierFor(probability, insight.dataConfidence),
    eligible: probability >= 75 && oddsInRange && insight.dataConfidence >= 0.65,
    metrics: { ...insight.metrics, ai: { providerReview: "concluída", scoreDelta: review.scoreDelta } },
    reasons: [...insight.reasons, `Revisão de IA: ${review.summary}`],
    caveats: [...insight.caveats, ...review.riskFlags.map((flag) => `Revisão de IA: ${flag}`)],
  };
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

const buildInsight = (fixture: ProviderFixture, positions: Map<number, number>, prediction: Prediction[] | null, oddsPayload: OddsResponse[] | null, homeRecent: RecentMetrics | null, awayRecent: RecentMetrics | null, injuries: Injury[] | null, lineups: Lineup[] | null, homeStatsBomb: StatsBombProfile | undefined, awayStatsBomb: StatsBombProfile | undefined, footballData: FootballDataContext): Insight => {
  const apiHomePosition = positions.get(fixture.teams.home.id) || null;
  const apiAwayPosition = positions.get(fixture.teams.away.id) || null;
  const homePosition = footballData.homePosition ?? apiHomePosition;
  const awayPosition = footballData.awayPosition ?? apiAwayPosition;
  const resolvedHomeRecent = homeRecent ?? footballData.homeRecent;
  const resolvedAwayRecent = awayRecent ?? footballData.awayRecent;
  const favorite = chooseFavorite(fixture, prediction, homePosition, awayPosition, resolvedHomeRecent, resolvedAwayRecent);
  const favoriteTeam = favorite === "home" ? fixture.teams.home : fixture.teams.away;
  const opponentTeam = favorite === "home" ? fixture.teams.away : fixture.teams.home;
  const favoriteRecent = favorite === "home" ? resolvedHomeRecent : resolvedAwayRecent;
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
  const historicalPrior = statsBombPrior(favorite === "home" ? homeStatsBomb : awayStatsBomb, favorite === "home" ? awayStatsBomb : homeStatsBomb);
  const inputs: Array<[number | null, number]> = [
    [predictionProbability === null ? null : predictionProbability / 100, 0.22], [formRate, 0.18], [venueRate, 0.11],
    [tableScore, 0.16], [marketProbability, 0.08], [injuryScore, 0.07], [lineupScore, 0.07], [xgScore, 0.06], [historicalPrior.score, 0.03],
    [footballData.score, 0.02],
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
      statsbomb: historicalPrior.metrics,
      footballData: {
        status: footballData.status,
        label: footballData.label,
        competitionCode: footballData.competitionCode,
        tableSource: footballData.homePosition !== null && footballData.awayPosition !== null ? "football-data.org" : "API-Football",
        homePosition: footballData.homePosition,
        awayPosition: footballData.awayPosition,
        favoriteRecentMatches: favorite === "home" ? footballData.homeRecent?.total || null : footballData.awayRecent?.total || null,
        verificationScore: footballData.score,
        updatedAt: footballData.updatedAt,
      },
    },
    reasons: [
      formRate !== null ? `Forma recente: ${favoriteRecent?.wins} vitórias nos últimos ${favoriteRecent?.total}.` : null,
      venueRate !== null ? `Recorte de mando: ${favoriteRecent?.venueWins} vitórias em ${favoriteRecent?.venueTotal}.` : null,
      tableGap !== null ? `Diferença de tabela: ${tableGap >= 0 ? "+" : ""}${tableGap} posições.` : null,
      odds ? `Odd observada: ${odds.toFixed(2)}.` : null,
      predictionProbability !== null ? `Previsão externa usada como um dos sinais: ${predictionProbability}%.` : null,
      historicalPrior.score !== null ? `Base histórica StatsBomb: ${historicalPrior.metrics.xgForPerMatch} xG por jogo em ${historicalPrior.metrics.favoriteMatches} partidas agregadas.` : null,
      footballData.status === "confirmado" ? `Tabela e forma na competição confirmadas pela football-data.org (${footballData.competitionCode}).` : null,
    ].filter((value): value is string => Boolean(value)),
    caveats: [
      xgProxy === null ? "xG indisponível; o modelo não inventa esse indicador." : "Indicador de criação em modo proxy; não equivale a xG oficial.",
      lineupStatus !== "confirmada" ? "Escalação ainda não confirmada." : null,
      oddsInRange ? null : "Odd fora da faixa operacional de 1,30–2,90 ou indisponível.",
      historicalPrior.score !== null ? "StatsBomb é base histórica seletiva; não é dado ao vivo nem confirmação de escalação." : null,
      ["sem cobertura", "indisponível", "não configurada"].includes(footballData.status) ? `football-data.org: ${footballData.label}.` : null,
    ].filter((value): value is string => Boolean(value)),
  };
};

const persistInsight = async (fixture: ProviderFixture, insight: Insight, targetDate: string, analysisRunId: string) => {
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
  const analysis = await upsert<{ id: string }>("fixture_analyses", "fixture_id", {
    fixture_id: savedFixture.id, model_version: "v1.3", probability: insight.probability, confidence: insight.dataConfidence,
    model_score: insight.score, tier: insight.tier, eligible: insight.eligible, favorite_side: insight.favorite,
    recommended_market: insight.recommendedMarket, bookmaker: insight.bookmaker, odds: insight.odds,
    implied_probability: insight.impliedProbability, metrics: insight.metrics, reasons: insight.reasons, caveats: insight.caveats,
    analyzed_at: insight.sourceUpdatedAt,
  });
  // Resolution ignores a duplicate rather than mutating the pre-match snapshot.
  await databaseRequest("published_analysis_snapshots?on_conflict=fixture_id,target_date,market_code", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      analysis_run_id: analysisRunId,
      fixture_id: savedFixture.id,
      target_date: targetDate,
      market_code: "match_winner_90",
      favorite_side: insight.favorite,
      recommended_market: insight.recommendedMarket,
      model_version: "v1.3",
      probability: insight.probability,
      confidence: insight.dataConfidence,
      tier: insight.tier,
      eligible: insight.eligible,
      odds: insight.odds,
      bookmaker: insight.bookmaker,
      model_snapshot: {
        analysisId: analysis.id,
        score: insight.score,
        impliedProbability: insight.impliedProbability,
        metrics: insight.metrics,
        reasons: insight.reasons,
        caveats: insight.caveats,
      },
      published_at: insight.sourceUpdatedAt,
    }),
  });
  return savedFixture;
};

const runNextDayAnalysis = async (apiKey: string, footballDataApiKey: string | null) => {
  const targetDate = brtDate(1);
  const run = await databaseRequest<{ id: string }[]>("ingestion_runs", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ provider: PROVIDER, run_type: "next_day_analysis", started_at: utcNow(), status: "running" }),
  });
  const runId = run[0]?.id;
  if (!runId) throw new Error("Could not start the ingestion audit record.");
  const publication = await databaseRequest<{ id: string }[]>("analysis_runs", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ target_date: targetDate, run_kind: "next_day_scan", started_at: utcNow(), status: "running" }),
  });
  const publicationId = publication[0]?.id;
  if (!publicationId) throw new Error("Could not start the publication audit record.");
  const client = new ApiFootballClient();
  const officialData = new FootballDataClient();
  let aiCredential: AiWorkerCredential | null = null;
  try {
    const configured = await rpc<AiWorkerCredential[]>("get_ai_provider_credential_for_worker");
    aiCredential = configured?.[0]?.enabled ? configured[0] : null;
  } catch (error) {
    console.warn("Optional AI configuration unavailable", { message: error instanceof Error ? error.message : "Unknown error" });
  }
  let aiReviewAttempts = 0;
  try {
    const fixtures = await client.get<ProviderFixture[]>("fixtures", { date: targetDate, timezone: "America/Sao_Paulo" }, 45, apiKey);
    const scheduled = fixtures
      .filter((fixture) => ["NS", "TBD"].includes(fixture.fixture.status.short) && PRIORITY_LEAGUES.has(fixture.league.id))
      .sort((left, right) => new Date(left.fixture.date).getTime() - new Date(right.fixture.date).getTime());
    await databaseRequest(`analysis_runs?id=eq.${publicationId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ fixtures_detected: scheduled.length }),
    });

    const leagueContexts = new Map<string, { positions: Map<number, number>; seasonFixtures: ProviderFixture[] | null }>();
    const representativeFixtures = new Map<string, ProviderFixture>();
    scheduled.forEach((fixture) => representativeFixtures.set(`${fixture.league.id}:${fixture.league.season}`, fixture));
    for (const [key, fixture] of representativeFixtures) {
      const standings = await client.optional<StandingsResponse[]>("standings", { league: fixture.league.id, season: fixture.league.season }, 180, apiKey);
      // A cached season payload provides form and home/away records for every
      // team in a league, avoiding two provider calls for every individual game.
      const seasonFixtures = await client.optional<ProviderFixture[]>("fixtures", { league: fixture.league.id, season: fixture.league.season }, 360, apiKey);
      leagueContexts.set(key, { positions: tablePositions(standings), seasonFixtures });
    }

    const dailyOdds = await client.optional<OddsResponse[]>("odds", { date: targetDate }, 120, apiKey);
    const oddsByFixture = new Map<number, OddsResponse>();
    (dailyOdds || []).forEach((entry) => {
      if (typeof entry.fixture?.id === "number") oddsByFixture.set(entry.fixture.id, entry);
    });

    let statsBombProfiles = new Map<string, StatsBombProfile>();
    try {
      statsBombProfiles = await getStatsBombProfiles(scheduled.flatMap((fixture) => [fixture.teams.home.name, fixture.teams.away.name]));
    } catch (error) {
      console.warn("Optional StatsBomb prior unavailable", { message: error instanceof Error ? error.message : "Unknown error" });
    }

    const insights: Insight[] = [];
    for (const fixture of scheduled) {
      const context = leagueContexts.get(`${fixture.league.id}:${fixture.league.season}`) || { positions: new Map<number, number>(), seasonFixtures: null };
      const prediction = await client.optional<Prediction[]>("predictions", { fixture: fixture.fixture.id }, 60, apiKey);
      const footballData = await footballDataContext(officialData, footballDataApiKey, fixture);
      let insight = buildInsight(
        fixture,
        context.positions,
        prediction,
        oddsByFixture.has(fixture.fixture.id) ? [oddsByFixture.get(fixture.fixture.id)!] : null,
        recentMetrics(context.seasonFixtures, fixture.teams.home.id, true),
        recentMetrics(context.seasonFixtures, fixture.teams.away.id, false),
        null,
        null,
        statsBombProfiles.get(normalizedTeamKey(fixture.teams.home.name)),
        statsBombProfiles.get(normalizedTeamKey(fixture.teams.away.name)),
        footballData,
      );
      let review: AiReview | null = null;
      let reviewLatency: number | null = null;
      if (aiCredential && aiReviewAttempts < aiCredential.max_reviews_per_run) {
        const started = Date.now();
        aiReviewAttempts += 1;
        try {
          review = await reviewWithAi(aiCredential, fixture, insight);
          reviewLatency = Date.now() - started;
          if (review) {
            insight = applyAiReview(insight, review);
          }
        } catch (error) {
          console.warn("Optional AI review unavailable", { provider: aiCredential.provider, message: error instanceof Error ? error.message : "Unknown error" });
        }
      }
      const savedFixture = await persistInsight(fixture, insight, targetDate, publicationId);
      if (review && aiCredential) {
        await databaseRequest("ai_fixture_reviews", {
          method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            fixture_id: savedFixture.id,
            provider: aiCredential.provider,
            model: aiCredential.model,
            status: "completed",
            review: { summary: review.summary, riskFlags: review.riskFlags },
            score_delta: review.scoreDelta,
            latency_ms: reviewLatency,
          }),
        });
      }
      insights.push(insight);
    }
    await databaseRequest(`ingestion_runs?id=eq.${runId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "completed", completed_at: utcNow(), records_written: insights.length }),
    });
    await databaseRequest(`analysis_runs?id=eq.${publicationId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "completed", completed_at: utcNow(), analyses_published: insights.length }),
    });
    return insights;
  } catch (error) {
    await databaseRequest(`ingestion_runs?id=eq.${runId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "failed", completed_at: utcNow(), error_message: error instanceof Error ? error.message : "Unknown error" }),
    });
    await databaseRequest(`analysis_runs?id=eq.${publicationId}`, {
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
    const footballDataApiKey = await rpc<string | null>("get_football_data_key");
    const candidates = await runNextDayAnalysis(apiKey, footballDataApiKey);
    return Response.json({ ok: true, targetDate: brtDate(1), analyzed: candidates.length, generatedAt: utcNow() });
  } catch (error) {
    console.error("APITOLHEIRO refresh failed", error instanceof Error ? error.message : "Unknown error");
    return Response.json({ error: "Analysis run failed." }, { status: 500 });
  }
});
