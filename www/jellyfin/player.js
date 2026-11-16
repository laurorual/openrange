/* player.js — playback for the OpenRange Jellyfin client, always through <video src> (the TV's native player).
 *
 *  - PlaybackInfo with the jf.js profile; the server decides DirectPlay / DirectStream / Transcode (HLS TS).
 *  - If direct play errors, retries once forcing transcoding (unless the server can't transcode).
 *  - Text subtitles: <track> WebVTT, drawn by us in #legenda-tela (instant switch). Image ones: burned in (restarts playback).
 *  - Switching audio restarts playback without direct play (the native player only plays the default track).
 *  - Reports start, progress (10 s) and stop to /Sessions/Playing*, for "Continue watching".
 *  - Counts stalls ("waiting" after start) and time stopped; sends them to the PC at the end.
 *  - An episode that ends → 10 s countdown and the next one of the season starts by itself.
 *  - J4: menu (↓) with quality, audio, subtitles, chapters and queue; seek thumbnails (trickplay);
 *    chapter marks and name on the bar; "Skip intro/credits" (media segments or chapters with that
 *    name); play queue (album, playlist) and audio mode (cover + bar always visible).
 * Keys: OK pauses (or skips the intro, if that notice is on screen) · ←/→ −10 s/+30 s (accumulates) ·
 *       1–9 = 10–90 %, 0 = start · ↑ shows the bar · ↓ opens the menu · Yellow subtitles · Blue audio ·
 *       Green info · Red compatible mode · ⏩/⏪ next/previous in the queue (or ±60/30 s) · Back exits.
 */
