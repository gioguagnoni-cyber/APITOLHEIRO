// Server-owned StatsBomb Open Data ingestion. This source is historical and
// selective: raw match events are reduced to aggregates in memory and are not
// persisted or returned by the public dashboard.

type StatsBombSeason = {
  competition_id: number;
  season_id: number;
  country_name?: string | null;
  competition_name?: string | null;
  competition_gender?: string | null;
  competition_international?: boolean | null;
  season_name?: string | null;
  match_updated?: string | null;
  match_available?: string | null;
};

type StatsBombMatch = {
  match_id: number;
  match_date: string;
  kick_off?: string | null;
  home_team?: { home_team_name?: string | null } | null;
  away_team?: { away_team_name?: string | null } | null;
  home_score?: number | null;
  away_score?: number | null;
  match_status?: string | null;
  last_updated?: string | null;
};

type StoredMatch = {
  statsbomb_match_id: number;
  home_team_name: string;
  away_team_name: string;
};

type StatsBombEvent = {
  type?: { name?: string | null } | null;
  team?: { name?: string | null } | null;
  shot?: { statsbomb_xg?: number | null; outcome?: { name?: string | null } | null } | null;
  pass?: { outcome?: { name?: string | null } | null } | null;
};

type Aggregate = {
  xg: number;
  shots: number;
  shotsOnTarget: number;
  completedPasses: number;
  pressures: number;
};

const PROVIDER = "statsbomb-open-data";
const SOURCE_BASE = "https://raw.githubusercontent.com/hudl/open-data/master/data";
const MAX_EVENTS_PER_RUN = 4;

const now = () => new Date().toISOString();

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
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 360);
    throw new Error(`Database request failed (${response.status}): ${detail || "no detail returned"}`);
  }
  if (response.status === 204) return null as T;
  const body = await response.text();
  return body ? JSON.parse(body) as T : null as T;
};

const rpc = <T>(name: string, args: Record<string, unknown> = {}) =>
  databaseRequest<T>(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });

const patch = (tablePath: string, value: Record<string, unknown>) =>
  databaseRequest<void>(tablePath, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(value),
  });

const upsertMany = (table: string, conflictColumns: string, rows: Record<string, unknown>[]) => {
  if (!rows.length) return Promise.resolve();
  return databaseRequest<void>(`${table}?on_conflict=${encodeURIComponent(conflictColumns)}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
};

const constantTimeEquals = (left: string, right: string) => {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
};

const normalizeTeamKey = (name: string) => name
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .toLocaleLowerCase("en-US")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .replace(/\s+/g, "_");

const numberOrZero = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const rounded = (value: number) => Math.round(value * 1_000) / 1_000;

const emptyAggregate = (): Aggregate => ({ xg: 0, shots: 0, shotsOnTarget: 0, completedPasses: 0, pressures: 0 });

const summarizeEvents = (events: StatsBombEvent[], fixture: StoredMatch) => {
  const home = emptyAggregate();
  const away = emptyAggregate();
  for (const event of events) {
    const teamName = event.team?.name || "";
    const aggregate = teamName === fixture.home_team_name ? home : teamName === fixture.away_team_name ? away : null;
    if (!aggregate) continue;
    const type = event.type?.name;
    if (type === "Shot") {
      aggregate.shots += 1;
      aggregate.xg += numberOrZero(event.shot?.statsbomb_xg);
      const outcome = event.shot?.outcome?.name || "";
      if (["Goal", "Saved", "Saved To Post", "Saved to Post"].includes(outcome)) aggregate.shotsOnTarget += 1;
    } else if (type === "Pass" && !event.pass?.outcome?.name) {
      aggregate.completedPasses += 1;
    } else if (type === "Pressure") {
      aggregate.pressures += 1;
    }
  }
  return { home, away };
};

const sourceRequest = async <T>(relativePath: string): Promise<T> => {
  const response = await fetch(`${SOURCE_BASE}/${relativePath}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`StatsBomb source returned HTTP ${response.status}.`);
  return await response.json() as T;
};

const startRun = async () => {
  const result = await databaseRequest<{ id: string }[]>("ingestion_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ provider: PROVIDER, run_type: "historical_aggregate_sync", status: "running", started_at: now() }),
  });
  const runId = result[0]?.id;
  if (!runId) throw new Error("Could not create a StatsBomb ingestion audit record.");
  return runId;
};

const finishRun = (runId: string, status: "completed" | "failed", recordsWritten: number, errorMessage?: string) =>
  patch(`ingestion_runs?id=eq.${runId}`, {
    status,
    completed_at: now(),
    records_written: recordsWritten,
    ...(errorMessage ? { error_message: errorMessage.slice(0, 500) } : {}),
  });

const syncCatalog = async () => {
  const catalog = await sourceRequest<StatsBombSeason[]>("competitions.json");
  const rows = catalog
    .filter((entry) => Number.isInteger(entry.competition_id) && Number.isInteger(entry.season_id))
    .map((entry) => ({
      statsbomb_competition_id: entry.competition_id,
      statsbomb_season_id: entry.season_id,
      country_name: entry.country_name || "Internacional",
      competition_name: entry.competition_name || "Competição",
      season_name: entry.season_name || "Temporada não identificada",
      competition_gender: entry.competition_gender || "não informado",
      is_international: entry.competition_international === true,
      source_match_updated_at: entry.match_updated || null,
      source_match_available_at: entry.match_available || null,
      catalog_synced_at: now(),
    }));
  await upsertMany("statsbomb_seasons", "statsbomb_competition_id,statsbomb_season_id", rows);
  return rows.length;
};

