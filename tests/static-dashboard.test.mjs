import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a entrega pública é uma página estática e usa somente o RPC limitado", () => {
  const page = read("docs/index.html");
  const script = read("docs/app.js");
  assert.match(page, /<script src="\.\/config\.js"><\/script>/);
  assert.match(script, /rpc\/get_public_tipster_dashboard/);
  assert.match(script, /schemaVersion !== 8/);
  assert.match(script, /credentials: "omit"/);
  assert.doesNotMatch(script, /v3\.football\.api-sports\.io|x-apisports-key|cron_secret|supabase_secret|service_role/i);
});

test("o painel traz transparência de tiers, campeonatos e jogos detectados", () => {
  const page = read("docs/index.html");
  const script = read("docs/app.js");
  assert.match(page, /id="league-filter"/);
  assert.match(page, /id="screening"/);
  assert.match(page, /id="statsbomb-source"/);
  assert.match(page, /id="football-data-source"/);
  assert.match(script, /screenedFixtures/);
  assert.match(script, /statsbomb/);
  assert.match(script, /footballData/);
  assert.match(script, /classificationLabel/);
  assert.match(script, /decision-checks/);
  assert.match(script, /homeLast5/);
  assert.match(script, /Escalação oficial/);
  assert.match(script, /Ajuste pré-jogo/);
  assert.match(script, /XI oficial/);
  assert.match(page, /data-tier="4"/);
  assert.match(page, /id="results"/);
  assert.match(page, /id="owner-dialog"/);
  assert.match(script, /save_ai_provider_credential/);
  assert.match(script, /get_ai_provider_settings/);
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
