# APITOLHEIRO Lab

Dashboard pré-jogo para organizar sinais de tipster. Ele não promete retorno, acerto ou probabilidade real: a porcentagem exibida é uma estimativa explicável do modelo v1.

## O que a V1 faz

- Varre os jogos do dia e aprofunda o candidato prioritário por execução no plano gratuito. O limite de 10 chamadas/minuto da API-Football é respeitado com até 9 chamadas sequenciais; planos superiores podem ampliar API_FOOTBALL_MAX_REQUESTS_PER_RUN.
- Mede forma nos últimos 10, recorte dos últimos 5 no mando relevante, diferença de tabela, odd de Match Winner, força do rival, baixas, escalação perto do início e um proxy de criação quando não há xG oficial.
- Pondera sinais disponíveis. Ausência de dados reduz a confiança; não vira sinal positivo.
- Mostra Tier 1–4. Tier 1 exige estimativa >=75%, confiança de dados >=65% e odd entre 1,30 e 2,90. Os valores alimentam o score, não são filtros rígidos para os demais tiers. A tela mantém também os Tiers não qualificados, com o motivo e os critérios que passaram ou falharam.
- Mantém cache por endpoint, registra todas as chamadas efetivas e reserva quota atomicamente antes de chamar o provedor.

## Segurança

- API-Football e o segredo de cron ficam no Supabase Vault; nenhum deles é enviado ao GitHub Pages, ao navegador ou ao repositório.
- Todas as tabelas do schema public usam RLS e não têm política pública. Só o backend com service role lê e escreve.
- As RPCs de quota e de leitura de segredo são SECURITY DEFINER com `search_path` fixo e EXECUTE revogado de PUBLIC, anon e authenticated.
- A Edge Function `refresh-radar` só aceita `Authorization: Bearer CRON_SECRET`, enviado pelo Supabase Cron. Não há botão público que possa consumir a quota.

## Entrega pública via GitHub Pages

A interface pública oficial está em `docs/`, como no modelo de entrega do DASHNAVE. O GitHub Pages serve arquivos estáticos e a página consulta somente a RPC `get_public_tipster_dashboard` no Supabase.

- A página não chama a API-Football, não conhece o segredo de cron e não tem acesso às tabelas operacionais.
- O Supabase expõe somente um JSON limitado: até 32 leituras atuais em todos os Tiers e até 80 jogos da última varredura, agrupáveis por campeonato. Jogos detectados que ainda não receberam análise detalhada aparecem como “aguardando priorização”; não recebem Tier artificialmente. Cache, logs de uso, payloads do provedor e credenciais permanecem privados.
- `docs/config.js` contém somente a URL do projeto e uma chave `sb_publishable`, projetada pelo Supabase para uso em navegador. A proteção está nas permissões da RPC e no contrato fixo que ela retorna.
- Configure GitHub Pages para publicar a branch `main`, pasta `/docs`. A URL esperada é `https://gioguagnoni-cyber.github.io/APITOLHEIRO/`.

## Configuração

O frontend não requer servidor externo ou Vercel. A atualização diária é feita pela Edge Function do Supabase e pelo `pg_cron`.

1. No Supabase, abra **SQL Editor** e crie os três valores no Vault (substitua apenas os textos entre aspas):

   ```sql
   select vault.create_secret('SUA_CHAVE_API_FOOTBALL', 'apitolheiro_api_football_key');
   select vault.create_secret('SEU_CRON_SECRET', 'apitolheiro_cron_secret');
   select vault.create_secret('https://lngivvahbetcujweejim.supabase.co', 'apitolheiro_project_url');
   ```

2. Avise que os valores foram registrados. Então aplique a migração `20260828011600_schedule_edge_refresh.sql` e execute uma primeira atualização autenticada para validar os dados.

O job roda diariamente às 11:00 UTC (08:00 BRT). A função publicada é `refresh-radar`; ela usa as chaves internas já disponibilizadas pelo runtime do Supabase e não precisa de configuração no navegador.

O banco já possui as migrações em supabase/migrations. A aplicação usa um teto padrão de 90 chamadas/dia, propositalmente abaixo das 100 fornecidas pelo plano gratuito.

## Desenvolvimento

    npm install
    npm run test:static

## Limites de dados

Cobertura de odds, previsões, lesões e escalações varia por competição. A ingestão usa cache por endpoint e interrompe novas chamadas ao atingir a margem de segurança. xG oficial não é presumido: a V1 sinaliza proxy de criação quando esse dado não estiver disponível.
