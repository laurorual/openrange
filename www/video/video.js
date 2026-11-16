/* OpenRange video test: plays each file in www/midia/ (tools/gerar-videos.sh), measures and reports to the PC.
 *
 * Per test: load and play 0–6 s, seek to 14 s (tests Range/seek) and play to 18 s.
 * Measures: time to first frame, seek time and, only in Chromium's pipeline (MSE/hls.js), decoded/dropped
 * frames and sound. This TV's <video src> uses the NATIVE hardware player, which exposes no
 * metrics (notes/archive/achados-2026-11.md 18:27): there the viewer's rating counts, keys 1–5.
 */
(function () {
  'use strict';
  tv.iniciar({ app: 'video' });

  var TESTES = [
    // round 3 (green runs these): HEVC 1080p60 served by the portal, no Jellyfin in the path
    { id: 'hevc-1080p60-20M', nome: 'HEVC 1080p60 · 20 Mb/s (sintético)', url: '/midia/hevc-1080p60-20M.mp4', modo: 'direto', novo: true },
    { id: 'jogo-portal',      nome: 'Gravação de jogo (Combat Master) via portal', url: '/midia/rodada3/jogo-combat-master.mp4',
      modo: 'direto', novo: true, ate: 38 },
    // round 2: native player formats
    { id: 'mkv-h264-1080p',   nome: 'MKV · H.264 1080p · AAC',          url: '/midia/h264-1080p30-aac.mkv', modo: 'direto', r2: true },
    { id: 'ts-h264-1080p',    nome: 'TS direto · H.264 1080p · AAC',    url: '/midia/h264-1080p30-aac.ts', modo: 'direto', r2: true },
    { id: 'mkv-hevc-ac3',     nome: 'MKV · HEVC 1080p · AC-3',          url: '/midia/hevc-1080p30-ac3.mkv', modo: 'direto', r2: true },
    { id: 'mp4-hevc10',       nome: 'MP4 · HEVC 10 bits 1080p',         url: '/midia/hevc-main10-1080p30-aac.mp4', modo: 'direto', r2: true },
    { id: 'mp4-hevc-4k',      nome: 'MP4 · HEVC 4K',                    url: '/midia/hevc-2160p30-aac.mp4', modo: 'direto', r2: true },
    { id: 'mp4-h264-4k',      nome: 'MP4 · H.264 4K',                   url: '/midia/h264-2160p30-aac.mp4', modo: 'direto', r2: true },
    { id: 'mp4-eac3',         nome: 'MP4 · H.264 720p · E-AC-3',        url: '/midia/h264-720p30-eac3.mp4', modo: 'direto', r2: true },
    { id: 'mkv-dts',          nome: 'MKV · H.264 720p · DTS',           url: '/midia/h264-720p30-dts.mkv', modo: 'direto', r2: true },
    { id: 'mkv-flac',         nome: 'MKV · H.264 720p · FLAC',          url: '/midia/h264-720p30-flac.mkv', modo: 'direto', r2: true },
    { id: 'mp4-mp3',          nome: 'MP4 · H.264 720p · MP3',           url: '/midia/h264-720p30-mp3.mp4', modo: 'direto', r2: true },
    { id: 'mp4-aac51',        nome: 'MP4 · H.264 720p · AAC 5.1',       url: '/midia/h264-720p30-aac51.mp4', modo: 'direto', r2: true },
    { id: 'hls-nat-ts-1080p', nome: 'HLS nativo · TS 1080p',            url: '/midia/hls-ts-1080p30/index.m3u8', modo: 'nativo', r2: true },
    { id: 'hls-nat-fmp4',     nome: 'HLS nativo · fMP4 H.264 1080p',    url: '/midia/hls-fmp4-1080p30/index.m3u8', modo: 'nativo', r2: true },
    { id: 'hls-nat-fmp4-hevc', nome: 'HLS nativo · fMP4 HEVC 1080p',    url: '/midia/hls-fmp4-hevc-1080p30/index.m3u8', modo: 'nativo', r2: true },
    { id: 'legenda-vtt',      nome: 'Legenda WebVTT (<track>) · MP4 720p', url: '/midia/h264-main-720p30-aac.mp4', modo: 'direto',
      legenda: '/midia/legenda.vtt', r2: true },
    // round 1 (18:27): already tested
    { id: 'mp4-720p30',      nome: 'MP4 · H.264 main 720p30 · AAC',   url: '/midia/h264-main-720p30-aac.mp4',  modo: 'direto' },
    { id: 'mp4-1080p30',     nome: 'MP4 · H.264 high 1080p30 · AAC',  url: '/midia/h264-high-1080p30-aac.mp4', modo: 'direto' },
    { id: 'mp4-1080p60',     nome: 'MP4 · H.264 high 1080p60 · AAC',  url: '/midia/h264-high-1080p60-aac.mp4', modo: 'direto' },
    { id: 'mp4-ac3',         nome: 'MP4 · H.264 720p · AC-3',         url: '/midia/h264-720p30-ac3.mp4',       modo: 'direto' },
    { id: 'mp4-hevc',        nome: 'MP4 · HEVC 1080p30',              url: '/midia/hevc-main-1080p30-aac.mp4', modo: 'direto' },
    { id: 'webm-vp9-opus',   nome: 'WebM · VP9 720p · Opus',          url: '/midia/vp9-720p30-opus.webm',      modo: 'direto' },
    { id: 'webm-vp9-vorbis', nome: 'WebM · VP9 720p · Vorbis',        url: '/midia/vp9-720p30-vorbis.webm',    modo: 'direto' },
    { id: 'hls-nativo-720p', nome: 'HLS nativo · TS 720p30',          url: '/midia/hls-ts-720p30/index.m3u8',  modo: 'nativo' },
    { id: 'hlsjs-ts-720p',   nome: 'hls.js · TS 720p30 (MSE)',        url: '/midia/hls-ts-720p30/index.m3u8',  modo: 'hlsjs', fps: 30 },
    { id: 'hlsjs-ts-1080p',  nome: 'hls.js · TS 1080p30 (MSE)',       url: '/midia/hls-ts-1080p30/index.m3u8', modo: 'hlsjs', fps: 30 },
    { id: 'hlsjs-fmp4-1080p', nome: 'hls.js · fMP4 1080p30 (MSE)',    url: '/midia/hls-fmp4-1080p30/index.m3u8', modo: 'hlsjs', fps: 30 }
  ];
  var MIME = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', ts: 'video/mp2t',
               m3u8: 'application/vnd.apple.mpegurl' };
  var NOTAS = { 1: 'tudo ok', 2: 'imagem com problema', 3: 'som com problema ou sem som', 4: 'imagem e som com problema',
                5: 'não tocou' };
  var SIMBOLO_NOTA = { 1: '✓', 2: '✗ img', 3: '✗ som', 4: '✗ ambos', 5: '✗ nada' };
  var SEEK_DE = 6, SEEK_PARA = 14, FIM = 18, LIMITE_CARGA = 25000, LIMITE_TRAVADO = 8000;

  var v = document.getElementById('video');
  var stats = document.getElementById('stats');
  var lista = document.getElementById('lista');
  var hls = null, e = null, fila = [], itens = {}, aguardandoNota = null;

  // --- list -------------------------------------------------------------------------
  var separou = false;
  TESTES.forEach(function (t) {
    if (!t.novo && !separou) {
      separou = true;
      var s = document.createElement('div');
      s.className = 'separador';
      s.textContent = 'Rodadas 1 e 2 (já testados)';
      lista.appendChild(s);
    }
    var el = document.createElement('div');
    el.className = 'item focavel';
    el.innerHTML = '<span class="nome"></span><span class="res"></span>';
    el.querySelector('.nome').textContent = t.nome;
    el.addEventListener('click', function () { fila = []; aguardandoNota = null; rodar(t); });
    lista.appendChild(el);
    itens[t.id] = el.querySelector('.res');
  });
  tv.focar(tv.focaveis()[0]);

  function marcar(t, classe, texto) { itens[t.id].className = 'res ' + classe; itens[t.id].textContent = texto; }

  // --- measurement ------------------------------------------------------------------
  function contadores() {
    var q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    return {
      dec: q ? q.totalVideoFrames : (v.webkitDecodedFrameCount || 0),
      perd: q ? q.droppedVideoFrames : (v.webkitDroppedFrameCount || 0),
      audio: typeof v.webkitAudioDecodedByteCount === 'number' ? v.webkitAudioDecodedByteCount : null,
      agora: Date.now()
    };
  }
  function buffer() {
    var b = v.buffered, r = [];
    for (var i = 0; i < b.length; i++) r.push(b.start(i).toFixed(1) + '–' + b.end(i).toFixed(1));
    return r.join(' ') || '—';
  }
  function anota(nome) { if (e) e.eventos.push(nome + '@' + (Date.now() - e.t0)); }

  function limpar() {
    if (hls) { try { hls.destroy(); } catch (x) {} hls = null; }
    v.pause();
    var trilhas = v.querySelectorAll('track');
    for (var i = 0; i < trilhas.length; i++) v.removeChild(trilhas[i]);
    v.removeAttribute('src');
    try { v.load(); } catch (x) {}
  }

  function rodar(t) {
    limpar();
    e = { t: t, t0: Date.now(), fase: 'carregando', eventos: [], ultimoT: -1, ultimoMov: Date.now(), tempoSeek: null };
    marcar(t, 'rodando', '…');
    tv.focar(itens[t.id].parentNode);
    var ext = t.url.split('?')[0].split('.').pop();
    e.canPlay = t.modo === 'hlsjs' ? null : v.canPlayType(MIME[ext] || '');
    if (t.modo === 'hlsjs') {
      if (!window.Hls || !Hls.isSupported()) return terminar('falhou', 'hls.js não suportado');
      hls = new Hls({ enableWorker: true, maxBufferLength: 20 });
      hls.on(Hls.Events.ERROR, function (_, d) {
        anota('hls-erro:' + d.details + (d.fatal ? ':FATAL' : ''));
        if (d.fatal) terminar('falhou', 'hls.js: ' + d.type + ' / ' + d.details);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, function () { anota('manifesto'); });
      hls.loadSource(t.url);
      hls.attachMedia(v);
    } else {
      if (t.legenda) {
        var tr = document.createElement('track');
        tr.kind = 'subtitles'; tr.srclang = 'pt'; tr.label = 'Português'; tr.src = t.legenda; tr['default'] = true;
        tr.addEventListener('load', function () { anota('legenda-carregada'); });
        tr.addEventListener('error', function () { anota('legenda-erro'); });
        v.appendChild(tr);
        if (v.textTracks && v.textTracks[0]) v.textTracks[0].mode = 'showing';
      }
      v.src = t.url;
    }
    var p = v.play();
    if (p && p.catch) p.catch(function (x) { anota('play-recusado:' + (x && x.name)); });
  }

  function terminar(resultado, motivo) {
    if (!e || e.fase === 'fim') return;
    var t = e.t, c = contadores();
    e.fase = 'fim';
    var r = { tipo: 'video', teste: t.id, modo: t.modo, url: t.url, resultado: resultado, motivo: motivo || '',
              canPlayType: e.canPlay, largura: v.videoWidth, altura: v.videoHeight, chegou_em_s: +e.ultimoT.toFixed(1),
              ms_ate_1o_quadro: e.tPlay, ms_seek: e.tempoSeek, eventos: e.eventos.slice(0, 40) };
    // stalls: "waiting" after the first "playing" that didn't come from a seek
    var tocando = false, travadas = 0;
    for (var i = 0; i < e.eventos.length; i++) {
      var nome = e.eventos[i].split('@')[0], ant = i ? e.eventos[i - 1].split('@')[0] : '';
      if (nome === 'playing') tocando = true;
      else if (nome === 'waiting' && tocando && ant !== 'seeking') travadas++;
    }
    r.travadas = travadas;
    var nativo = false;
    if (e.c0) {
      var seg = (c.agora - e.c0.agora - (e.tempoSeek || 0)) / 1000;
      var dec = c.dec - e.c0.dec, perd = c.perd - e.c0.perd;
      nativo = dec === 0 && e.ultimoT > 1;          // time moved but Chromium decoded nothing
      if (nativo) {
        r.player = 'nativo';
      } else {
        r.player = 'chromium';
        r.fps_real = seg > 0 ? +(dec / seg).toFixed(1) : null;
        r.perdidos_pct = dec > 0 ? +(100 * perd / dec).toFixed(1) : null;
        r.audio_bytes = c.audio === null || e.c0.audio === null ? null : c.audio - e.c0.audio;
        if (resultado === 'ok' && t.fps && (r.perdidos_pct > 5 || (r.fps_real !== null && r.fps_real < t.fps * 0.85)))
          resultado = r.resultado = 'lento';
      }
    }
    if (v.textTracks && v.textTracks.length) {
      var tt = v.textTracks[0];
      r.legenda = { modo: tt.mode, cues: tt.cues ? tt.cues.length : null };
    }
    if (v.error) r.erro_video = { code: v.error.code, message: v.error.message || '' };
    r.resumo = [nativo ? 'player nativo' : (r.largura ? r.largura + 'x' + r.altura : 'sem imagem'),
                r.fps_real != null ? r.fps_real + ' fps' : '', r.perdidos_pct != null ? r.perdidos_pct + '% perdidos' : '',
                r.audio_bytes == null ? '' : (r.audio_bytes > 0 ? 'som ok' : 'SEM SOM'),
                r.ms_ate_1o_quadro != null ? '1º quadro ' + r.ms_ate_1o_quadro + ' ms' : '',
                r.ms_seek != null ? 'seek ' + r.ms_seek + ' ms' : '',
                'travadas ' + r.travadas,
                r.legenda ? 'legenda ' + r.legenda.modo + ' (' + r.legenda.cues + ' falas)' : '', r.motivo].filter(Boolean).join(' · ');
    tv.enviar(r);
    var simbolo = { ok: '✓', lento: '~', falhou: '✗' }[resultado];
    marcar(t, resultado, simbolo + (r.fps_real != null ? ' ' + r.fps_real + 'fps' : '') + ' ?');
    var texto = t.nome + '\n' + resultado.toUpperCase() + '\n' + r.resumo.split(' · ').join('\n');
    limpar();
    if (motivo === 'parado pelo usuário') { stats.textContent = texto; return; }
    aguardandoNota = t;
    stats.textContent = texto + '\n\nComo foi? 1 ok · 2 imagem ruim · 3 som ruim\n4 imagem e som ruins · 5 não tocou · 0 pula';
  }

  function avaliar(n) {
    var t = aguardandoNota;
    aguardandoNota = null;
    if (n !== '0') {
      tv.enviar({ tipo: 'video', teste: t.id, resultado: 'avaliação', resumo: n + ' = ' + NOTAS[n], nota: +n });
      marcar(t, n === '1' ? 'ok' : 'falhou', SIMBOLO_NOTA[n]);
    } else {
      marcar(t, 'lento', '— pulado');
    }
    stats.textContent = t.nome + ': ' + (NOTAS[n] || 'pulado') + (fila.length ? '\nPróximo…' : '');
    if (fila.length) setTimeout(function () { rodar(fila.shift()); }, 1200);
  }

  // --- <video> events ---------------------------------------------------------------
  // 4K (18:56): the native player plays only the audio, the seek never ends and "ended" arrives — must not wait.
  v.addEventListener('ended', function () {
    if (e && (e.fase === 'tocando1' || e.fase === 'buscando'))
      terminar('falhou', 'acabou antes da hora (' + e.fase + ', ' + v.currentTime.toFixed(1) + ' s)');
  });
  ['loadedmetadata', 'canplay', 'waiting', 'stalled', 'seeking', 'ended'].forEach(function (n) {
    v.addEventListener(n, function () { anota(n); });
  });
  v.addEventListener('playing', function () {
    anota('playing');
    if (!e || e.fase !== 'carregando') return;
    e.tPlay = Date.now() - e.t0;
    e.c0 = contadores();
    e.fase = 'tocando1';
  });
  v.addEventListener('seeked', function () {
    anota('seeked');
    if (e && e.fase === 'buscando') { e.tempoSeek = Date.now() - e.tSeek0; e.fase = 'tocando2'; }
  });
  v.addEventListener('error', function () {
    if (!e || e.fase === 'fim' || !v.getAttribute('src') && !hls) return;
    var err = v.error;
    terminar('falhou', 'erro do <video> ' + (err ? err.code : '?') + (err && err.message ? ': ' + err.message : ''));
  });

  // --- test clock ---------------------------------------------------------------------
  setInterval(function () {
    if (!e || e.fase === 'fim') return;
    var agora = Date.now(), ct = v.currentTime, c = contadores();
    if (ct !== e.ultimoT) { e.ultimoT = ct; e.ultimoMov = agora; }
    if (e.fase === 'carregando' && agora - e.t0 > LIMITE_CARGA) return terminar('falhou', 'não começou em 25 s');
    if ((e.fase === 'tocando1' || e.fase === 'tocando2') && agora - e.ultimoMov > LIMITE_TRAVADO)
      return terminar('falhou', 'travou em ' + ct.toFixed(1) + ' s');
    if (e.fase === 'buscando' && agora - e.tSeek0 > LIMITE_TRAVADO)
      return terminar('falhou', 'seek não terminou em 8 s');
    if (e.fase === 'tocando1' && ct >= SEEK_DE) {
      e.fase = 'buscando'; e.tSeek0 = agora; v.currentTime = SEEK_PARA;
    } else if (e.fase === 'tocando2' && (ct >= (e.t.ate || FIM) || v.ended)) {   // ate: testes mais longos
      return terminar('ok');
    }
    stats.textContent = e.t.nome + '\n' +
      'fase:      ' + e.fase + '\n' +
      'tempo:     ' + ct.toFixed(1) + ' s   buffer: ' + buffer() + '\n' +
      'imagem:    ' + (v.videoWidth ? v.videoWidth + 'x' + v.videoHeight : '—') + '\n' +
      'quadros:   ' + c.dec + ' decod. / ' + c.perd + ' perdidos' + (c.dec ? '' : ' (nativo?)') + '\n' +
      'canPlay:   ' + (e.canPlay === null ? '(hls.js)' : '"' + e.canPlay + '"') + '\n' +
      'decorrido: ' + ((agora - e.t0) / 1000).toFixed(1) + ' s';
  }, 250);

  // --- teclas -----------------------------------------------------------------------------
  function rodando() { return e && e.fase !== 'fim'; }
  tv.ao('numero', function (n) {
    if (!aguardandoNota || !(n in NOTAS || n === '0')) return false;
    avaliar(n);
    return true;
  });
  tv.ao('verde', function () {
    fila = TESTES.filter(function (t) { return t.novo; });
    aguardandoNota = null;
    rodar(fila.shift());
    return true;
  });
  tv.ao('amarelo', function () { document.body.classList.toggle('cheio'); return true; });
  tv.ao('vermelho', function () {
    if (rodando()) { fila = []; terminar('falhou', 'parado pelo usuário'); }
    return true;
  });
  tv.ao('voltar', function () {
    if (document.body.classList.contains('cheio')) { document.body.classList.remove('cheio'); return true; }
    if (rodando() || aguardandoNota) { fila = []; aguardandoNota = null; if (rodando()) terminar('falhou', 'parado pelo usuário'); return true; }
    return false;
  });
  tv.ao('play', function () { v.play(); return true; });
  tv.ao('pause', function () { v.pause(); return true; });
})();
