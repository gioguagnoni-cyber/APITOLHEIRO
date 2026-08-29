// Rechecks only already-suggested fixtures close to kickoff.  This is a
// server-only worker: API-Football and cron credentials never reach GitHub
// Pages or the browser.  Every result is appended to fixture_lineup_reviews
// before the mutable dashboard projection is updated.

type DatabaseFixture = {
  id: string;
  provider_fixture_id: number;
  kickoff_at: string;
  home_team_id: string;
  away_team_id: string;
};

type AnalysisRow = {
  id: string;
  fixture_id: string;
  probability: number;
  confidence: number;
  model_score: number;
  tier: 1 | 2 | 3 | 4;
  eligible: boolean;
  favorite_side: "home" | "away";
  metrics: Record<string, unknown>;
  reasons: string[];
  caveats: string[];
  fixtures: DatabaseFixture | DatabaseFixture[];
};

type TeamRow = { id: string; provider_team_id: number; name: string };
type LineupPlayer = {
  player?: { id?: number; name?: string; pos?: string; number?: number | null } | null;
};
type Lineup = {
  team?: { id?: number; name?: string | null } | null;
  formation?: string | null;
  startXI?: LineupPlayer[] | null;
};
type Injury = {
  team?: { id?: number } | null;
  player?: { id?: number; name?: string | null } | null;
};
type ReviewRow = {
  lineup_fingerprint: string | null;
  official_lineup: Record<string, unknown> | null;
  review_status: string;
  reviewed_at: string;
};

const API_BASE_URL = "https://v3.football.api-sports.io";
const PROVIDER = "api-football";
const FREE_DAILY_LIMIT = 100;
const MAX_FIXTURES_PER_RUN = 4;
const REVIEW_WINDOW_START_MINUTES = 20;
const REVIEW_WINDOW_END_MINUTES = 100;
const REVIEW_COOLDOWN_MINUTES = 20;

const utcNow = () => new Date().toISOString();
const usageDate = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

