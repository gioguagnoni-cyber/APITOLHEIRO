import { NextResponse } from "next/server";
import { getTodayUsage } from "@/lib/api-football";
import { config, hasServerConfiguration } from "@/lib/config";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import type { DashboardPayload, FixtureInsight } from "@/lib/types";

export const dynamic = "force-dynamic";

type AnalysisRow = {
  fixture_id: string;
  probability: number;
  confidence: number;
  model_score: number;
  tier: 1 | 2 | 3 | 4;
  eligible: boolean;
  favorite_side: "home" | "away";
  recommended_market: string;
  bookmaker: string | null;
  odds: number | null;
  implied_probability: number | null;
  metrics: FixtureInsight["metrics"];
  reasons: string[];
  caveats: string[];
  analyzed_at: string;
};

type FixtureRow = {
  id: string;
  provider_fixture_id: number;
  competition_id: string;
  home_team_id: string;
  away_team_id: string;
  kickoff_at: string;
};

type TeamRow = { id: string; provider_team_id: number; name: string; logo_url: string | null };
type CompetitionRow = { id: string; name: string; country: string | null };

// This is a data-completeness gate, not an investment rule. It prevents a
// partially collected response from appearing as a seemingly decisive insight.
const MINIMUM_PUBLISHABLE_CONFIDENCE = 0.65;

const emptyPayload = (setupRequired: boolean, usedRequests: number): DashboardPayload => ({
  generatedAt: new Date().toISOString(),
  refreshAvailable: Boolean(config.refreshSecret),
  setupRequired,
  usedRequests,
  dailyLimit: config.dailyLimit,
  candidates: [],
});

export async function GET() {
  const usedRequests = await getTodayUsage();
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json(emptyPayload(true, usedRequests), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const { data: analyses, error: analysesError } = await supabase
    .from("fixture_analyses")
    .select("fixture_id, probability, confidence, model_score, tier, eligible, favorite_side, recommended_market, bookmaker, odds, implied_probability, metrics, reasons, caveats, analyzed_at")
    .order("eligible", { ascending: false })
    .order("probability", { ascending: false })
    .limit(32)
    .returns<AnalysisRow[]>();

  if (analysesError || !analyses?.length) {
    return NextResponse.json(emptyPayload(!hasServerConfiguration(), usedRequests), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const fixtureIds = analyses.map((analysis) => analysis.fixture_id);
  const { data: fixtures } = await supabase
    .from("fixtures")
    .select("id, provider_fixture_id, competition_id, home_team_id, away_team_id, kickoff_at")
    .in("id", fixtureIds)
    .returns<FixtureRow[]>();
  const fixtureMap = new Map((fixtures || []).map((fixture) => [fixture.id, fixture]));
  const teamIds = [...new Set((fixtures || []).flatMap((fixture) => [fixture.home_team_id, fixture.away_team_id]))];
  const competitionIds = [...new Set((fixtures || []).map((fixture) => fixture.competition_id))];
  const [{ data: teams }, { data: competitions }] = await Promise.all([
    supabase.from("teams").select("id, provider_team_id, name, logo_url").in("id", teamIds).returns<TeamRow[]>(),
    supabase.from("competitions").select("id, name, country").in("id", competitionIds).returns<CompetitionRow[]>(),
  ]);
  const teamMap = new Map((teams || []).map((team) => [team.id, team]));
  const competitionMap = new Map((competitions || []).map((competition) => [competition.id, competition]));

  const candidates = analyses.flatMap((analysis): FixtureInsight[] => {
    const fixture = fixtureMap.get(analysis.fixture_id);
    if (!fixture) return [];
    const home = teamMap.get(fixture.home_team_id);
    const away = teamMap.get(fixture.away_team_id);
    const competition = competitionMap.get(fixture.competition_id);
    if (!home || !away || !competition) return [];
    return [{
      fixtureId: fixture.provider_fixture_id,
      kickoff: fixture.kickoff_at,
      league: competition.name,
      country: competition.country,
      home: { id: home.provider_team_id, name: home.name, logo: home.logo_url, position: null },
      away: { id: away.provider_team_id, name: away.name, logo: away.logo_url, position: null },
      favorite: analysis.favorite_side,
      favoriteName: analysis.favorite_side === "home" ? home.name : away.name,
      recommendedMarket: analysis.recommended_market,
      bookmaker: analysis.bookmaker,
      odds: analysis.odds,
      impliedProbability: analysis.implied_probability,
      probability: analysis.probability,
      dataConfidence: analysis.confidence,
      score: analysis.model_score,
      tier: analysis.tier,
      eligible: analysis.eligible,
      sourceUpdatedAt: analysis.analyzed_at,
      metrics: analysis.metrics,
      reasons: analysis.reasons,
      caveats: analysis.caveats,
    }];
  }).filter((candidate) => candidate.dataConfidence >= MINIMUM_PUBLISHABLE_CONFIDENCE);

  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      refreshAvailable: Boolean(config.refreshSecret),
      setupRequired: !hasServerConfiguration(),
      usedRequests,
      dailyLimit: config.dailyLimit,
      candidates,
    } satisfies DashboardPayload,
    { headers: { "Cache-Control": "no-store" } },
  );
}
