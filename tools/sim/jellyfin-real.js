// jellyfin-real.js — runs the client (www/jellyfin/) in jsdom against the REAL LAN Jellyfin (test data:
// series with chapters/trickplay, music, collection, playlist). Uses the token in ~/.cache/openrange (tools/jf-perfil.py).
// The <video> is fake (jsdom plays no media): checks calls, screens and player state, not the picture.
const fs = require('fs'), path = require('path'), os = require('os');
const { JSDOM } = require('jsdom');
const WWW = path.resolve(__dirname, '../../www');
const tk = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.cache/openrange/jellyfin-token.json'), 'utf8'));
const html = fs.readFileSync(WWW + '/jellyfin/index.html', 'utf8').replace(/<script[^>]*><\/script>/g, '');
const origem = new URL(tk.servidor);
const dom = new JSDOM(html, { url: 'http://' + origem.hostname + '/jellyfin/', pretendToBeVisual: true, runScripts: 'outside-only' });
const w = dom.window, d = w.document, log = [];
w.localStorage.setItem('jf.token', tk.token); w.localStorage.setItem('jf.userId', tk.userId); w.localStorage.setItem('jf.nome', 'teste');
for (const prop of ['offsetWidth', 'offsetHeight']) Object.defineProperty(w.HTMLElement.prototype, prop, { get() {
  for (let e = this; e; e = e.parentElement) {
    if (e.style && e.style.display === 'none') return 0;
    if (e.id === 'player' && !e.classList.contains('visivel')) return 0;
    if (e.id === 'menu' && !e.classList.contains('visivel')) return 0;
  } return 10; } });
