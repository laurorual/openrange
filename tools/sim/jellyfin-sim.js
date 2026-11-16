const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const WWW = path.resolve(__dirname, '../../www');
const html = fs.readFileSync(WWW + '/jellyfin/index.html', 'utf8').replace(/<script[^>]*><\/script>/g, '');
const dom = new JSDOM(html, { url: 'http://192.168.15.69/jellyfin/', pretendToBeVisual: true, runScripts: 'outside-only' });
const w = dom.window, d = w.document;
w.localStorage.setItem('jf.servidores', JSON.stringify([{ url: 'http://192.168.15.69:8096', nome: 'falso' }]));
const log = [], pedidos = [];
// timers 50x faster
const st = w.setTimeout.bind(w), si = w.setInterval.bind(w);
w.setTimeout = (f, ms) => st(f, (ms || 0) / 50); w.setInterval = (f, ms) => si(f, Math.max(1, (ms || 0) / 50));
// visibility: display:none on some ancestor, or the player hidden
for (const prop of ['offsetWidth', 'offsetHeight']) Object.defineProperty(w.HTMLElement.prototype, prop, { get() {
  for (let e = this; e; e = e.parentElement) {
    if (e.style && e.style.display === 'none') return 0;
    if (e.id === 'player' && !e.classList.contains('visivel')) return 0;
  } return 10; } });
// media
const v0 = w.HTMLMediaElement.prototype;
v0.play = function () { this._paused = false; return Promise.resolve(); };
v0.pause = function () { this._paused = true; };
v0.load = function () {};
Object.defineProperty(v0, 'paused', { get() { return this._paused !== false; } });
let ct = 0; Object.defineProperty(v0, 'currentTime', { get() { return ct; }, set(x) { ct = x; log.push('  [video] currentTime = ' + x); } });
Object.defineProperty(v0, 'duration', { get() { return 5400; } });
w.HTMLMediaElement.prototype.canPlayType = () => '';
// jsdom has <track> but no TextTrack: a minimal one so the subtitle renderer can be driven by hand
Object.defineProperty(w.HTMLTrackElement.prototype, 'track', { get() { return this._tt || (this._tt = { mode: 'disabled', activeCues: [], oncuechange: null }); } });
let servidorSemConversao = false;   // a Jellyfin-compatible endpoint that ignores EnableDirectPlay=false / bitrate caps
// API falsa
const mov = (i, extra) => Object.assign({ Id: 'm' + i, Name: 'Filme ' + i, Type: 'Movie', ProductionYear: 2000 + i, ImageTags: { Primary: 't' + i },
  RunTimeTicks: 5400e7, UserData: {} }, extra || {});
const filmes = Array.from({ length: 70 }, (_, i) => mov(i));
const resume = mov(1, { UserData: { PlaybackPositionTicks: 1234e7, PlayedPercentage: 23 } });
const streams = [{ Index: 0, Type: 'Video', Codec: 'hevc', Width: 1920, Height: 1080, BitDepth: 10, VideoRangeType: 'SDR' },
  { Index: 1, Type: 'Audio', Codec: 'ac3', DisplayTitle: 'Português AC3 5.1' }, { Index: 2, Type: 'Audio', Codec: 'dts', DisplayTitle: 'English DTS 5.1' },
  { Index: 3, Type: 'Subtitle', Codec: 'srt', DisplayTitle: 'Português SRT', Language: 'por', DeliveryMethod: 'External', DeliveryUrl: '/Videos/m1/ms1/Subtitles/3/0/Stream.vtt' },
  { Index: 4, Type: 'Subtitle', Codec: 'pgssub', DisplayTitle: 'English PGS', DeliveryMethod: 'Encode' }];
