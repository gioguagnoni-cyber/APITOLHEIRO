"use client";

import { useEffect, useMemo, useState } from "react";
import type { DashboardPayload, FixtureInsight, RecentMetrics } from "@/lib/types";

const formatKickoff = (value: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

const formatTimestamp = (value: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(value));

const record = (metrics: RecentMetrics | null, venue = false) => {
  if (!metrics || metrics.unavailable) return "—";
  const total = venue ? metrics.venueTotal : metrics.total;
  const wins = venue ? metrics.venueWins : metrics.wins;
  return wins + "V / " + total;
};

const strengthTone = (strength: FixtureInsight["metrics"]["opponentStrength"]) => {
  if (strength.includes("baixa")) return "positive";
  if (strength.includes("alta")) return "negative";
  return "neutral";
};

function CandidateCard({ candidate }: { candidate: FixtureInsight }) {
  const favoriteIsHome = candidate.favorite === "home";
  const last10 = candidate.metrics.last10;
  const venue = candidate.metrics.venueLast5;

  return (
    <article className={"candidate-card tier-" + candidate.tier}>
      <div className="card-topline">
        <span>{candidate.country || "Internacional"} · {candidate.league}</span>
        <span>{formatKickoff(candidate.kickoff)}</span>
      </div>

      <div className="fixture-heading">
        <div className="team-side home">
          <span className="team-avatar">{candidate.home.name.slice(0, 1)}</span>
          <div>
            <strong>{candidate.home.name}</strong>
            <small>{candidate.home.position ? candidate.home.position + "º na tabela" : "posição indisponível"}</small>
          </div>
        </div>
        <div className="versus">×</div>
        <div className="team-side away">
          <div>
            <strong>{candidate.away.name}</strong>
            <small>{candidate.away.position ? candidate.away.position + "º na tabela" : "posição indisponível"}</small>
          </div>
          <span className="team-avatar">{candidate.away.name.slice(0, 1)}</span>
        </div>
      </div>

      <div className="recommendation">
        <div>
          <span className="eyebrow">Lado modelado</span>
          <strong>{candidate.favoriteName}</strong>
          <small>{candidate.recommendedMarket}</small>
        </div>
        <div className="probability">
          <span>{candidate.probability}%</span>
          <small>probabilidade do modelo</small>
        </div>
        <div className={"tier-badge tier-" + candidate.tier}>Tier {candidate.tier}</div>
      </div>

      <div className="signal-grid">
        <div className="signal">
          <span>Últimos 10</span>
          <strong>{record(last10)}</strong>
          <small>{last10 ? last10.wins + "V " + last10.draws + "E " + last10.losses + "D" : "sem histórico"}</small>
        </div>
        <div className="signal">
          <span>Últimos 5 no mando</span>
          <strong>{record(venue, true)}</strong>
          <small>{favoriteIsHome ? "em casa" : "fora de casa"}</small>
        </div>
        <div className="signal">
          <span>Dif. de tabela</span>
          <strong>{candidate.metrics.tableGap === null ? "—" : (candidate.metrics.tableGap >= 0 ? "+" : "") + candidate.metrics.tableGap}</strong>
          <small>posições</small>
        </div>
        <div className={"signal " + strengthTone(candidate.metrics.opponentStrength)}>
          <span>Força rival</span>
          <strong>{candidate.metrics.opponentStrength}</strong>
          <small>proxy de tabela</small>
        </div>
        <div className="signal">
          <span>{candidate.metrics.xg.mode === "xg" ? "xG diferencial" : "Criação"}</span>
          <strong>{candidate.metrics.xg.value === null ? "—" : (candidate.metrics.xg.value > 0 ? "+" : "") + candidate.metrics.xg.value}</strong>
          <small>{candidate.metrics.xg.mode === "proxy" ? "proxy" : candidate.metrics.xg.mode}</small>
        </div>
        <div className="signal">
          <span>Escalação</span>
          <strong>{candidate.metrics.lineup.status}</strong>
          <small>{candidate.metrics.lineup.unavailableCount === null ? "lesões indisponíveis" : candidate.metrics.lineup.unavailableCount + " baixas listadas"}</small>
        </div>
      </div>

      <div className="card-footer">
        <div className="odd-panel">
          <span>Odd {candidate.bookmaker ? "· " + candidate.bookmaker : ""}</span>
          <strong>{candidate.odds ? candidate.odds.toFixed(2) : "—"}</strong>
          <small>{candidate.impliedProbability ? candidate.impliedProbability + "% implícita" : "mercado indisponível"}</small>
        </div>
        <div className="confidence-panel">
          <span>Confiança dos dados</span>
          <div className="confidence-track"><i style={{ width: Math.round(candidate.dataConfidence * 100) + "%" }} /></div>
          <small>{Math.round(candidate.dataConfidence * 100)}% de sinais disponíveis</small>
        </div>
      </div>

      <div className="card-notes">
        {candidate.reasons.slice(0, 2).map((reason) => <span key={reason} className="reason">+ {reason}</span>)}
        {candidate.caveats.slice(0, 2).map((caveat) => <span key={caveat} className="caveat">! {caveat}</span>)}
      </div>
    </article>
  );
}

function EmptyState({ setupRequired }: { setupRequired: boolean }) {
  return (
    <div className="empty-state">
      <span className="empty-pulse" />
      <h2>{setupRequired ? "Conecte as credenciais do servidor" : "Aguardando a primeira análise verificada"}</h2>
      <p>
        {setupRequired
          ? "Defina SUPABASE_URL, SUPABASE_SECRET_KEY, API_FOOTBALL_KEY e CRON_SECRET apenas no ambiente do servidor. Nenhuma chave deve ir ao navegador."
          : "O cron protegido executa diariamente às 08:00 (BRT), usando cache e um teto operacional de 90 das 100 chamadas disponíveis."}
      </p>
    </div>
  );
}

export default function HomePage() {
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState(false);
  const [tier, setTier] = useState<"all" | 1 | 2 | 3 | 4>("all");

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch("/api/dashboard", { cache: "no-store" });
        if (!response.ok) throw new Error("Dashboard unavailable");
        setDashboard((await response.json()) as DashboardPayload);
      } catch {
        setError(true);
      }
    };
    void load();
  }, []);

  const candidates = useMemo(
    () => (dashboard?.candidates || []).filter((candidate) => tier === "all" || candidate.tier === tier),
    [dashboard, tier],
  );
  const tierOneCount = dashboard?.candidates.filter((candidate) => candidate.tier === 1).length || 0;

  return (
    <main>
      <section className="shell">
        <header className="masthead">
          <div className="brand">
            <span className="brand-mark"><i /><i /><i /></span>
            <span>APITOLHEIRO <b>LAB</b></span>
          </div>
          <div className="live-status">
            <span className="live-dot" />
            Análise pré-jogo · dados cacheados
          </div>
        </header>

        <section className="hero">
          <div>
            <p className="kicker">TIPSTER INTELLIGENCE</p>
            <h1>Leitura rápida.<br /><em>Decisão consciente.</em></h1>
            <p className="hero-copy">Uma fila visual de jogos, com sinais ponderados — nunca filtros cegos. Probabilidade é estimativa do modelo, não promessa de resultado.</p>
          </div>
          <div className="hero-stat">
            <span>Prioridade</span>
            <strong>≥ 75%</strong>
            <small>com odd entre 1,30 e 2,90</small>
          </div>
        </section>

        <section className="status-strip">
          <div><span>Jogos analisados</span><strong>{dashboard ? dashboard.candidates.length : "—"}</strong></div>
          <div><span>Tier 1 hoje</span><strong>{dashboard ? tierOneCount : "—"}</strong></div>
          <div><span>Quota API</span><strong>{dashboard ? dashboard.usedRequests + " / " + dashboard.dailyLimit : "—"}</strong></div>
          <div><span>Última leitura</span><strong>{dashboard ? formatTimestamp(dashboard.generatedAt) : "carregando"}</strong></div>
        </section>

        <section className="content-header">
          <div>
            <p className="kicker">RADAR DE HOJE</p>
            <h2>Candidatos ordenados por sinal composto</h2>
          </div>
          <div className="tier-filters" aria-label="Filtrar por tier">
            {(["all", 1, 2, 3, 4] as const).map((value) => (
              <button key={String(value)} className={tier === value ? "selected" : ""} onClick={() => setTier(value)}>
                {value === "all" ? "Todos" : "T" + value}
              </button>
            ))}
          </div>
        </section>

        {error ? (
          <div className="empty-state"><h2>Não foi possível carregar o radar.</h2><p>Tente novamente após verificar a configuração do servidor.</p></div>
        ) : !dashboard ? (
          <div className="loading-grid">{[1, 2, 3].map((item) => <div className="loading-card" key={item} />)}</div>
        ) : candidates.length ? (
          <section className="candidate-grid">{candidates.map((candidate) => <CandidateCard key={candidate.fixtureId} candidate={candidate} />)}</section>
        ) : (
          <EmptyState setupRequired={dashboard.setupRequired} />
        )}

        <section className="method">
          <div>
            <p className="kicker">COMO LER</p>
            <h2>Compensação, não checklist.</h2>
          </div>
          <p>Forma, mando, tabela, preço de mercado, força rival, disponibilidade e criação contribuem com pesos. Um sinal fraco pode ser compensado por outros; dados ausentes reduzem a confiança em vez de serem tratados como positivos.</p>
        </section>
      </section>
    </main>
  );
}