const eventRowsFromSeason = (matches: StatsBombMatch[], competitionId: number, seasonId: number) => matches
  .filter((match) => Number.isInteger(match.match_id) && Boolean(match.home_team?.home_team_name) && Boolean(match.away_team?.away_team_name))
  .map((match) => ({
    statsbomb_match_id: match.match_id,
    statsbomb_competition_id: competitionId,
    statsbomb_season_id: seasonId,
    match_date: match.match_date,
    kickoff_time: match.kick_off || null,
    home_team_name: match.home_team?.home_team_name || "Mandante",
    away_team_name: match.away_team?.away_team_name || "Visitante",
    home_team_key: normalizeTeamKey(match.home_team?.home_team_name || "Mandante"),
    away_team_key: normalizeTeamKey(match.away_team?.away_team_name || "Visitante"),
    home_score: match.home_score ?? null,
    away_score: match.away_score ?? null,
    source_updated_at: match.last_updated || null,
  }));

const selectPendingSeason = () => databaseRequest<Array<{ statsbomb_competition_id: number; statsbomb_season_id: number }>>(
  "statsbomb_seasons?select=statsbomb_competition_id,statsbomb_season_id&matches_ingested_at=is.null&order=source_match_updated_at.desc.nullslast&limit=1",
);

const selectPendingEvents = () => databaseRequest<StoredMatch[]>(
  `statsbomb_matches?select=statsbomb_match_id,home_team_name,away_team_name&events_ingested_at=is.null&event_error_at=is.null&order=match_date.desc&limit=${MAX_EVENTS_PER_RUN}`,
);

const processEventBatch = async (matches: StoredMatch[]) => {
  let written = 0;
  for (const match of matches) {
    try {
      const events = await sourceRequest<StatsBombEvent[]>(`events/${match.statsbomb_match_id}.json`);
      const aggregate = summarizeEvents(events, match);
      await patch(`statsbomb_matches?statsbomb_match_id=eq.${match.statsbomb_match_id}`, {
        home_xg: rounded(aggregate.home.xg),
        away_xg: rounded(aggregate.away.xg),
        home_shots: aggregate.home.shots,
        away_shots: aggregate.away.shots,
        home_shots_on_target: aggregate.home.shotsOnTarget,
        away_shots_on_target: aggregate.away.shotsOnTarget,
        home_completed_passes: aggregate.home.completedPasses,
        away_completed_passes: aggregate.away.completedPasses,
        home_pressures: aggregate.home.pressures,
        away_pressures: aggregate.away.pressures,
        events_ingested_at: now(),
        event_error_at: null,
        event_error_message: null,
      });
      written += 1;
    } catch (error) {
      await patch(`statsbomb_matches?statsbomb_match_id=eq.${match.statsbomb_match_id}`, {
        event_error_at: now(),
        event_error_message: error instanceof Error ? error.message.slice(0, 500) : "Unknown source error",
      });
    }
  }
  if (written) await rpc<void>("refresh_statsbomb_team_profiles");
  return written;
};

const runSync = async () => {
  const runId = await startRun();
  try {
    const existing = await databaseRequest<Array<{ statsbomb_competition_id: number }>>(
      "statsbomb_seasons?select=statsbomb_competition_id&limit=1",
    );
    if (!existing.length) {
      const seasons = await syncCatalog();
      await finishRun(runId, "completed", seasons);
      return { stage: "catalog", recordsWritten: seasons };
    }

    const pendingSeason = await selectPendingSeason();
    if (pendingSeason[0]) {
      const season = pendingSeason[0];
      const sourceMatches = await sourceRequest<StatsBombMatch[]>(`matches/${season.statsbomb_competition_id}/${season.statsbomb_season_id}.json`);
      const rows = eventRowsFromSeason(sourceMatches, season.statsbomb_competition_id, season.statsbomb_season_id);
      await upsertMany("statsbomb_matches", "statsbomb_match_id", rows);
      await patch(
        `statsbomb_seasons?statsbomb_competition_id=eq.${season.statsbomb_competition_id}&statsbomb_season_id=eq.${season.statsbomb_season_id}`,
        { matches_ingested_at: now() },
      );
      const eventRows = rows.slice(0, MAX_EVENTS_PER_RUN).map((row) => ({
        statsbomb_match_id: Number(row.statsbomb_match_id),
        home_team_name: String(row.home_team_name),
        away_team_name: String(row.away_team_name),
      }));
      const aggregates = await processEventBatch(eventRows);
      const recordsWritten = rows.length + aggregates;
      await finishRun(runId, "completed", recordsWritten);
      return { stage: "season", recordsWritten, matchesDiscovered: rows.length, aggregates };
    }

    const pendingEvents = await selectPendingEvents();
    const aggregates = await processEventBatch(pendingEvents);
    await finishRun(runId, "completed", aggregates);
    return { stage: "events", recordsWritten: aggregates };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown StatsBomb ingestion error";
    await finishRun(runId, "failed", 0, message);
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
    const result = await runSync();
    return Response.json({ ok: true, source: "StatsBomb Open Data", historicalOnly: true, ...result, generatedAt: now() });
  } catch (error) {
    console.error("StatsBomb history refresh failed", error instanceof Error ? error.message : "Unknown error");
    return Response.json({ error: "Historical source sync failed." }, { status: 500 });
  }
});
