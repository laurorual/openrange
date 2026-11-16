// jellyfin-j5.js — J5 against the real Jellyfin: first access (finds the default server), user/password login on
// the on-screen keyboard, Settings, servers (bad address, 2nd server, switch, remove), sign out.
// Uso: JF_USUARIO=nome JF_SENHA=senha NODE_PATH=~/.cache/openrange/sim/node_modules node tools/sim/jellyfin-j5.js
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
  const dom = new JSDOM(html, { url: 'http://' + host + '/jellyfin/', pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
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
  for (const f of ['/lib/tv.js', '/jellyfin/jf.js', '/jellyfin/player.js', '/jellyfin/app.js']) w.eval(fs.readFileSync(WWW + f, 'utf8'));
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
  pagina({}); await espera(1800);
  show('1º acesso (sem nada salvo) → servidores: ' + semTok(w.localStorage.getItem('jf.servidores')));
  await recarrega();
  show('após recarregar → ' + topo().querySelector('h1').textContent + ' · ' + topo().querySelector('.dica').textContent + '\n   opções: ' + linhas().map(l => l.querySelector('.linha-titulo').textContent).join(' | '));
  linha(/usuário e senha/).click(); await espera(100);
  show('teclado: ' + topo().querySelector('h1').textContent + ' · ' + topo().querySelectorAll('.tecla').length + ' teclas');
  digita(USUARIO); confirma(); await espera(300);
  show('→ ' + topo().querySelector('h1').textContent + ' · campo mascarado: "' + topo().querySelector('.busca-campo').textContent + '"');
  digita('x'); confirma(); await espera(1500);
  show('senha errada → "' + topo().querySelector('.estado').textContent + '"');
  [...topo().querySelectorAll('.tecla')].find(t => t.textContent === 'limpar').click();
  digita(SENHA); show('campo: "' + topo().querySelector('.busca-campo').textContent + '"'); confirma(); await espera(2500);
  show('senha certa → aba ativa: ' + (topo().querySelector('.aba.ativa') || {}).textContent + ' · usuário: ' + topo().querySelector('.usuario').textContent + ' · salvo: ' + semTok(w.localStorage.getItem('jf.servidores')));
  topo().querySelector('.aba[data-aba="ajustes"]').click(); await espera(1500);
  const vals = () => linhas().map(l => l.querySelector('.linha-titulo').textContent + ' = ' + (l.querySelector('.linha-valor') || {}).textContent).join('\n   ');
  show('Ajustes:\n   ' + vals());
  for (const re of [/Qualidade padrão/, /Pular aberturas/, /Idioma de áudio/]) { w.tv.focar(linha(re)); tecla(39); } await espera(800);   // → changes the option
  const me = await w.jf.api('GET', '/Users/Me');
  show('→ em 3 opções → qualidade=' + w.localStorage.getItem('jf.qualidade') + ' autopular=' + w.localStorage.getItem('jf.autopular') + ' · no servidor AudioLanguagePreference=' + me.Configuration.AudioLanguagePreference);
  me.Configuration.AudioLanguagePreference = ''; await w.jf.api('POST', '/Users/Configuration', { userId: me.Id }, me.Configuration);
  w.localStorage.removeItem('jf.qualidade'); w.localStorage.removeItem('jf.autopular');
  linha(/^Servidor/).click(); await espera(200);
  show('Servidores: ' + linhas().map(l => l.querySelector('.linha-titulo').textContent + ' [' + l.querySelector('.linha-sub').textContent.slice(0, 50) + ']').join(' | '));
  linha(/Adicionar servidor/).click(); await espera(100);
  digita('127.0.0.1:9'); confirma(); await espera(2500);
  show('endereço ruim → "' + topo().querySelector('.estado').textContent + '"');
  tecla(8); await espera(100);
  w.jf.adicionarServidor('http://127.0.0.1:8096', { Id: 'outro-id', ServerName: 'Outro (mesmo Jellyfin por 127.0.0.1)', Version: '10.10.7' }); w.jf.usarServidor(0);
  tecla(8); await espera(100); linha(/^Servidor/).click(); await espera(200);
  show('com 2 servidores: ' + linhas().map(l => l.querySelector('.linha-titulo').textContent).join(' | '));
  linha(/Outro/).click(); await espera(500); await recarrega();
  show('trocou → ' + topo().querySelector('h1').textContent + ' · ' + topo().querySelector('.dica').textContent + ' · jf.servidor=' + w.jf.servidor);
  linha(/^Servidores/).click(); await espera(200);
  w.tv.focar(linha(/Outro/)); tecla(403); await espera(50); tecla(403); await espera(500);
  show('vermelho 2× no servidor em uso → restam: ' + JSON.parse(w.localStorage.getItem('jf.servidores')).map(s => s.url).join(', '));
  await recarrega();
  show('recarregou → aba ativa: ' + (topo().querySelector('.aba.ativa') || {}).textContent + ' (sessão do 1º servidor preservada) · servidor ' + w.jf.servidor);
  const token = w.jf.sessao.token;
  topo().querySelector('.aba[data-aba="ajustes"]').click(); await espera(1200);
  linha(/^Usuário/).click(); await espera(1200);
  let st = 0; try { await w.jf.api('GET', '/Users/Me'); } catch (e) { st = e.status; }
  const r = await fetch(tk.servidor + '/Users/Me', { headers: { Authorization: 'MediaBrowser Client="t", Device="t", DeviceId="t", Version="1", Token="' + token + '"' } });
  show('sair → ' + topo().querySelector('h1').textContent + ' · token local: ' + w.jf.sessao.token + ' · token antigo no servidor: HTTP ' + r.status);
  console.log('\nJ5 ok (' + recargas + ' recargas)'); process.exit(0);
})().catch(e => { console.log('ERRO no roteiro:', e.message); log.forEach(l => console.log(l)); process.exit(1); });
