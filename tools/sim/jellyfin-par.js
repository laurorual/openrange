// jellyfin-par.js — QWERTY keyboard, Settings with ←/→ and list, and phone pairing (QR + /api/par) against
// the real Jellyfin and a test portal. Usage: start `DNS=0 PORTA_HTTP=18080 PORTA_HTTPS=18443 python3 tools/portal.py` and run
// JF_USUARIO=nome JF_SENHA=senha NODE_PATH=~/.cache/openrange/sim/node_modules node tools/sim/jellyfin-par.js
// "Reload the page" = a new jsdom window with the same localStorage.
const fs = require('fs'), path = require('path'), os = require('os');
const { JSDOM, VirtualConsole } = require('jsdom');
const WWW = path.resolve(__dirname, '../../www');
const tk = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.cache/openrange/jellyfin-token.json'), 'utf8'));
const host = new URL(tk.servidor).hostname, USUARIO = process.env.JF_USUARIO, SENHA = process.env.JF_SENHA;
if (!USUARIO || SENHA == null) { console.log('defina JF_USUARIO e JF_SENHA'); process.exit(2); }
const html = fs.readFileSync(WWW + '/jellyfin/index.html', 'utf8').replace(/<script[^>]*><\/script>/g, '');
let w, d, log = [], recargas = 0;
const espera = (ms) => new Promise(r => setTimeout(r, ms));
function pagina(storage) {
  const dom = new JSDOM(html, { url: 'http://' + host + ':18080/jellyfin/', pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  w = dom.window; d = w.document;
  Object.keys(storage || {}).forEach(k => w.localStorage.setItem(k, storage[k]));
  for (const prop of ['offsetWidth', 'offsetHeight']) Object.defineProperty(w.HTMLElement.prototype, prop, { get() {
    for (let e = this; e; e = e.parentElement) { if (e.style && e.style.display === 'none') return 0; if ((e.id === 'player' || e.id === 'menu') && !e.classList.contains('visivel')) return 0; } return 10; } });
  const XHR = w.XMLHttpRequest;
  w.XMLHttpRequest = function () {
    const x = new XHR(), open = x.open.bind(x), send = x.send.bind(x); let alvo = '';
    x.open = (m, u, a) => { alvo = u; open(m, u, a); };
    x.send = (c) => { if (alvo === '/relatorio') { const r = JSON.parse(c); if (r.tipo !== 'tecla') log.push('  [PC] ' + r.tipo + ': ' + (r.msg || '')); return; } if (alvo === '/api/inicio') return; send(c); };
    return x;
  };
  w.console.log = () => {};
  w.setTimeout = ((st) => (f, ms) => st(f, ms))(w.setTimeout.bind(w));
  for (const f of ['/lib/vendor/qrcode.js', '/lib/tv.js', '/jellyfin/jf.js', '/jellyfin/player.js', '/jellyfin/app.js']) w.eval(fs.readFileSync(WWW + f, 'utf8'));
  w.addEventListener('error', (e) => console.log('ERRO JS:', e.message));
}
const guarda = () => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; };
const recarrega = async () => { const s = guarda(); recargas++; pagina(s); await espera(1500); };
const tecla = (k) => { const ev = new w.Event('keydown', { bubbles: true }); Object.defineProperty(ev, 'keyCode', { value: k }); d.dispatchEvent(ev); };
const topo = () => { const t = d.querySelectorAll('.tela'); return t[t.length - 1]; };
const show = (t) => { console.log('\n## ' + t); log.splice(0).forEach(l => console.log(l)); };
const linhas = () => [...topo().querySelectorAll('.linha')];
const linha = (re) => { const l = linhas().find(l => re.test(l.textContent)); if (!l) throw new Error('linha não achada: ' + re); return l; };
const digita = (txt) => { for (const ch of txt) { const t = [...topo().querySelectorAll('.tecla')].find(t => t.textContent === ch); if (!t) throw new Error('sem tecla "' + ch + '"'); t.click(); } };
const confirma = () => topo().querySelector('.tecla.confirma').click();
const semTok = (s) => String(s).replace(/"token":"[^"]+"/g, '"token":"<T>"').replace(/"userId":"[^"]+"/g, '"userId":"<U>"');
(async () => {
  const PORTAL = 'http://' + host + ':18080';
  pagina({ 'jf.servidores': JSON.stringify([{ url: tk.servidor, nome: 'PC', token: tk.token, userId: tk.userId, usuario: 'teste' }]) });
  await espera(1800);
  topo().querySelector('.aba[data-aba="busca"]').click(); await espera(200);
  show('busca, fileiras do teclado: ' + [...topo().querySelectorAll('.fila-teclas')].map(f => f.textContent).join(' / '));
  tecla(8); await espera(800);
  topo().querySelector('.aba[data-aba="ajustes"]').click(); await espera(1500);
  const q = linha(/Qualidade padrão/); w.tv.focar(q);
  const val = () => q.querySelector('.linha-valor').textContent;
  let v0 = val(); tecla(39); let v1 = val(); tecla(39); let v2 = val(); tecla(37); tecla(37); tecla(37); let v3 = val();
  show('Ajustes ←/→: ' + v0 + ' → ' + v1 + ' → ' + v2 + ' ←←← ' + v3 + ' · foco continua na linha: ' + (w.tv.atual === q));
  tecla(13); await espera(100);
  show('OK abre a lista: ' + topo().querySelector('h1').textContent + ' · ' + linhas().map(l => l.textContent).join(' | ') + '\n   foco: ' + w.tv.atual.textContent);
  linha(/3 Mb/).click(); await espera(100);
  show('escolheu 3 Mb/s → ' + val() + ' · salvo: ' + w.localStorage.getItem('jf.qualidade') + ' · foco voltou à linha: ' + (w.tv.atual === linha(/Qualidade padrão/)));
  w.localStorage.removeItem('jf.qualidade');
  linha(/^Servidor/).click(); await espera(200);
  linha(/usuário e senha|teclado da TV/).click(); await espera(100);
  show('teclado de texto, fileiras: ' + [...topo().querySelectorAll('.fila-teclas')].map(f => f.textContent).join(' / '));
  tecla(8); await espera(100);
  linha(/celular/).click(); await espera(1200);
  const url = topo().querySelector('.par-link').textContent, cod = /c=(\w+)/.exec(url)[1];
  show('pareamento: ' + url.replace(cod, '<código>') + ' · QR: ' + (topo().querySelector('.par-qr img') ? 'imagem ' + topo().querySelector('.par-qr img').getAttribute('width') + 'px' : 'FALTA') + ' · ' + topo().querySelector('.estado').textContent.replace(cod, '<código>'));
  const pg = await fetch(PORTAL + '/jellyfin/celular.html?c=' + cod); show('página do celular: HTTP ' + pg.status + ' ' + (await pg.text()).length + ' B');
  const cel = async (c) => { await fetch(PORTAL + '/api/par/' + cod + '/comando', { method: 'POST', body: JSON.stringify(c) });
    for (let i = 0; i < 20; i++) { await espera(700); const d = await (await fetch(PORTAL + '/api/par/' + cod)).json(); if (d.resultado) return d; } return { resultado: { msg: 'SEM RESPOSTA DA TV' }, estado: {} }; };
  let r = await cel({ tipo: 'adicionar', url: 'http://127.0.0.1:9', usar: false });
  show('celular → adicionar endereço ruim: ' + JSON.stringify(r.resultado));
  w.jf.servidores[0].id = 'id-antigo';                                      // so the same Jellyfin counts as another server
  r = await cel({ tipo: 'adicionar', url: '127.0.0.1', usuario: USUARIO, senha: 'errada', usar: false });
  show('celular → adicionar 127.0.0.1 com senha errada: ' + JSON.stringify(r.resultado) + '\n   TV: ' + r.estado.servidores.map(s => s.url + (s.emUso ? '●' : '') + '[' + (s.usuario || '-') + ']').join(', '));
  r = await cel({ tipo: 'entrar', url: 'http://127.0.0.1:8096', usuario: USUARIO, senha: SENHA });
  show('celular → entrar: ' + JSON.stringify(r.resultado) + ' · TV: ' + r.estado.servidores.map(s => s.url + (s.emUso ? '●' : '') + '[' + (s.usuario || '-') + ']').join(', '));
  r = await cel({ tipo: 'usar', url: 'http://127.0.0.1:8096' });
  show('celular → usar: ' + JSON.stringify(r.resultado) + ' · TV: ' + r.estado.servidores.map(s => s.url + (s.emUso ? '●' : '')).join(', ') + ' · na tela: "' + topo().querySelector('.estado').textContent + '"');
  topo().querySelector('.botao').click(); await espera(600);
  await recarrega();
  show('Concluir → recarregou no servidor ' + w.jf.servidor + ' · logado: ' + w.jf.sessao.nome + ' · aba: ' + (topo().querySelector('.aba.ativa') || {}).textContent);
  await w.jf.api('POST', '/Sessions/Logout').then(null, () => {});
  const grep = require('child_process').spawnSync('grep', ['-c', '"senha"\\|errada', path.resolve(__dirname, '../../logs/portal.log')]).stdout.toString().trim();
  console.log('\nocorrências de senha no portal.log: ' + grep + '\npareamento ok'); process.exit(0);
})().catch(e => { console.log('ERRO no roteiro:', e.message); log.forEach(l => console.log(l)); process.exit(1); });
