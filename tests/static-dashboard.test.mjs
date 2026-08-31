import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a entrega pública separa o feed esportivo do controle privado", () => {
  const page = read("docs/index.html");
  const script = read("docs/app.js");
  const ownerControl = read("supabase/functions/owner-control/index.ts");
  assert.match(page, /<script src="\.\/config\.js\?v=[^"]+"><\/script>/);
  assert.match(page, /<script src="\.\/app\.js\?v=[^"]+" defer><\/script>/);
  assert.match(script, /rpc\/get_public_tipster_dashboard/);
  assert.match(script, /schemaVersion < 10/);
  assert.match(script, /functions\/v1\/owner-control/);
  assert.match(script, /apitoleiro_device_token/);
  assert.match(script, /window\.location\.hash/);
  assert.match(script, /link individual de ativação/);
  assert.match(script, /credentials: "omit"/);
  assert.match(ownerControl, /ALLOWED_ORIGINS/);
  assert.match(ownerControl, /sb_publishable_/);
  assert.match(ownerControl, /authorizeDevice/);
  assert.match(ownerControl, /token_hash/);
  assert.doesNotMatch(ownerControl, /claimDevice|claim_device/);
  assert.doesNotMatch(script, /v3\.football\.api-sports\.io|x-apisports-key|cron_secret|supabase_secret|service_role/i);
  assert.doesNotMatch(script, /bookmaker|impliedProbability|metrics\.market/i);
  assert.doesNotMatch(ownerControl, /get_owner_access_secret|Senha do proprietário|constantTimeEquals/);
});

test("o painel traz transparência de tiers, campeonatos e jogos detectados", () => {
  const page = read("docs/index.html");
  const script = read("docs/app.js");
  assert.match(page, /id="league-filter"/);
  assert.match(page, /id="screening"/);
  assert.match(page, /StatsBomb Open Data/);
  assert.match(page, /football-data\.org/);
  assert.match(script, /screenedFixtures/);
  assert.match(script, /statsbomb/);
  assert.match(script, /footballData/);
  assert.match(script, /classificationLabel/);
  assert.match(script, /mandatory-row/);
  assert.match(script, /homeLast5/);
  assert.match(script, /Escalação/);
  assert.match(script, /Ajuste pré-jogo/);
  assert.match(script, /XI oficial/);
  assert.match(page, /data-tier="4"/);
  assert.match(page, /id="results"/);
  assert.match(page, /id="ai-settings-form"/);
  assert.match(script, /action, \.\.\.fields/);
  assert.doesNotMatch(page, /owner-email|owner-dialog|private-gate|Desbloquear|Enviar link de acesso|Senha do proprietário/);
  assert.doesNotMatch(script, /ownerPassword|apitoleiro_owner_password|sessionStorage|openOwnerDialog|authenticate/);
  assert.doesNotMatch(script, /auth\/v1\/otp|signInWithOtp/);
});

test("o painel implementa banca, entrada manual e liquidação Green ou Red", () => {
  const page = read("docs/index.html");
  const script = read("docs/app.js");
  assert.match(page, /data-view-target="bets"/);
  assert.match(page, /data-view-target="bankroll"/);
  assert.match(page, /id="bet-entry-form"/);
  assert.match(page, /id="bet-stake"/);
  assert.match(page, /id="bet-odds"/);
  assert.match(script, /create_bet/);
  assert.match(script, /settle_bet/);
  assert.match(script, /set_bankroll/);
  assert.match(script, /settleOwnerBet\(bet\.id, "green"\)/);
  assert.match(script, /settleOwnerBet\(bet\.id, "red"\)/);
});

test("a navegação e o visual são estruturados em barra lateral neutra", () => {
  const page = read("docs/index.html");
  const css = read("docs/styles.css");
  assert.match(page, /class="sidebar"/);
  assert.match(page, /Rotinas automáticas/);
  assert.match(page, /01:00 · 11:00 · 16:00 · 23:00/);
  assert.match(css, /--surface:#fff/);
  assert.match(css, /--green:#16833c/);
  assert.match(css, /--red:#c33131/);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient|text-shadow/i);
});

test("a configuração pública não contém credenciais de servidor", () => {
  const config = read("docs/config.js");
  assert.match(config, /sb_publishable_/);
  assert.doesNotMatch(config, /sb_secret_|service_role|api-football|cron_secret/i);
});

test("a página impede que entradas remotas virem HTML dinâmico", () => {
  const script = read("docs/app.js");
  assert.doesNotMatch(script, /innerHTML\s*=/);
  assert.match(script, /document\.createElement/);
});