(function () {
  'use strict';

  var div = document.getElementById('player');
  var v = document.getElementById('video');
  var osd = document.getElementById('osd');
  var oTitulo = document.getElementById('osd-titulo'), oBarra = document.getElementById('osd-barra');
  var oTempo = document.getElementById('osd-tempo'), oEstado = document.getElementById('osd-estado');
  var painel = document.getElementById('info');
  var telas = document.getElementById('telas');

  var e = null;              // state of the current playback
  var timerOsd = null, timerProgresso = null, timerSeek = null, alvoSeek = null;
  var proximo = null;        // countdown to the next episode: {item, timer, restante}
  var aviso = document.getElementById('proximo');
  var oMarcas = document.getElementById('osd-marcas'), oTrick = document.getElementById('trick');
  var oPular = document.getElementById('pular'), menu = document.getElementById('menu');
  var capaAudio = document.getElementById('capa-audio'), oLegenda = document.getElementById('legenda-tela');
  // Servers seen ignoring a conversion request (asked for no direct play / a bitrate cap, got DirectPlay anyway):
  // Jellyfin-compatible endpoints that only hand out the original file. Per server URL, for this page load.
  var semConversao = {};
  function servidorConverte() { return !semConversao[jf.servidor]; }
  var QUALIDADES = [[0, 'Automática (direto quando dá)'], [20e6, '1080p · 20 Mb/s'], [10e6, '1080p · 10 Mb/s'],
                    [6e6, '720p · 6 Mb/s'], [3e6, '720p · 3 Mb/s'], [1.5e6, '480p · 1,5 Mb/s']];

  function U() { return window.jfUtil; }
  function ajuste(k, pad) { try { var x = localStorage.getItem('jf.' + k); return x == null ? pad : x; } catch (x2) { return pad; } }
  function ativo() { return !!e || !!proximo; }
  function ticks(seg) { return Math.round(seg * jf.TICKS); }

  function corpoSessao(extra) {
    var c = { ItemId: e.item.Id, MediaSourceId: e.ms.Id, PlaySessionId: e.playSessionId, PlayMethod: e.metodo,
              PositionTicks: ticks(v.currentTime || e.inicioSeg || 0), CanSeek: true, IsPaused: v.paused,
              AudioStreamIndex: e.audio, SubtitleStreamIndex: e.legenda, VolumeLevel: 100 };
    for (var k in extra) if (extra.hasOwnProperty(k)) c[k] = extra[k];
    return c;
  }
  function relatar(caminho, extra) {
    if (!e) return Promise.resolve();
    return jf.api('POST', '/Sessions/Playing' + caminho, null, corpoSessao(extra || {}))
      .then(null, function (x) { tv.log('relatório ' + (caminho || 'início') + ' falhou: ' + x.message); });
  }

  // --- OSD ---------------------------------------------------------------------------------------
  function duracaoSeg() {
    if (e && e.item.RunTimeTicks) return e.item.RunTimeTicks / jf.TICKS;
    return isFinite(v.duration) ? v.duration : 0;
  }
  function desenharOsd() {
    if (!e) return;
    var dur = duracaoSeg(), pos = alvoSeek != null ? alvoSeek : v.currentTime;
    oBarra.style.width = dur ? Math.min(100, 100 * pos / dur).toFixed(2) + '%' : '0';
    oTempo.textContent = U().relogio(pos) + ' / ' + U().relogio(dur) + (alvoSeek != null ? '   (pular)' : '');
    var cap = capituloEm(pos);
    oEstado.textContent = (cap ? cap.Name + '   ·   ' : '') + (v.paused ? '❚❚ pausado' : '▶') + '   ' +
                          (e.fila ? (e.iFila + 1) + '/' + e.fila.length + '   ' : '') + e.metodo + (e.carregando ? '   carregando…' : '');
    desenharTrick(alvoSeek);
  }
  function capituloEm(pos) {
    var caps = (e && e.item.Chapters) || [], achado = null;
    for (var i = 0; i < caps.length; i++) if (caps[i].StartPositionTicks / jf.TICKS <= pos + 0.5) achado = caps[i];
    return achado;
  }
  function desenharMarcas() {
    oMarcas.innerHTML = '';
    var caps = e.item.Chapters || [], dur = duracaoSeg();
    if (!dur) return;
    for (var i = 1; i < caps.length; i++) {
      var m = document.createElement('div');
      m.style.left = (100 * caps[i].StartPositionTicks / jf.TICKS / dur).toFixed(2) + '%';
      oMarcas.appendChild(m);
    }
  }
  // Thumbnail of where the seek is going (only while the target is being picked).
  function desenharTrick(pos) {
    if (pos == null || !e || !e.trick) { oTrick.className = ''; return; }
    var t = e.trick, n = Math.min(t.info.ThumbnailCount - 1, Math.floor(pos * 1000 / t.info.Interval));
    var folha = Math.floor(n / t.porFolha), k = n % t.porFolha;
    var col = k % t.info.TileWidth, lin = Math.floor(k / t.info.TileWidth), dur = duracaoSeg();
    oTrick.style.width = t.info.Width + 'px';
    oTrick.style.height = t.info.Height + 'px';
    oTrick.style.backgroundImage = 'url("' + t.url(folha) + '")';
    oTrick.style.backgroundPosition = (-col * t.info.Width) + 'px ' + (-lin * t.info.Height) + 'px';
    oTrick.style.left = Math.max(0, Math.min(1168 - t.info.Width, 1168 * (dur ? pos / dur : 0) - t.info.Width / 2)) + 'px';
    oTrick.className = 'visivel';
  }
  function mostrarOsd(fixo) {
    osd.className = 'visivel';
    desenharOsd();
    clearTimeout(timerOsd);
    if (!fixo && !v.paused && !e.audioSo) timerOsd = setTimeout(function () { osd.className = ''; }, 4000);
  }

  function desenharInfo() {
    var ms = e.ms, s = ms.MediaStreams || [];
    var vid = s.filter(function (x) { return x.Type === 'Video'; })[0] || {};
    var aud = s.filter(function (x) { return x.Index === e.audio; })[0] || s.filter(function (x) { return x.Type === 'Audio'; })[0] || {};
    var leg = s.filter(function (x) { return x.Index === e.legenda; })[0];
    var motivos = /TranscodeReasons=([^&]+)/.exec(e.url);
    painel.textContent = [
      'Método:   ' + e.metodo + (e.ignorouConversao ? ' · o servidor não converte vídeo' +
          (e.bitrate ? ' (limite ' + (e.bitrate / 1e6) + ' Mb/s ignorado)' : '') :
        (e.tentouTranscodificar ? ' (direct play falhou antes)' : '') +
        (e.semDireto && !e.tentouTranscodificar ? ' (modo compatível)' : '') +
        (e.bitrate ? ' · limite ' + (e.bitrate / 1e6) + ' Mb/s' : '')),
      'Travadas: ' + e.travadas + (e.msParado ? ' · ' + (e.msParado / 1000).toFixed(1) + ' s parado' : ''),
      motivos ? 'Motivo:   ' + decodeURIComponent(motivos[1]).split(',').join(', ') : '',
      'Arquivo:  ' + (ms.Container || '?') + ' · ' + (ms.Bitrate ? (ms.Bitrate / 1e6).toFixed(1) + ' Mb/s' : ''),
      'Vídeo:    ' + (vid.Codec || '?') + ' ' + (vid.Width || '?') + 'x' + (vid.Height || '?') + (vid.BitDepth ? ' ' + vid.BitDepth + ' bits' : '') +
        (vid.VideoRangeType && vid.VideoRangeType !== 'SDR' ? ' ' + vid.VideoRangeType : ''),
      'Áudio:    ' + (aud.DisplayTitle || aud.Codec || '?'),
      'Legenda:  ' + (leg ? (leg.DisplayTitle || leg.Codec) + (e.trilhas[leg.Index] ? ' (texto, <track>)' : ' (queimada no vídeo)') : 'desligada'),
      'Servidor: ' + jf.servidor
    ].filter(Boolean).map(quebrarLinha).join('\n');
  }
  // Hard-wraps one info line at INFO_COLS (long URLs/titles have no spaces, so CSS alone can't be trusted on
  // the TV's old engine); continuation lines are indented under the value column.
  var INFO_COLS = 64, INFO_RECUO = '          ';
  function quebrarLinha(l) {
    if (l.length <= INFO_COLS) return l;
    var out = [l.slice(0, INFO_COLS)], resto = l.slice(INFO_COLS), n = INFO_COLS - INFO_RECUO.length;
    while (resto.length) { out.push(INFO_RECUO + resto.slice(0, n)); resto = resto.slice(n); }
    return out.join('\n');
  }

  // --- legendas --------------------------------------------------------------------------------------
  function montarLegendas() {
    var antigas = v.querySelectorAll('track');
    for (var i = 0; i < antigas.length; i++) v.removeChild(antigas[i]);
    e.trilhas = {};
    (e.ms.MediaStreams || []).forEach(function (s) {
      if (s.Type !== 'Subtitle' || s.DeliveryMethod !== 'External' || !s.DeliveryUrl) return;
      var t = document.createElement('track');
      t.kind = 'subtitles';
      t.label = s.DisplayTitle || s.Language || ('#' + s.Index);
      if (s.Language) t.srclang = s.Language.slice(0, 2);
      t.src = jf.comToken(/^https?:/.test(s.DeliveryUrl) ? s.DeliveryUrl : jf.servidor + s.DeliveryUrl);
      v.appendChild(t);
      e.trilhas[s.Index] = t;
    });
    aplicarLegenda();
  }
  // The selected track runs in 'hidden' mode (cues load, the browser draws nothing) and we draw its active cues
  // in #legenda-tela with our font: the TV's native cue renderer misplaces the circumflex (ê â ô).
  function aplicarLegenda() {
    for (var idx in e.trilhas) if (e.trilhas.hasOwnProperty(idx)) {
      var t = e.trilhas[idx], ligada = +idx === e.legenda;
      if (!t.track) continue;
      t.track.mode = ligada ? 'hidden' : 'disabled';
      t.track.oncuechange = ligada ? desenharLegenda : null;
      t.onload = ligada ? desenharLegenda : null;
    }
    desenharLegenda();
  }
  var legendaChave = '';
  function desenharLegenda() {
    var t = e && e.trilhas[e.legenda], cues = t && t.track && t.track.mode !== 'disabled' && t.track.activeCues;
    var partes = [];
    for (var i = 0; cues && i < cues.length; i++) partes.push(textoDaCue(cues[i]));
    var chave = partes.join('\n');
    if (chave === legendaChave) return;
    legendaChave = chave;
    oLegenda.innerHTML = '';
    partes.forEach(function (txt, k) {
      if (k) oLegenda.appendChild(document.createElement('br'));
      var s = document.createElement('span');
      s.textContent = txt;
      oLegenda.appendChild(s);
    });
  }
  // Plain text of a WebVTT cue: tags (<i>, <c.x>, <00:01.000>) dropped, entities decoded, NFC so a
  // decomposed "e + ◌̂" becomes one glyph "ê" (combining marks are the other way to get a floating accent).
  var ENTIDADES = { amp: '&', lt: '<', gt: '>', nbsp: ' ', lrm: '‎', rlm: '‏' };
  function textoDaCue(c) {
    var s = String(c.text || '').replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, function (_, n) { return ENTIDADES[n]; });
    return s.normalize ? s.normalize('NFC') : s;
  }
  function limparLegenda() { legendaChave = ''; oLegenda.innerHTML = ''; }
  function legendaQueimada(idx) { return idx != null && idx >= 0 && !e.trilhas[idx]; }

  function trocarLegenda() {
    var opcoes = [-1].concat((e.ms.MediaStreams || []).filter(function (s) { return s.Type === 'Subtitle'; })
                                                     .map(function (s) { return s.Index; }));
    if (opcoes.length === 1) return tv.aviso('Sem legendas neste vídeo');
    var atual = opcoes.indexOf(e.legenda == null ? -1 : e.legenda);
    escolherLegenda(opcoes[(atual + 1) % opcoes.length]);
  }
  function escolherLegenda(prox) {
    var s = (e.ms.MediaStreams || []).filter(function (x) { return x.Index === prox; })[0];
    tv.aviso('Legenda: ' + (s ? s.DisplayTitle || s.Codec : 'desligada'));
    if (legendaQueimada(prox) || legendaQueimada(e.legenda)) {
      return reiniciar({ legenda: prox, audio: e.audio, semDireto: e.semDireto });   // needs another video
    }
    e.legenda = prox;
    aplicarLegenda();
    relatar('/Progress', { EventName: 'SubtitleTrackChange' });
  }

  function trocarAudio() {
    var lista = (e.ms.MediaStreams || []).filter(function (s) { return s.Type === 'Audio'; });
    if (lista.length < 2) return tv.aviso('Só há uma faixa de áudio');
    var i = 0;
    for (var k = 0; k < lista.length; k++) if (lista[k].Index === e.audio) i = k;
    escolherAudio(lista[(i + 1) % lista.length]);
  }
  function escolherAudio(prox) {
    tv.aviso('Áudio: ' + (prox.DisplayTitle || prox.Codec));
    reiniciar({ audio: prox.Index, legenda: e.legenda, semDireto: prox.Index !== e.ms.DefaultAudioStreamIndex });
  }

  // --- playback --------------------------------------------------------------------------------------
  // tocar(item, inicioTicks, aoFim, opcoes) — opcoes: {audio, legenda, semDireto, bitrate, fila, iFila}
  function tocar(item, inicioTicks, aoFim, opcoes) {
    opcoes = opcoes || {};
    var audioSo = item.MediaType === 'Audio' || item.Type === 'Audio';
    if (opcoes.bitrate === undefined && !audioSo) {   // default quality from Settings
      opcoes.bitrate = +ajuste('qualidade', '0') || 0;
      if (opcoes.bitrate) opcoes.semDireto = true;
    }
    fecharMenu();
    oPular.className = ''; oTrick.className = ''; oMarcas.innerHTML = '';
    div.className = 'visivel' + (audioSo ? ' audio' : '');
    if (audioSo) {
      var capa = jf.imagem(item, 'Primary', 500);
      capaAudio.innerHTML = '';
      if (capa) { var im = document.createElement('img'); im.src = capa; capaAudio.appendChild(im); }
      var tx = document.createElement('div');
      tx.textContent = (item.Artists && item.Artists.join(', ') || item.AlbumArtist || '') + (item.Album ? ' — ' + item.Album : '');
      capaAudio.appendChild(tx);
    }
    telas.style.display = 'none';
    oTitulo.textContent = item.SeriesName ? item.SeriesName + ' · ' + item.Name : item.Name;
    oEstado.textContent = 'preparando…';
    osd.className = 'visivel';
    painel.className = '';
    // The full item (chapters, trickplay) comes along; queue/next-episode items arrive trimmed.
    var completo = item.Chapters && item.MediaSources ? Promise.resolve(item)
      : jf.api('GET', '/Items/' + item.Id, { userId: jf.sessao.userId }).then(null, function () { return item; });
    Promise.all([jf.playbackInfo(item.Id, { audio: opcoes.audio, legenda: opcoes.legenda, semDireto: opcoes.semDireto,
                                            bitrate: opcoes.bitrate }), completo]).then(function (rs) {
      var r = rs[0];
      item = rs[1] || item;
      if (r.ErrorCode) throw new Error('servidor recusou: ' + r.ErrorCode);
      var ms = r.MediaSources && r.MediaSources[0];
      if (!ms) throw new Error('nenhuma fonte de mídia');
      var rep = jf.urlDeReproducao(item, ms, r.PlaySessionId, opcoes.bitrate);
      if (!rep) throw new Error('o servidor não ofereceu nenhum jeito de tocar isto');
      e = { item: item, ms: ms, playSessionId: r.PlaySessionId, metodo: rep.metodo, url: rep.url, aoFim: aoFim,
            inicioSeg: (inicioTicks || 0) / jf.TICKS, carregando: true, semDireto: !!opcoes.semDireto,
            tentouTranscodificar: !!opcoes.tentouTranscodificar,
            audio: opcoes.audio != null ? opcoes.audio : ms.DefaultAudioStreamIndex,
            legenda: opcoes.legenda != null ? opcoes.legenda : (ms.DefaultSubtitleStreamIndex != null ? ms.DefaultSubtitleStreamIndex : -1),
            trilhas: {}, iniciado: false, travadas: 0, msParado: 0, paradoDesde: 0,
            bitrate: opcoes.bitrate || 0, fila: opcoes.fila || null, iFila: opcoes.iFila || 0, audioSo: audioSo,
            trick: audioSo ? null : jf.trickplay(item, ms), segs: [] };
      // Asked for a conversion and the server handed out the original file anyway: it can't transcode.
      e.ignorouConversao = !audioSo && !!(opcoes.semDireto || opcoes.bitrate) && rep.metodo !== 'Transcode';
      if (e.ignorouConversao) {
        if (servidorConverte()) tv.aviso('Este servidor não converte vídeo: tocando o arquivo original', 6000);
        semConversao[jf.servidor] = true;
      }
      var meu = e;
      if (!audioSo) jf.segmentos(item).then(function (sg) { if (e === meu) e.segs = sg; });
      desenharMarcas();
      var motivos = /TranscodeReasons=([^&]+)/.exec(rep.url);
      tv.enviar({ tipo: 'log', msg: 'tocar "' + item.Name + '" · ' + rep.metodo + ' · ' + ms.Container +
                  (motivos ? ' · motivos: ' + decodeURIComponent(motivos[1]) : '') + ' · início ' + U().relogio(e.inicioSeg) });
      montarLegendas();
      v.src = rep.url;
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
      desenharInfo();
      mostrarOsd(true);
    }).then(null, function (x) {
      U().erro('reprodução', x);
      fechar();
    });
  }

  function reiniciar(opcoes) {
    if (!e) return;
    var item = e.item, aoFim = e.aoFim, pos = v.currentTime || e.inicioSeg;
    if (opcoes.bitrate === undefined) opcoes.bitrate = e.bitrate;
    opcoes.fila = e.fila; opcoes.iFila = e.iFila;
    encerrar(false).then(function () { tocar(item, ticks(pos), aoFim, opcoes); });
  }

  // Tells the server and releases the video. Doesn't hide the player (reiniciar uses this).
  function encerrar(fim) {
    if (!e) return Promise.resolve();
    clearInterval(timerProgresso); timerProgresso = null;
    clearTimeout(timerSeek); alvoSeek = null;
    var velho = e, pos = v.currentTime;
    if (velho.paradoDesde) velho.msParado += Date.now() - velho.paradoDesde;
    tv.enviar({ tipo: 'log', msg: 'fim "' + velho.item.Name + '" · ' + velho.metodo + (velho.ignorouConversao ? ' (servidor não converte)' : velho.semDireto ? ' (sem direct play)' : '') +
                ' · em ' + U().relogio(pos) + ' · ' + velho.travadas + ' travadas · ' + (velho.msParado / 1000).toFixed(1) + ' s parado' });
    var p = relatar('/Stopped', { PositionTicks: ticks(fim ? duracaoSeg() : pos) });
    if (velho.metodo === 'Transcode') {
      p = p.then(function () {
        return jf.api('DELETE', '/Videos/ActiveEncodings', { deviceId: jf.deviceId, playSessionId: velho.playSessionId })
          .then(null, function () {});
      });
    }
    e = null;
    limparLegenda();
    v.pause();
    v.removeAttribute('src');
    try { v.load(); } catch (x) {}
    return p;
  }

  function fechar() {
    fecharMenu();
    oPular.className = ''; oTrick.className = '';
    div.className = '';
    osd.className = '';
    painel.className = '';
    telas.style.display = '';
    if (tv.atual) tv.focar(tv.atual);
  }

  function parar(fim) {
    if (menuAberto()) { fecharMenu(); return rearmarOsd(); }   // Back with the menu open only closes the menu
    if (cancelarProximo()) return;
    if (!e) return fechar();
    var aoFim = e.aoFim;
    encerrar(fim).then(function () { if (aoFim) aoFim(); });
    fechar();
  }

  // --- <video> events -------------------------------------------------------------------------------
  v.addEventListener('loadedmetadata', function () {
    if (e && e.inicioSeg > 1) v.currentTime = e.inicioSeg;
  });
  v.addEventListener('playing', function () {
    if (!e) return;
    e.carregando = false;
    if (e.paradoDesde) { e.msParado += Date.now() - e.paradoDesde; e.paradoDesde = 0; }
    if (!e.iniciado) {             // only once per playback (it used to repeat on every stall: 20:08)
      e.iniciado = true;
      relatar('');
      clearInterval(timerProgresso);
      timerProgresso = setInterval(function () { relatar('/Progress', { EventName: 'TimeUpdate' }); }, 10000);
    }
    mostrarOsd();
  });
  v.addEventListener('waiting', function () {
    if (!e) return;
    e.carregando = true;
    // stall = data ran out mid-playback (initial loading and seeks don't count)
    if (e.iniciado && !v.seeking && alvoSeek == null) { e.travadas++; e.paradoDesde = Date.now(); }
    desenharOsd();
  });
  v.addEventListener('pause', function () { if (e && !e.carregando) { mostrarOsd(true); relatar('/Progress', { EventName: 'Pause' }); } });
  v.addEventListener('timeupdate', function () {
    if (!e) return;
    if (osd.className) desenharOsd();
    desenharLegenda();   // backup for engines that don't fire cuechange on hidden tracks
    var t = v.currentTime, seg = null;
    for (var i = 0; i < e.segs.length; i++) if (t >= e.segs[i].ini && t < e.segs[i].fim - 1) seg = e.segs[i];
    if (seg !== e.segAtual) {
      e.segAtual = seg;
      oPular.textContent = seg ? (seg.tipo === 'Intro' ? 'Pular abertura' : 'Pular créditos') + '  (OK)' : '';
      oPular.className = seg ? 'visivel' : '';
      if (seg && seg.tipo === 'Intro' && ajuste('autopular', '0') === '1') pularSegmento();
    }
  });
  function pularSegmento() {
    var seg = e.segAtual;
    if (!seg) return false;
    tv.log('pulou ' + seg.tipo + ' → ' + U().relogio(seg.fim));
    oPular.className = ''; e.segAtual = null;
    v.currentTime = Math.min(seg.fim, duracaoSeg() - 0.5);
    return true;
  }
  v.addEventListener('ended', function () {
    if (!e) return;
    var item = e.item, aoFim = e.aoFim;
    if (e.fila && e.iFila + 1 < e.fila.length) return irNaFila(e.iFila + 1, true);
    if (e.fila || item.Type !== 'Episode' || !item.SeriesId) return parar(true);
    encerrar(true);
    jf.api('GET', '/Shows/' + item.SeriesId + '/Episodes', { userId: jf.sessao.userId, startItemId: item.Id, limit: 2,
                                                             fields: 'Overview,UserData' })
      .then(function (r) {
        var prox = r && r.Items && r.Items[1];
        if (!prox || ajuste('autoprox', '1') !== '1') { fechar(); if (aoFim) aoFim(); return; }
        contarProximo(prox, aoFim);
      }, function () { fechar(); if (aoFim) aoFim(); });
  });

  // Queue (album, playlist): switches item without closing the player.
  function irNaFila(i, acabou) {
    if (!e || !e.fila || i < 0 || i >= e.fila.length) return false;
    var fila = e.fila, aoFim = e.aoFim;
    encerrar(!!acabou).then(function () { tocar(fila[i], 0, aoFim, { fila: fila, iFila: i }); });
    return true;
  }

  // --- player menu (↓) --------------------------------------------------------------------------
  function menuAberto() { return menu.className.indexOf('visivel') >= 0; }
  function fecharMenu() { menu.className = 'rolavel'; menu.innerHTML = ''; }
  // The menu pins the OSD (mostrarOsd(true)); once it closes the bar must hide again after the usual delay.
  function rearmarOsd() { if (e && osd.className) mostrarOsd(); }
  function abrirMenu() {
    if (!e) return;
    menu.innerHTML = '';
    var primeiro = null, marcado = null;
    function secao(titulo) { var h = document.createElement('h3'); h.textContent = titulo; menu.appendChild(h); }
    function opcao(texto, ligado, fn) {
      var o = document.createElement('div');
      o.className = 'opcao focavel' + (ligado ? ' ligada' : '');
      o.textContent = (ligado ? '● ' : '○ ') + texto;
      o.addEventListener('click', function () { fecharMenu(); fn(); rearmarOsd(); });
      menu.appendChild(o);
      if (!primeiro) primeiro = o;
      if (ligado && !marcado) marcado = o;
    }
    var s = e.ms.MediaStreams || [];
    if (!e.audioSo) {
      secao('Qualidade');
      if (!servidorConverte()) {
        var nota = document.createElement('p');
        nota.className = 'nota';
        nota.textContent = 'Original: este servidor não converte vídeo.';
        menu.appendChild(nota);
      } else QUALIDADES.forEach(function (q) {
        opcao(q[1], e.bitrate === q[0], function () {
          tv.aviso('Qualidade: ' + q[1]);
          reiniciar({ audio: e.audio, legenda: e.legenda, semDireto: q[0] ? true : false, bitrate: q[0] });
        });
      });
      var auds = s.filter(function (x) { return x.Type === 'Audio'; });
      if (auds.length > 1) {
        secao('Áudio');
        auds.forEach(function (a) { opcao(a.DisplayTitle || a.Codec, a.Index === e.audio, function () { escolherAudio(a); }); });
      }
      var legs = s.filter(function (x) { return x.Type === 'Subtitle'; });
      if (legs.length) {
        secao('Legenda');
        opcao('Desligada', e.legenda == null || e.legenda < 0, function () { escolherLegenda(-1); });
        legs.forEach(function (l) { opcao(l.DisplayTitle || l.Codec, l.Index === e.legenda, function () { escolherLegenda(l.Index); }); });
      }
      var caps = e.item.Chapters || [];
      if (caps.length > 1) {
        secao('Capítulos');
        var agora = capituloEm(v.currentTime);
        caps.forEach(function (c) {
          opcao(U().relogio(c.StartPositionTicks / jf.TICKS) + '  ' + c.Name, c === agora, function () {
            v.currentTime = c.StartPositionTicks / jf.TICKS; mostrarOsd();
          });
        });
      }
    }
    if (e.fila && e.fila.length > 1) {
      secao('Fila');
      e.fila.forEach(function (it, i) {
        opcao((i + 1) + '. ' + it.Name, i === e.iFila, function () { if (i !== e.iFila) irNaFila(i); });
      });
    }
    menu.className = 'rolavel visivel';
    menu.scrollTop = 0;
    tv.focar(e.audioSo && marcado ? marcado : primeiro);
    mostrarOsd(true);
  }

  function contarProximo(prox, aoFim) {
    proximo = { item: prox, restante: 10, aoFim: aoFim };
    function tique() {
      if (!proximo) return;
      aviso.textContent = 'Próximo: ' + (prox.IndexNumber != null ? 'E' + prox.IndexNumber + ' · ' : '') + prox.Name +
                          ' em ' + proximo.restante + ' s   (OK começa já · Voltar cancela)';
      aviso.className = 'visivel';
      if (proximo.restante-- <= 0) return seguirProximo();
      proximo.timer = setTimeout(tique, 1000);
    }
    tique();
  }
  function seguirProximo() {
    if (!proximo) return;
    var p = proximo; cancelarProximo(true);
    tocar(p.item, 0, p.aoFim);
  }
  function cancelarProximo(seguindo) {
    if (!proximo) return false;
    clearTimeout(proximo.timer);
    var aoFim = proximo.aoFim;
    proximo = null;
    aviso.className = '';
    if (!seguindo) { fechar(); if (aoFim) aoFim(); }
    return true;
  }
  v.addEventListener('error', function () {
    if (!e || !v.getAttribute('src')) return;
    var err = v.error, msg = 'erro do player ' + (err ? err.code : '?');
    tv.enviar({ tipo: 'erro', msg: msg + ' em ' + e.metodo + ' (' + e.item.Name + ', ' + e.ms.Container + ')' });
    // Native HLS was only tested with a simple playlist (index.m3u8). If Jellyfin's master.m3u8 (with variants)
    // doesn't open, try the media playlist directly (main.m3u8, same parameters).
    if (e.metodo === 'Transcode' && /\/master\.m3u8/.test(e.url) && !e.tentouMain) {
      e.tentouMain = true;
      e.url = e.url.replace('/master.m3u8', '/main.m3u8');
      tv.log('master.m3u8 falhou; tentando main.m3u8');
      v.src = e.url;
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
      return;
    }
    if (e.metodo !== 'Transcode' && !e.tentouTranscodificar && servidorConverte()) {
      tv.aviso('O player não abriu o arquivo direto; tentando transcodificar…', 5000);
      var item = e.item, aoFim = e.aoFim, pos = e.inicioSeg, aud = e.audio, leg = e.legenda;
      encerrar(false).then(function () {
        tocar(item, ticks(pos), aoFim, { audio: aud, legenda: leg, semDireto: true, tentouTranscodificar: true });
      });
      return;
    }
    U().erro('reprodução', new Error(msg));
    parar(false);
  });

  // --- teclas -----------------------------------------------------------------------------------------
  function pausar() {
    if (v.paused) { v.play(); relatar('/Progress', { EventName: 'Unpause' }); } else v.pause();
    mostrarOsd(v.paused);
    return true;
  }
  function pular(delta) {
    if (alvoSeek == null) alvoSeek = v.currentTime;
    alvoSeek = Math.max(0, Math.min(duracaoSeg() - 2, alvoSeek + delta));
    mostrarOsd(true);
    clearTimeout(timerSeek);
    timerSeek = setTimeout(function () {         // accumulates consecutive presses into one seek
      var alvo = alvoSeek;
      alvoSeek = null;
      if (alvo != null && e) v.currentTime = alvo;
      mostrarOsd();
    }, 700);
    return true;
  }
  // With the menu open, arrows and OK belong to tv.js (normal navigation between options).
  function soNoPlayer(fn) { return function (nome) { return e && !menuAberto() ? fn(nome) : false; }; }
  tv.ao('ok', function () {
    if (proximo) { seguirProximo(); return true; }
    if (!e || menuAberto()) return false;
    return pularSegmento() || pausar();
  });
  function numero(n) {                           // 1–9 = 10–90 %, 0 = start (registered in app.js)
    var dur = duracaoSeg();
    if (!e || !dur) return true;
    alvoSeek = null;
    return pular(+n * dur / 10 - v.currentTime);
  }
  function play() { if (e && !menuAberto() && v.paused) pausar(); return true; }   // tecla Play (registrada no app.js)
  tv.ao('pause', soNoPlayer(function () { if (!v.paused) pausar(); return true; }));
  tv.ao('playpause', soNoPlayer(pausar));
  // Outside the player (or with the menu open) ←/→ belong to the app: a focused Settings option may handle them.
  function setaLateral(dir, delta) {
    return function () {
      if (e && !menuAberto()) return pular(delta);
      return !e && window.jfApp ? window.jfApp.seta(dir) : false;
    };
  }
  tv.ao('esquerda', setaLateral('esquerda', -10));
  tv.ao('direita', setaLateral('direita', 30));
  tv.ao('retroceder', soNoPlayer(function () { return (e.fila && irNaFila(e.iFila - 1)) || pular(-30); }));
  tv.ao('avancar', soNoPlayer(function () { return (e.fila && irNaFila(e.iFila + 1)) || pular(60); }));
  tv.ao('cima', soNoPlayer(function () { mostrarOsd(); return true; }));
  tv.ao('baixo', soNoPlayer(function () { abrirMenu(); return true; }));
  // amarelo: app.js (no player chama jfPlayer.trocarLegenda; fora dele, teste de rede)
  function alternarInfo() {                      // verde (registrado no app.js)
    if (!e) return;
    desenharInfo();
    painel.className = painel.className ? '' : 'visivel';
  }
  tv.ao('stop', soNoPlayer(function () { parar(false); return true; }));

  // Red: restarts from the same point without direct play (the server remuxes to HLS TS, copying the video
  // when it can). Useful to compare when a direct file stutters. Press again to go back to direct.
  function modoCompativel() {
    if (!e) return;
    if (!servidorConverte()) return tv.aviso('Este servidor não converte vídeo: só toca o arquivo original');
    var novo = !e.semDireto;
    tv.aviso(novo ? 'Modo compatível: remux em HLS pelo servidor' : 'Voltando ao direct play');
    reiniciar({ audio: e.audio, legenda: e.legenda, semDireto: novo });
  }

  window.jfPlayer = { tocar: tocar, parar: parar, ativo: ativo, trocarAudio: trocarAudio, trocarLegenda: function () { if (e) trocarLegenda(); }, modoCompativel: modoCompativel,
                     alternarInfo: alternarInfo, numero: numero, abrirMenu: abrirMenu, menuAberto: menuAberto, play: play };
})();
