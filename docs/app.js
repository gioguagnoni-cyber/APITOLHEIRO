(() => {
  "use strict";

  const config = window.APITOLHEIRO_PUBLIC_CONFIG;
  const state = {
    payload: null,
    tier: "all",
    league: "all",
    screeningLeague: "all",
    ownerPassword: sessionStorage.getItem("apitoleiro_owner_password") || "",
    ownerData: null,
    selectedCandidate: null,
    pendingCandidate: null,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const dom = {
    dashboard: $("#dashboard"), screening: $("#screening"), screeningMeta: $("#screening-meta"),
    results: $("#results"), resultsMeta: $("#results-meta"), refresh: $("#refresh-button"),
    league: $("#league-filter"), screeningLeague: $("#screening-league-filter"),
    updated: $("#source-updated"), viewTitle: $("#view-title"), viewEyebrow: $("#view-eyebrow"),
    ownerAccess: $("#owner-access"), ownerDialog: $("#owner-dialog"), ownerForm: $("#owner-login-form"),
    ownerPassword: $("#owner-password"), ownerMessage: $("#owner-auth-message"), ownerDot: $("#owner-state-dot"),
    ownerLabel: $("#owner-state-label"), ownerCopy: $("#owner-state-copy"), openBadge: $("#open-bets-badge"),
    betDialog: $("#bet-dialog"), betForm: $("#bet-entry-form"), betMessage: $("#bet-entry-message"),
    betsList: $("#bets-list"), bankrollForm: $("#bankroll-form"), bankrollMessage: $("#bankroll-message"),
    aiForm: $("#ai-settings-form"), aiProvider: $("#ai-provider"), aiModel: $("#ai-model"),
    aiKey: $("#ai-api-key"), aiEnabled: $("#ai-enabled"), aiMax: $("#ai-max-reviews"),
    aiStatus: $("#ai-settings-status"), aiConnection: $("#ai-connection-state"),
  };

  const ptDate = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const percent = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function text(value) { return document.createTextNode(String(value ?? "—")); }
  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.append(text(content));
    return node;
  }
  function number(value, digits = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toFixed(digits) : "—";
  }
  function currency(value) { return money.format(Number(value) || 0); }
  function leagueKey(item) { return `${item.country || "Internacional"}::${item.league || "Competição"}`; }
  function leagueLabel(item) { return `${item.league || "Competição"} · ${item.country || "Internacional"}`; }

  function emptyState(title, description) {
    const box = element("div", "empty-state");
    box.append(element("h3", "", title), element("p", "", description));
    return box;
  }

  function record(metrics, venue) {
    if (!metrics || metrics.unavailable) return { main: "—", detail: "sem histórico" };
    const total = venue ? metrics.venueTotal : metrics.total;
    const wins = venue ? metrics.venueWins : metrics.wins;
    const draws = venue ? metrics.venueDraws : metrics.draws;
    const losses = venue ? metrics.venueLosses : metrics.losses;
    if (!Number.isFinite(Number(total)) || !Number.isFinite(Number(wins))) return { main: "—", detail: "sem histórico" };
    return { main: `${wins}V ${draws ?? "—"}E ${losses ?? "—"}D`, detail: `${total} jogos` };
  }

  function metric(label, value, detail, tone = "") {
    const box = element("div", `metric ${tone}`.trim());
    box.append(element("span", "", label), element("strong", "", value), element("small", "", detail));
    return box;
  }

  function mandatoryItem(check, fallbackLabel, type) {
    const value = check?.value;
    let display = "—";
    if ((type === "last10" || type === "homeLast5") && value && typeof value === "object") display = `${value.observedWins ?? "—"}/${value.observedMatches ?? "—"}`;
    if (type === "tableGap" && value && typeof value === "object" && value.observedPositions !== null && value.observedPositions !== undefined) display = `${Number(value.observedPositions) >= 0 ? "+" : ""}${value.observedPositions}`;
    const passed = check?.passed === true;
    const item = element("div", `mandatory-item ${passed ? "pass" : "fail"}`);
    item.append(element("span", "", check?.label || fallbackLabel), element("strong", "", display), element("small", "", passed ? "atendida" : "não atendida"));
    return item;
  }

  function classification(candidate) {
    if (candidate.classification === "lineup_suspended") return "Suspensa após escalação";
    if (candidate.classification === "lineup_downgraded") return "Rebaixada após escalação";
    return candidate.eligible ? "Sugestão qualificada" : "Somente análise";
  }

  function officialLineup(lineup) {
    const favorite = lineup?.officialLineup?.favorite || {};
    const starters = Array.isArray(favorite.starters) ? favorite.starters : [];
    if (!starters.length) return null;
    const section = element("section", "official-lineup");
    section.append(element("h4", "", `XI oficial · ${favorite.team || "lado sugerido"}${favorite.formation ? ` · ${favorite.formation}` : ""}`));
    const players = element("div", "lineup-players");
    starters.forEach((player) => players.append(element("span", "", player.name || "Jogador não identificado")));
    section.append(players);
    return section;
  }

  function buildCandidate(candidate) {
    const metrics = candidate.metrics || {};
    const last10 = record(metrics.last10, false);
    const last5 = record(metrics.venueLast5, true);
    const table = metrics.table || {};
    const xg = metrics.xg || {};
    const prediction = metrics.prediction || {};
    const injuries = metrics.injuries || {};
    const lineup = metrics.lineup || {};
    const review = lineup.lineupReview || {};
    const statsbomb = metrics.statsbomb || {};
    const official = metrics.footballData || {};
    const checks = candidate.checks || {};
    const card = element("article", "candidate-card");

    const head = element("div", "candidate-head");
    const competition = element("div", "candidate-competition");
    competition.append(element("span", "", leagueLabel(candidate)), element("strong", "", `${candidate.home?.name || "Mandante"} × ${candidate.away?.name || "Visitante"}`), element("small", "", candidate.kickoff ? ptDate.format(new Date(candidate.kickoff)) : "horário indisponível"));
    const pick = element("div", "candidate-pick");
    pick.append(element("span", "", "Lado modelado"), element("strong", "", candidate.favoriteName || "—"), element("small", "", candidate.recommendedMarket || "vitória no tempo regulamentar"));
    const probability = element("div", "probability");
    probability.append(element("strong", "", `${number(candidate.probability)}%`), element("small", "", "modelo"));
    const tier = element("span", "tier-tag", `Tier ${candidate.tier || 4}`);
    const actions = element("div", "candidate-actions");
    const entry = element("button", "entry-button", candidate.eligible ? "Entrada realizada" : "Não qualificado");
    entry.type = "button";
    entry.disabled = candidate.eligible !== true;
    if (candidate.eligible) entry.addEventListener("click", () => openBet(candidate));
    actions.append(entry);
    head.append(competition, pick, probability, tier, actions);

    const mandatory = element("div", "mandatory-row");
    mandatory.append(mandatoryItem(checks.last10, "Últimos 10", "last10"), mandatoryItem(checks.homeLast5, "Últimos 5 em casa", "homeLast5"), mandatoryItem(checks.tableGap, "Diferença de tabela", "tableGap"));

    const lineupStatus = review.status || lineup.status || "pendente";
    const lineupTone = ["suspended", "downgraded"].includes(lineupStatus) ? "negative" : ["confirmed", "unchanged", "confirmada"].includes(lineupStatus) ? "positive" : "";
    const grid = element("div", "metrics-grid");
    grid.append(
      metric("Últimos 10", last10.main, last10.detail),
      metric("Últimos 5 no mando", last5.main, candidate.favorite === "home" ? "em casa" : "fora"),
      metric("Tabela", table.homePosition && table.awayPosition ? `${table.homePosition}º × ${table.awayPosition}º` : "—", table.source || "sem posição"),
      metric("Diferença", metrics.tableGap === null || metrics.tableGap === undefined ? "—" : `${Number(metrics.tableGap) >= 0 ? "+" : ""}${metrics.tableGap}`, "posições"),
      metric("Força rival", metrics.opponentStrength || "—", "proxy relativo"),
      metric(xg.mode === "xg" ? "xG diferencial" : "Criação", xg.value === null || xg.value === undefined ? "—" : `${Number(xg.value) > 0 ? "+" : ""}${number(xg.value, 2)}`, xg.mode || "sem cobertura"),
      metric("Previsão externa", prediction.favoriteProbability === null || prediction.favoriteProbability === undefined ? "—" : `${number(prediction.favoriteProbability)}%`, prediction.source || "API-Football"),
      metric("Baixas", injuries.favoriteCount === null || injuries.favoriteCount === undefined ? "—" : `${injuries.favoriteCount} × ${injuries.opponentCount ?? "—"}`, "sugerido × rival"),
      metric("Escalação", lineupStatus, review.checkedAt ? `${review.startersConfirmed || "—"}/11 · ${ptDate.format(new Date(review.checkedAt))}` : "reconsulta pendente", lineupTone),
      metric("Ajuste pré-jogo", review.probabilityDelta === null || review.probabilityDelta === undefined ? "—" : `${Number(review.probabilityDelta) > 0 ? "+" : ""}${number(review.probabilityDelta)} pp`, review.decision || "aguarda XI", lineupTone),
      metric("StatsBomb", statsbomb.status || "sem cobertura", Number.isFinite(Number(statsbomb.xgForPerMatch)) ? `${number(statsbomb.xgForPerMatch, 2)} xG histórico` : "histórico agregado"),
      metric("football-data.org", official.status || "sem cobertura", official.competitionCode || "conferência oficial"),
    );

    const foot = element("div", "candidate-foot");
    const notes = element("div", "candidate-notes");
    (candidate.reasons || []).slice(0, 5).forEach((item) => notes.append(element("span", "", `✓ ${item}`)));
    (candidate.caveats || []).slice(0, 5).forEach((item) => notes.append(element("span", "warning", `! ${item}`)));
    const status = element("div", "lineup-summary", `${classification(candidate)} · ${Math.round((Number(candidate.dataConfidence) || 0) * 100)}% de cobertura`);
    foot.append(notes, status);
    card.append(head, mandatory, grid);
    const xi = officialLineup(lineup);
    if (xi) card.append(xi);
    card.append(foot);
    return card;
  }

  function matching(item, key) { return key === "all" || leagueKey(item) === key; }

  function renderCandidates() {
    dom.dashboard.replaceChildren();
    if (!state.payload) return dom.dashboard.append(emptyState("Sem leitura", "O feed público ainda não respondeu."));
    const candidates = (state.payload.candidates || []).filter((item) => matching(item, state.league)).filter((item) => state.tier === "all" || String(item.tier) === state.tier);
    if (!candidates.length) return dom.dashboard.append(emptyState("Nenhum jogo neste recorte", "Altere o Tier ou o campeonato. A tela “Jogos filtrados” mostra todos os jogos encontrados."));
    const list = element("div", "candidate-list");
    candidates.forEach((candidate) => list.append(buildCandidate(candidate)));
    dom.dashboard.append(list);
  }

  function renderScreening() {
    dom.screening.replaceChildren();
    const fixtures = (state.payload?.screenedFixtures || []).filter((item) => matching(item, state.screeningLeague));
    dom.screeningMeta.textContent = fixtures.length ? `${fixtures.length} jogo(s) no recorte atual.` : "Nenhum jogo no recorte atual.";
    if (!fixtures.length) return dom.screening.append(emptyState("Nenhum jogo encontrado", "Aguarde a próxima rotina ou selecione outro campeonato."));
    const table = element("div", "data-table");
    const header = element("div", "table-row header");
    ["Campeonato", "Jogo", "Horário", "Situação", "Motivo"].forEach((label) => header.append(element("span", "", label)));
    table.append(header);
    fixtures.forEach((fixture) => {
      const row = element("div", "table-row");
      const league = element("div"); league.append(element("strong", "", fixture.league || "Competição"), element("small", "", fixture.country || "Internacional"));
      const match = element("div"); match.append(element("strong", "", `${fixture.homeName || "Mandante"} × ${fixture.awayName || "Visitante"}`));
      const time = element("span", "", fixture.kickoff ? ptDate.format(new Date(fixture.kickoff)) : "—");
      const analyzed = fixture.analysisStatus === "analisado";
      const status = element("span", "status-label", analyzed ? `Tier ${fixture.tier}` : fixture.analysisStatus === "fora_de_escopo" ? "Fora do escopo" : "Aguardando");
      const reason = element("span", "", analyzed ? (fixture.classificationLabel || `${number(fixture.probability)}%`) : (fixture.screeningReason || "sem publicação"));
      row.append(league, match, time, status, reason); table.append(row);
    });
    dom.screening.append(table);
  }

  function renderResults() {
    dom.results.replaceChildren();
    const data = state.payload?.results || {};
    dom.resultsMeta.textContent = `${Number(data.greenCount) || 0} Green · ${Number(data.redCount) || 0} Red · ${Number(data.pendingCount) || 0} aguardando`;
    const history = Array.isArray(data.history) ? data.history : [];
    if (!history.length) return dom.results.append(emptyState("Sem liquidações automáticas", "O histórico do modelo aparecerá quando sugestões publicadas terminarem."));
    const table = element("div", "data-table");
    const header = element("div", "table-row header");
    ["Campeonato", "Jogo", "Sugestão", "Tier", "Resultado"].forEach((label) => header.append(element("span", "", label)));
    table.append(header);
    history.slice(0, 30).forEach((item) => {
      const row = element("div", "table-row");
      const league = element("div"); league.append(element("strong", "", item.league || "Competição"), element("small", "", item.country || ""));
      const match = element("div"); match.append(element("strong", "", `${item.homeName || "Mandante"} × ${item.awayName || "Visitante"}`), element("small", "", item.kickoff ? ptDate.format(new Date(item.kickoff)) : ""));
      const pick = element("div"); pick.append(element("strong", "", item.favoriteName || "—"), element("small", "", `${number(item.probability)}%`));
      const tier = element("span", "tier-tag", `T${item.tier || "—"}`);
      const outcome = String(item.settlement || "pending");
      const label = outcome === "green" ? "Green" : outcome === "red" ? "Red" : outcome === "void" ? "Anulado" : "Pendente";
      row.append(league, match, pick, tier, element("span", `status-label ${outcome === "green" || outcome === "red" ? outcome : ""}`, label)); table.append(row);
    });
    dom.results.append(table);
  }

  function syncLeagues() {
    const items = [...(state.payload?.candidates || []), ...(state.payload?.screenedFixtures || [])];
    const unique = new Map(); items.forEach((item) => unique.set(leagueKey(item), leagueLabel(item)));
    [dom.league, dom.screeningLeague].forEach((select) => {
      const current = select === dom.league ? state.league : state.screeningLeague;
      select.replaceChildren(); const all = element("option", "", "Todos os campeonatos"); all.value = "all"; select.append(all);
      [...unique.entries()].sort((a, b) => a[1].localeCompare(b[1], "pt-BR")).forEach(([key, label]) => { const option = element("option", "", label); option.value = key; select.append(option); });
      select.value = unique.has(current) ? current : "all";
    });
  }

  function setSummary() {
    const payload = state.payload || {};
    $("#screened-count").textContent = String(payload.screenedCount ?? 0);
    $("#analyzed-count").textContent = String(payload.analyzedCount ?? 0);
    $("#verified-count").textContent = String(payload.verifiedCount ?? 0);
    $("#qualified-count").textContent = String(payload.qualifiedCount ?? 0);
    dom.updated.textContent = payload.sourceUpdatedAt ? `Atualizado ${ptDate.format(new Date(payload.sourceUpdatedAt))}` : payload.scanUpdatedAt ? `Varredura ${ptDate.format(new Date(payload.scanUpdatedAt))}` : "sem leitura recente";
    $$('[data-tier]').forEach((button) => { const key = button.dataset.tier; button.textContent = key === "all" ? "Todos" : `Tier ${key} · ${payload.tierCounts?.[key] ?? 0}`; });
  }

  async function loadPublic() {
    if (!config?.supabaseUrl || !config?.publishableKey) return dom.dashboard.replaceChildren(emptyState("Configuração ausente", "O contrato público do Supabase não foi encontrado."));
    dom.refresh.disabled = true; dom.refresh.textContent = "Atualizando…";
    try {
      const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/get_public_tipster_dashboard`, { method: "POST", cache: "no-store", credentials: "omit", headers: { apikey: config.publishableKey, Authorization: `Bearer ${config.publishableKey}`, "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error(`Feed indisponível (${response.status})`);
      const payload = await response.json();
      if (!payload || payload.schemaVersion !== 10 || !Array.isArray(payload.candidates) || !Array.isArray(payload.screenedFixtures)) throw new Error("Contrato público incompatível.");
      state.payload = payload; syncLeagues(); setSummary(); renderCandidates(); renderScreening(); renderResults();
    } catch (error) {
      console.warn("APITOLHEIRO public feed", error instanceof Error ? error.message : "unknown");
      dom.dashboard.replaceChildren(emptyState("Não foi possível carregar o radar", "Tente novamente em alguns instantes."));
    } finally { dom.refresh.disabled = false; dom.refresh.textContent = "Atualizar"; }
  }

  const viewMeta = {
    radar: ["ANÁLISE", "Radar do dia"], screening: ["ANÁLISE", "Jogos filtrados"], bets: ["GESTÃO", "Minhas apostas"],
    bankroll: ["GESTÃO", "Banca"], ai: ["CONFIGURAÇÃO", "API IA"], method: ["SISTEMA", "Regras e fontes"],
  };
  function showView(name) {
    $$(".view").forEach((view) => view.classList.toggle("active", view.dataset.view === name));
    $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.viewTarget === name));
    dom.viewEyebrow.textContent = viewMeta[name]?.[0] || "APITOLHEIRO"; dom.viewTitle.textContent = viewMeta[name]?.[1] || "Painel";
    if (["bets", "bankroll", "ai"].includes(name) && !state.ownerPassword) openOwnerDialog();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function ownerCall(action, fields = {}, password = state.ownerPassword) {
    const response = await fetch(`${config.supabaseUrl}/functions/v1/owner-control`, {
      method: "POST", credentials: "omit", cache: "no-store",
      headers: { apikey: config.publishableKey, Authorization: `Bearer ${password}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...fields }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(payload.error || `Operação indisponível (${response.status})`); error.status = response.status; throw error; }
    return payload;
  }

  function setPrivateVisibility(unlocked) {
    ["bets", "bankroll"].forEach((name) => { $(`#${name}-private-gate`).hidden = unlocked; $(`#${name}-private-content`).hidden = !unlocked; });
    $("#ai-private-gate").hidden = unlocked; dom.aiForm.hidden = !unlocked;
    dom.ownerDot.classList.toggle("connected", unlocked);
    dom.ownerLabel.textContent = unlocked ? "Área privada desbloqueada" : "Área privada bloqueada";
    dom.ownerCopy.textContent = unlocked ? "Sessão protegida ativa" : "Banca e chaves protegidas";
    dom.ownerAccess.textContent = unlocked ? "Bloquear" : "Desbloquear";
    if (!unlocked) dom.openBadge.textContent = "0";
  }

  function lockOwner(message = "Sessão privada encerrada.") {
    state.ownerPassword = ""; state.ownerData = null; sessionStorage.removeItem("apitoleiro_owner_password");
    setPrivateVisibility(false); dom.ownerMessage.textContent = message;
  }

  function openOwnerDialog() { dom.ownerMessage.textContent = ""; dom.ownerPassword.value = ""; dom.ownerDialog.showModal(); setTimeout(() => dom.ownerPassword.focus(), 0); }

  async function loadOwnerDashboard() {
    if (!state.ownerPassword) return;
    try { const data = await ownerCall("dashboard"); state.ownerData = data; setPrivateVisibility(true); renderOwnerData(); }
    catch (error) { if (error.status === 401 || error.status === 429) lockOwner(error.message); else console.warn("Owner dashboard", error.message); }
  }

  function renderOwnerData() {
    const data = state.ownerData || {};
    const bank = data.bankroll || {};
    dom.openBadge.textContent = String(bank.openCount || 0);
    $("#bet-open-count").textContent = String(bank.openCount || 0); $("#bet-open-exposure").textContent = `${currency(bank.openExposure)} comprometidos`;
    $("#bet-green-count").textContent = String(bank.greenCount || 0); $("#bet-red-count").textContent = String(bank.redCount || 0); $("#bet-profit").textContent = currency(bank.realizedProfit);
    $("#bankroll-balance").textContent = currency(bank.balance); $("#bankroll-result").textContent = `Resultado: ${currency(bank.realizedProfit)}`;
    $("#bankroll-available").textContent = currency(bank.available); $("#bankroll-initial").textContent = currency(bank.initial); $("#bankroll-exposure").textContent = currency(bank.openExposure);
    $("#bankroll-roi").textContent = `${percent.format(Number(bank.roi) || 0)}%`; $("#bankroll-record").textContent = `${bank.greenCount || 0}G · ${bank.redCount || 0}R`; $("#bankroll-input").value = String(Number(bank.initial) || 0);
    renderBets(data.bets || []); renderAiSettings(data.ai || {});
  }

  function renderBets(bets) {
    dom.betsList.replaceChildren();
    if (!bets.length) return dom.betsList.append(emptyState("Nenhuma entrada registrada", "Use “Entrada realizada” em uma sugestão qualificada para abrir sua primeira aposta."));
    const table = element("div", "bet-list");
    const header = element("div", "bet-row header"); ["Jogo", "Escolha", "Entrada", "Odd", "Status", "Liquidação"].forEach((label) => header.append(element("span", "", label))); table.append(header);
    bets.forEach((bet) => {
      const row = element("div", "bet-row");
      const fixture = element("div"); fixture.append(element("strong", "", `${bet.home_team_name} × ${bet.away_team_name}`), element("small", "", `${bet.league_name} · ${ptDate.format(new Date(bet.kickoff_at))}`));
      const pick = element("div"); pick.append(element("strong", "", bet.chosen_team_name), element("small", "", bet.chosen_side === bet.suggested_side ? "lado sugerido" : "lado oposto"));
      const stake = element("strong", "", currency(bet.stake)); const odds = element("strong", "", number(bet.offered_odds, 3));
      const label = bet.status === "green" ? "Green" : bet.status === "red" ? "Red" : "Aberta";
      const status = element("span", `status-label ${bet.status === "green" || bet.status === "red" ? bet.status : ""}`, label);
      const actions = element("div", "settle-actions");
      const green = element("button", "green", "Green"); green.type = "button"; green.addEventListener("click", () => settleOwnerBet(bet.id, "green"));
      const red = element("button", "red", "Red"); red.type = "button"; red.addEventListener("click", () => settleOwnerBet(bet.id, "red")); actions.append(green, red);
      row.append(fixture, pick, stake, odds, status, actions); table.append(row);
    });
    dom.betsList.append(table);
  }

  async function settleOwnerBet(betId, outcome) {
    if (!window.confirm(`Confirmar ${outcome === "green" ? "Green" : "Red"} para esta entrada?`)) return;
    try { state.ownerData = await ownerCall("settle_bet", { betId, outcome }); renderOwnerData(); }
    catch (error) { window.alert(error.message); }
  }

  function renderAiSettings(ai) {
    if (ai.provider) dom.aiProvider.value = ai.provider;
    if (ai.model) dom.aiModel.value = ai.model;
    dom.aiEnabled.checked = ai.enabled !== false; dom.aiMax.value = String(ai.maxReviewsPerRun ?? 10);
    dom.aiConnection.textContent = ai.configured ? `${String(ai.provider).toUpperCase()} conectado · ${ai.model || "modelo configurado"}` : "Nenhuma IA configurada.";
    dom.aiStatus.textContent = ai.configured ? "Chave criptografada. Cole uma nova chave somente para substituir a conexão." : "A chave será testada antes de ser criptografada.";
  }

  function openBet(candidate) {
    if (!state.ownerPassword) { state.pendingCandidate = candidate; openOwnerDialog(); return; }
    state.selectedCandidate = candidate;
    $("#bet-league").textContent = leagueLabel(candidate); $("#bet-fixture").textContent = `${candidate.home?.name || "Mandante"} × ${candidate.away?.name || "Visitante"}`;
    $("#bet-home-label").textContent = candidate.home?.name || "Mandante"; $("#bet-away-label").textContent = candidate.away?.name || "Visitante";
    const selected = dom.betForm.querySelector(`input[name='chosen-side'][value='${candidate.favorite || "home"}']`); if (selected) selected.checked = true;
    $("#bet-stake").value = ""; $("#bet-odds").value = ""; dom.betMessage.textContent = ""; dom.betDialog.showModal();
  }

  const modelDefaults = { deepseek: "deepseek-chat", openai: "gpt-4.1-mini", google: "gemini-2.0-flash", grok: "grok-3-mini" };

  $$(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.viewTarget)));
  $$("[data-tier]").forEach((button) => button.addEventListener("click", () => { state.tier = button.dataset.tier || "all"; $$('[data-tier]').forEach((item) => item.classList.toggle("selected", item === button)); renderCandidates(); }));
  dom.league.addEventListener("change", () => { state.league = dom.league.value || "all"; renderCandidates(); });
  dom.screeningLeague.addEventListener("change", () => { state.screeningLeague = dom.screeningLeague.value || "all"; renderScreening(); });
  dom.refresh.addEventListener("click", () => void loadPublic());
  $$(".unlock-action").forEach((button) => button.addEventListener("click", openOwnerDialog));
  dom.ownerAccess.addEventListener("click", () => state.ownerPassword ? lockOwner() : openOwnerDialog());
  $("#owner-close").addEventListener("click", () => dom.ownerDialog.close()); $("#owner-cancel").addEventListener("click", () => dom.ownerDialog.close());
  $("#bet-close").addEventListener("click", () => dom.betDialog.close()); $("#bet-cancel").addEventListener("click", () => dom.betDialog.close());

  dom.ownerForm.addEventListener("submit", async (event) => {
    event.preventDefault(); const password = dom.ownerPassword.value; const submit = dom.ownerForm.querySelector("button[type='submit']"); submit.disabled = true; dom.ownerMessage.textContent = "Validando…";
    try {
      await ownerCall("authenticate", {}, password); state.ownerPassword = password; sessionStorage.setItem("apitoleiro_owner_password", password); dom.ownerPassword.value = ""; dom.ownerDialog.close(); setPrivateVisibility(true); await loadOwnerDashboard();
      if (state.pendingCandidate) { const candidate = state.pendingCandidate; state.pendingCandidate = null; openBet(candidate); }
    } catch (error) { dom.ownerMessage.textContent = error.message; dom.ownerMessage.className = "form-message error"; }
    finally { submit.disabled = false; }
  });

  dom.betForm.addEventListener("submit", async (event) => {
    event.preventDefault(); if (!state.selectedCandidate) return;
    const chosen = dom.betForm.querySelector("input[name='chosen-side']:checked")?.value; const submit = dom.betForm.querySelector("button[type='submit']"); submit.disabled = true; dom.betMessage.textContent = "Registrando…";
    try {
      state.ownerData = await ownerCall("create_bet", { fixtureId: state.selectedCandidate.fixtureId, chosenSide: chosen, stake: Number($("#bet-stake").value), offeredOdds: Number($("#bet-odds").value) });
      renderOwnerData(); dom.betDialog.close(); showView("bets");
    } catch (error) { dom.betMessage.textContent = error.message; dom.betMessage.className = "form-message error"; }
    finally { submit.disabled = false; }
  });

  dom.bankrollForm.addEventListener("submit", async (event) => {
    event.preventDefault(); const submit = dom.bankrollForm.querySelector("button[type='submit']"); submit.disabled = true; dom.bankrollMessage.textContent = "Salvando…";
    try { state.ownerData = await ownerCall("set_bankroll", { initialAmount: Number($("#bankroll-input").value) }); renderOwnerData(); dom.bankrollMessage.textContent = "Banca atualizada."; dom.bankrollMessage.className = "form-message success"; }
    catch (error) { dom.bankrollMessage.textContent = error.message; dom.bankrollMessage.className = "form-message error"; }
    finally { submit.disabled = false; }
  });

  dom.aiProvider.addEventListener("change", () => { dom.aiModel.value = modelDefaults[dom.aiProvider.value] || ""; });
  dom.aiForm.addEventListener("submit", async (event) => {
    event.preventDefault(); const submit = dom.aiForm.querySelector("button[type='submit']"); submit.disabled = true; dom.aiStatus.textContent = "Testando a chave diretamente no provedor…"; dom.aiStatus.className = "form-message";
    try {
      const response = await ownerCall("save_ai", { provider: dom.aiProvider.value, apiKey: dom.aiKey.value, model: dom.aiModel.value.trim(), enabled: dom.aiEnabled.checked, maxReviewsPerRun: Number(dom.aiMax.value) });
      dom.aiKey.value = ""; dom.aiStatus.textContent = response.message || "Conexão concluída."; dom.aiStatus.className = "form-message success"; await loadOwnerDashboard();
    } catch (error) { dom.aiStatus.textContent = error.message; dom.aiStatus.className = "form-message error"; }
    finally { submit.disabled = false; }
  });

  dom.ownerDialog.addEventListener("click", (event) => { if (event.target === dom.ownerDialog) dom.ownerDialog.close(); });
  dom.betDialog.addEventListener("click", (event) => { if (event.target === dom.betDialog) dom.betDialog.close(); });

  setPrivateVisibility(Boolean(state.ownerPassword));
  void loadPublic();
  if (state.ownerPassword) void loadOwnerDashboard();
})();
