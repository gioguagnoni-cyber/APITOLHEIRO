# APITOLHEIRO

Dashboard pré-jogo para organizar sinais de tipster. Ele não promete retorno, acerto ou probabilidade real: a porcentagem exibida é uma estimativa explicável do modelo v1.

## O que a V1 faz

- Executa quatro ciclos em America/Sao_Paulo: 23:00 publica o dia seguinte; 01:00, 11:00 e 16:00 atualizam o dia corrente. Dados estáveis têm cache de até 24 horas, enquanto a lista do dia é reconsultada, preservando a franquia gratuita.
- Mede forma nos últimos 10, recorte dos últimos 5 no mando relevante, diferença de tabela, força do rival, baixas, escalação perto do início e um proxy de criação quando não há xG oficial.
- Pondera sinais disponíveis. Ausência de dados reduz a confiança; não vira sinal positivo. A lista prioritária recebe a maior parte da quota, mas cada rotina também explora até 8 jogos fora dela para evitar descarte automático de oportunidades.
- Mostra Tier 1–4. As três regras obrigatórias iniciam em Tier 3; os sinais esportivos complementares podem elevar a Tier 2 ou 1. A estimativa de probabilidade e a confiança dos dados são informativas, não promessas de resultado. A tela mantém também os Tiers não qualificados, com o motivo e os critérios que passaram ou falharam.
- Mantém cache por endpoint, registra todas as chamadas efetivas e reserva quota atomicamente antes de chamar o provedor.
- Sincroniza o catálogo e agregados históricos do StatsBomb Open Data em uma Edge Function separada. São guardadas métricas derivadas por partida e por equipe (xG, finalizações, passes completos e pressões), nunca o payload bruto de eventos.
- Usa a football-data.org como conferência oficial opcional de tabela e forma por competição. São até duas chamadas cacheáveis por competição presente na varredura. A fonte só substitui a posição de tabela quando os dois times são associados com segurança.
- Congela cada publicação pré-jogo em um snapshot imutável. Às 02:10 BRT, com novas conferências às 04:10 e 08:10, registra Green, Red ou Anulado. Para o mercado 1X2 recomendado, liquidação é pelo placar aos 90 minutos mais acréscimos — prorrogação e pênaltis não contam.
- Reconsulta cada sugestão elegível entre 25 e 0 minutos antes do início, priorizando aproximadamente 20 minutos, e faz uma última conferência perto de cinco minutos quando já havia XI oficial. Mudanças mensuráveis rebaixam ou suspendem a sugestão sem apagar a publicação original.
- Mantém a gestão direta de banca: entrada manual, lado escolhido, valor, odd pessoal, estado aberto e liquidação manual Green/Red. A odd pessoal serve só para calcular lucro/prejuízo; não participa da análise esportiva.
- Vincula OpenAI, DeepSeek, Gemini ou Grok diretamente, sem senha e sem link de e-mail. A chave é testada no provedor, transmitida por HTTPS e criptografada no banco.

## Segurança

- API-Football, football-data.org e o segredo de cron ficam no Supabase Vault; nenhum deles é enviado ao GitHub Pages, ao navegador ou ao repositório.
- Todas as tabelas do schema public usam RLS e não têm política pública. Só o backend com service role lê e escreve.
- As RPCs de quota e leitura de chaves operacionais são SECURITY DEFINER com `search_path` fixo e EXECUTE revogado de PUBLIC, anon e authenticated.
- As Edge Functions `refresh-radar` e `settle-published-bets` só aceitam `Authorization: Bearer CRON_SECRET`, enviado pelo Supabase Cron. Não há botão público que possa consumir a quota.
- A Edge Function `refresh-statsbomb-history` usa o mesmo cron protegido e não precisa de chave externa. Ela não expõe nem entrega eventos brutos do StatsBomb ao navegador.
- A Edge Function `owner-control` não pede senha. Um link individual de ativação grava no navegador um token aleatório; somente o hash SHA-256 é guardado no banco. A função aceita a origem oficial/ambiente local e limita requisições. Tabelas de banca, apostas e credenciais continuam acessíveis somente com service role.

> **Modo individual sem login:** abra uma vez o link individual entregue ao proprietário. O token fica no armazenamento local desse navegador, é removido imediatamente da barra de endereço e nunca é uma senha digitada. Para trocar de navegador, gere uma nova autorização no Supabase.

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

1. No Supabase, abra **SQL Editor** e crie os valores no Vault (substitua apenas os textos entre aspas):

   ```sql
   select vault.create_secret('SUA_CHAVE_API_FOOTBALL', 'apitolheiro_api_football_key');
   select vault.create_secret('SUA_CHAVE_FOOTBALL_DATA', 'apitolheiro_football_data_key');
   select vault.create_secret('SEU_CRON_SECRET', 'apitolheiro_cron_secret');
   select vault.create_secret('https://lngivvahbetcujweejim.supabase.co', 'apitolheiro_project_url');
   select vault.create_secret('UMA_CHAVE_ALEATORIA_LONGA_E_EXCLUSIVA_PARA_CRIPTOGRAFIA', 'apitolheiro_ai_config_key');
   ```

2. Não existe senha de proprietário, login ou redirecionamento de e-mail. Na primeira abertura, use o link individual de ativação; depois, a URL normal abre diretamente banca, apostas e configuração de IA.

Os jobs `refresh-apitolheiro-0100`, `-1100`, `-1600` e `-2300` executam às 01:00, 11:00, 16:00 e 23:00 BRT. O das 23:00 analisa o dia seguinte; os três restantes atualizam o dia corrente. `settle-published-bets` continua auditando as publicações do modelo às 02:10, 04:10 e 08:10 BRT.

O job `refresh-statsbomb-history` executa aos minutos 07 e 37 de cada hora e avança de forma incremental para evitar sobrecarga. O repositório [StatsBomb Open Data](https://github.com/hudl/open-data) é histórico e seletivo, não um feed ao vivo; publicações baseadas nesses agregados exibem a atribuição StatsBomb exigida pela fonte.

O job `refresh-apitolheiro-lineup-review` é chamado a cada dois minutos, mas não usa a API quando não existe jogo qualificado a 25 minutos ou menos do início. Ele processa até oito jogos por ciclo, usa cache curto e evita repetir uma escalação já finalizada, salvo a conferência final perto de cinco minutos.

O banco já possui as migrações em `supabase/migrations`. A análise reserva no máximo 78 das 100 chamadas diárias da API-Football e no máximo 70 por execução, deixando margem para escalações. Os quatro horários reaproveitam cache de tabela, temporada, previsão e fonte oficial; ausência de um sinal opcional é registrada, nunca inventada.

## Desenvolvimento

    npm install
    npm run test:static

## Limites de dados

Cobertura de previsões, lesões, escalações e football-data.org varia por competição e plano. A ingestão usa cache por endpoint e interrompe novas chamadas ao atingir a margem de segurança. xG oficial não é presumido: a V1 sinaliza proxy de criação quando esse dado não estiver disponível. StatsBomb Open Data é uma base histórica seletiva, não uma fonte ao vivo.
