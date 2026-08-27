import { ApiFootballClient } from "./api-football";
import { getSupabaseAdmin } from "./supabase-server";
import type { FixtureInsight, ProviderFixture, RecentMetrics } from "./types";

type Standing = { team: { id: number }; rank: number; points?: number; goalsDiff?: number };
type StandingsResponse = { league?: { standings?: Standing[][] } };
type Prediction = {
  predictions?: {
    winner?: { id?: number | null };
    percent?: { home?: string | null; draw?: string | null; away?: string | null };
    goals?: { home?: string | number | null; away?: string | number | null };
  };
};
type OddsResponse = {
  bookmakers?: {
    name?: string;
    bets?: { name?: string; values?: { value?: string; odd?: string }[] }[];
  }[];
};
type Injury = { team?: { id?: number } };
type Lineup = { team?: { id?: number }; startXI?: unknown[] };

// The free API-Football tier allows 10 requests per minute. One detailed fixture
// is deliberately processed sequentially, leaving a margin below that ceiling.
const MAX_DETAILED_CANDIDATES = 1;
const PRIORITY_LEAGUES = new Set([2, 3, 39, 61, 71, 72, 73, 78, 88, 94, 128, 135, 140, 253]);

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const safeNumber = (value: string | number | null | undefined) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value || "");
  return Number.isFinite(parsed) ? parsed : null;
};

const fixtureResult = (fixture: ProviderFixture, teamId: number) => {
  const isHome = fixture.teams.home.id === teamId;
  const team = isHome ? fixture.teams.home : fixture.teams.away;
  const other = isHome ? fixture.teams.away : fixture.teams.home;
  const goalsFor = isHome ? fixture.goals?.home : fixture.goals?.away;
  const goalsAgainst = isHome ? fixture.goals?.away : fixture.goals?.home;
  const decided = team.winner === true ? "win" : other.winner === true ? "loss" : "draw";

  return {
    isHome,
    decided,
    goalsFor: typeof goalsFor === "number" ? goalsFor : 0,
    goalsAgainst: typeof goalsAgainst === "number" ? goalsAgainst : 0,
  };
};

const recentMetrics = (
  fixtures: ProviderFixture[] | null,
  teamId: number,
  upcomingIsHome: boolean,
): RecentMetrics | null => {
  if (!fixtures?.length) return null;

  const complete = fixtures.filter((fixture) => ["FT", "AET", "PEN"].includes(fixture.fixture.status.short));
  const all = complete.slice(0, 10).map((fixture) => fixtureResult(fixture, teamId));
  const build = (items: ReturnType<typeof fixtureResult>[]) => ({
    wins: items.filter((item) => item.decided === "win").length,
    draws: items.filter((item) => item.decided === "draw").length,
    losses: items.filter((item) => item.decided === "loss").length,
    goalsFor: items.reduce((total, item) => total + item.goalsFor, 0),
    goalsAgainst: items.reduce((total, item) => total + item.goalsAgainst, 0),
  });

  const venueItems = complete
    .filter((fixture) => fixtureResult(fixture, teamId).isHome === upcomingIsHome)
    .slice(0, 5)
    .map((fixture) => fixtureResult(fixture, teamId));
  const allSummary = build(all);
  const venueSummary = build(venueItems);

  return {
    total: all.length,
    ...allSummary,
    venueTotal: venueItems.length,
    venueWins: venueSummary.wins,
    unavailable: all.length === 0,
  };
};

