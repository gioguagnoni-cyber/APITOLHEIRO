type OwnerBet = {
  id: string;
  provider_fixture_id: number;
  league_name: string;
  country_name: string | null;
  kickoff_at: string;
  home_team_name: string;
  away_team_name: string;
  suggested_side: "home" | "away";
  chosen_side: "home" | "away";
  chosen_team_name: string;
  stake: number;
  offered_odds: number;
  status: "open" | "green" | "red";
  profit_loss: number;
  suggested_probability: number | null;
  suggested_tier: number | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
};

type FixtureRow = {
  id: string;
  provider_fixture_id: number;
  kickoff_at: string;
  competitions: { name?: string; country?: string | null } | Array<{ name?: string; country?: string | null }>;
  home: { name?: string } | Array<{ name?: string }>;
  away: { name?: string } | Array<{ name?: string }>;
  fixture_analyses: { favorite_side?: "home" | "away"; probability?: number; tier?: number; eligible?: boolean } | Array<{ favorite_side?: "home" | "away"; probability?: number; tier?: number; eligible?: boolean }>;
};

const ALLOWED_ORIGINS = new Set([
  "https://gioguagnoni-cyber.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);

const utcNow = () => new Date().toISOString();
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const firstServerKey = () => {
  const modernKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modernKeys) {
    try {
      const values = Object.values(JSON.parse(modernKeys) as Record<string, string>).filter(Boolean);
      if (values[0]) return values[0];
    } catch {
      return "";
    }
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
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("Owner database request failed", { path: path.split("?")[0], status: response.status, detail: detail.slice(0, 240) });
    if (response.status === 409) throw new Error("duplicate key");
    throw new Error(`Database request failed (${response.status}).`);
  }
  if (response.status === 204) return null as T;
  const body = await response.text();
  return body ? JSON.parse(body) as T : null as T;
};

const rpc = <T>(name: string, args: Record<string, unknown> = {}) =>
  databaseRequest<T>(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });

const constantTimeEquals = (left: string, right: string) => {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
};

const sha256 = async (value: string) => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
};

const requestFingerprint = async (request: Request) => {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const agent = request.headers.get("user-agent") || "unknown";
  return sha256(`${forwarded}|${agent.slice(0, 200)}`);
};

const originHeaders = (request: Request) => {
  const origin = request.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://gioguagnoni-cyber.github.io",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
};

const json = (request: Request, body: Record<string, unknown>, status = 200) =>
  Response.json(body, { status, headers: originHeaders(request) });

const one = <T>(value: T | T[]) => Array.isArray(value) ? value[0] : value;

const checkRateLimit = async (fingerprint: string) => {
  const query = new URLSearchParams({ select: "attempts,window_started_at,blocked_until", fingerprint: `eq.${fingerprint}`, limit: "1" });
  const rows = await databaseRequest<Array<{ attempts: number; window_started_at: string; blocked_until: string | null }>>(`owner_access_attempts?${query}`);
  const row = rows[0];
  return !row?.blocked_until || new Date(row.blocked_until).getTime() <= Date.now();
};

const recordFailedAccess = async (fingerprint: string) => {
  const query = new URLSearchParams({ select: "attempts,window_started_at", fingerprint: `eq.${fingerprint}`, limit: "1" });
  const rows = await databaseRequest<Array<{ attempts: number; window_started_at: string }>>(`owner_access_attempts?${query}`);
  const current = rows[0];
  const expired = !current || Date.now() - new Date(current.window_started_at).getTime() > 15 * 60_000;
  const attempts = expired ? 1 : clamp(Number(current.attempts) + 1, 1, 100);
  const blockedUntil = attempts >= 8 ? new Date(Date.now() + 30 * 60_000).toISOString() : null;
  await databaseRequest("owner_access_attempts?on_conflict=fingerprint", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ fingerprint, attempts, window_started_at: expired ? utcNow() : current.window_started_at, blocked_until: blockedUntil, updated_at: utcNow() }),
  });
};