const v0 = w.HTMLMediaElement.prototype;
v0.play = function () { this._p = false; return Promise.resolve(); }; v0.pause = function () { this._p = true; }; v0.load = function () {};
Object.defineProperty(v0, 'paused', { get() { return this._p !== false; } });
let ct = 0; Object.defineProperty(v0, 'currentTime', { get() { return ct; }, set(x) { ct = x; log.push('  [video] currentTime = ' + (+x).toFixed(1)); } });
Object.defineProperty(v0, 'duration', { get() { return 90; } });
// /relatorio and /api/inicio belong to the portal: intercepted; everything else really goes to Jellyfin
const XHR = w.XMLHttpRequest; const pedidos = [];
w.XMLHttpRequest = function () {
  const x = new XHR(), open = x.open.bind(x), send = x.send.bind(x); let alvo = '';
  x.open = (m, u, a) => { alvo = u; if (u.indexOf(tk.servidor) === 0) pedidos.push(m + ' ' + u.slice(tk.servidor.length).split('?')[0]); open(m, u, a); };
  x.send = (c) => {
    if (alvo === '/relatorio') { const r = JSON.parse(c); if (r.tipo !== 'tecla') log.push('  [PC] ' + r.tipo + ': ' + (r.msg || '')); return; }
    if (alvo === '/api/inicio') return;
    send(c);
  };
  return x;
};
w.console.log = () => {};
for (const f of ['/lib/tv.js', '/jellyfin/jf.js', '/jellyfin/player.js', '/jellyfin/app.js']) w.eval(fs.readFileSync(WWW + f, 'utf8'));
w.addEventListener('error', (e) => console.log('ERRO JS:', e.message));
const espera = (ms) => new Promise(r => setTimeout(r, ms));
const tecla = (k) => { const ev = new w.Event('keydown', { bubbles: true }); Object.defineProperty(ev, 'keyCode', { value: k }); d.dispatchEvent(ev); };
const vid = d.getElementById('video'), fire = (n) => vid.dispatchEvent(new w.Event(n));
const topo = () => { const t = d.querySelectorAll('.tela'); return t[t.length - 1]; };
const show = (t) => { console.log('\n## ' + t); log.splice(0).forEach(l => console.log(l)); };
const cartoes = (r) => [...(r || topo()).querySelectorAll('.cartao')];
const nomeC = (c) => c.querySelector('.titulo').textContent;
const fileiras = (r) => [...(r || topo()).querySelectorAll('.bloco-fileira h2')].map(h => h.textContent + ' (' + h.nextSibling.children.length + ')').join(' | ');
const abrirPorNome = async (n, ms) => { const c = cartoes().find(c => nomeC(c) === n); if (!c) throw new Error('cartão não achado: ' + n); c.click(); await espera(ms || 700); };
const src = () => (vid.getAttribute('src') || '').replace(tk.servidor, '').replace(tk.token, '<T>').split('&PlaySessionId')[0];
(async () => {
  await espera(1500);
  show('início: ' + fileiras());
  // --- series ---
  await abrirPorNome('Séries');
  show('biblioteca Séries: ' + topo().querySelector('.contagem').textContent + ' · ' + cartoes().map(nomeC).join(', '));
  tecla(406); await espera(700);
  show('azul → ' + topo().querySelector('.contagem').textContent + ' · ' + cartoes().map(nomeC).join(', '));
  tecla(406); await espera(700);
  await abrirPorNome(cartoes().map(nomeC)[0], 1200);
  const sr = topo();
  show('série: ' + sr.querySelector('h1').textContent + ' · ' + sr.querySelector('.meta').textContent + '\n   botões: ' +
       [...sr.querySelectorAll('.botao')].map(b => b.textContent).join(' | ') + '\n   extras: ' + fileiras(sr.querySelector('.extras')));
  sr.querySelector('[data-botao="play"]').click(); await espera(1500);
  fire('loadedmetadata'); fire('playing'); ct = 5; fire('timeupdate'); await espera(300);
  show('tocando ep.: ' + src() + '\n   OSD: ' + d.getElementById('osd-titulo').textContent + ' | ' + d.getElementById('osd-estado').textContent +
       ' · marcas de capítulo: ' + d.getElementById('osd-marcas').children.length + ' · aviso: "' + d.getElementById('pular').textContent + '"');
  tecla(13); await espera(100);
  show('OK com o aviso → currentTime ' + ct);
  tecla(39); await espera(50);
  const tr = d.getElementById('trick');
  show('→ (seek): miniatura ' + tr.className + ' · ' + tr.style.backgroundImage.replace(tk.servidor, '').replace(tk.token, '<T>') + ' · pos ' + tr.style.backgroundPosition + ' · ' + tr.style.width + 'x' + tr.style.height);
  const turl = /url\("?([^")]+)/.exec(tr.style.backgroundImage)[1];
  const resp = await fetch(turl); show('  folha de miniaturas: HTTP ' + resp.status + ' ' + resp.headers.get('content-type') + ' ' + (await resp.arrayBuffer()).byteLength + ' B');
  await espera(900);
  tecla(40); await espera(100);
  const m = d.getElementById('menu');
  show('↓ menu: ' + [...m.children].map(x => (x.tagName === 'H3' ? '\n   [' + x.textContent + '] ' : x.textContent + ' · ')).join('') + '\n   foco: ' + w.tv.atual.textContent);
  [...m.querySelectorAll('.opcao')].find(o => /Parte 2/.test(o.textContent)).click(); await espera(100);
  show('capítulo "Parte 2" → currentTime ' + ct + ' · menu aberto: ' + w.jfPlayer.menuAberto());
  tecla(40); await espera(100);
  [...m.querySelectorAll('.opcao')].find(o => /6 Mb/.test(o.textContent)).click(); await espera(2500);
  show('qualidade 6 Mb/s → ' + src().slice(0, 60) + ' · VideoBitrate=' + (/VideoBitrate=(\d+)/.exec(vid.getAttribute('src')) || [])[1] +
       ' · MaxWidth=' + (/MaxWidth=(\d+)/.exec(vid.getAttribute('src')) || [])[1]);
  fire('loadedmetadata'); fire('playing');
  tecla(40); await espera(100); tecla(8); await espera(100);
  show('menu + Voltar → menu aberto: ' + w.jfPlayer.menuAberto() + ' · player ativo: ' + w.jfPlayer.ativo());
  ct = 89; fire('ended'); await espera(1500);
  show('fim do episódio → "' + d.getElementById('proximo').textContent + '"');
  tecla(8); await espera(800);
  show('Voltar cancela → player: "' + d.getElementById('player').className + '" · botão: ' + topo().querySelector('[data-botao="play"]').textContent);
  // season: Play plays everything
  cartoes(topo().querySelector('.extras'))[0].click(); await espera(900);
  show('temporada: ' + topo().querySelector('h1').textContent + ' · ' + topo().querySelector('.contagem').textContent);
  tecla(415); await espera(1500); fire('loadedmetadata'); fire('playing');
  show('Play (toca tudo) → ' + d.getElementById('osd-estado').textContent);
  tecla(40); await espera(100);
  show('menu com fila: ' + [...m.querySelectorAll('h3')].map(h => h.textContent).join(', ') + ' · itens da fila: ' + [...m.querySelectorAll('.opcao')].filter(o => /^[●○] \d+\. /.test(o.textContent)).length);
  tecla(8); fire('ended'); await espera(1500);
  show('ended com fila → ' + d.getElementById('osd-titulo').textContent);
  tecla(8); await espera(600); tecla(8); await espera(300); tecla(8); await espera(300); tecla(8); await espera(900);
  // --- music ---
  show('de volta: ' + (topo().querySelector('.aba.ativa') ? 'início' : topo().className));
  await abrirPorNome('Músicas');
  show('Músicas: ' + topo().querySelector('.contagem').textContent + ' · ' + cartoes().map(c => nomeC(c) + (c.classList.contains('quadrado') ? '□' : '')).join(', '));
  tecla(406); await espera(700);
  show('azul → ' + topo().querySelector('.contagem').textContent + ' · ' + cartoes().map(nomeC).join(', '));
  await abrirPorNome('Banda Teste');
  show('artista → ' + topo().querySelector('h1').textContent + ': ' + cartoes().map(nomeC).join(', '));
  await abrirPorNome('Album Um', 900);
  show('álbum: ' + topo().querySelector('h1').textContent + ' · ' + topo().querySelector('.meta').textContent + ' · faixas: ' +
       [...topo().querySelectorAll('.faixa')].map(f => f.textContent).join(' | '));
  topo().querySelectorAll('.faixa')[1].click(); await espera(1500); fire('loadedmetadata'); fire('playing');
  show('faixa 2 → ' + src() + '\n   player: ' + d.getElementById('player').className + ' · ' + d.getElementById('osd-titulo').textContent + ' · ' + d.getElementById('osd-estado').textContent +
       ' · capa: ' + !!d.querySelector('#capa-audio img') + ' "' + d.getElementById('capa-audio').textContent + '"');
  fire('ended'); await espera(1500);
  show('ended → ' + d.getElementById('osd-titulo').textContent + ' · ' + d.getElementById('osd-estado').textContent);
  tecla(8); await espera(500); tecla(8); tecla(8); tecla(8); await espera(900);
  // --- playlists and collections ---
  await abrirPorNome('Playlists'); await abrirPorNome('Playlist Teste');
  show('playlist: ' + topo().querySelector('.contagem').textContent + ' · ' + cartoes().length + ' itens');
  tecla(8); await espera(200); tecla(8); await espera(800);
  await abrirPorNome('Coleções'); await abrirPorNome('Coleção Teste');
  show('coleção: ' + topo().querySelector('.contagem').textContent + ' · ' + cartoes().map(nomeC).join(', '));
  tecla(8); await espera(200); tecla(8); await espera(800);
  // --- movie genres (no genres in the data: only checks the call) ---
  await abrirPorNome('Filmes'); tecla(406); await espera(700);
  show('Filmes → azul: ' + topo().querySelector('.contagem').textContent);
  const ruins = pedidos.filter(p => /undefined|null/.test(p));
  console.log('\n## ' + pedidos.length + ' pedidos ao Jellyfin real; suspeitos: ' + (ruins.length ? ruins.join(', ') : 'nenhum'));
  process.exit(0);
})().catch(e => { console.log('ERRO no roteiro:', e.message); log.forEach(l => console.log(l)); process.exit(1); });
