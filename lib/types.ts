export type ProviderFixture = {
  fixture: {
    id: number;
    date: string;
    timestamp: number;
    timezone?: string;
    status: { short: string; long: string };
    venue?: { name?: string | null; city?: string | null };
  };
  league: {
    id: number;
    name: string;
    country?: string | null;
    logo?: string | null;
    season: number;
    round?: string | null;
  };
  teams: {
    home: { id: number; name: string; logo?: string | null; winner?: boolean | null };
    away: { id: number; name: string; logo?: string | null; winner?: boolean | null };
  };
  goals?: { home?: number | null; away?: number | null };
};

export type RecentMetrics = {
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

export type FixtureInsight = {
  fixtureId: number;
  kickoff: string;
  league: string;
  country: string | null;
  home: { id: number; name: string; logo: string | null; position: number | null };
  away: { id: number; name: string; logo: string | null; position: number | null };
  favorite: "home" | "away";
  favoriteName: string;
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
  metrics: {
    last10: RecentMetrics | null;
    venueLast5: RecentMetrics | null;
    tableGap: number | null;
    opponentStrength: "muito baixa" | "baixa" | "média" | "alta" | "muito alta" | "indisponível";
    xg: { value: number | null; mode: "xg" | "proxy" | "indisponível"; label: string };
    lineup: { status: "confirmada" | "pendente" | "indisponível"; unavailableCount: number | null };
  };
  reasons: string[];
  caveats: string[];
};

export type DashboardPayload = {
  generatedAt: string;
  refreshAvailable: boolean;
  setupRequired: boolean;
  usedRequests: number;
  dailyLimit: number;
  candidates: FixtureInsight[];
};