const venueMetrics = (metrics: RecentMetrics | null): RecentMetrics | null => {
  if (!metrics) return null;
  return {
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
};

const tablePositions = (payload: StandingsResponse[] | null) => {
  const values = payload?.flatMap((item) => item.league?.standings?.flat() || []) || [];
  return new Map(values.map((standing) => [standing.team.id, standing.rank]));
};

const findOdds = (payload: OddsResponse[] | null, favorite: "home" | "away") => {
  const wanted = favorite === "home" ? ["Home", "1"] : ["Away", "2"];
  for (const entry of payload || []) {
    for (const bookmaker of entry.bookmakers || []) {
      const market = bookmaker.bets?.find((bet) => /match winner|winner/i.test(bet.name || ""));
      const value = market?.values?.find((candidate) => wanted.includes(candidate.value || ""));
      const odds = safeNumber(value?.odd);
      if (odds) return { odds, bookmaker: bookmaker.name || null };
    }
  }
  return { odds: null, bookmaker: null };
};

const strengthLabel = (position: number | null) => {
  if (!position) return "indisponível" as const;
  if (position >= 17) return "muito baixa" as const;
  if (position >= 12) return "baixa" as const;
  if (position >= 7) return "média" as const;
  if (position >= 4) return "alta" as const;
  return "muito alta" as const;
};

const isKickoffNear = (kickoff: string) => {
  const minutes = (new Date(kickoff).getTime() - Date.now()) / 60_000;
  return minutes >= -15 && minutes <= 90;
};

const fixturePriority = (fixture: ProviderFixture) => {
  if (PRIORITY_LEAGUES.has(fixture.league.id)) return 100;
  if (["Brazil", "Argentina", "England", "Spain", "Italy", "Germany", "France", "Portugal"].includes(fixture.league.country || "")) return 50;
  return 0;
};

const tierFor = (probability: number, confidence: number): 1 | 2 | 3 | 4 => {
  if (probability >= 75 && confidence >= 0.65) return 1;
  if (probability >= 68) return 2;
  if (probability >= 60) return 3;
  return 4;
};

const apiPercent = (prediction: Prediction[] | null, favorite: "home" | "away") => {
  const percent = prediction?.[0]?.predictions?.percent;
  return safeNumber(favorite === "home" ? percent?.home : percent?.away);
};

const predictedGoalDifference = (prediction: Prediction[] | null, favorite: "home" | "away") => {
  const goals = prediction?.[0]?.predictions?.goals;
  const home = safeNumber(goals?.home);
  const away = safeNumber(goals?.away);
  if (home === null || away === null) return null;
  return favorite === "home" ? home - away : away - home;
};

const chooseFavorite = (
  fixture: ProviderFixture,
  prediction: Prediction[] | null,
  homePosition: number | null,
  awayPosition: number | null,
  homeRecent: RecentMetrics | null,
  awayRecent: RecentMetrics | null,
) => {
  const predictedWinner = prediction?.[0]?.predictions?.winner?.id;
  if (predictedWinner === fixture.teams.home.id) return "home" as const;
  if (predictedWinner === fixture.teams.away.id) return "away" as const;
  if (homePosition && awayPosition && homePosition !== awayPosition) {
    return homePosition < awayPosition ? "home" as const : "away" as const;
  }
  const homeRate = homeRecent?.total ? homeRecent.wins / homeRecent.total : 0.5;
  const awayRate = awayRecent?.total ? awayRecent.wins / awayRecent.total : 0.5;
  return homeRate >= awayRate ? "home" as const : "away" as const;
};

const buildInsight = (
  fixture: ProviderFixture,
  positions: Map<number, number>,
  prediction: Prediction[] | null,
  oddsPayload: OddsResponse[] | null,
  homeRecent: RecentMetrics | null,
  awayRecent: RecentMetrics | null,
  injuries: Injury[] | null,
  lineups: Lineup[] | null,
): FixtureInsight => {
  const homePosition = positions.get(fixture.teams.home.id) || null;
  const awayPosition = positions.get(fixture.teams.away.id) || null;
  const favorite = chooseFavorite(fixture, prediction, homePosition, awayPosition, homeRecent, awayRecent);
  const favoriteTeam = favorite === "home" ? fixture.teams.home : fixture.teams.away;
  const opponentTeam = favorite === "home" ? fixture.teams.away : fixture.teams.home;
  const favoriteRecent = favorite === "home" ? homeRecent : awayRecent;
  const favoritePosition = favorite === "home" ? homePosition : awayPosition;
  const opponentPosition = favorite === "home" ? awayPosition : homePosition;
  const favoriteInjuries = (injuries || []).filter((injury) => injury.team?.id === favoriteTeam.id).length;
  const opposingInjuries = (injuries || []).filter((injury) => injury.team?.id === opponentTeam.id).length;
  const hasConfirmedLineup = (lineups || []).some((lineup) => lineup.team?.id === favoriteTeam.id && (lineup.startXI?.length || 0) >= 11);
  const lineupStatus = hasConfirmedLineup ? "confirmada" : lineups ? "pendente" : "indisponível";
  const predictionProbability = apiPercent(prediction, favorite);
  const { odds, bookmaker } = findOdds(oddsPayload, favorite);
  const formRate = favoriteRecent?.total ? favoriteRecent.wins / favoriteRecent.total : null;
  const venueRate = favoriteRecent?.venueTotal ? favoriteRecent.venueWins / favoriteRecent.venueTotal : null;
  const tableGap = favoritePosition && opponentPosition ? opponentPosition - favoritePosition : null;
  const tableScore = tableGap === null ? null : clamp(0.5 + tableGap / 30);
  const marketProbability = odds ? 1 / odds : null;
  const injuryScore = injuries ? clamp(0.58 + (opposingInjuries - favoriteInjuries) * 0.05) : null;
  const lineupScore = lineupStatus === "confirmada" ? 0.8 : lineupStatus === "pendente" ? 0.56 : null;
  const goalDifference = predictedGoalDifference(prediction, favorite);
  const observedGoalDifference = favoriteRecent?.total
    ? (favoriteRecent.goalsFor - favoriteRecent.goalsAgainst) / favoriteRecent.total
    : null;
  const xgProxy = goalDifference ?? observedGoalDifference;
  const xgScore = xgProxy === null ? null : clamp(0.5 + xgProxy / 3);
  const inputs = [
    [predictionProbability === null ? null : predictionProbability / 100, 0.24],
    [formRate, 0.18],
    [venueRate, 0.11],
    [tableScore, 0.16],
    [marketProbability, 0.08],
    [injuryScore, 0.07],
    [lineupScore, 0.07],
    [xgScore, 0.09],
  ] as const;
  const availableWeight = inputs.reduce((total, [value, weight]) => total + (value === null ? 0 : weight), 0);
  const dataScore = inputs.reduce((total, [value, weight]) => total + (value === null ? 0 : value * weight), 0);
  const normalizedDataScore = availableWeight ? dataScore / availableWeight : 0.5;
  const probability = Math.round(clamp(normalizedDataScore * 0.78 + (marketProbability ?? normalizedDataScore) * 0.22, 0.38, 0.92) * 100);
  const confidence = Math.round(availableWeight * 100) / 100;
  const tier = tierFor(probability, confidence);
  const oddsInRange = odds !== null && odds >= 1.3 && odds <= 2.9;
  const reasons = [
    formRate !== null ? "Forma recente: " + favoriteRecent?.wins + " vitórias nos últimos " + favoriteRecent?.total + "." : null,
    venueRate !== null ? "Recorte de mando: " + favoriteRecent?.venueWins + " vitórias em " + favoriteRecent?.venueTotal + "." : null,
    tableGap !== null ? "Diferença de tabela: " + (tableGap >= 0 ? "+" : "") + tableGap + " posições." : null,
    odds ? "Odd observada: " + odds.toFixed(2) + "." : null,
    predictionProbability !== null ? "Previsão externa usada como um dos sinais: " + predictionProbability + "%." : null,
  ].filter((reason): reason is string => Boolean(reason));
  const caveats = [
    xgProxy === null ? "xG indisponível; o modelo não inventa esse indicador." : "Indicador de criação em modo proxy; não equivale a xG oficial.",
    lineupStatus !== "confirmada" ? "Escalação ainda não confirmada." : null,
    oddsInRange ? null : "Odd fora da faixa operacional de 1,30–2,90 ou indisponível.",
  ].filter((caveat): caveat is string => Boolean(caveat));

  return {
    fixtureId: fixture.fixture.id,
    kickoff: fixture.fixture.date,
    league: fixture.league.name,
    country: fixture.league.country || null,
    home: { id: fixture.teams.home.id, name: fixture.teams.home.name, logo: fixture.teams.home.logo || null, position: homePosition },
    away: { id: fixture.teams.away.id, name: fixture.teams.away.name, logo: fixture.teams.away.logo || null, position: awayPosition },
    favorite,
    favoriteName: favoriteTeam.name,
    recommendedMarket: favorite === "home" ? "Vitória mandante" : "Vitória visitante",
    bookmaker,
    odds,
    impliedProbability: marketProbability ? Math.round(marketProbability * 100) : null,
    probability,
    dataConfidence: confidence,
    score: Math.round(normalizedDataScore * 100),
    tier,
    eligible: probability >= 75 && oddsInRange && confidence >= 0.65,
    sourceUpdatedAt: new Date().toISOString(),
    metrics: {
      last10: favoriteRecent,
      venueLast5: venueMetrics(favoriteRecent),
      tableGap,
      opponentStrength: strengthLabel(opponentPosition),
      xg: {
        value: xgProxy === null ? null : Math.round(xgProxy * 100) / 100,
        mode: xgProxy === null ? "indisponível" : "proxy",
        label: xgProxy === null ? "Sem xG ou proxy disponível" : "Proxy de criação recente",
      },
      lineup: { status: lineupStatus, unavailableCount: injuries ? favoriteInjuries : null },
    },
    reasons,
    caveats,
  };
};

const persistInsight = async (fixture: ProviderFixture, insight: FixtureInsight) => {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  const { data: home } = await supabase
    .from("teams")
    .upsert({ provider_team_id: fixture.teams.home.id, name: fixture.teams.home.name, logo_url: fixture.teams.home.logo || null }, { onConflict: "provider_team_id" })
    .select("id")
    .single<{ id: string }>();
  const { data: away } = await supabase
    .from("teams")
    .upsert({ provider_team_id: fixture.teams.away.id, name: fixture.teams.away.name, logo_url: fixture.teams.away.logo || null }, { onConflict: "provider_team_id" })
    .select("id")
    .single<{ id: string }>();
  const { data: competition } = await supabase
    .from("competitions")
    .upsert(
      {
        provider_league_id: fixture.league.id,
        season: fixture.league.season,
        name: fixture.league.name,
        country: fixture.league.country || null,
        logo_url: fixture.league.logo || null,
      },
      { onConflict: "provider_league_id,season" },
    )
    .select("id")
    .single<{ id: string }>();

  if (!home || !away || !competition) return;

  const { data: savedFixture } = await supabase
    .from("fixtures")
    .upsert(
      {
        provider_fixture_id: fixture.fixture.id,
        competition_id: competition.id,
        home_team_id: home.id,
        away_team_id: away.id,
        kickoff_at: fixture.fixture.date,
        status_short: fixture.fixture.status.short,
        status_long: fixture.fixture.status.long,
        venue_name: fixture.fixture.venue?.name || null,
      },
      { onConflict: "provider_fixture_id" },
    )
    .select("id")
    .single<{ id: string }>();

  if (!savedFixture) return;

  await supabase.from("fixture_analyses").upsert(
    {
      fixture_id: savedFixture.id,
      model_version: "v1.0",
      probability: insight.probability,
      confidence: insight.dataConfidence,
      model_score: insight.score,
      tier: insight.tier,
      eligible: insight.eligible,
      favorite_side: insight.favorite,
      recommended_market: insight.recommendedMarket,
      bookmaker: insight.bookmaker,
      odds: insight.odds,
      implied_probability: insight.impliedProbability,
      metrics: insight.metrics,
      reasons: insight.reasons,
      caveats: insight.caveats,
      analyzed_at: insight.sourceUpdatedAt,
    },
    { onConflict: "fixture_id" },
  );
};

export const runDailyAnalysis = async () => {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");
  const client = new ApiFootballClient();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const { data: run } = await supabase
    .from("ingestion_runs")
    .insert({ provider: "api-football", run_type: "daily_analysis", started_at: new Date().toISOString(), status: "running" })
    .select("id")
    .single<{ id: string }>();

  try {
    const fixtures = await client.get<ProviderFixture[]>("fixtures", { date: today, timezone: "America/Sao_Paulo" }, 20);
    const scheduled = fixtures
      .filter((fixture) =>
        ["NS", "TBD"].includes(fixture.fixture.status.short) &&
        new Date(fixture.fixture.date).getTime() >= Date.now() - 15 * 60_000,
      )
      .sort((left, right) => {
        const priorityDifference = fixturePriority(right) - fixturePriority(left);
        return priorityDifference || new Date(left.fixture.date).getTime() - new Date(right.fixture.date).getTime();
      })
      .slice(0, MAX_DETAILED_CANDIDATES);

    const insights: FixtureInsight[] = [];
    for (const fixture of scheduled) {
      const standings = await client.getOptional<StandingsResponse[]>("standings", {
        league: fixture.league.id,
        season: fixture.league.season,
      }, 60);
      const prediction = await client.getOptional<Prediction[]>("predictions", { fixture: fixture.fixture.id }, 60);
      const oddsPayload = await client.getOptional<OddsResponse[]>("odds", { fixture: fixture.fixture.id }, 180);
      const homeFixtures = await client.getOptional<ProviderFixture[]>("fixtures", { team: fixture.teams.home.id, last: 20 }, 360);
      const awayFixtures = await client.getOptional<ProviderFixture[]>("fixtures", { team: fixture.teams.away.id, last: 20 }, 360);
      const injuries = await client.getOptional<Injury[]>("injuries", { fixture: fixture.fixture.id }, 240);
      const lineups = isKickoffNear(fixture.fixture.date)
        ? await client.getOptional<Lineup[]>("fixtures/lineups", { fixture: fixture.fixture.id }, 15)
        : null;
      const insight = buildInsight(
        fixture,
        tablePositions(standings),
        prediction,
        oddsPayload,
        recentMetrics(homeFixtures, fixture.teams.home.id, true),
        recentMetrics(awayFixtures, fixture.teams.away.id, false),
        injuries,
        lineups,
      );
      insights.push(insight);
      await persistInsight(fixture, insight);
    }

    await supabase
      .from("ingestion_runs")
      .update({ status: "completed", completed_at: new Date().toISOString(), records_written: insights.length })
      .eq("id", run?.id || "");
    return insights;
  } catch (error) {
    await supabase
      .from("ingestion_runs")
      .update({ status: "failed", completed_at: new Date().toISOString(), error_message: error instanceof Error ? error.message : "Unknown error" })
      .eq("id", run?.id || "");
    throw error;
  }
};