let qcPolls = 0; const consultas = [];
function rota(m, u, corpo) {
  const p = u.pathname, q = Object.fromEntries(u.searchParams);
  if (p === '/api/inicio') return { fuso_min: -180 };
  if (p === '/Users/Public') return [];
  if (p === '/QuickConnect/Enabled') return true;
  if (p === '/Sessions/Logout') return null;
  if (p === '/QuickConnect/Initiate') return { Code: '481516', Secret: 'seg' };
  if (p === '/QuickConnect/Connect') return { Authenticated: ++qcPolls > 2 };
  if (p === '/Users/AuthenticateWithQuickConnect') return { AccessToken: 'tok123', User: { Id: 'u1', Name: 'teste' } };
  if (p === '/Users/Me') return { Id: 'u1', Name: 'teste' };
  if (p === '/UserItems/Resume') return { Items: [resume] };
  if (p === '/Shows/NextUp') return { Items: q.seriesId ? [mov(2, { Type: 'Episode', SeriesId: 's1', IndexNumber: 2, ParentIndexNumber: 1, Name: 'Episódio 2', MediaSources: [{ MediaStreams: streams }] })] : [] };
  if (p === '/UserViews') return { Items: [{ Id: 'v1', Name: 'Filmes', Type: 'CollectionFolder', CollectionType: 'movies', ImageTags: { Primary: 'x' } },
                                            { Id: 'v2', Name: 'Videoclipes', Type: 'CollectionFolder', CollectionType: 'musicvideos' }] };
  if (p === '/Persons') return { Items: q.searchTerm ? [{ Id: 'p1', Name: 'Pessoa ' + q.searchTerm, Type: 'Person' }] : [] };
  if (/\/Similar$/.test(p)) return { Items: filmes.slice(20, 26) };
  if (p === '/Shows/s1/Seasons') return { Items: [{ Id: 't1', Name: 'Temporada 1', Type: 'Season', SeriesId: 's1', SeriesName: 'Série X', IsFolder: true, UserData: { UnplayedItemCount: 2 } }] };
  if (p === '/Items/s1') return { Id: 's1', Name: 'Série X', Type: 'Series', ProductionYear: 2020, Status: 'Continuing', ChildCount: 1, UserData: {},
    Genres: ['Drama'], People: [{ Id: 'p9', Name: 'Atriz', Type: 'Actor', Role: 'Protagonista' }, { Id: 'p8', Name: 'Diretora', Type: 'Director' }] };
  if (p === '/Items/Latest') return q.parentId === 'v1' ? filmes.slice(0, 16) : [];
  if (p === '/Items') {
    consultas.push(q);
    if (q.searchTerm) return { Items: filmes.filter(f => f.Name.toUpperCase().indexOf(q.searchTerm.toUpperCase()) >= 0).slice(0, 5), TotalRecordCount: 5 };
    if (q.filters === 'IsFavorite' && q.includeItemTypes === 'Movie' && !q.parentId) return { Items: filmes.slice(3, 5), TotalRecordCount: 2 };
    if (q.filters === 'IsFavorite' && !q.parentId) return { Items: [], TotalRecordCount: 0 };
    let lista = q.filters === 'IsUnplayed' ? filmes.slice(0, 7) : filmes;
    if (q.sortOrder === 'Descending') lista = lista.slice().reverse();
    const a = +q.startIndex, b = a + +q.limit; return { Items: lista.slice(a, b), TotalRecordCount: lista.length }; }
  if (p.indexOf('/MediaSegments/') === 0) return { Items: [] };
  if (/^\/Items\/m\d+$/.test(p) && p !== '/Items/m1') return mov(+p.slice(8), { Chapters: [], MediaSources: [{ MediaStreams: streams }] });
  if (p === '/Items/m1') return Object.assign({}, resume, { Overview: 'Sinopse.', MediaSources: [{ MediaStreams: streams }] });
  if (/^\/Items\/m\d+\/PlaybackInfo$/.test(p)) {
    const b = JSON.parse(corpo);
    log.push('  [PlaybackInfo] audio=' + b.AudioStreamIndex + ' legenda=' + b.SubtitleStreamIndex + ' direct=' + b.EnableDirectPlay +
             ' perfil=' + (b.DeviceProfile && b.DeviceProfile.Name));
    const direto = servidorSemConversao || (b.EnableDirectPlay !== false && b.SubtitleStreamIndex !== 4 && b.AudioStreamIndex !== 2);
    return { PlaySessionId: 'ps' + pedidos.length, MediaSources: [{ Id: 'ms1', Container: 'mkv', SupportsDirectPlay: direto, SupportsDirectStream: direto,
      DefaultAudioStreamIndex: 1, DefaultSubtitleStreamIndex: -1, MediaStreams: streams,
      TranscodingUrl: direto ? undefined : '/videos/m1/master.m3u8?MediaSourceId=ms1&TranscodeReasons=AudioCodecNotSupported,SubtitleCodecNotSupported&api_key=tok123' }] };
  }
  if (p === '/Shows/s1/Episodes') return { Items: [mov(1, { Type: 'Episode', SeriesId: 's1', IndexNumber: 1, ParentIndexNumber: 1 }), mov(2, { Type: 'Episode', SeriesId: 's1', IndexNumber: 2, ParentIndexNumber: 1, Name: 'Episódio 2' })] };
  if (p.indexOf('/UserPlayedItems/') === 0 || p.indexOf('/UserFavoriteItems/') === 0) return { Played: true };
  if (p.indexOf('/Sessions/Playing') === 0 || p === '/Videos/ActiveEncodings') return null;
  return { erro404: true };
}
w.XMLHttpRequest = function () {
  const x = this; let m, u, h = {};
  x.open = (mm, uu) => { m = mm; u = new w.URL(uu, 'http://192.168.15.69/jellyfin/'); };
  x.setRequestHeader = (k, v) => { h[k] = v; };
  x.send = (corpo) => {
    if (u.pathname === '/relatorio') { const r = JSON.parse(corpo); if (r.tipo !== 'tecla') log.push('  [PC] ' + r.tipo + ': ' + (r.msg || '')); return; }
    pedidos.push(m + ' ' + u.pathname + (u.pathname.indexOf('PlaybackInfo') < 0 && corpo ? ' ' + corpo.slice(0, 90) : ''));
    st(() => { const r = rota(m, u, corpo); if (r && r.erro404) { x.status = 404; x.responseText = ''; log.push('  !! 404 ' + m + ' ' + u.pathname); }
      else { x.status = r === null ? 204 : 200; x.responseText = r === null ? '' : JSON.stringify(r); }
      if (x.status !== 204 && !(h.Authorization || '').includes('Token=') && !u.pathname.startsWith('/QuickConnect') && !u.pathname.startsWith('/Users/Auth') && u.pathname !== '/Users/Public' && u.pathname !== '/api/inicio')
        log.push('  !! sem token: ' + u.pathname);
      x.onload && x.onload(); }, 2);
  };
};
w.console.log = () => {};
w.onerror = null;
for (const f of ['/lib/tv.js', '/jellyfin/jf.js', '/jellyfin/player.js', '/jellyfin/app.js']) {
  try { w.eval(fs.readFileSync(WWW + f, 'utf8')); } catch (e) { console.log('ERRO ao carregar', f, e); process.exit(1); }
}
const espera = (ms) => new Promise(r => st(r, ms));
const tecla = (k) => { const ev = new w.Event('keydown', { bubbles: true }); Object.defineProperty(ev, 'keyCode', { value: k }); d.dispatchEvent(ev); };
const vid = d.getElementById('video');
const fire = (n) => vid.dispatchEvent(new w.Event(n));
const telaTopo = () => { const t = d.querySelectorAll('.tela'); return t[t.length - 1]; };
const show = (t) => { console.log('\n## ' + t); log.splice(0).forEach(l => console.log(l)); };
w.addEventListener('error', (e) => console.log('ERRO JS:', e.message));
(async () => {
  await espera(30);
  show('login: ' + [...d.querySelectorAll('.linha-titulo')].map(x => x.textContent).join(' | '));
  [...d.querySelectorAll('.linha')].find(l => /Quick Connect/.test(l.textContent)).click(); await espera(30);
  show('login: código = ' + (d.querySelector('.codigo') || {}).textContent);
  await espera(400);
  const fileiras = [...d.querySelectorAll('.bloco-fileira h2')].map((h, i) => h.textContent + ' (' + h.nextSibling.children.length + ')');
  show('início: ' + fileiras.join(' | ') + ' · foco: ' + (w.tv.atual && w.tv.atual.querySelector('.titulo').textContent) +
       ' · token salvo: ' + w.localStorage.getItem('jf.token'));
  [...d.querySelectorAll('.cartao')].find(c => c.querySelector('.titulo').textContent === 'Filmes').click();
  await espera(100);
  const g = telaTopo();
  show('grade: ' + g.querySelector('h1').textContent + ' · ' + g.querySelectorAll('.cartao').length + ' cartões · ' + g.querySelector('.contagem').textContent);
  w.tv.focar(g.querySelectorAll('.cartao')[55]); await espera(100);
  show('grade após foco no 56º: ' + g.querySelectorAll('.cartao').length + ' cartões');
  tecla(8); await espera(50);
  show('voltar → telas: ' + d.querySelectorAll('.tela').length + ' · foco: ' + (w.tv.atual && w.tv.atual.querySelector('.titulo').textContent));
  d.querySelector('.cartao[data-id="m1"]').click(); await espera(100);
  const det = telaTopo();
  show('detalhe: ' + det.querySelector('h1').textContent + ' · meta: ' + det.querySelector('.meta').textContent + ' · botões: ' +
       [...det.querySelectorAll('.botao')].map(b => b.textContent).join(' | ') + ' · ' + [...det.querySelectorAll('.faixas')].map(f => f.textContent).join(' / '));
  det.querySelector('.botao').click(); await espera(100);
  show('player: src = ' + vid.getAttribute('src') + ' · tracks: ' + vid.querySelectorAll('track').length + ' · telas escondidas: ' + d.getElementById('telas').style.display);
  fire('loadedmetadata'); fire('playing'); await espera(50);
  show('tocando: ' + d.getElementById('osd-estado').textContent);
  tecla(405); await espera(50);
  const tr = vid.querySelector('track');
  show('amarelo 1: track src=' + tr.src + ' mode=' + (tr.track && tr.track.mode));
  { // subtitles are drawn by us (the TV's cue font misplaces ê): hidden track + #legenda-tela, NFC, no tags/entities
    const leg = d.getElementById('legenda-tela');
    if (tr.track.mode !== 'hidden') console.log('ERRO legenda: track deveria estar hidden, está ' + tr.track.mode);
    tr.track.activeCues = [{ text: 'Voc<i>e\u0302</i> est&amp;á\nsegunda linha' }, { text: '<c.amarelo>Pôr</c>' }];
    tr.track.oncuechange(); await espera(5);
    const txt = leg.textContent, esperado = 'Você est&á\nsegunda linhaPôr';
    console.log(txt === esperado && txt.indexOf('\u0302') < 0 ? '## legenda desenhada: ' + JSON.stringify(txt) + ' (' + leg.children.length + ' nós)'
                                                                : 'ERRO legenda: ' + JSON.stringify(txt));
    tr.track.activeCues = []; tr.track.oncuechange();
    if (leg.textContent) console.log('ERRO legenda: não limpou ao sair da cue');
    if (!/#legenda-tela[^}]*font-size/.test(html) || !/#osd\.visivel ~ #legenda-tela/.test(html)) console.log('ERRO legenda: CSS de #legenda-tela sumiu');
  }
  tecla(405); await espera(150);
  show('amarelo 2 (PGS, queimada): src = ' + vid.getAttribute('src'));
  fire('loadedmetadata'); fire('playing');
  tecla(406); await espera(150);
  show('azul (áudio DTS): src = ' + vid.getAttribute('src'));
  fire('loadedmetadata'); fire('playing'); ct = 100;
  tecla(39); tecla(39); tecla(39); await espera(30);
  show('→ ×3 antes do debounce: ' + d.getElementById('osd-tempo').textContent);
  await espera(40);
  show('depois do debounce');
  tecla(404); await espera(10);
  show('verde (info):\n' + d.getElementById('info').textContent);
  { // a very long server URL (no spaces) must be wrapped, not widen the panel off-screen
    const antes = w.jf.servidor; w.jf.servidor = 'https://jellyfin.exemplo.com.br/' + 'caminho-muito-longo/'.repeat(8) + '?x=1';
    tecla(404); tecla(404); await espera(10);
    const linhas = d.getElementById('info').textContent.split('\n'), longa = linhas.filter(l => l.length > 64);
    const junto = linhas.map(l => l.replace(/^ {10}/, '')).join('');
    console.log(longa.length ? 'ERRO info: linha com ' + longa[0].length + ' caracteres' : '## info: URL longa quebrada em ' + linhas.length + ' linhas (≤ 64)');
    if (junto.indexOf(w.jf.servidor) < 0) console.log('ERRO info: a URL quebrada perdeu caracteres');
    w.jf.servidor = antes; tecla(404); tecla(404); await espera(10);
  }
  tecla(8); await espera(150);
  show('voltar do player → telas visíveis: ' + (d.getElementById('telas').style.display === '') + ' · player: ' + d.getElementById('player').className);
  det.querySelector('.botao').click(); await espera(100); fire('loadedmetadata');
  vid.dispatchEvent(new w.Event('error')); await espera(150);
  show('erro no direct play → src = ' + vid.getAttribute('src'));
  vid.dispatchEvent(new w.Event('error')); await espera(50);
  show('erro também no master.m3u8 → src = ' + vid.getAttribute('src'));
  vid.dispatchEvent(new w.Event('error')); await espera(100);
  show('erro no main.m3u8 → player: "' + d.getElementById('player').className + '" (fechado = ok)');
  // --- rodada nova ---
  pedidos.length = 0;
  det.querySelector('.botao').click(); await espera(100);
  fire('loadedmetadata'); fire('playing'); fire('waiting'); fire('playing'); fire('waiting'); fire('playing'); await espera(30);
  tecla(404); await espera(10);
  show('2 travadas → inícios relatados: ' + pedidos.filter(x => x === 'POST /Sessions/Playing' || x.startsWith('POST /Sessions/Playing {')).length +
       ' · info: ' + d.getElementById('info').textContent.split('\n').filter(l => l.indexOf('Travadas') === 0)[0]);
  tecla(404);
  tecla(53); await espera(40);
  show('tecla 5 (50%)');
  tecla(403); await espera(150);
  show('vermelho (modo compatível) → ' + vid.getAttribute('src').split('?')[0]);
  fire('loadedmetadata'); fire('playing');
  tecla(8); await espera(150);
  show('voltar do player');
  const marcar = [...det.querySelectorAll('.botao')].find(b => b.textContent === 'Marcar como visto');
  marcar.click(); await espera(30);
  show('marcar como visto → botão: ' + marcar.textContent);
  const antes = pedidos.filter(x => x.indexOf('/UserItems/Resume') >= 0).length;
  tecla(8); await espera(100);
  show('voltar ao início → Resume recarregado: ' + (pedidos.filter(x => x.indexOf('/UserItems/Resume') >= 0).length - antes) +
       ' · foco: ' + (w.tv.atual && w.tv.atual.querySelector('.titulo').textContent) + ' · fileiras: ' + d.querySelectorAll('.bloco-fileira').length);
  // next episode
  w.jfPlayer.tocar(mov(1, { Type: 'Episode', SeriesId: 's1', IndexNumber: 1, SeriesName: 'Série' }), 0, () => log.push('  [aoFim]'));
  await espera(50); fire('loadedmetadata'); fire('playing'); fire('ended'); await espera(40);
  show('fim do episódio → aviso: ' + d.getElementById('proximo').textContent);
  await espera(300);
  show('depois da contagem → src: ' + (vid.getAttribute('src') || '').split('?')[0] + ' · aviso: "' + d.getElementById('proximo').className + '"');
  fire('ended'); await espera(40); tecla(8); await espera(50);
  show('ended no último + Voltar → player: "' + d.getElementById('player').className + '"');
  // --- J2: tabs, search, sort/filter, favorites, series ---
  const aba = (id) => telaTopo().querySelector('.aba[data-aba="' + id + '"]');
  const tk = (id) => telaTopo().querySelector('.tecla[data-tecla="' + id + '"]');
  show('J2: tela do topo tem barra? ' + !!telaTopo().querySelector('.barra') + ' · aba ativa: ' + telaTopo().querySelector('.aba.ativa').textContent);
  aba('busca').click(); await espera(30);
  show('busca aberta · foco: ' + w.tv.atual.textContent + ' · teclas: ' + telaTopo().querySelectorAll('.tecla').length);
  w.localStorage.removeItem('jf.busca'); tk('limpar').click();
  tk('F').click(); tk('I').click(); tk('L').click(); tecla(49); await espera(60);
  show('digitou FIL + tecla 1 → campo "' + telaTopo().querySelector('.busca-campo').textContent + '" · ' + telaTopo().querySelector('.contagem').textContent +
       ' · cartões: ' + telaTopo().querySelectorAll('.grade .cartao').length + ' (pessoa: ' + telaTopo().querySelectorAll('.cartao.pessoa').length + ')');
  tk('apagar').click(); await espera(60);
  show('apagar → "' + telaTopo().querySelector('.busca-campo').textContent + '" · ' + telaTopo().querySelector('.contagem').textContent);
  telaTopo().querySelector('.cartao.pessoa').click(); await espera(60);
  show('pessoa → grade: ' + telaTopo().querySelector('h1').textContent + ' · ' + telaTopo().querySelector('.contagem').textContent + ' · personIds=' + consultas[consultas.length - 1].personIds);
  tecla(8); await espera(30); tecla(8); await espera(60);
  show('Voltar 2× (busca → início): aba ativa = ' + telaTopo().querySelector('.aba.ativa').textContent + ' · telas: ' + d.querySelectorAll('.tela').length);
  aba('favoritos').click(); await espera(80);
  show('favoritos: ' + [...telaTopo().querySelectorAll('.bloco-fileira h2')].map(h => h.textContent + ' (' + h.nextSibling.children.length + ')').join(' | ') +
       ' · vazio visível: ' + !!telaTopo().querySelector('p.vazio'));
  aba('inicio').click(); await espera(80);
  [...d.querySelectorAll('.cartao')].find(c => c.querySelector('.titulo').textContent === 'Filmes').click(); await espera(60);
  tecla(404); await espera(60);
  let c1 = telaTopo().querySelector('.contagem').textContent, q1 = consultas[consultas.length - 1];
  tecla(405); await espera(60);
  show('grade: verde → ' + c1 + ' [sortBy=' + q1.sortBy + ' ' + q1.sortOrder + '] · 1º: ' + '?' + '\n   amarelo → ' + telaTopo().querySelector('.contagem').textContent +
       ' [filters=' + consultas[consultas.length - 1].filters + '] · cartões: ' + telaTopo().querySelectorAll('.cartao').length + ' · salvo: ' + w.localStorage.getItem('jf.grade.v1'));
  tecla(405); tecla(405); tecla(405); await espera(60);
  tecla(8); await espera(60);
  w.jfApp.empilhar; // series
  const serie = { Id: 's1', Name: 'Série X', Type: 'Series', IsFolder: true };
  const cs = [...d.querySelectorAll('.cartao')][0];
  // opens the series through the same function as the cards: simulates a series card in a row
  w.eval("window.__abrirSerie = function () { var c = document.querySelector('.cartao'); }");
  d.querySelector('.cartao[data-id="m1"]').click(); await espera(80);   // movie details (rich)
  const dt = telaTopo();
  show('detalhe rico: botões = ' + [...dt.querySelectorAll('.botao')].map(b => b.textContent).join(' | ') + '\n   meta: ' + dt.querySelector('.meta').textContent +
       '\n   extras: ' + [...dt.querySelectorAll('.extras h2')].map(h => h.textContent + ' (' + h.nextSibling.children.length + ')').join(' | '));
  dt.querySelector('[data-botao="audio"]').click(); dt.querySelector('[data-botao="legenda"]').click(); dt.querySelector('[data-botao="legenda"]').click();
  show('seletores → ' + dt.querySelector('[data-botao="audio"]').textContent + ' | ' + dt.querySelector('[data-botao="legenda"]').textContent);
  dt.querySelector('[data-botao="play"]').click(); await espera(80);
  show('tocar com escolhas → ' + (vid.getAttribute('src') || '').split('?')[0]);
  tecla(8); await espera(120);
  show('voltou do player · seletores mantidos: ' + telaTopo().querySelector('[data-botao="audio"]').textContent);
  w.jfApp.abrir({ Id: 's1', Name: 'Série X', Type: 'Series', IsFolder: true }); await espera(120);
  const sr = telaTopo();
  show('série: ' + sr.querySelector('h1').textContent + ' · meta: ' + sr.querySelector('.meta').textContent + ' · ' + (sr.querySelector('.generos') || {}).textContent +
       '\n   botões: ' + [...sr.querySelectorAll('.botao')].map(b => b.textContent).join(' | ') + ' · ' + (sr.querySelector('.faixas') || {}).textContent +
       '\n   extras: ' + [...sr.querySelectorAll('.extras h2')].map(h => h.textContent + ' (' + h.nextSibling.children.length + ')').join(' | '));
  sr.querySelector('.extras .cartao').click(); await espera(80);
  show('temporada → ' + telaTopo().querySelector('h1').textContent + ' · ' + telaTopo().querySelector('.contagem').textContent + ' · largos: ' + telaTopo().querySelectorAll('.cartao.largo').length);
  tecla(8); await espera(60);
  sr.querySelector('[data-botao="play"]').click(); await espera(80);
  show('play da série → ' + (vid.getAttribute('src') || '').split('?')[0]);
  tecla(8); await espera(80);
  { // choosing a subtitle in the ↓ menu must not leave the OSD pinned (it used to stay until ↑ was pressed)
    w.jfPlayer.tocar(mov(6, { MediaSources: [{ MediaStreams: streams }], Chapters: [] }), 0, null, { bitrate: 0 });
    await espera(80); fire('loadedmetadata'); fire('playing'); vid._paused = false;
    w.jfPlayer.abrirMenu(); await espera(10);
    const op = [...d.querySelectorAll('#menu .opcao')].find((o) => /Português SRT/.test(o.textContent));
    op.click(); await espera(200);                       // OSD delay is 4 s / 50 = 80 ms here
    const osdEstado = d.getElementById('osd').className;
    show('legenda pelo menu → OSD "' + osdEstado + '" · legenda ' + (vid.querySelector('track') && vid.querySelector('track').track.mode));
    if (osdEstado) console.log('ERRO OSD continuou visível depois de escolher a legenda no menu');
    tecla(8); await espera(120);
  }
  { // a server that can't convert: quality request ignored → honest info, notice, no quality options, red key inert
    servidorSemConversao = true;
    w.jfPlayer.tocar(mov(5, { MediaSources: [{ MediaStreams: streams }], Chapters: [] }), 0, null, { bitrate: 6e6, semDireto: true });
    await espera(80); fire('loadedmetadata'); fire('playing');
    tecla(404); await espera(10);
    const metodo = d.getElementById('info').textContent.replace(/\n {10}/g, '').split('\n')[0], aviso = (d.getElementById('tv-aviso') || {}).textContent || '';
    tecla(404);
    w.jfPlayer.abrirMenu(); await espera(10);
    const nota = (d.querySelector('#menu .nota') || {}).textContent || '', qualidades = [...d.querySelectorAll('#menu .opcao')].filter(o => /Mb\/s/.test(o.textContent)).length;
    tecla(8); await espera(10);
    const src0 = vid.getAttribute('src'); tecla(403); await espera(150);
    show('servidor sem conversão → ' + metodo + '\n   aviso: ' + aviso + '\n   menu: "' + nota + '", opções de Mb/s: ' + qualidades +
         ' · vermelho trocou o vídeo: ' + (vid.getAttribute('src') !== src0));
    if (!/DirectPlay · o servidor não converte vídeo \(limite 6 Mb\/s ignorado\)/.test(metodo) || !/não converte/.test(aviso) || !nota || qualidades ||
        vid.getAttribute('src') !== src0) console.log('ERRO servidor sem conversão');
    tecla(8); await espera(120); servidorSemConversao = false;
  }
  console.log('\n## pedidos à API'); pedidos.forEach(p => console.log('  ' + p));
  process.exit(0);
})();
