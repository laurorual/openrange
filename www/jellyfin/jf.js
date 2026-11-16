/* jf.js — Jellyfin API access (10.10) + this TV's native player profile.
 * ES5 + Promise (the QJY runtime and Sraf have Promise). No dependencies besides tv.js.
 *
 * Servers: list in localStorage (jf.servidores), each with URL, name and its own session (token,
 * user); jf.atual says which one is in use. Switch/add/remove → the app reloads the page.
 * With no server, the app tries the default (same host as the page, port 8096) or ?servidor=URL.
 * If the TV's localStorage is wiped, just add the server and log in again.
 */
(function (w) {
  'use strict';

  var VERSAO = '0.5.0';
  var TICKS = 10000000;                                // 1 s in Jellyfin ticks
  // On the LAN direct play needs no cap; transcoding, however, would use the whole cap
  // (the server asked 60 Mb/s for a 1080p at 19:40). So the cap is high and the transcode URL's
  // VideoBitrate is cut down to TETO_TRANSCODE.
  var TETO_DIRETO = 120000000, TETO_TRANSCODE = 20000000;

  function ler(k) { try { return w.localStorage.getItem('jf.' + k); } catch (e) { return null; } }
  function gravar(k, v) { try { if (v == null) w.localStorage.removeItem('jf.' + k); else w.localStorage.setItem('jf.' + k, v); } catch (e) {} }

  function parametro(nome) {
    var m = new RegExp('[?&]' + nome + '=([^&#]*)').exec(w.location.search);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function limparUrl(u) { return String(u || '').replace(/\s+/g, '').replace(/\/+$/, ''); }
  var servidorPadrao = limparUrl(parametro('servidor') || (w.location.protocol + '//' + w.location.hostname + ':8096'));
  var servidores = [];
  try { servidores = JSON.parse(ler('servidores') || '[]') || []; } catch (e) { servidores = []; }
  if (!servidores.length && ler('token')) {          // migration from the single session (up to J4)
    servidores.push({ url: servidorPadrao, nome: '', token: ler('token'), userId: ler('userId'), usuario: ler('nome') });
    gravar('token', null); gravar('userId', null); gravar('nome', null);
  }
  var iAtual = Math.max(0, Math.min(+ler('atual') || 0, servidores.length - 1));
  var pedido = parametro('servidor') && limparUrl(parametro('servidor'));
  if (pedido) for (var si = 0; si < servidores.length; si++) if (servidores[si].url === pedido) iAtual = si;
  var atual = servidores[iAtual] || null;
  var servidor = atual ? atual.url : '';
  function salvarServidores() { gravar('servidores', JSON.stringify(servidores)); gravar('atual', String(iAtual)); }
  salvarServidores();
  var deviceId = ler('deviceId');
  if (!deviceId) {
    deviceId = 'openrange-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    gravar('deviceId', deviceId);
  }
  var sessao = { token: atual && atual.token || null, userId: atual && atual.userId || null, nome: atual && atual.usuario || null };

  function cabecalho() {
    var h = 'MediaBrowser Client="openrange", Device="TV Philco", DeviceId="' + deviceId + '", Version="' + VERSAO + '"';
    if (sessao.token) h += ', Token="' + sessao.token + '"';
    return h;
  }

  function qs(obj) {
    var partes = [];
    for (var k in obj) if (obj.hasOwnProperty(k) && obj[k] !== undefined && obj[k] !== null && obj[k] !== '')
      partes.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
    return partes.length ? '?' + partes.join('&') : '';
  }

  // api('GET', '/Items', {userId: ...}) -> Promise with the JSON (or null on 204)
  function api(metodo, caminho, query, corpo) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open(metodo, servidor + caminho + qs(query || {}), true);
      x.timeout = 20000;
      x.setRequestHeader('Authorization', cabecalho());
      if (corpo !== undefined) x.setRequestHeader('Content-Type', 'application/json');
      x.onload = function () {
        if (x.status === 401) { var e401 = new Error('não autorizado (401)'); e401.status = 401; return reject(e401); }
        if (x.status < 200 || x.status >= 300) {
          var e = new Error(metodo + ' ' + caminho + ' → HTTP ' + x.status + ' ' + (x.responseText || '').slice(0, 200));
          e.status = x.status;
          return reject(e);
        }
        if (!x.responseText) return resolve(null);
        try { resolve(JSON.parse(x.responseText)); } catch (err) { reject(err); }
      };
      x.onerror = function () { reject(new Error('sem conexão com ' + servidor)); };
      x.ontimeout = function () { reject(new Error('tempo esgotado: ' + caminho)); };
      x.send(corpo === undefined ? null : JSON.stringify(corpo));
    });
  }

  // --- session / Quick Connect ------------------------------------------------------------
  function salvarSessao(r) {
    sessao.token = r.AccessToken; sessao.userId = r.User.Id; sessao.nome = r.User.Name;
    if (atual) { atual.token = sessao.token; atual.userId = sessao.userId; atual.usuario = sessao.nome; salvarServidores(); }
  }
  function sair() {
    var t = sessao.token;
    sessao.token = sessao.userId = sessao.nome = null;
    if (atual) { atual.token = atual.userId = atual.usuario = null; salvarServidores(); }
    return t;
  }
  // Login to a listed server that isn't the current one (used by phone pairing).
  function entrarEm(k, usuario, senha) {
    var sv = servidores[k];
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('POST', sv.url + '/Users/AuthenticateByName', true);
      x.timeout = 15000;
      x.setRequestHeader('Authorization', 'MediaBrowser Client="openrange", Device="TV Philco", DeviceId="' + deviceId + '", Version="' + VERSAO + '"');
      x.setRequestHeader('Content-Type', 'application/json');
      x.onload = function () {
        var r = null;
        try { r = JSON.parse(x.responseText); } catch (e) {}
        if (x.status !== 200 || !r || !r.AccessToken) return reject(new Error(x.status === 401 ? 'usuário ou senha incorretos' : 'login falhou (HTTP ' + x.status + ')'));
        sv.token = r.AccessToken; sv.userId = r.User.Id; sv.usuario = r.User.Name;
        if (sv === atual) { sessao.token = sv.token; sessao.userId = sv.userId; sessao.nome = sv.usuario; }
        salvarServidores();
        resolve(r);
      };
      x.onerror = function () { reject(new Error('sem conexão com ' + sv.url)); };
      x.ontimeout = function () { reject(new Error('tempo esgotado')); };
      x.send(JSON.stringify({ Username: usuario, Pw: senha || '' }));
    });
  }
  function entrarComSenha(usuario, senha) {
    return api('POST', '/Users/AuthenticateByName', null, { Username: usuario, Pw: senha || '' }).then(function (r) {
      salvarSessao(r); return r;
    });
  }

  // --- servidores -----------------------------------------------------------------------------
  // Public info of any server (no login). Rejects if it isn't a Jellyfin.
  function infoDe(url) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('GET', url + '/System/Info/Public', true);
      x.timeout = 8000;
      x.onload = function () {
        var d = null;
        try { d = JSON.parse(x.responseText); } catch (e) {}
        if (x.status === 200 && d && d.Id && d.Version) resolve(d);
        else reject(new Error('não é um servidor Jellyfin (HTTP ' + x.status + ')'));
      };
      x.onerror = function () { reject(new Error('sem resposta')); };
      x.ontimeout = function () { reject(new Error('tempo esgotado')); };
      x.send();
    });
  }
  // Accepts "192.168.0.10", "host:8096", "https://jf.example.com/jellyfin"… and tries the plausible variants.
  function acharServidor(texto) {
    var t = limparUrl(texto), candidatos = [];
    if (!t) return Promise.reject(new Error('endereço vazio'));
    if (/^https?:\/\//i.test(t)) candidatos.push(t);
    else {
      var temPorta = /:\d+(\/|$)/.test(t);
      if (!temPorta && t.indexOf('/') < 0) candidatos.push('http://' + t + ':8096');
      candidatos.push('http://' + t, 'https://' + t);
      if (!temPorta && t.indexOf('/') < 0) candidatos.push('https://' + t + ':8920');
    }
    var i = 0, ultimo = null;
    function proximo() {
      if (i >= candidatos.length) return Promise.reject(new Error('nenhum Jellyfin em "' + t + '" (' + (ultimo && ultimo.message) + ')'));
      var url = candidatos[i++];
      return infoDe(url).then(function (info) { return { url: url, info: info }; }, function (e) { ultimo = e; return proximo(); });
    }
    return proximo();
  }
  function adicionarServidor(url, info) {
    url = limparUrl(url);
    for (var k = 0; k < servidores.length; k++) if (servidores[k].url === url || (info && servidores[k].id === info.Id)) { iAtual = k; salvarServidores(); return k; }
    servidores.push({ url: url, nome: info && info.ServerName || '', id: info && info.Id || '', versao: info && info.Version || '' });
    iAtual = servidores.length - 1;
    salvarServidores();
    return iAtual;
  }
  function usarServidor(k) { if (servidores[k]) { iAtual = k; salvarServidores(); } }
  function removerServidor(k) {
    if (!servidores[k]) return;
    servidores.splice(k, 1);
    if (iAtual > k || iAtual >= servidores.length) iAtual = Math.max(0, iAtual - 1);
    salvarServidores();
  }

  // Starts and calls aoCodigo(code); resolves when someone approves in Jellyfin. cancelar() stops polling.
  function quickConnect(aoCodigo) {
    var parado = false, timer = null;
    var p = api('POST', '/QuickConnect/Initiate').then(function (qc) {
      aoCodigo(qc.Code);
      return new Promise(function (resolve, reject) {
        function checar() {
          if (parado) return;
          api('GET', '/QuickConnect/Connect', { secret: qc.Secret }).then(function (st) {
            if (parado) return;
            if (!st.Authenticated) { timer = setTimeout(checar, 3000); return; }
            api('POST', '/Users/AuthenticateWithQuickConnect', null, { Secret: qc.Secret }).then(function (r) {
              salvarSessao(r); resolve(r);
            }, reject);
          }, function (e) {
            if (e.status === 404) reject(new Error('o código expirou; reabra o app'));
            else timer = setTimeout(checar, 5000);
          });
        }
        checar();
      });
    });
    p.cancelar = function () { parado = true; clearTimeout(timer); };
    return p;
  }

  // --- imagens -------------------------------------------------------------------------------
  function imagem(item, tipo, largura) {
    var id = item.Id, tag;
    tipo = tipo || 'Primary';
    if (tipo === 'Primary') {
      tag = item.ImageTags && item.ImageTags.Primary;
      if (!tag && item.SeriesPrimaryImageTag) { id = item.SeriesId; tag = item.SeriesPrimaryImageTag; }
      if (!tag && item.AlbumPrimaryImageTag) { id = item.AlbumId; tag = item.AlbumPrimaryImageTag; }
      if (!tag) return '';
      return servidor + '/Items/' + id + '/Images/Primary' + qs({ fillWidth: largura || 300, quality: 85, tag: tag });
    }
    if (tipo === 'Backdrop') {
      if (item.BackdropImageTags && item.BackdropImageTags.length) tag = item.BackdropImageTags[0];
      else if (item.ParentBackdropImageTags && item.ParentBackdropImageTags.length) { id = item.ParentBackdropItemId; tag = item.ParentBackdropImageTags[0]; }
      if (!tag) return '';
      return servidor + '/Items/' + id + '/Images/Backdrop/0' + qs({ fillWidth: largura || 1280, quality: 70, tag: tag });
    }
    if (tipo === 'Thumb') {
      tag = item.ImageTags && item.ImageTags.Thumb;
      if (!tag) return imagem(item, 'Primary', largura);
      return servidor + '/Items/' + id + '/Images/Thumb' + qs({ fillWidth: largura || 400, quality: 85, tag: tag });
    }
    return '';
  }

  // --- native player profile (docs/tv-platform.md "Video"; evidence: notes/archive/achados-2026-11.md 18:27, 18:53) -------------------------------
  // <video src> = hardware decoder: mp4/mkv/ts/webm, H.264 and HEVC 8/10-bit up to 1080p, AAC up to 5.1,
  // AC-3, E-AC-3, MP3, FLAC. Not: 4K, DTS, Vorbis, HLS fMP4. Transcoding: HLS with TS segments.
  var AUDIO_DIRETO = 'aac,ac3,eac3,mp3,flac';
  var ATE_1080 = [
    { Condition: 'LessThanEqual', Property: 'Width', Value: '1920', IsRequired: true },
    { Condition: 'LessThanEqual', Property: 'Height', Value: '1080', IsRequired: true }
  ];
  function perfil() {
    return {
      Name: 'openrange Philco PTV42G70N5CF',
      MaxStreamingBitrate: TETO_DIRETO,
      MaxStaticBitrate: TETO_DIRETO,
      MusicStreamingTranscodingBitrate: 192000,
      DirectPlayProfiles: [
        { Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: 'h264,hevc', AudioCodec: AUDIO_DIRETO },
        { Container: 'mkv', Type: 'Video', VideoCodec: 'h264,hevc', AudioCodec: AUDIO_DIRETO },
        { Container: 'ts,mpegts', Type: 'Video', VideoCodec: 'h264,hevc', AudioCodec: 'aac,ac3,eac3,mp3' },
        { Container: 'webm', Type: 'Video', VideoCodec: 'vp9', AudioCodec: 'opus' },
        { Container: 'mp3,aac,m4a,m4b,flac,ac3', Type: 'Audio' }
      ],
      TranscodingProfiles: [
        { Container: 'ts', Type: 'Video', Protocol: 'hls', Context: 'Streaming', VideoCodec: 'h264',
          AudioCodec: 'aac,ac3', MaxAudioChannels: '6', MinSegments: 1, BreakOnNonKeyFrames: false },
        { Container: 'mp3', Type: 'Audio', Protocol: 'http', Context: 'Streaming', AudioCodec: 'mp3', MaxAudioChannels: '2' }
      ],
      ContainerProfiles: [],
      CodecProfiles: [
        { Type: 'Video', Codec: 'h264', Conditions: ATE_1080.concat([
          { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '51', IsRequired: false }]) },
        { Type: 'Video', Codec: 'hevc', Conditions: ATE_1080.concat([
          { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '10', IsRequired: false },
          // the screen isn't HDR: HDR goes through transcoding (the server tone-maps, if configured)
          { Condition: 'EqualsAny', Property: 'VideoRangeType', Value: 'SDR', IsRequired: false }]) },
        { Type: 'Video', Codec: 'vp9', Conditions: ATE_1080 },
        { Type: 'VideoAudio', Conditions: [
          { Condition: 'LessThanEqual', Property: 'AudioChannels', Value: '6', IsRequired: false }] }
      ],
      // <track> only reads WebVTT: the server converts srt/ass/ssa to vtt. Image subtitles are burned in.
      SubtitleProfiles: [
        { Format: 'vtt', Method: 'External' },
        { Format: 'pgssub', Method: 'Encode' },
        { Format: 'dvdsub', Method: 'Encode' },
        { Format: 'dvbsub', Method: 'Encode' }
      ],
      ResponseProfiles: [{ Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' }]
    };
  }

  function playbackInfo(itemId, opcoes) {
    opcoes = opcoes || {};
    var corpo = {
      UserId: sessao.userId, DeviceProfile: perfil(), MaxStreamingBitrate: TETO_DIRETO,
      StartTimeTicks: 0, AutoOpenLiveStream: true, IsPlayback: true,
      EnableDirectPlay: true, EnableDirectStream: true, EnableTranscoding: true,
      AllowVideoStreamCopy: true, AllowAudioStreamCopy: true
    };
    if (opcoes.audio != null) corpo.AudioStreamIndex = opcoes.audio;
    if (opcoes.legenda != null) corpo.SubtitleStreamIndex = opcoes.legenda;
    // no direct play: the server remuxes/transcodes to HLS TS (audio switch, or the direct file failed)
    if (opcoes.semDireto) corpo.EnableDirectPlay = false;
    // quality picked in the player menu (bits/s): caps and forces transcoding
    if (opcoes.bitrate) {
      corpo.MaxStreamingBitrate = opcoes.bitrate;
      corpo.DeviceProfile.MaxStreamingBitrate = opcoes.bitrate;
      corpo.EnableDirectPlay = false;
      corpo.EnableDirectStream = false;
    }
    return api('POST', '/Items/' + itemId + '/PlaybackInfo', { userId: sessao.userId }, corpo);
  }

  // URL the <video src> will play, from the MediaSource the server picked.
  function urlDeReproducao(item, ms, playSessionId, bitrate) {
    var audio = item.MediaType === 'Audio' || item.Type === 'Audio';
    if (ms.SupportsDirectPlay && audio) {
      return { metodo: 'DirectPlay', url: servidor + '/Audio/' + item.Id + '/stream.' + (ms.Container || 'mp3').split(',')[0] + qs({
        Static: 'true', MediaSourceId: ms.Id, PlaySessionId: playSessionId, DeviceId: deviceId, api_key: sessao.token }) };
    }
    if (ms.SupportsDirectPlay || (ms.SupportsDirectStream && !ms.TranscodingUrl)) {
      var ext = (ms.Container || 'mp4').split(',')[0];
      if (ext === 'mov') ext = 'mp4';
      return { metodo: ms.SupportsDirectPlay ? 'DirectPlay' : 'DirectStream',
               url: servidor + '/Videos/' + item.Id + '/stream.' + ext + qs({
                 Static: 'true', MediaSourceId: ms.Id, PlaySessionId: playSessionId, DeviceId: deviceId, api_key: sessao.token }) };
    }
    if (ms.TranscodingUrl) {
      var url = ms.TranscodingUrl.replace(/([?&]VideoBitrate=)(\d+)/, function (_, k, n) {
        return k + Math.min(+n, bitrate || TETO_TRANSCODE, TETO_TRANSCODE);
      });
      // Quality picked in the menu: the server only caps the bitrate; resolution is capped here.
      var alt = !bitrate ? 0 : bitrate <= 1.5e6 ? 480 : bitrate <= 6e6 ? 720 : 0;
      if (alt) {
        url = url.replace(/([?&]MaxHeight=)\d+/, '$1' + alt).replace(/([?&]MaxWidth=)\d+/, '$1' + Math.round(alt * 16 / 9 / 2) * 2);
        if (!/[?&]MaxHeight=/.test(url)) url += '&MaxHeight=' + alt + '&MaxWidth=' + Math.round(alt * 16 / 9 / 2) * 2;
      }
      return { metodo: 'Transcode', url: servidor + url };
    }
    return null;
  }

  // Seek thumbnails (trickplay): sheets of TileWidth x TileHeight frames, one every Interval ms.
  // Returns null if the item has none; else {url(sheet), info} of the smallest width available.
  function trickplay(item, ms) {
    var t = item.Trickplay && (item.Trickplay[ms.Id] || item.Trickplay[Object.keys(item.Trickplay)[0]]);
    if (!t) return null;
    var larguras = Object.keys(t).map(Number).sort(function (a, b) { return a - b; });
    if (!larguras.length) return null;
    var info = t[larguras[0]];
    return { info: info, porFolha: info.TileWidth * info.TileHeight,
             url: function (folha) {
               return servidor + '/Videos/' + item.Id + '/Trickplay/' + info.Width + '/' + folha + '.jpg' +
                      qs({ MediaSourceId: ms.Id, api_key: sessao.token });
             } };
  }

  // Skippable parts: /MediaSegments (10.10, needs a server plugin) and, without it, chapters named
  // intro/credits. Returns [{tipo:'Intro'|'Outro', ini, fim}] in seconds.
  function segmentos(item) {
    function dosCapitulos() {
      var caps = item.Chapters || [], r = [], dur = (item.RunTimeTicks || 0) / TICKS;
      for (var i = 0; i < caps.length; i++) {
        var nome = caps[i].Name || '', ini = caps[i].StartPositionTicks / TICKS;
        var fim = i + 1 < caps.length ? caps[i + 1].StartPositionTicks / TICKS : dur;
        if (/^(intro|abertura|opening|op)\b/i.test(nome)) r.push({ tipo: 'Intro', ini: ini, fim: fim });
        else if (/^(cr[eé]ditos|credits|outro|ending|ed)\b/i.test(nome)) r.push({ tipo: 'Outro', ini: ini, fim: fim });
      }
      return r;
    }
    return api('GET', '/MediaSegments/' + item.Id, { includeSegmentTypes: 'Intro,Outro' }).then(function (r) {
      var its = (r && r.Items) || [];
      if (!its.length) return dosCapitulos();
      return its.map(function (x) { return { tipo: x.Type, ini: x.StartTicks / TICKS, fim: x.EndTicks / TICKS }; });
    }, dosCapitulos);
  }

  function comToken(url) {
    if (/[?&](api_key|ApiKey)=/.test(url)) return url;
    return url + (url.indexOf('?') < 0 ? '?' : '&') + 'api_key=' + encodeURIComponent(sessao.token);
  }

  w.jf = {
    TICKS: TICKS, VERSAO: VERSAO, servidor: servidor, servidorPadrao: servidorPadrao, deviceId: deviceId, sessao: sessao,
    servidores: servidores, atual: atual, indiceAtual: function () { return iAtual; },
    infoDe: infoDe, acharServidor: acharServidor, adicionarServidor: adicionarServidor, usarServidor: usarServidor,
    removerServidor: removerServidor, entrarComSenha: entrarComSenha, entrarEm: entrarEm,
    api: api, qs: qs, quickConnect: quickConnect, sair: sair,
    imagem: imagem, perfil: perfil, playbackInfo: playbackInfo, urlDeReproducao: urlDeReproducao, comToken: comToken,
    trickplay: trickplay, segmentos: segmentos
  };
})(window);