const cacheKeyFor = (path: string, query: Record<string, string | number>) =>
  [path, ...Object.entries(query).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`)].join("|");

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

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
  return { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", ...extra };
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

class ApiFootballClient {
  private requestsThisRun = 0;
  private unavailable = false;

  async optional<T>(path: string, query: Record<string, string | number>, ttlMinutes: number, apiKey: string): Promise<T | null> {
    const cacheKey = cacheKeyFor(path, query);
    const cacheQuery = new URLSearchParams({
      select: "payload,expires_at",
      provider: `eq.${PROVIDER}`,
      cache_key: `eq.${cacheKey}`,
      limit: "1",
    });
    try {
      const cached = await databaseRequest<Array<{ payload: T; expires_at: string }>>(`provider_cache?${cacheQuery}`);
      if (cached[0] && new Date(cached[0].expires_at).getTime() > Date.now()) return cached[0].payload;
      if (this.unavailable || this.requestsThisRun >= MAX_FIXTURES_PER_RUN * 2) return null;
      const quota = await rpc<Array<{ allowed: boolean }>>("reserve_api_quota", {
        p_provider: PROVIDER,
        p_usage_date: usageDate(),
        p_limit: FREE_DAILY_LIMIT,
        p_count: 1,
      });
      if (!quota[0]?.allowed) {
        this.unavailable = true;
        return null;
      }
      this.requestsThisRun += 1;
      const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
      const response = await fetch(`${API_BASE_URL}/${path}?${params}`, {
        headers: { "x-apisports-key": apiKey },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        if (response.status === 429) this.unavailable = true;
        return null;
      }
      const body = await response.json() as { response?: T; errors?: Record<string, string> | string[] };
      if (body.errors && Object.keys(body.errors).length) return null;
      const payload = body.response as T;
      const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
      await databaseRequest("provider_cache?on_conflict=provider,cache_key", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ provider: PROVIDER, cache_key: cacheKey, payload, fetched_at: utcNow(), expires_at: expiresAt }),
      });
      return payload;
    } catch (error) {
      console.warn("Lineup provider input unavailable", { path, message: error instanceof Error ? error.message : "Unknown" });
      return null;
    }
  }
}

const fixtureOf = (row: AnalysisRow) => Array.isArray(row.fixtures) ? row.fixtures[0] : row.fixtures;

const favoriteStarters = (lineup: Lineup | undefined) => (lineup?.startXI || [])
  .map((entry) => ({
    id: typeof entry.player?.id === "number" ? entry.player.id : null,
    name: entry.player?.name || "Jogador não identificado",
    position: entry.player?.pos || null,
    number: entry.player?.number ?? null,
  }))
  .filter((player) => player.id !== null || player.name !== "Jogador não identificado");

const fingerprintFor = (starters: Array<{ id: number | null; name: string }>, formation: string | null | undefined) =>
  `${formation || "?"}|${starters.map((player) => player.id === null ? `name:${player.name}` : `id:${player.id}`).sort().join(",")}`;

const previousStarters = (review: ReviewRow | null) => {
  const favorite = review?.official_lineup?.favorite as { starters?: unknown } | undefined;
  return Array.isArray(favorite?.starters)
    ? favorite.starters.filter((item): item is { id: number | null; name: string } => Boolean(item) && typeof item === "object" && "name" in item)
    : [];
};

const playerKey = (player: { id: number | null; name: string }) => player.id === null ? `name:${player.name}` : `id:${player.id}`;

const changedPlayers = (before: Array<{ id: number | null; name: string }>, after: Array<{ id: number | null; name: string }>) => {
  const afterKeys = new Set(after.map(playerKey));
  const beforeKeys = new Set(before.map(playerKey));
  return {
    out: before.filter((player) => !afterKeys.has(playerKey(player))),
    in: after.filter((player) => !beforeKeys.has(playerKey(player))),
  };
};

const queryCandidates = async () => {
  const from = new Date(Date.now() + REVIEW_WINDOW_START_MINUTES * 60_000).toISOString();
  const until = new Date(Date.now() + REVIEW_WINDOW_END_MINUTES * 60_000).toISOString();
  const query = new URLSearchParams({
    select: "id,fixture_id,probability,confidence,model_score,tier,eligible,favorite_side,metrics,reasons,caveats,fixtures!inner(id,provider_fixture_id,kickoff_at,home_team_id,away_team_id)",
    eligible: "eq.true",
    "fixtures.kickoff_at": `gte.${from}`,
    "fixtures.kickoff_at": `lte.${until}`,
    limit: String(MAX_FIXTURES_PER_RUN),
  });
  const rows = await databaseRequest<AnalysisRow[]>(`fixture_analyses?${query}`);
  return (rows || []).filter((row) => Boolean(fixtureOf(row))).sort((left, right) =>
    new Date(fixtureOf(left).kickoff_at).getTime() - new Date(fixtureOf(right).kickoff_at).getTime(),
  );
};

const queryTeams = async (fixtures: DatabaseFixture[]) => {
  const ids = [...new Set(fixtures.flatMap((fixture) => [fixture.home_team_id, fixture.away_team_id]))];
  if (!ids.length) return new Map<string, TeamRow>();
  const rows = await databaseRequest<TeamRow[]>(`teams?${new URLSearchParams({ select: "id,provider_team_id,name", id: `in.(${ids.join(",")})` })}`);
  return new Map((rows || []).map((team) => [team.id, team]));
};

const latestReview = async (fixtureId: string) => {
  const query = new URLSearchParams({
    select: "lineup_fingerprint,official_lineup,review_status,reviewed_at",
    fixture_id: `eq.${fixtureId}`,
    order: "reviewed_at.desc",
    limit: "1",
  });
  const rows = await databaseRequest<ReviewRow[]>(`fixture_lineup_reviews?${query}`);
  return rows?.[0] || null;
};

const shouldReview = (review: ReviewRow | null) => {
  if (!review) return true;
  const elapsed = Date.now() - new Date(review.reviewed_at).getTime();
  return Number.isFinite(elapsed) && elapsed >= REVIEW_COOLDOWN_MINUTES * 60_000;
};

const reviewFixture = async (analysis: AnalysisRow, teams: Map<string, TeamRow>, client: ApiFootballClient, apiKey: string) => {
  const fixture = fixtureOf(analysis);
  if (!fixture) return "skipped";
  const previous = await latestReview(analysis.fixture_id);
  if (!shouldReview(previous)) return "cooldown";

  const favoriteId = analysis.favorite_side === "home" ? fixture.home_team_id : fixture.away_team_id;
  const opponentId = analysis.favorite_side === "home" ? fixture.away_team_id : fixture.home_team_id;
  const favoriteTeam = teams.get(favoriteId);
  const opponentTeam = teams.get(opponentId);
  if (!favoriteTeam || !opponentTeam) throw new Error("Fixture team reference is missing.");

  const lineups = await client.optional<Lineup[]>("fixtures/lineups", { fixture: fixture.provider_fixture_id }, 4, apiKey);
  const favoriteLineup = (lineups || []).find((lineup) => lineup.team?.id === favoriteTeam.provider_team_id);
  const opponentLineup = (lineups || []).find((lineup) => lineup.team?.id === opponentTeam.provider_team_id);
  const starters = favoriteStarters(favoriteLineup);
  const opponentStarters = favoriteStarters(opponentLineup);
  const sourceFetchedAt = utcNow();

  if (starters.length < 11) {
    await databaseRequest("fixture_lineup_reviews", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        fixture_id: analysis.fixture_id,
        review_status: lineups === null ? "unavailable" : "awaiting_lineup",
        official_lineup: { favorite: { team: favoriteTeam.name, starters }, opponent: { team: opponentTeam.name, starters: opponentStarters } },
        probability_before: analysis.probability,
        probability_after: analysis.probability,
        probability_delta: 0,
        analysis_before: { tier: analysis.tier, eligible: analysis.eligible },
        analysis_after: { tier: analysis.tier, eligible: analysis.eligible },
        source_fetched_at: sourceFetchedAt,
        note: lineups === null ? "API-Football não respondeu a reconsulta; a sugestão não foi promovida por este worker." : "Escalação oficial do time sugerido ainda não contém 11 titulares.",
      }),
    });
    return lineups === null ? "unavailable" : "awaiting";
  }

  // Injury data is reconsulted only after an official XI exists.  This saves
  // free-plan calls while still detecting newly listed absences versus the
  // original scan.  A null response never becomes a fabricated absence.
  const injuries = await client.optional<Injury[]>("injuries", { fixture: fixture.provider_fixture_id }, 4, apiKey);
  const favoriteInjuries = injuries === null ? null : injuries.filter((injury) => injury.team?.id === favoriteTeam.provider_team_id).length;
  const originalLineup = (analysis.metrics.lineup || {}) as { unavailableCount?: unknown; lineupReview?: { status?: unknown } };
  const originalUnavailable = typeof originalLineup.unavailableCount === "number" ? originalLineup.unavailableCount : null;
  const newlyListedAbsences = favoriteInjuries === null || originalUnavailable === null
    ? 0
    : Math.max(0, favoriteInjuries - originalUnavailable);
  const fingerprint = fingerprintFor(starters, favoriteLineup?.formation);
  const previousPlayers = previousStarters(previous);
  const changes = previous?.lineup_fingerprint && previous.lineup_fingerprint !== fingerprint
    ? changedPlayers(previousPlayers, starters)
    : { out: [], in: [] };
  const changedStarterCount = Math.max(changes.out.length, changes.in.length);
  const riskPoints = Math.min(20, changedStarterCount * 5 + newlyListedAbsences * 4);
  const probabilityBefore = Number(analysis.probability);
  const probabilityAfter = Math.round(clamp(probabilityBefore - riskPoints, 0, 100) * 100) / 100;
  const currentReviewStatus = typeof originalLineup.lineupReview?.status === "string" ? originalLineup.lineupReview.status : "";
  const suspended = riskPoints >= 10 || probabilityAfter < 75;
  const reviewStatus = riskPoints > 0
    ? (suspended ? "suspended" : "downgraded")
    : (["downgraded", "suspended"].includes(currentReviewStatus) ? currentReviewStatus : (previous?.lineup_fingerprint ? "unchanged" : "confirmed"));
  const nextTier = reviewStatus === "suspended" ? 4 : reviewStatus === "downgraded" ? Math.min(4, analysis.tier + 1) : analysis.tier;
  const nextEligible = reviewStatus !== "downgraded" && reviewStatus !== "suspended" && analysis.eligible;
  const officialLineup = {
    favorite: { teamId: favoriteTeam.provider_team_id, team: favoriteTeam.name, formation: favoriteLineup?.formation || null, starters },
    opponent: { teamId: opponentTeam.provider_team_id, team: opponentTeam.name, formation: opponentLineup?.formation || null, starters: opponentStarters },
  };
  const lineupReview = {
    status: reviewStatus,
    checkedAt: sourceFetchedAt,
    source: "API-Football /fixtures/lineups",
    favoriteFormation: favoriteLineup?.formation || null,
    startersConfirmed: starters.length,
    opponentStartersConfirmed: opponentStarters.length,
    lineupFingerprint: fingerprint,
    previousFingerprint: previous?.lineup_fingerprint || null,
    changes,
    newlyListedAbsences: favoriteInjuries === null ? null : newlyListedAbsences,
    probabilityBefore,
    probabilityAfter,
    probabilityDelta: probabilityAfter - probabilityBefore,
    decision: reviewStatus === "suspended" ? "sugestão suspensa" : reviewStatus === "downgraded" ? "sugestão rebaixada" : "sem rebaixamento",
  };
  const metrics = {
    ...analysis.metrics,
    lineup: {
      ...originalLineup,
      status: "confirmada",
      unavailableCount: favoriteInjuries === null ? originalUnavailable : favoriteInjuries,
      officialLineup,
      lineupReview,
    },
    sources: {
      ...((analysis.metrics.sources || {}) as Record<string, unknown>),
      lineup: { provider: "API-Football", endpoint: "/fixtures/lineups", updatedAt: sourceFetchedAt },
    },
  };
  const explanatoryNote = riskPoints > 0
    ? `Reconsulta da escalação: ${changedStarterCount} alteração(ões) de titular e ${newlyListedAbsences} nova(s) baixa(s) listada(s); ajuste conservador de ${riskPoints} ponto(s) percentuais.`
    : "Escalação oficial reconsultada sem mudança de risco mensurável em relação ao último registro disponível.";
  const reasons = [...(analysis.reasons || []).filter((item) => !item.startsWith("Reconsulta da escalação:")), reviewStatus === "confirmed" || reviewStatus === "unchanged" ? "Escalação oficial confirmada pela API-Football antes do jogo." : null].filter((item): item is string => Boolean(item));
  const caveats = [...(analysis.caveats || []).filter((item) => !item.startsWith("Reconsulta da escalação:")), riskPoints > 0 ? explanatoryNote : null].filter((item): item is string => Boolean(item));

  await databaseRequest("fixture_lineup_reviews", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      fixture_id: analysis.fixture_id,
      review_status: reviewStatus,
      official_lineup: officialLineup,
      lineup_fingerprint: fingerprint,
      previous_fingerprint: previous?.lineup_fingerprint || null,
      changes,
      probability_before: probabilityBefore,
      probability_after: probabilityAfter,
      probability_delta: probabilityAfter - probabilityBefore,
      analysis_before: { tier: analysis.tier, eligible: analysis.eligible },
      analysis_after: { tier: nextTier, eligible: nextEligible },
      source_fetched_at: sourceFetchedAt,
      note: explanatoryNote,
    }),
  });
  await databaseRequest(`fixture_analyses?id=eq.${analysis.id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      model_version: "v2.4-lineup-revalidation",
      probability: probabilityAfter,
      tier: nextTier,
      eligible: nextEligible,
      metrics,
      reasons,
      caveats,
      analyzed_at: sourceFetchedAt,
    }),
  });
  return reviewStatus;
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
    const candidates = await queryCandidates();
    const teams = await queryTeams(candidates.map(fixtureOf).filter((fixture): fixture is DatabaseFixture => Boolean(fixture)));
    const client = new ApiFootballClient();
    const results: Record<string, number> = {};
    for (const candidate of candidates) {
      const outcome = await reviewFixture(candidate, teams, client, apiKey);
      results[outcome] = (results[outcome] || 0) + 1;
    }
    return Response.json({ ok: true, checked: candidates.length, results, generatedAt: utcNow() });
  } catch (error) {
    console.error("APITOLHEIRO lineup review failed", error instanceof Error ? error.message : "Unknown error");
    return Response.json({ error: "Lineup review failed." }, { status: 500 });
  }
});
