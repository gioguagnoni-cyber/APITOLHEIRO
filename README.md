# APITOLHEIRO Lab

Dashboard pré-jogo para organizar sinais de tipster. Ele não promete retorno, acerto ou probabilidade real: a porcentagem exibida é uma estimativa explicável do modelo v1.

## O que a V1 faz

- Varre os jogos do dia e aprofunda o candidato prioritário por execução no plano gratuito. O limite de 10 chamadas/minuto da API-Football é respeitado com até 9 chamadas sequenciais; planos superiores podem ampliar API_FOOTBALL_MAX_REQUESTS_PER_RUN. O painel só publica análises com ao menos 65% de cobertura dos sinais.
- Mede forma nos últimos 10, recorte dos últimos 5 no mando relevante, diferença de tabela, odd de Match Winner, força do rival, baixas, escalação perto do início e um proxy de criação quando não há xG oficial.
- Pondera sinais disponíveis. Ausência de dados reduz a confiança; não vira sinal positivo.
- Mostra Tier 1–4. Tier 1 exige estimativa >=75%, confiança de dados >=65% e odd entre 1,30 e 2,90. Os valores alimentam o score, não são filtros rígidos para os demais tiers.
- Mantém cache por endpoint, registra todas as chamadas efetivas e reserva quota atomicamente antes de chamar o provedor.

## Segurança

- API-Football, service role do Supabase e segredo de cron são variáveis privadas sem prefixo NEXT_PUBLIC_.
- Todas as tabelas do schema public usam RLS e não têm política pública. Só o backend com service role lê e escreve.
- A RPC de quota é SECURITY DEFINER com search_path fixo, validação de parâmetros e EXECUTE revogado de PUBLIC, anon e authenticated.
- O endpoint de ingestão exige Authorization Bearer CRON_SECRET. Não há botão público de refresh que possa consumir a quota.

## Configuração

1. Copie .env.example para .env.local.
2. Em SUPABASE_SECRET_KEY, use uma chave sb_secret do projeto Supabase apenas no ambiente do servidor. SUPABASE_SERVICE_ROLE_KEY continua aceito somente para compatibilidade com a chave legada.
3. Em API_FOOTBALL_KEY, use uma única chave legítima da API-Sports.
4. Defina CRON_SECRET com um valor aleatório longo e configure o mesmo valor na Vercel.
5. Faça deploy. O cron em vercel.json executa diariamente às 11:00 UTC, equivalente a 08:00 BRT.

O banco já possui as migrações em supabase/migrations. A aplicação usa um teto padrão de 90 chamadas/dia, propositalmente abaixo das 100 fornecidas pelo plano gratuito.

## Desenvolvimento

    npm install
    npm run dev
    npm run typecheck
    npm run lint
    npm run build

## Limites de dados

Cobertura de odds, previsões, lesões e escalações varia por competição. A ingestão usa cache por endpoint e interrompe novas chamadas ao atingir a margem de segurança. xG oficial não é presumido: a V1 sinaliza proxy de criação quando esse dado não estiver disponível.
