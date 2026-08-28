import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a entrega pública é uma página estática e usa somente o RPC limitado", () => {
  const page = read("docs/index.html");
  const script = read("docs/app.js");
  assert.match(page, /<script src="\.\/config\.js"><\/script>/);
  assert.match(script, /rpc\/get_public_tipster_dashboard/);
  assert.match(script, /credentials: "omit"/);
  assert.doesNotMatch(script, /api-football|cron_secret|supabase_secret|service_role/i);
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
