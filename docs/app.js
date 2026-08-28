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
  const refreshButton = document.querySelector("#refresh-button");
  const leagueFilter = document.querySelector("#league-filter");
  const tierButtons = [...document.querySelectorAll("[data-tier]")];
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
    if (name === "coverageThreshold") return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : "—";
    if (name === "oddsRange") return Number.isFinite(Number(value)) ? formatNumber(value, 2) : "sem odd";
    return Number.isFinite(Number(value)) ? `${formatNumber(value)}%` : "—";
  }

  function buildChecks(candidate) {
    const checks = candidate.checks || {};
    const list = element("div", "decision-checks");
    ["modelThreshold", "coverageThreshold", "oddsRange"].forEach((name) => {
      const check = checks[name] || {};
      const passed = check.passed === true;
      const chip = element("div", `decision-check ${passed ? "pass" : "fail"}`);
      chip.append(
        element("span", "", check.label || "Critério"),
        element("strong", "", checkValue(name, check.value)),
        element("small", "", passed ? "atende" : "não atende"),
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
      ? `${fixtures.length} jogo(s) detectado(s) no recorte atual. “Aguardando detalhamento” significa que não houve consumo adicional de API naquele jogo.`
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
      const status = element("div", `screen-status ${fixture.analysisStatus === "analisado" ? "analyzed" : "pending"}`);
      if (fixture.analysisStatus === "analisado") {
        status.append(element("strong", "", `Analisado · Tier ${fixture.tier}`), element("small", "", `${formatNumber(fixture.probability)}% · ${Math.round((Number(fixture.dataConfidence) || 0) * 100)}% cobertura`));
      } else {
        status.append(element("strong", "", "Aguardando detalhamento"), element("small", "", "priorização por quota"));
      }
      const decision = element("div", "screen-decision", fixture.analysisStatus === "analisado" ? (fixture.classificationLabel || "Analisado") : fixture.screeningReason);
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
        ? "Altere o tier ou o campeonato. Jogos detectados sem análise detalhada continuam visíveis no mapa abaixo."
        : "O mapa abaixo separa os jogos aguardando detalhamento para preservar a quota diária.";
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
      if (!payload || payload.schemaVersion !== 4 || !Array.isArray(payload.candidates) || !Array.isArray(payload.screenedFixtures) || !payload.statsbomb || !payload.footballData) throw new Error("Formato de feed inválido");
      state.payload = payload;
      setSummary(payload);
      renderStatsBombSource(payload);
      renderFootballDataSource(payload);
      syncLeagueOptions(payload);
      render();
    } catch (error) {
      dashboard.replaceChildren(emptyState("Não foi possível carregar o radar.", "A leitura pública será tentada novamente quando você clicar em atualizar.", true));
      screening.replaceChildren();
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
  refreshButton.addEventListener("click", () => void load());
  void load();
})();
