(() => {
  "use strict";

  const config = window.APITOLHEIRO_PUBLIC_CONFIG;
  const state = { payload: null, tier: "all" };
  const dashboard = document.querySelector("#dashboard");
  const refreshButton = document.querySelector("#refresh-button");
  const tierButtons = [...document.querySelectorAll("[data-tier]")];
  const numbers = {
    analyzed: document.querySelector("#analyzed-count"),
    verified: document.querySelector("#verified-count"),
    tierOne: document.querySelector("#tier-one-count"),
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

  function buildCandidate(candidate) {
    const metrics = candidate.metrics || {};
    const last10 = record(metrics.last10, false);
    const venue = record(metrics.venueLast5, true);
    const favoriteIsHome = candidate.favorite === "home";
    const xg = metrics.xg || {};
    const lineup = metrics.lineup || {};
    const article = element("article", `candidate-card tier-${candidate.tier}`);

    const top = element("div", "card-topline");
    top.append(
      element("span", "", `${candidate.country || "Internacional"} · ${candidate.league || "Competição"}`),
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

    const signals = element("div", "signal-grid");
    signals.append(
      labelValue("Últimos 10", last10.main, last10.detail),
      labelValue("Últimos 5 no mando", venue.main, favoriteIsHome ? "em casa" : "fora de casa"),
      labelValue("Dif. de tabela", metrics.tableGap === null || metrics.tableGap === undefined ? "—" : `${Number(metrics.tableGap) >= 0 ? "+" : ""}${metrics.tableGap}`, "posições"),
      labelValue("Força rival", metrics.opponentStrength || "indisponível", "proxy de tabela", strengthTone(metrics.opponentStrength)),
      labelValue(xg.mode === "xg" ? "xG diferencial" : "Criação", xg.value === null || xg.value === undefined ? "—" : `${Number(xg.value) > 0 ? "+" : ""}${formatNumber(xg.value, 2)}`, xg.mode === "proxy" ? "proxy de criação" : (xg.mode || "indisponível")),
      labelValue("Escalação", lineup.status || "indisponível", lineup.unavailableCount === null || lineup.unavailableCount === undefined ? "baixas indisponíveis" : `${lineup.unavailableCount} baixas listadas`),
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
    article.append(top, heading, recommendation, signals, footer, notes);
    return article;
  }

  function emptyState(title, description, failed) {
    const box = element("div", `empty-state${failed ? " failed" : ""}`);
    if (!failed) box.append(element("span", "empty-pulse"));
    box.append(element("h2", "", title), element("p", "", description));
    return box;
  }

  function render() {
    dashboard.replaceChildren();
    const payload = state.payload;
    if (!payload) {
      dashboard.append(emptyState("Ainda não há leitura para exibir.", "O feed público não retornou uma análise verificável.", false));
      return;
    }
    const candidates = (Array.isArray(payload.candidates) ? payload.candidates : []).filter((candidate) => state.tier === "all" || String(candidate.tier) === state.tier);
    if (!candidates.length) {
      const filtered = state.tier !== "all";
      const title = filtered ? `Nenhum candidato Tier ${state.tier} no momento.` : "Aguardando uma análise verificada.";
      const details = filtered
        ? "Altere o filtro para ver outros tiers ou atualize a leitura cacheada."
        : `${payload.analyzedCount || 0} jogo(s) foram lidos, mas ${payload.verifiedCount || 0} atingiram a cobertura mínima de dados.`;
      dashboard.append(emptyState(title, details, false));
      return;
    }
    const grid = element("section", "candidate-grid");
    candidates.forEach((candidate) => grid.append(buildCandidate(candidate)));
    dashboard.append(grid);
  }

  function setSummary(payload) {
    numbers.analyzed.textContent = String(payload.analyzedCount ?? 0);
    numbers.verified.textContent = String(payload.verifiedCount ?? 0);
    numbers.tierOne.textContent = String(payload.tierOneCount ?? 0);
    numbers.updated.textContent = payload.sourceUpdatedAt ? ptShortDate.format(new Date(payload.sourceUpdatedAt)) : "sem leitura";
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
      if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.candidates)) throw new Error("Formato de feed inválido");
      state.payload = payload;
      setSummary(payload);
      render();
    } catch (error) {
      dashboard.replaceChildren(emptyState("Não foi possível carregar o radar.", "A leitura pública será tentada novamente quando você clicar em atualizar.", true));
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
  refreshButton.addEventListener("click", () => void load());
  void load();
})();
