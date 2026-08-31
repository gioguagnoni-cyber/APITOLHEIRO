# APITOLHEIRO Lab

Dashboard pré-jogo para organizar sinais de tipster. Ele não promete retorno, acerto ou probabilidade real: a porcentagem exibida é uma estimativa explicável do modelo v1.

## O que a V1 faz

- Às 23:30 BRT, varre todos os jogos do dia seguinte nas competições prioritárias já configuradas e publica um Tier 1–4 para cada jogo encontrado. A rotina reutiliza tabela e calendário da temporada por campeonato para calcular forma e mando de todos os confrontos com menos chamadas; previsões entram enquanto houver orçamento seguro.
- Mede forma nos últimos 10, recorte dos últimos 5 no mando relevante, diferença de tabela, força do rival, baixas, escalação perto do início e um proxy de criação quando não há xG oficial.
- Pondera sinais disponíveis. Ausência de dados reduz a confiança; não vira sinal positivo.
- Mostra Tier 1–4. As três regras obrigatórias iniciam em Tier 3; os sinais esportivos complementares podem elevar a Tier 2 ou 1. A estimativa de probabilidade e a confiança dos dados são informativas, não promessas de resultado. A tela mantém também os Tiers não qualificados, com o motivo e os critérios que passaram ou falharam.
- Mantém cache por endpoint, registra todas as chamadas efetivas e reserva quota atomicamente antes de chamar o provedor.
- Sincroniza o catálogo e agregados históricos do StatsBomb Open Data em uma Edge Function separada. São guardadas métricas derivadas por partida e por equipe (xG, finalizações, passes completos e pressões), nunca o payload bruto de eventos.
- Usa a football-data.org como conferência oficial opcional de tabela e forma por competição. São até duas chamadas cacheáveis por competição presente na varredura. A fonte só substitui a posição de tabela quando os dois times são associados com segurança.
- Congela cada publicação pré-jogo em um snapshot imutável. Às 02:10 BRT, com novas conferências às 04:10 e 08:10, registra Green, Red ou Anulado. Para o mercado 1X2 recomendado, liquidação é pelo placar aos 90 minutos mais acréscimos — prorrogação e pênaltis não contam.
- Reconsulta cada sugestão elegível na janela de 20 a 100 minutos antes do início. Quando a API-Football publicar 11 titulares, a tela passa a exibir a escalação, horário e fonte da revisão. Se uma escalação oficial já registrada mudar, ou se surgirem novas baixas listadas em relação à varredura inicial, o sistema registra a diferença, reduz a estimativa de forma conservadora e rebaixa ou suspende a sugestão. A publicação original não é apagada.
- Oferece uma área exclusiva do proprietário para vincular OpenAI, DeepSeek ou Gemini. A chave é transmitida por HTTPS, criptografada no banco com uma chave mestra do Vault e não é exposta ao feed público, GitHub Pages, logs de UI ou repositório. A revisão de IA é opcional e tem limite explícito por publicação.

## Segurança

- API-Football, football-data.org e o segredo de cron ficam no Supabase Vault; nenhum deles é enviado ao GitHub Pages, ao navegador ou ao repositório.
- Todas as tabelas do schema public usam RLS e não têm política pública. Só o backend com service role lê e escreve.
- As RPCs de quota e de leitura de segredo são SECURITY DEFINER com `search_path` fixo e EXECUTE revogado de PUBLIC, anon e authenticated.
- As Edge Functions `refresh-radar` e `settle-published-bets` só aceitam `Authorization: Bearer CRON_SECRET`, enviado pelo Supabase Cron. Não há botão público que possa consumir a quota.
- A Edge Function `refresh-statsbomb-history` usa o mesmo cron protegido e não precisa de chave externa. Ela não expõe nem entrega eventos brutos do StatsBomb ao navegador.

## Entrega pública via GitHub Pages

A interface pública oficial está em `docs/`, como no modelo de entrega do DASHNAVE. O GitHub Pages serve arquivos estáticos e a página consulta somente a RPC `get_public_tipster_dashboard` no Supabase.

