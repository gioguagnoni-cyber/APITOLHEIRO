(() => {
  "use strict";

  const config = window.APITOLHEIRO_PUBLIC_CONFIG;
  const state = { payload: null, tier: "all", league: "all" };
  const dashboard = document.querySelector("#dashboard");
  const screening = document.querySelector("#screening");
  const screeningMeta = document.querySelector("#screening-meta");
  const statsbombSource = document.querySelector("#statsbomb-source");
  const statsbombStatus = document.querySelector("#statsbomb-status");
  const footballDataSource = document.querySelector("#football-data-source");
  const footballDataStatus = document.querySelector("#football-data-status");
  const publicationCopy = document.querySelector("#publication-copy");
  const results = document.querySelector("#results");
  const resultsMeta = document.querySelector("#results-meta");
  const refreshButton = document.querySelector("#refresh-button");
  const leagueFilter = document.querySelector("#league-filter");
  const tierButtons = [...document.querySelectorAll("[data-tier]")];
  const ownerAccess = document.querySelector("#owner-access");
  const ownerDialog = document.querySelector("#owner-dialog");
  const ownerClose = document.querySelector("#owner-close");
  const ownerEmail = document.querySelector("#owner-email");
  const ownerLink = document.querySelector("#owner-link");
  const ownerAuthPanel = document.querySelector("#owner-auth-panel");
  const ownerAuthMessage = document.querySelector("#owner-auth-message");
  const aiForm = document.querySelector("#ai-settings-form");
  const aiProvider = document.querySelector("#ai-provider");
  const aiModel = document.querySelector("#ai-model");
  const aiApiKey = document.querySelector("#ai-api-key");
  const aiEnabled = document.querySelector("#ai-enabled");
  const aiMaxReviews = document.querySelector("#ai-max-reviews");
  const aiSettingsStatus = document.querySelector("#ai-settings-status");
  const ownerSignout = document.querySelector("#owner-signout");
  let ownerToken = sessionStorage.getItem("apitoleiro_owner_access_token") || "";
  const numbers = {
    screened: document.querySelector("#screened-count"),
    analyzed: document.querySelector("#analyzed-count"),
    verified: document.querySelector("#verified-count"),
    qualified: document.querySelector("#qualified-count"),
    updated: document.querySelector("#source-updated"),
  };

  const ptDate = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const ptShortDate = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });

  function text(value) {
    return document.createTextNode(String(value ?? "—"));
  }

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.append(text(content));
    return node;
  }

  function labelValue(label, value, caption, tone = "") {
    const box = element("div", `signal ${tone}`.trim());
    box.append(element("span", "", label), element("strong", "", value), element("small", "", caption));
    return box;
  }

  function record(metrics, venue) {
    if (!metrics || metrics.unavailable) return { main: "—", detail: "sem histórico" };
    const total = venue ? metrics.venueTotal : metrics.total;
    const wins = venue ? metrics.venueWins : metrics.wins;
    if (!Number.isFinite(total) || !Number.isFinite(wins)) return { main: "—", detail: "sem histórico" };
    return { main: `${wins}V / ${total}`, detail: venue ? "recorte do mando" : `${metrics.wins}V ${metrics.draws}E ${metrics.losses}D` };
  }

  function strengthTone(value) {
    if (String(value).includes("baixa")) return "positive";
    if (String(value).includes("alta")) return "negative";
    return "";
  }

  function formatNumber(value, digits = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toFixed(digits) : "—";
  }

  function leagueKey(item) {
    return `${item.country || "Internacional"}::${item.league || "Competição"}`;
  }

  function leagueLabel(item) {
    return `${item.league || "Competição"} · ${item.country || "Internacional"}`;
  }

  function classificationText(candidate) {
    const labels = {
      sugerido: "Sugerido",
      last10_insuficiente: "Não sugerido · últimos 10",
      home_last5_insuficiente: "Não sugerido · mando",
      tabela_insuficiente: "Não sugerido · tabela",
      criterios_sem_cobertura: "Não sugerido · dados incompletos",
      qualificado: "Qualificado",
      cobertura_insuficiente: "Cobertura insuficiente",
      mercado_indisponivel: "Mercado indisponível",
      odd_fora_da_faixa: "Odd fora da faixa",
      probabilidade_abaixo_meta: "Abaixo da meta",
      monitorar: "Monitorar",
    };
    return labels[candidate.classification] || "Analisado";
  }

  function checkValue(name, value) {
    if (value === null || value === undefined || value === "") return name === "oddsRange" ? "sem odd" : "—";
    if (["last10", "homeLast5"].includes(name) && typeof value === "object") return `${value.observedWins ?? "—"}/${value.observedMatches ?? "—"}`;
    if (name === "tableGap" && typeof value === "object") return value.observedPositions === null || value.observedPositions === undefined ? "—" : `${Number(value.observedPositions) >= 0 ? "+" : ""}${value.observedPositions}`;
    if (name === "coverageThreshold") return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : "—";
    if (name === "oddsRange") return Number.isFinite(Number(value)) ? formatNumber(value, 2) : "sem odd";
    return Number.isFinite(Number(value)) ? `${formatNumber(value)}%` : "—";
  }

  function buildChecks(candidate) {
    const checks = candidate.checks || {};
    const list = element("div", "decision-checks");
    const mandatory = ["last10", "homeLast5", "tableGap"].filter((name) => checks[name]);
    (mandatory.length ? mandatory : ["modelThreshold", "coverageThreshold", "oddsRange"]).forEach((name) => {
      const check = checks[name] || {};
      const passed = check.passed === true;
      const chip = element("div", `decision-check ${passed ? "pass" : "fail"}`);
      chip.append(
        element("span", "", check.label || "Critério"),
        element("strong", "", checkValue(name, check.value)),
        element("small", "", passed ? "regra obrigatória atendida" : "regra obrigatória não atendida"),
      );
      list.append(chip);
    });
    return list;
  }

  function buildCandidate(candidate) {
    const metrics = candidate.metrics || {};
    const last10 = record(metrics.last10, false);
    const venue = record(metrics.venueLast5, true);
    const favoriteIsHome = candidate.favorite === "home";
    const xg = metrics.xg || {};
    const lineup = metrics.lineup || {};
    const statsbomb = metrics.statsbomb || {};
    const footballData = metrics.footballData || {};
    const statsbombAvailable = statsbomb.status === "histórico";
    const statsbombValue = statsbombAvailable && Number.isFinite(Number(statsbomb.xgForPerMatch))
      ? `${formatNumber(statsbomb.xgForPerMatch, 2)} xG`
      : (statsbomb.status || "sem cobertura");
    const statsbombCaption = statsbombAvailable
      ? `${statsbomb.favoriteMatches || 0} partidas históricas`
      : (statsbomb.label || "não entra no score");
    const footballDataVerified = footballData.status === "confirmado";
    const footballDataValue = footballDataVerified
      ? `Tabela ${footballData.tableSource || "oficial"}`
      : (footballData.status || "sem cobertura");
    const footballDataCaption = footballDataVerified
      ? `${footballData.competitionCode || "competição"} · ${footballData.favoriteRecentMatches || 0} jogos recentes`
      : (footballData.label || "não altera o score");
    const article = element("article", `candidate-card tier-${candidate.tier}`);

    const top = element("div", "card-topline");
    top.append(
      element("span", "", leagueLabel(candidate)),
      element("span", "", candidate.kickoff ? ptDate.format(new Date(candidate.kickoff)) : "horário indisponível"),
    );

    const heading = element("div", "fixture-heading");
    const home = element("div", "team-side home");
    home.append(element("span", "team-avatar", String(candidate.home?.name || "?").slice(0, 1)));
    const homeCopy = element("div");
    homeCopy.append(element("strong", "", candidate.home?.name || "Mandante"), element("small", "", "mandante"));
    home.append(homeCopy);
    const away = element("div", "team-side away");
    const awayCopy = element("div");
    awayCopy.append(element("strong", "", candidate.away?.name || "Visitante"), element("small", "", "visitante"));
    away.append(awayCopy, element("span", "team-avatar", String(candidate.away?.name || "?").slice(0, 1)));
    heading.append(home, element("div", "versus", "×"), away);

    const recommendation = element("div", "recommendation");
    const favorite = element("div");
    favorite.append(element("span", "eyebrow", "Lado modelado"), element("strong", "", candidate.favoriteName), element("small", "", candidate.recommendedMarket));
    const probability = element("div", "probability");
    probability.append(element("span", "", `${formatNumber(candidate.probability)}%`), element("small", "", "probabilidade do modelo"));
    recommendation.append(favorite, probability, element("div", `tier-badge tier-${candidate.tier}`, `Tier ${candidate.tier}`));

    const classification = element("div", `classification ${candidate.eligible ? "qualified" : "not-qualified"}`);
    classification.append(element("strong", "", classificationText(candidate)), element("span", "", candidate.classificationLabel || "Sem justificativa disponível."));

    const signals = element("div", "signal-grid");
    signals.append(
      labelValue("Últimos 10", last10.main, last10.detail),
      labelValue("Últimos 5 no mando", venue.main, favoriteIsHome ? "em casa" : "fora de casa"),
      labelValue("Dif. de tabela", metrics.tableGap === null || metrics.tableGap === undefined ? "—" : `${Number(metrics.tableGap) >= 0 ? "+" : ""}${metrics.tableGap}`, "posições"),
      labelValue("Força rival", metrics.opponentStrength || "indisponível", "proxy de tabela", strengthTone(metrics.opponentStrength)),
      labelValue(xg.mode === "xg" ? "xG diferencial" : "Criação", xg.value === null || xg.value === undefined ? "—" : `${Number(xg.value) > 0 ? "+" : ""}${formatNumber(xg.value, 2)}`, xg.mode === "proxy" ? "proxy de criação" : (xg.mode || "indisponível")),
      labelValue("Escalação", lineup.status || "indisponível", lineup.unavailableCount === null || lineup.unavailableCount === undefined ? "baixas indisponíveis" : `${lineup.unavailableCount} baixas listadas`),
      labelValue("StatsBomb", statsbombValue, statsbombCaption, statsbombAvailable ? "positive" : ""),
      labelValue("football-data.org", footballDataValue, footballDataCaption, footballDataVerified ? "positive" : ""),
    );

    const footer = element("div", "card-footer");
    const odd = element("div", "odd-panel");
    odd.append(
      element("span", "", `Odd${candidate.bookmaker ? ` · ${candidate.bookmaker}` : ""}`),
      element("strong", "", candidate.odds ? formatNumber(candidate.odds, 2) : "—"),
      element("small", "", candidate.impliedProbability ? `${formatNumber(candidate.impliedProbability)}% implícita` : "mercado indisponível"),
    );
    const confidence = element("div", "confidence-panel");
    const confidenceValue = Math.max(0, Math.min(1, Number(candidate.dataConfidence) || 0));
    const track = element("div", "confidence-track");
    const bar = element("i");
    bar.style.width = `${Math.round(confidenceValue * 100)}%`;
    track.append(bar);
    confidence.append(element("span", "", "Confiança dos dados"), track, element("small", "", `${Math.round(confidenceValue * 100)}% de sinais disponíveis`));
    footer.append(odd, confidence);

    const notes = element("div", "card-notes");
    (Array.isArray(candidate.reasons) ? candidate.reasons : []).slice(0, 2).forEach((reason) => notes.append(element("span", "reason", `+ ${reason}`)));
    (Array.isArray(candidate.caveats) ? candidate.caveats : []).slice(0, 2).forEach((caveat) => notes.append(element("span", "caveat", `! ${caveat}`)));
    article.append(top, heading, recommendation, classification, buildChecks(candidate), signals, footer, notes);
    return article;
  }

  function emptyState(title, description, failed) {
    const box = element("div", `empty-state${failed ? " failed" : ""}`);
    if (!failed) box.append(element("span", "empty-pulse"));
    box.append(element("h2", "", title), element("p", "", description));
    return box;
  }

  function matchingLeague(item) {
    return state.league === "all" || leagueKey(item) === state.league;
  }

  function renderScreening() {
    screening.replaceChildren();
    const payload = state.payload;
    if (!payload) return;
    const fixtures = (Array.isArray(payload.screenedFixtures) ? payload.screenedFixtures : []).filter(matchingLeague);
    screeningMeta.textContent = fixtures.length
      ? `${fixtures.length} jogo(s) detectado(s) no recorte atual. Jogos priorizados recebem Tier; os demais permanecem visíveis como “fora do escopo”, sem consumir quota.`
      : "Nenhum jogo detectado para o campeonato selecionado na última varredura.";
    if (!fixtures.length) {
      screening.append(emptyState("Sem jogos no recorte.", "Altere o campeonato ou aguarde a próxima varredura cacheada.", false));
      return;
    }
    const table = element("div", "screen-table");
    const header = element("div", "screen-row screen-head");
    ["Campeonato", "Jogo", "Horário", "Situação", "Decisão"].forEach((label) => header.append(element("span", "", label)));
    table.append(header);
    fixtures.forEach((fixture) => {
      const row = element("div", "screen-row");
      const competition = element("div", "screen-competition");
      competition.append(element("strong", "", fixture.league || "Competição"), element("small", "", fixture.country || "Internacional"));
      const match = element("div", "screen-match");
      match.append(element("strong", "", `${fixture.homeName || "Mandante"} × ${fixture.awayName || "Visitante"}`));
      const kickoff = element("span", "screen-kickoff", fixture.kickoff ? ptShortDate.format(new Date(fixture.kickoff)) : "—");
      const analyzed = fixture.analysisStatus === "analisado";
      const outOfScope = fixture.analysisStatus === "fora_de_escopo";
      const status = element("div", `screen-status ${analyzed ? "analyzed" : "pending"}`);
      if (analyzed) {
        status.append(element("strong", "", `Analisado · Tier ${fixture.tier}`), element("small", "", `${formatNumber(fixture.probability)}% · ${Math.round((Number(fixture.dataConfidence) || 0) * 100)}% cobertura`));
      } else if (outOfScope) {
        status.append(element("strong", "", "Fora do escopo"), element("small", "", "campeonato não priorizado"));
      } else {
        status.append(element("strong", "", "Aguardando publicação"), element("small", "", "rotina noturna pendente"));
      }
      const decision = element("div", "screen-decision", analyzed ? (fixture.classificationLabel || "Analisado") : fixture.screeningReason);
      row.append(competition, match, kickoff, status, decision);
      table.append(row);
    });
    screening.append(table);
  }

  function render() {
    dashboard.replaceChildren();
    const payload = state.payload;
    if (!payload) {
      dashboard.append(emptyState("Ainda não há leitura para exibir.", "O feed público não retornou uma análise.", false));
      return;
    }
    const candidates = (Array.isArray(payload.candidates) ? payload.candidates : [])
      .filter((candidate) => matchingLeague(candidate))
      .filter((candidate) => state.tier === "all" || String(candidate.tier) === state.tier);
    if (!candidates.length) {
      const filtered = state.tier !== "all";
      const title = filtered ? `Nenhuma análise Tier ${state.tier} neste recorte.` : "Nenhuma análise detalhada neste recorte.";
      const details = filtered
        ? "Altere o tier ou o campeonato. O mapa abaixo mantém os jogos que aguardam a publicação noturna."
        : "Ainda não existe uma publicação concluída para este recorte. O mapa abaixo mostra o estado da varredura.";
      dashboard.append(emptyState(title, details, false));
    } else {
      const grid = element("section", "candidate-grid");
      candidates.forEach((candidate) => grid.append(buildCandidate(candidate)));
      dashboard.append(grid);
    }
    renderScreening();
  }

  function syncLeagueOptions(payload) {
    const items = [...(Array.isArray(payload.candidates) ? payload.candidates : []), ...(Array.isArray(payload.screenedFixtures) ? payload.screenedFixtures : [])];
    const unique = new Map();
    items.forEach((item) => unique.set(leagueKey(item), leagueLabel(item)));
    leagueFilter.replaceChildren();
    const all = element("option", "", "Todos os campeonatos");
    all.value = "all";
    leagueFilter.append(all);
    [...unique.entries()].sort((left, right) => left[1].localeCompare(right[1], "pt-BR")).forEach(([key, label]) => {
      const option = element("option", "", label);
      option.value = key;
      leagueFilter.append(option);
    });
    if (!unique.has(state.league)) state.league = "all";
    leagueFilter.value = state.league;
  }

  function setSummary(payload) {
    numbers.screened.textContent = String(payload.screenedCount ?? 0);
    numbers.analyzed.textContent = String(payload.analyzedCount ?? 0);
    numbers.verified.textContent = String(payload.verifiedCount ?? 0);
    numbers.qualified.textContent = String(payload.qualifiedCount ?? 0);
    numbers.updated.textContent = payload.sourceUpdatedAt ? ptShortDate.format(new Date(payload.sourceUpdatedAt)) : (payload.scanUpdatedAt ? ptShortDate.format(new Date(payload.scanUpdatedAt)) : "sem leitura");
    tierButtons.forEach((button) => {
      const tier = button.dataset.tier || "all";
      button.textContent = tier === "all" ? "Todos" : `T${tier} · ${payload.tierCounts?.[tier] ?? 0}`;
    });
  }

  function renderStatsBombSource(payload) {
    const source = payload.statsbomb || {};
    const aggregated = Number(source.matchesAggregated) || 0;
    const discovered = Number(source.matchesDiscovered) || 0;
    const profiles = Number(source.teamProfiles) || 0;
    const coverage = aggregated
      ? `${aggregated} partidas agregadas · ${profiles} perfis de equipe. O sinal só entra quando os dois times têm cobertura histórica suficiente.`
      : "Catálogo histórico em sincronização. Até existir cobertura dos dois times, este sinal não altera a probabilidade.";
    statsbombStatus.textContent = `${source.mode || "histórico seletivo"} · ${aggregated}/${discovered || "—"} partidas processadas. ${coverage}`;
    statsbombSource.classList.toggle("ready", aggregated > 0);
  }

  function renderFootballDataSource(payload) {
    const source = payload.footballData || {};
    const verified = Number(source.verifiedAnalyses) || 0;
    const partial = Number(source.partialAnalyses) || 0;
    const coverage = verified
      ? `${verified} análise(s) com tabela e forma confirmadas; ${partial} parcial(is).`
      : "A fonte será aplicada apenas a competições mapeadas e cobertas pelo plano; nenhuma chave ou resposta bruta é exposta aqui.";
    footballDataStatus.textContent = `${source.mode || "tabela e forma por competição"} · ${coverage}`;
    footballDataSource.classList.toggle("ready", verified > 0);
  }

  function renderPublication(payload) {
    const publication = payload.publication || {};
    const schedule = payload.schedule || {};
    const date = publication.targetDate ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" }).format(new Date(`${publication.targetDate}T12:00:00-03:00`)) : null;
    const published = Number(publication.analysesPublished) || 0;
    const detected = Number(publication.fixturesDetected) || 0;
    if (publication.status === "completed") {
      publicationCopy.textContent = `${date ? `Dia-alvo ${date}: ` : ""}${published}/${detected} jogos prioritários receberam Tier. A publicação ocorre às ${schedule.nextDayScan || "23:30"} BRT; a conferência de resultado roda às ${(schedule.resultChecks || []).join(", ")} BRT.`;
    } else if (publication.status === "running") {
      publicationCopy.textContent = `${date ? `Dia-alvo ${date}: ` : ""}varredura em andamento. O feed só trata a análise como publicada quando a rotina termina.`;
    } else if (publication.status === "failed") {
      publicationCopy.textContent = "A última varredura não foi concluída. Nenhum resultado será atribuído a uma análise inexistente; verifique a próxima execução programada.";
    } else {
      publicationCopy.textContent = `A próxima varredura cria o mapa do dia seguinte às ${schedule.nextDayScan || "23:30"} BRT. Jogos prioritários recebem Tier 1–4, inclusive quando não atingem a meta.`;
    }
  }

  function renderResults(payload) {
    results.replaceChildren();
    const resultData = payload.results || {};
    const green = Number(resultData.greenCount) || 0;
    const red = Number(resultData.redCount) || 0;
    const pending = Number(resultData.pendingCount) || 0;
    resultsMeta.textContent = `${green} green · ${red} red · ${pending} aguardando. Mercado 1X2: somente 90 minutos e acréscimos.`;
    const history = Array.isArray(resultData.history) ? resultData.history : [];
    if (!history.length) {
      results.append(emptyState("Ainda não há publicação liquidada.", "Quando um jogo publicado terminar, a rotina registrará Green, Red ou Anulado sem reescrever a análise original.", false));
      return;
    }
    const table = element("div", "result-table");
    const header = element("div", "result-row result-head");
    ["Campeonato", "Jogo", "Publicação", "Tier", "Resultado 90'", "Liquidação"].forEach((label) => header.append(element("span", "", label)));
    table.append(header);
    history.forEach((item) => {
      const row = element("div", "result-row");
      const competition = element("div");
      competition.append(element("strong", "", item.league || "Competição"), element("small", "", item.country || "Internacional"));
      const match = element("div");
      match.append(element("strong", "", `${item.homeName || "Mandante"} × ${item.awayName || "Visitante"}`), element("small", "", item.kickoff ? ptShortDate.format(new Date(item.kickoff)) : ""));
      const publication = element("div");
      publication.append(element("strong", "", item.favoriteName || "—"), element("small", "", `${item.market || "1X2"} · ${formatNumber(item.probability)}%`));
      const tier = element("span", `tier-badge tier-${item.tier || 4}`, `Tier ${item.tier || "—"}`);
      const score = element("div");
      score.append(element("strong", "", Number.isFinite(Number(item.homeScore90)) && Number.isFinite(Number(item.awayScore90)) ? `${item.homeScore90} × ${item.awayScore90}` : "—"), element("small", "", "90 min. + acréscimos"));
      const status = String(item.settlement || "void");
      const statusLabel = { green: "GREEN", red: "RED", void: "ANULADO" }[status] || "ANULADO";
      const outcome = element("div", `result-outcome ${status}`, statusLabel);
      outcome.append(element("small", "", item.note || ""));
      row.append(competition, match, publication, tier, score, outcome);
      table.append(row);
    });
    results.append(table);
  }

  const ownerHeaders = () => ({
    apikey: config.publishableKey,
    Authorization: `Bearer ${ownerToken}`,
    "Content-Type": "application/json",
  });

  async function ownerRpc(name, body = {}) {
    const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST", headers: ownerHeaders(), body: JSON.stringify(body), credentials: "omit",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message || `Acesso indisponível (${response.status})`);
    return payload;
  }

  function updateModelForProvider() {
    const defaults = { openai: "gpt-4.1-mini", deepseek: "deepseek-chat", google: "gemini-2.0-flash" };
    aiModel.value = defaults[aiProvider.value] || "";
  }

  function clearOwnerSession(message = "Sessão do proprietário encerrada.") {
    ownerToken = "";
    sessionStorage.removeItem("apitoleiro_owner_access_token");
    ownerAuthPanel.hidden = false;
    aiForm.hidden = true;
    ownerAuthMessage.textContent = message;
  }

  async function renderOwnerSettings() {
    if (!ownerToken) return;
    try {
      const settings = await ownerRpc("get_ai_provider_settings");
      if (!settings?.isAdmin) {
        clearOwnerSession("Este e-mail não possui permissão de proprietário.");
        return;
      }
      ownerAuthPanel.hidden = true;
      aiForm.hidden = false;
      if (settings.provider) aiProvider.value = settings.provider;
      if (settings.model) aiModel.value = settings.model;
      aiEnabled.checked = settings.enabled === true;
      aiMaxReviews.value = String(settings.maxReviewsPerRun ?? 0);
      aiSettingsStatus.textContent = settings.encryptionReady
        ? (settings.configured ? `Chave configurada em ${settings.configuredAt ? ptShortDate.format(new Date(settings.configuredAt)) : "data não informada"}. Informe outra chave apenas para substituir a atual.` : "Nenhuma chave configurada. A análise estatística continua independente.")
        : "Falta preparar a chave mestra de criptografia no Vault; a chave de provedor não será aceita antes disso.";
      aiApiKey.required = !settings.configured;
    } catch (error) {
      clearOwnerSession(error instanceof Error ? error.message : "Não foi possível validar a sessão.");
    }
  }

  async function importOwnerSessionFromUrl() {
    const fragment = new URLSearchParams(window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "");
    const accessToken = fragment.get("access_token");
    if (accessToken) {
      ownerToken = accessToken;
      sessionStorage.setItem("apitoleiro_owner_access_token", ownerToken);
      history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
    }
    if (ownerToken) await renderOwnerSettings();
  }

  async function load() {
    if (!config?.supabaseUrl || !config?.publishableKey) {
      dashboard.replaceChildren(emptyState("Configuração pública ausente.", "A página não encontrou o contrato do Supabase.", true));
      return;
    }
    refreshButton.disabled = true;
    refreshButton.textContent = "Atualizando…";
    try {
      const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/get_public_tipster_dashboard`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        headers: {
          apikey: config.publishableKey,
          Authorization: `Bearer ${config.publishableKey}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      if (!response.ok) throw new Error(`Feed indisponível (${response.status})`);
      const payload = await response.json();
      if (!payload || payload.schemaVersion !== 6 || !Array.isArray(payload.candidates) || !Array.isArray(payload.screenedFixtures) || !payload.statsbomb || !payload.footballData || !payload.results) throw new Error("Formato de feed inválido");
      state.payload = payload;
      setSummary(payload);
      renderStatsBombSource(payload);
      renderFootballDataSource(payload);
      renderPublication(payload);
      renderResults(payload);
      syncLeagueOptions(payload);
      render();
    } catch (error) {
      dashboard.replaceChildren(emptyState("Não foi possível carregar o radar.", "A leitura pública será tentada novamente quando você clicar em atualizar.", true));
      screening.replaceChildren();
      results.replaceChildren();
      console.warn("APITOLHEIRO public dashboard", error instanceof Error ? error.message : "unknown error");
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = "Atualizar leitura";
    }
  }

  tierButtons.forEach((button) => button.addEventListener("click", () => {
    state.tier = button.dataset.tier || "all";
    tierButtons.forEach((item) => item.classList.toggle("selected", item === button));
    render();
  }));
  leagueFilter.addEventListener("change", () => {
    state.league = leagueFilter.value || "all";
    render();
  });
  ownerAccess.addEventListener("click", () => {
    ownerDialog.showModal();
    void renderOwnerSettings();
  });
  ownerClose.addEventListener("click", () => ownerDialog.close());
  ownerDialog.addEventListener("click", (event) => {
    if (event.target === ownerDialog) ownerDialog.close();
  });
  ownerLink.addEventListener("click", async () => {
    const email = ownerEmail.value.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      ownerAuthMessage.textContent = "Informe um e-mail válido para receber o link.";
      return;
    }
    ownerLink.disabled = true;
    ownerLink.textContent = "Enviando…";
    try {
      const response = await fetch(`${config.supabaseUrl}/auth/v1/otp`, {
        method: "POST",
        credentials: "omit",
        headers: { apikey: config.publishableKey, Authorization: `Bearer ${config.publishableKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email, create_user: true, redirect_to: `${window.location.origin}${window.location.pathname}` }),
      });
      if (!response.ok) throw new Error("Não foi possível enviar o link de acesso.");
      ownerAuthMessage.textContent = "Link enviado. Abra-o neste mesmo navegador para liberar a área privada.";
    } catch (error) {
      ownerAuthMessage.textContent = error instanceof Error ? error.message : "Falha ao solicitar o link.";
    } finally {
      ownerLink.disabled = false;
      ownerLink.textContent = "Enviar link de acesso";
    }
  });
  aiProvider.addEventListener("change", updateModelForProvider);
  aiForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const apiKey = aiApiKey.value;
    if (!apiKey || apiKey.length < 12) {
      aiSettingsStatus.textContent = "Informe uma chave válida para salvar ou substituir a configuração.";
      return;
    }
    if (!window.confirm("Confirmar o envio desta chave ao cofre criptografado do Supabase? Ela não poderá ser visualizada depois.")) return;
    const submit = aiForm.querySelector("button[type='submit']");
    submit.disabled = true;
    try {
      const settings = await ownerRpc("save_ai_provider_credential", {
        p_provider: aiProvider.value,
        p_api_key: apiKey,
        p_model: aiModel.value.trim(),
        p_enabled: aiEnabled.checked,
        p_max_reviews_per_run: Number(aiMaxReviews.value),
      });
      aiApiKey.value = "";
      aiSettingsStatus.textContent = settings.enabled
        ? `Configuração salva. Até ${settings.maxReviewsPerRun} revisão(ões) de IA poderão rodar por publicação.`
        : "Configuração salva com revisão automática desligada.";
    } catch (error) {
      aiSettingsStatus.textContent = error instanceof Error ? error.message : "Não foi possível salvar a configuração.";
    } finally {
      submit.disabled = false;
    }
  });
  ownerSignout.addEventListener("click", () => clearOwnerSession());
  refreshButton.addEventListener("click", () => void load());
  void importOwnerSessionFromUrl();
  void load();
})();