const clearFailedAccess = (fingerprint: string) =>
  databaseRequest(`owner_access_attempts?fingerprint=eq.${fingerprint}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });

const ownerDashboard = async () => {
  const [settings, bets, ai] = await Promise.all([
    databaseRequest<Array<{ initial_amount: number; currency: string; updated_at: string }>>("owner_bankroll_settings?select=initial_amount,currency,updated_at&owner_scope=eq.primary&limit=1"),
    databaseRequest<OwnerBet[]>("owner_bets?select=id,provider_fixture_id,league_name,country_name,kickoff_at,home_team_name,away_team_name,suggested_side,chosen_side,chosen_team_name,stake,offered_odds,status,profit_loss,suggested_probability,suggested_tier,settled_at,created_at,updated_at&order=created_at.desc&limit=500"),
    rpc<Record<string, unknown>>("get_ai_provider_settings_for_owner"),
  ]);
  const initial = Number(settings[0]?.initial_amount) || 0;
  const realizedProfit = (bets || []).filter((bet) => bet.status !== "open").reduce((sum, bet) => sum + Number(bet.profit_loss || 0), 0);
  const openExposure = (bets || []).filter((bet) => bet.status === "open").reduce((sum, bet) => sum + Number(bet.stake || 0), 0);
  const settledStake = (bets || []).filter((bet) => bet.status !== "open").reduce((sum, bet) => sum + Number(bet.stake || 0), 0);
  const greenCount = (bets || []).filter((bet) => bet.status === "green").length;
  const redCount = (bets || []).filter((bet) => bet.status === "red").length;
  return {
    bankroll: {
      initial,
      realizedProfit: Math.round(realizedProfit * 100) / 100,
      balance: Math.round((initial + realizedProfit) * 100) / 100,
      available: Math.round((initial + realizedProfit - openExposure) * 100) / 100,
      openExposure: Math.round(openExposure * 100) / 100,
      settledStake: Math.round(settledStake * 100) / 100,
      roi: settledStake ? Math.round((realizedProfit / settledStake) * 10_000) / 100 : 0,
      greenCount,
      redCount,
      openCount: (bets || []).filter((bet) => bet.status === "open").length,
      currency: settings[0]?.currency || "BRL",
      updatedAt: settings[0]?.updated_at || null,
    },
    bets: bets || [],
    ai,
  };
};

const saveBankroll = async (amount: unknown) => {
  const initial = Number(amount);
  if (!Number.isFinite(initial) || initial < 0 || initial > 1_000_000_000) throw new Error("Valor inicial da banca inválido.");
  await databaseRequest("owner_bankroll_settings?owner_scope=eq.primary", {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ initial_amount: Math.round(initial * 100) / 100 }),
  });
};

const getFixture = async (providerFixtureId: number) => {
  const select = "id,provider_fixture_id,kickoff_at,competitions(name,country),home:teams!fixtures_home_team_id_fkey(name),away:teams!fixtures_away_team_id_fkey(name),fixture_analyses(favorite_side,probability,tier,eligible)";
  const query = new URLSearchParams({ select, provider_fixture_id: `eq.${providerFixtureId}`, limit: "1" });
  const rows = await databaseRequest<FixtureRow[]>(`fixtures?${query}`);
  return rows[0] || null;
};

const createBet = async (payload: Record<string, unknown>) => {
  const providerFixtureId = Number(payload.fixtureId);
  const chosenSide = payload.chosenSide === "home" || payload.chosenSide === "away" ? payload.chosenSide : null;
  const stake = Number(payload.stake);
  const offeredOdds = Number(payload.offeredOdds);
  if (!Number.isInteger(providerFixtureId) || providerFixtureId <= 0) throw new Error("Jogo inválido.");
  if (!chosenSide) throw new Error("Escolha mandante ou visitante.");
  if (!Number.isFinite(stake) || stake <= 0 || stake > 1_000_000_000) throw new Error("Valor da entrada inválido.");
  if (!Number.isFinite(offeredOdds) || offeredOdds <= 1 || offeredOdds > 1000) throw new Error("Odd informada inválida.");
  const fixture = await getFixture(providerFixtureId);
  const analysis = fixture ? one(fixture.fixture_analyses) : null;
  if (!fixture || !analysis?.eligible) throw new Error("Somente uma sugestão qualificada pode receber uma entrada.");
  const home = one(fixture.home)?.name || "Mandante";
  const away = one(fixture.away)?.name || "Visitante";
  const competition = one(fixture.competitions) || {};
  const row = {
    fixture_id: fixture.id,
    provider_fixture_id: fixture.provider_fixture_id,
    league_name: competition.name || "Competição",
    country_name: competition.country || null,
    kickoff_at: fixture.kickoff_at,
    home_team_name: home,
    away_team_name: away,
    suggested_side: analysis.favorite_side || "home",
    chosen_side: chosenSide,
    chosen_team_name: chosenSide === "home" ? home : away,
    stake: Math.round(stake * 100) / 100,
    offered_odds: Math.round(offeredOdds * 1000) / 1000,
    suggested_probability: analysis.probability ?? null,
    suggested_tier: analysis.tier ?? null,
    status: "open",
  };
  const inserted = await databaseRequest<OwnerBet[]>("owner_bets", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row),
  });
  if (!inserted[0]) throw new Error("Não foi possível registrar a entrada.");
  await databaseRequest("owner_bet_events", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ bet_id: inserted[0].id, event_type: "created", previous_status: null, next_status: "open", snapshot: row }),
  });
};

const settleBet = async (payload: Record<string, unknown>) => {
  const betId = typeof payload.betId === "string" ? payload.betId : "";
  const outcome = payload.outcome === "green" || payload.outcome === "red" ? payload.outcome : null;
  if (!/^[0-9a-f-]{36}$/i.test(betId) || !outcome) throw new Error("Liquidação inválida.");
  const existing = await databaseRequest<OwnerBet[]>(`owner_bets?select=*&id=eq.${encodeURIComponent(betId)}&limit=1`);
  const bet = existing[0];
  if (!bet) throw new Error("Aposta não encontrada.");
  const eventType = bet.status === "open" ? "settled" : "corrected";
  await databaseRequest(`owner_bets?id=eq.${encodeURIComponent(betId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: outcome, settled_at: utcNow(), settlement_note: "Liquidação manual do proprietário" }),
  });
  await databaseRequest("owner_bet_events", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ bet_id: betId, event_type: eventType, previous_status: bet.status, next_status: outcome, snapshot: { outcome, changedAt: utcNow() } }),
  });
};

