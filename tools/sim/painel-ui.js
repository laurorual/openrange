// painel-ui.js (gate, called by tools/sim/painel.py) — loads www/painel/ in jsdom against the test portal (URL in
// argv[2]) and clicks through every tab. Any JS error or missing element → "ERRO" line.
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const BASE = process.argv[2];
const WWW = path.resolve(__dirname, '../../www');
const html = fs.readFileSync(WWW + '/painel/index.html', 'utf8').replace(/<script[^>]*><\/script>/g, '');
const dom = new JSDOM(html, { url: BASE + '/painel/#estado', pretendToBeVisual: true, runScripts: 'outside-only' });
const w = dom.window, d = w.document;
const erros = [];
w.fetch = (u, o) => fetch(new URL(u, BASE + '/painel/'), o);          // node's fetch, same origin as the page
w.confirm = () => true;
w.addEventListener('error', (e) => erros.push('JS: ' + e.message));
w.console.error = (...a) => erros.push('console: ' + a.join(' '));
try { w.eval(fs.readFileSync(WWW + '/painel/painel.js', 'utf8')); } catch (e) { console.log('ERRO ao carregar painel.js', e); process.exit(1); }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => d.querySelector(s);
const aba = async (nome) => { w.location.hash = nome; await espera(600); };
const clicar = (s) => { const b = typeof s === 'string' ? $(s) : s; if (!b) throw new Error('não achei ' + s); b.click(); };
const ok = (cond, msg) => { if (!cond) console.log('ERRO ui: ' + msg); return cond; };

(async () => {
  try {
    await espera(800);
    ok(!d.body.classList.contains('bloqueado'), 'painel bloqueado: ' + $('#bloqueio-msg').textContent);
    const cartoes = [...d.querySelectorAll('#cartoes .cartao h3')].map((h) => h.textContent);
    ok(cartoes.length === 5, 'estado: ' + cartoes.length + ' cartões');
    const cs = d.querySelectorAll('#cartoes .cartao');
    ok(!cs[3].querySelector('.k'), 'estado: linhas de Redirects não devem ter coluna de rótulo vazia (ficavam à direita)');
    ok(cs[1].querySelector('.linha').classList.contains('ok'), 'estado: TV com pedidos recentes devia aparecer ligada');
    ok(/minmax\(0, 1fr\) minmax\(0, 1fr\)/.test(html), 'loja: colunas devem ter largura fixa (minmax(0, 1fr))');
    ok(/TV 127\.0\.0\.1/.test($('#resumo').textContent), 'resumo: ' + $('#resumo').textContent);
    console.log('## ui estado: ' + cartoes.join(' | ') + ' · ' + $('#resumo').textContent);

    await aba('passos');
    clicar('[data-acao="teste-dns"]'); await espera(800);
    ok($('#dns-resultado').querySelectorAll('tr.ok').length >= 2, 'passos: teste de DNS sem linhas ok');
    ok($('#passo-3').classList.contains('ok') && $('#passo-4').classList.contains('ok'), 'passos 3/4 deviam estar ok');
    console.log('## ui passos: ' + [1, 2, 3, 4].map((n) => n + ($('#passo-' + n).classList.contains('ok') ? '✓' : '·')).join(' ') + ' · PC ' + $('#pc-ip').textContent);

    await aba('apps');
    const antes = d.querySelectorAll('#lista-apps .app').length;
    clicar('[data-acao="novo-app"]'); await espera(50);   // actions run on a microtask
    $('#ed-nome').value = 'App da UI'; $('#ed-secao').value = 'Testes'; $('#ed-url').value = 'http://{PC_IP}/ui/';
    $('#ed-nome').dispatchEvent(new w.Event('input'));
    ok($('#ed-previa').src.startsWith('data:image/svg+xml'), 'apps: prévia do ícone gerado');
    clicar('[data-acao="salvar-app"]'); await espera(800);
    const titulos = [...d.querySelectorAll('#lista-apps .secao-titulo')].map((t) => t.firstChild.textContent.trim());
    if (!ok(d.querySelectorAll('#lista-apps .app').length === antes + 1 && titulos.includes('Testes'), 'apps: novo app não apareceu (' + titulos + ') · recado: ' + $('#recado').textContent)) throw new Error('parei');
    const secaoTestes = [...d.querySelectorAll('#lista-apps .secao-titulo')].find((t) => /Testes/.test(t.textContent));
    clicar(secaoTestes.querySelector('button'));                    // move the "Testes" section up
    await espera(600);
    const depois = [...d.querySelectorAll('#lista-apps .secao-titulo')].map((t) => t.firstChild.textContent.trim());
    ok(depois.indexOf('Testes') === titulos.indexOf('Testes') - 1, 'apps: subir seção: ' + depois);
    const remover = [...d.querySelectorAll('#lista-apps .app')].find((a) => /App da UI/.test(a.textContent)).querySelector('.perigo');
    clicar(remover); await espera(600);
    ok(d.querySelectorAll('#lista-apps .app').length === antes, 'apps: remover');
    console.log('## ui apps: ' + antes + ' apps · seções ' + titulos.join(', ') + ' → ' + depois.join(', ') + ' · removido de volta');

    await aba('loja');
    ok(d.querySelectorAll('#catalogo .app').length === 4, 'loja: catálogo com ' + d.querySelectorAll('#catalogo .app').length);
    const favAntes = d.querySelectorAll('#favoritos .app').length;
    clicar([...d.querySelectorAll('#catalogo .app')].find((a) => /Pluto/.test(a.textContent)).querySelector('button'));
    await espera(800);
    ok(d.querySelectorAll('#favoritos .app').length === favAntes + 1, 'loja: + favorito');
    console.log('## ui loja: favoritos ' + favAntes + ' → ' + d.querySelectorAll('#favoritos .app').length + ' · ' + $('#cat-conta').textContent);

    await aba('rede');
    ok($('#rede-tv').value === '127.0.0.1' && /api-portal-v3/.test($('#redirects').value), 'rede: campos não carregaram');
    clicar('[data-acao="salvar-rede"]'); await espera(800);
    ok(!/visivel ruim/.test($('#recado').className), 'rede: salvar sem mudar deu erro: ' + $('#recado').textContent);
    console.log('## ui rede: TV ' + $('#rede-tv').value + ' · redirects ' + $('#redirects').value.split('\n').length + ' · ' + $('#recado').textContent);

    await aba('logs');
    await espera(500);
    ok($('#log-texto').textContent.length > 0, 'logs: vazio');
    $('#log-filtro').value = 'painel/api/apps'; $('#log-filtro').dispatchEvent(new w.Event('input'));
    const linhas = $('#log-texto').textContent.split('\n');
    ok(linhas.length > 0 && linhas.every((l) => l.includes('painel/api/apps')), 'logs: filtro');
    console.log('## ui logs: ' + linhas.length + ' linhas com o filtro');
  } catch (e) {
    console.log('ERRO ui: ' + e.stack);
  }
  erros.forEach((e) => console.log('ERRO ' + e));
  process.exit(0);
})();
