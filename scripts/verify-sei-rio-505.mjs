#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");

console.log("=== 1. Validando dist/manifest.json e integridade dos arquivos ===");
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3, "manifest_version deve ser 3");
assert.equal(manifest.version, "3.9.5", "version deve ser 3.9.5");
assert.ok(manifest.content_scripts.length >= 30, "content_scripts incompleto");

manifest.content_scripts.forEach((cs, idx) => {
  const hasRio = (cs.matches || []).some((m) => m.includes(".rio/"));
  assert.ok(hasRio, `content_scripts[${idx}] sem suporte a .rio`);
  for (const f of [...(cs.js || []), ...(cs.css || [])]) {
    assert.ok(fs.existsSync(path.join(DIST, f)), `Arquivo ausente em dist/: ${f}`);
  }
});

for (const war of manifest.web_accessible_resources || []) {
  assert.ok((war.matches || []).some((m) => m.includes(".rio/")), "web_accessible_resources sem .rio");
  for (const res of war.resources || []) {
    if (!res.includes("*")) {
      assert.ok(fs.existsSync(path.join(DIST, res)), `Recurso web_accessible ausente: ${res}`);
    }
  }
}

for (const iconPath of Object.values(manifest.icons || {})) {
  assert.ok(fs.existsSync(path.join(DIST, iconPath)), `Icone ausente: ${iconPath}`);
}
assert.ok(fs.existsSync(path.join(DIST, manifest.background.service_worker)), "background.service_worker ausente");
if (manifest.options_page) assert.ok(fs.existsSync(path.join(DIST, manifest.options_page)), "options_page ausente");
if (manifest.side_panel?.default_path) assert.ok(fs.existsSync(path.join(DIST, manifest.side_panel.default_path)), "side_panel ausente");
console.log(`OK: ${manifest.content_scripts.length} content_scripts e todos os recursos verificados em dist/.`);

console.log("=== 2. Validando sintaxe dos scripts modificados ===");
for (const rel of [
  "js/sei-functions-pro.js",
  "js/init_all.js",
  "js/init.js",
  "js/sei-pro-arvore.js",
  "js/init_processo_arvore.js",
  "js/init_processo_capa.js",
]) {
  const code = fs.readFileSync(path.join(DIST, rel), "utf8");
  new vm.Script(code, { filename: rel });
}
console.log("OK: sintaxe JS validada sem erros.");

console.log("=== 3. Testando deteccao SEI.Rio 5.0.5 e handlers de clique nao destrutivos ===");
const fnCode = fs.readFileSync(path.join(DIST, "js/sei-functions-pro.js"), "utf8");
const arvCode = fs.readFileSync(path.join(DIST, "js/sei-pro-arvore.js"), "utf8");

// Ensure bare .unbind()/.unbind('click') is gone from setClickUrlAmigavel and initChangeUrl
const clickAmigavelBlock = fnCode.slice(fnCode.indexOf("function setClickUrlAmigavel()"), fnCode.indexOf("function arrayIDProcedimentos()"));
assert.ok(!clickAmigavelBlock.includes(".unbind("), "setClickUrlAmigavel ainda usa .unbind()");
assert.ok(clickAmigavelBlock.includes("ifrConteudoVisualizacao"), "setClickUrlAmigavel deve incluir ifrConteudoVisualizacao");
assert.ok(clickAmigavelBlock.includes(".off('click.seiproUrlAmigavel')"), "setClickUrlAmigavel deve usar namespace");

const changeUrlBlock = arvCode.slice(arvCode.indexOf("function initChangeUrl()"), arvCode.indexOf("function addIconActionsArvore("));
assert.ok(!changeUrlBlock.includes(".unbind("), "initChangeUrl ainda usa .unbind()");
assert.ok(changeUrlBlock.includes(".off('click.seiproChangeUrl')"), "initChangeUrl deve usar namespace");

// Execute version detection functions against a simulated SEI.Rio 5.0.5 DOM (customized logo + poisoned sessionStorage="false")
const extractFn = (src, name) => {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Funcao ${name} nao encontrada`);
  let depth = 0, i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`Bloco incompleto para ${name}`);
};

const harness = [
  extractFn(fnCode, "detectSei5DomPro"),
  extractFn(fnCode, "detectIfrConteudoPro"),
  extractFn(fnCode, "setSeiVersionPro"),
  extractFn(fnCode, "getSeiVersionPro"),
  extractFn(fnCode, "compareVersionNumbers"),
].join("\n\n");

const store = new Map([["versaoSei", "false"]]);
const mockDom = {
  head: { innerHTML: '<link href="/infra_css/bootstrap/bootstrap-5.3.1.min.css?6fecec20813fd5f59815f568a5346f7e">' },
  querySelector: (sel) => (sel.includes("bootstrap-5") ? {} : null),
  getElementById: (id) => (id === "ifrConteudoVisualizacao" ? {} : null),
};
const ctx = {
  document: mockDom,
  window: { name: "", parent: null, top: null },
  sessionStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  $: () => ({ attr: () => undefined, length: 0 }),
};
ctx.window.parent = ctx.window;
ctx.window.top = ctx.window;
vm.runInNewContext(harness, ctx);

assert.equal(ctx.detectSei5DomPro(), true, "detectSei5DomPro deve detectar Bootstrap 5 / InfraPaginaEsquema3");
assert.equal(ctx.detectIfrConteudoPro(), true, "detectIfrConteudoPro deve detectar #ifrConteudoVisualizacao");
assert.equal(ctx.getSeiVersionPro(), "5.0.0", "getSeiVersionPro deve limpar 'false' e cair no fallback 5.0.0");
assert.ok(ctx.compareVersionNumbers(ctx.getSeiVersionPro(), "5") >= 0, "versao detectada deve ser >= 5");

// Also verify explicit SEI 5.0.5 logo title wins over fallback
store.clear();
ctx.$ = () => ({ attr: () => "Sistema Eletr\u00F4nico de Informa\u00E7\u00F5es - Vers\u00E3o 5.0.5", length: 1 });
ctx.setSeiVersionPro();
assert.equal(ctx.getSeiVersionPro(), "5.0.5", "setSeiVersionPro deve extrair 5.0.5 do titulo oficial");

console.log("OK: todos os testes SEI.Rio 5.0.5 passaram!");