- A página não chama a API-Football, não conhece o segredo de cron e não tem acesso às tabelas operacionais.
- O Supabase expõe somente um JSON limitado: até 32 leituras atuais em todos os Tiers, até 80 jogos da última varredura e até 18 liquidações já concluídas. Cache, logs de uso, payloads do provedor, snapshots completos e credenciais permanecem privados.
- O feed também mostra o progresso da camada StatsBomb: catálogo, partidas agregadas e perfis históricos. Esse sinal só influencia uma análise quando os dois times possuem cobertura histórica suficiente; não equivale a xG ao vivo.
- O feed informa separadamente a cobertura da football-data.org. A UI recebe apenas status, competição e métricas já derivadas da análise — nunca token, cache bruto ou respostas privadas da API.
- `docs/config.js` contém somente a URL do projeto e uma chave `sb_publishable`, projetada pelo Supabase para uso em navegador. A proteção está nas permissões da RPC e no contrato fixo que ela retorna.
- Configure GitHub Pages para publicar a branch `main`, pasta `/docs`. A URL esperada é `https://gioguagnoni-cyber.github.io/APITOLHEIRO/`.

## Configuração

O frontend não requer servidor externo ou Vercel. A atualização diária é feita pela Edge Function do Supabase e pelo `pg_cron`.

1. No Supabase, abra **SQL Editor** e crie os cinco valores no Vault (substitua apenas os textos entre aspas):

   ```sql
   select vault.create_secret('SUA_CHAVE_API_FOOTBALL', 'apitolheiro_api_football_key');
   select vault.create_secret('SUA_CHAVE_FOOTBALL_DATA', 'apitolheiro_football_data_key');
   select vault.create_secret('SEU_CRON_SECRET', 'apitolheiro_cron_secret');
   select vault.create_secret('https://lngivvahbetcujweejim.supabase.co', 'apitolheiro_project_url');
   select vault.create_secret('UMA_CHAVE_ALEATORIA_LONGA_E_EXCLUSIVA_PARA_CRIPTOGRAFIA', 'apitolheiro_ai_config_key');
   ```

2. Em **Authentication → URL Configuration**, inclua `https://gioguagnoni-cyber.github.io/APITOLHEIRO/` em **Redirect URLs**. Isso permite que o link mágico da área privada volte à página pública correta.

O job `refresh-radar` roda diariamente às 02:30 UTC, que corresponde a 23:30 BRT do dia anterior, e analisa o dia seguinte. `settle-published-bets` roda às 05:10, 07:10 e 11:10 UTC (02:10, 04:10 e 08:10 BRT) para liquidar publicações pendentes. Ambos usam chaves internas já disponibilizadas pelo runtime do Supabase e não precisam de configuração no navegador.

O job `refresh-statsbomb-history` executa aos minutos 07 e 37 de cada hora e avança de forma incremental para evitar sobrecarga. O repositório [StatsBomb Open Data](https://github.com/hudl/open-data) é histórico e seletivo, não um feed ao vivo; publicações baseadas nesses agregados exibem a atribuição StatsBomb exigida pela fonte.

O job `refresh-apitolheiro-lineup-review` é chamado a cada 10 minutos, mas a própria função só consulta jogos sugeridos na janela pré-jogo e aplica cache curto. No plano gratuito ela compartilha o teto diário de 100 chamadas com a varredura noturna e prioriza no máximo quatro jogos por ciclo; em planos com quota maior, o mesmo mecanismo continua a registrar a trilha de auditoria sem expor a chave.

O banco já possui as migrações em supabase/migrations. A aplicação usa até 82 chamadas de análise em uma execução, com uma margem diária para a liquidação e falhas de provedor. Se houver mais jogos do que o orçamento permite para previsões individuais, todos recebem o Tier baseado nos sinais já obtidos e a ausência é descrita nos caveats.

## Desenvolvimento

    npm install
    npm run test:static

## Limites de dados

Cobertura de previsões, lesões, escalações e football-data.org varia por competição e plano. A ingestão usa cache por endpoint e interrompe novas chamadas ao atingir a margem de segurança. xG oficial não é presumido: a V1 sinaliza proxy de criação quando esse dado não estiver disponível. StatsBomb Open Data é uma base histórica seletiva, não uma fonte ao vivo.