const testAiCredential = async (provider: string, apiKey: string, model: string) => {
  const prompt = "Responda somente com OK.";
  let response: Response;
  if (provider === "google") {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 8, temperature: 0 } }),
      signal: AbortSignal.timeout(20_000),
    });
  } else {
    const endpoints: Record<string, string> = {
      openai: "https://api.openai.com/v1/chat/completions",
      deepseek: "https://api.deepseek.com/chat/completions",
      grok: "https://api.x.ai/v1/chat/completions",
    };
    response = await fetch(endpoints[provider], {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 8, temperature: 0 }),
      signal: AbortSignal.timeout(20_000),
    });
  }
  if (!response.ok) throw new Error(`A chave ou o modelo foi recusado pelo provedor (HTTP ${response.status}).`);
};

const saveAi = async (payload: Record<string, unknown>) => {
  const provider = typeof payload.provider === "string" ? payload.provider : "";
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  const maxReviews = clamp(Math.round(Number(payload.maxReviewsPerRun) || 0), 0, 80);
  if (!["openai", "deepseek", "google", "grok"].includes(provider)) throw new Error("Provedor de IA inválido.");
  if (apiKey.length < 12 || apiKey.length > 4096) throw new Error("Chave de IA inválida.");
  if (!model || model.length > 160) throw new Error("Modelo de IA inválido.");
  await testAiCredential(provider, apiKey, model);
  return rpc<Record<string, unknown>>("save_ai_provider_credential_for_owner", {
    p_provider: provider,
    p_api_key: apiKey,
    p_model: model,
    p_enabled: payload.enabled !== false,
    p_max_reviews_per_run: maxReviews,
  });
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: originHeaders(request) });
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json(request, { error: "Origin not allowed." }, 403);
  if (request.method !== "POST") return json(request, { error: "Method not allowed." }, 405);
  if (!projectUrl() || !firstServerKey()) return json(request, { error: "Server configuration is incomplete." }, 503);
  const fingerprint = await requestFingerprint(request);
  try {
    if (!await checkRateLimit(fingerprint)) return json(request, { error: "Muitas tentativas. Aguarde 30 minutos." }, 429);
    const received = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const ownerSecret = await rpc<string | null>("get_owner_access_secret");
    if (!ownerSecret || !received || !constantTimeEquals(received, ownerSecret)) {
      await recordFailedAccess(fingerprint);
      return json(request, { error: "Senha do proprietário inválida." }, 401);
    }
    await clearFailedAccess(fingerprint);
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = typeof payload.action === "string" ? payload.action : "authenticate";
    if (action === "authenticate") return json(request, { ok: true, authenticated: true });
    if (action === "dashboard") return json(request, { ok: true, ...(await ownerDashboard()) });
    if (action === "set_bankroll") await saveBankroll(payload.initialAmount);
    else if (action === "create_bet") await createBet(payload);
    else if (action === "settle_bet") await settleBet(payload);
    else if (action === "save_ai") {
      const ai = await saveAi(payload);
      return json(request, { ok: true, ai, message: "Conexão validada e chave criptografada." });
    } else return json(request, { error: "Ação inválida." }, 400);
    return json(request, { ok: true, ...(await ownerDashboard()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Operação privada indisponível.";
    console.error("APITOLHEIRO owner-control", { message });
    if (message.includes("duplicate key")) return json(request, { error: "Já existe uma entrada registrada para este jogo." }, 409);
    return json(request, { error: message }, 400);
  }
});
