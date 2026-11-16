/* OpenRange — feature test of the TV's browser.
 * Pure ES5 on purpose (the Sraf Browser is Chrome 47). Only READS capabilities: calls no
 * native TV function (QjyScript/Netrange are only listed) and creates no MediaKeys.
 * Result: on screen and via POST /relatorio (tools/portal.py saves it in logs/relatorios/).
 */
(function () {
  'use strict';

  var R = { tipo: 'relatorio', versao: 1, quando: new Date().toString(), url: location.href, secoes: {} };
  var saida = document.getElementById('saida');
  var estado = document.getElementById('estado');

  function tenta(fn) {
    try { return fn(); } catch (e) { return 'ERRO: ' + (e && e.name ? e.name + ': ' + e.message : String(e)); }
  }

  function classe(v) {
    if (v === true || v === 'probably' || v === 'sim') return 'sim';
    if (v === false || v === '' || v === 'nao' || v === undefined || v === null) return 'nao';
    if (v === 'maybe') return 'talvez';
    return 'info';
  }

  function texto(v) {
    if (v === true) return 'sim';
    if (v === false) return 'não';
    if (v === '') return '(vazio = não)';
    if (v === undefined) return 'undefined';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  function secao(nome, pares) {
    R.secoes[nome] = pares;
    var h = document.createElement('h2');
    h.textContent = nome;
    saida.appendChild(h);
    var t = document.createElement('table');
    for (var k in pares) {
      if (!pares.hasOwnProperty(k)) continue;
      var tr = document.createElement('tr');
      var a = document.createElement('td'); a.textContent = k;
      var b = document.createElement('td'); b.textContent = texto(pares[k]); b.className = classe(pares[k]);
      tr.appendChild(a); tr.appendChild(b); t.appendChild(tr);
    }
    saida.appendChild(t);
  }

  function enviar(obj, cb) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/relatorio', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.onreadystatechange = function () { if (x.readyState === 4 && cb) cb(x.status); };
      x.send(JSON.stringify(obj));
    } catch (e) { if (cb) cb('ERRO ' + e.name); }
  }

  // 1. Device and screen --------------------------------------------------------
  secao('Aparelho', {
    'navigator.userAgent': navigator.userAgent,
    'navigator.platform': navigator.platform,
    'navigator.language': navigator.language,
    'navigator.hardwareConcurrency': navigator.hardwareConcurrency,
    'navigator.deviceMemory': navigator.deviceMemory,
    'screen': screen.width + 'x' + screen.height + ' (disp. ' + screen.availWidth + 'x' + screen.availHeight + ')',
    'janela (inner)': window.innerWidth + 'x' + window.innerHeight,
    'devicePixelRatio': window.devicePixelRatio,
    'performance.memory.jsHeapSizeLimit (MB)': tenta(function () {
      return performance.memory ? Math.round(performance.memory.jsHeapSizeLimit / 1048576) : undefined;
    }),
    'HDR (dynamic-range: high)': tenta(function () { return matchMedia('(dynamic-range: high)').matches; }),
    'cookies': navigator.cookieEnabled
  });

  // 2. JS syntax (compiles without running) -------------------------------------
  var sintaxe = {
    'let/const (strict)': '"use strict"; let a = 1; const b = 2;',
    'let (sloppy)': 'let a = 1;',
    'arrow function': 'var f = (a) => a;',
    'class': '"use strict"; class A { m() {} }',
    'template literal': 'var s = `a${1}`;',
    'destructuring': 'var {a} = {a: 1}; var [b] = [1];',
    'parâmetro default': 'function f(a = 1) {}',
    'rest/spread': 'function f(...a) {} Math.max(...[1]);',
    'generator': 'function* g() { yield 1; }',
    'async/await (ES2017)': 'async function f() { await 1; }',
    'operador ** (ES2016)': 'var a = 2 ** 2;',
    'object spread (ES2018)': 'var o = {...{a: 1}};',
    'async generator (ES2018)': 'async function* g() {}',
    'optional catch binding (ES2019)': 'try {} catch {}',
    'optional chaining ?. (ES2020)': 'var a = null; a?.b;',
    'nullish ?? (ES2020)': 'var a = null ?? 1;',
    'BigInt literal (ES2020)': 'var a = 1n;',
    'class fields (ES2022)': '"use strict"; class A { x = 1; }'
  };
  var resSintaxe = {};
  for (var nome in sintaxe) {
    if (!sintaxe.hasOwnProperty(nome)) continue;
    resSintaxe[nome] = (function (cod) { try { new Function(cod); return true; } catch (e) { return false; } })(sintaxe[nome]);
  }
  resSintaxe['<script type=module>'] = 'noModule' in document.createElement('script');
  secao('Sintaxe JavaScript', resSintaxe);

  // 3. APIs ----------------------------------------------------------------------
  function existe(caminho) {
    return tenta(function () {
      var o = window, p = caminho.split('.');
      for (var i = 0; i < p.length; i++) { if (o == null) return false; o = o[p[i]]; }
      return o !== undefined && o !== null;
    });
  }
  var apis = ['Promise', 'fetch', 'Symbol', 'Map', 'Set', 'WeakMap', 'Proxy', 'Reflect', 'Intl', 'Object.assign',
    'Array.prototype.includes', 'Array.from', 'String.prototype.padStart', 'Object.entries', 'URL', 'URLSearchParams',
    'TextDecoder', 'AbortController', 'Blob', 'FileReader', 'crypto.subtle', 'WebAssembly', 'Worker', 'SharedWorker',
    'WebSocket', 'EventSource', 'indexedDB', 'requestAnimationFrame', 'requestIdleCallback', 'IntersectionObserver',
    'ResizeObserver', 'MutationObserver', 'CustomEvent', 'navigator.serviceWorker', 'navigator.sendBeacon',
    'history.pushState', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'AudioContext', 'webkitAudioContext',
    'navigator.getGamepads', 'Notification', 'customElements', 'HTMLElement.prototype.attachShadow'];
  var resApis = {};
  for (var i = 0; i < apis.length; i++) resApis[apis[i]] = existe(apis[i]);
  resApis['localStorage (escrita)'] = tenta(function () {
    localStorage.setItem('openrange', '1'); var ok = localStorage.getItem('openrange') === '1'; localStorage.removeItem('openrange'); return ok;
  });
  resApis['WebGL'] = tenta(function () { var c = document.createElement('canvas'); return !!(c.getContext('webgl') || c.getContext('experimental-webgl')); });
  resApis['WebGL2'] = tenta(function () { return !!document.createElement('canvas').getContext('webgl2'); });
  resApis['fullscreen'] = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  secao('APIs', resApis);

  // 4. CSS -----------------------------------------------------------------------
  var css = [['display', 'flex'], ['display', '-webkit-flex'], ['display', 'grid'], ['--x', '1'], ['position', 'sticky'],
    ['position', '-webkit-sticky'], ['object-fit', 'cover'], ['display', 'contents'], ['gap', '1px'], ['aspect-ratio', '1'],
    ['filter', 'blur(1px)'], ['backdrop-filter', 'blur(1px)'], ['-webkit-backdrop-filter', 'blur(1px)'],
    ['transform', 'translate3d(0,0,0)'], ['will-change', 'transform'], ['font-display', 'swap'], ['width', 'calc(1px + 1%)'],
    ['width', '1vw'], ['color', 'rgb(0 0 0 / 50%)']];
  var resCss = {};
  var temSupports = !!(window.CSS && CSS.supports);
  resCss['CSS.supports existe'] = temSupports;
  for (i = 0; i < css.length; i++) {
    resCss[css[i][0] + ': ' + css[i][1]] = temSupports ? tenta(function () { return CSS.supports(css[i][0], css[i][1]); }) : 'sem CSS.supports';
  }
  secao('CSS', resCss);

  // 5. Media ---------------------------------------------------------------------
  var tipos = [
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/mp4; codecs="avc1.4D401F"', 'video/mp4; codecs="avc1.640028"',
    'video/mp4; codecs="avc1.640033"', 'video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"',
    'video/mp4; codecs="hvc1.2.4.L120.B0"', 'video/mp4; codecs="av01.0.05M.08"', 'video/webm; codecs="vp8, vorbis"',
    'video/webm; codecs="vp9"', 'video/webm; codecs="vp09.00.10.08"', 'video/mp2t; codecs="avc1.42E01E, mp4a.40.2"',
    'video/x-matroska', 'application/vnd.apple.mpegurl', 'application/x-mpegURL', 'application/dash+xml',
    'audio/mp4; codecs="mp4a.40.2"', 'audio/mp4; codecs="mp4a.40.5"', 'audio/mpeg', 'audio/mp4; codecs="ac-3"',
    'audio/mp4; codecs="ec-3"', 'audio/webm; codecs="opus"', 'audio/mp4; codecs="opus"', 'audio/ogg; codecs="vorbis"',
    'audio/flac', 'audio/mp4; codecs="flac"', 'audio/wav'];
  var v = document.createElement('video');
  var MS = window.MediaSource || window.WebKitMediaSource;
  var resPlay = {}, resMse = {};
  for (i = 0; i < tipos.length; i++) {
    resPlay[tipos[i]] = tenta(function () { return v.canPlayType(tipos[i]); });
    resMse[tipos[i]] = MS && MS.isTypeSupported ? tenta(function () { return MS.isTypeSupported(tipos[i]); }) : 'sem MSE';
  }
  secao('<video>.canPlayType (reprodução direta)', resPlay);
  secao('MediaSource.isTypeSupported (hls.js / dash.js)', resMse);

  // 6. TV native objects (names only; nothing is called) ----------------------------
  function nomesDe(o) {
    var n = [];
    try { for (var k in o) n.push(k); } catch (e) {}
    try { var p = Object.getOwnPropertyNames(o); for (var j = 0; j < p.length; j++) if (n.indexOf(p[j]) < 0) n.push(p[j]); } catch (e) {}
    return n.slice(0, 80);
  }
  var nativos = ['QjyScript', 'Netrange', 'nrBrowser', 'oipfObjectFactory', 'Android', 'chrome', 'opera', 'tizen', 'webOS',
    'PalmSystem', 'webapis', 'hbbtv', 'NetCastGetDeviceInfo', 'mstar', 'MStar', 'external'];
  var resNat = {};
  for (i = 0; i < nativos.length; i++) {
    var o = tenta((function (n) { return function () { return window[n]; }; })(nativos[i]));
    if (o === undefined || o === null) { resNat[nativos[i]] = false; continue; }
    var desc = typeof o;
    var nomes = nomesDe(o);
    if (typeof o === 'function' && o.prototype) nomes = nomes.concat(['[prototype]']).concat(nomesDe(o.prototype));
    resNat[nativos[i]] = desc + ': ' + nomes.join(', ');
  }
  secao('Objetos nativos da TV (só listados)', resNat);

  // 7. Desempenho (bem grosseiro) -------------------------------------------------------
  var t0 = Date.now(), soma = 0;
  for (i = 0; i < 3000000; i++) soma += i % 7;
  var t1 = Date.now();
  var arr = []; for (i = 0; i < 200000; i++) arr.push({ a: i, b: 'x' + i });
  var js = JSON.stringify(arr); JSON.parse(js);
  var t2 = Date.now();
  secao('Desempenho', { 'loop 3M (ms)': t1 - t0, 'JSON 200k objetos (ms)': t2 - t1, 'tamanho JSON (KB)': Math.round(js.length / 1024) });

  // 8. DRM / EME (support queries only; no MediaKeys, no license requests) ------------
  var resEme = { 'navigator.requestMediaKeySystemAccess': !!navigator.requestMediaKeySystemAccess,
    'video.webkitGenerateKeyRequest (EME antigo)': 'webkitGenerateKeyRequest' in v,
    'WebKitMediaKeys': !!window.WebKitMediaKeys, 'MSMediaKeys': !!window.MSMediaKeys };
  var sistemas = ['com.widevine.alpha', 'com.microsoft.playready', 'com.microsoft.playready.recommendation',
    'com.youtube.playready', 'com.chromecast.playready', 'org.w3.clearkey'];
  var pendentes = 0;

  function finalizar() {
    secao('DRM / EME (consulta de suporte)', resEme);
    estado.textContent = 'enviando relatório…';
    enviar(R, function (st) { estado.textContent = (st === 204 ? 'relatório enviado ao PC ✓' : 'falha ao enviar (' + st + ')'); });
  }

  if (navigator.requestMediaKeySystemAccess) {
    var cfg = [{ initDataTypes: ['cenc'],
      videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
      audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }];
    for (i = 0; i < sistemas.length; i++) {
      pendentes++;
      (function (ks) {
        var feito = false;
        function fim(val) { if (feito) return; feito = true; resEme[ks] = val; if (--pendentes === 0) finalizar(); }
        try {
          navigator.requestMediaKeySystemAccess(ks, cfg).then(function (acc) {
            var c = tenta(function () { return acc.getConfiguration(); });
            var rob = c && c.videoCapabilities && c.videoCapabilities[0] ? c.videoCapabilities[0].robustness : '';
            fim('sim (robustness: "' + (rob || '') + '")');
          }, function (e) { fim(false); });
        } catch (e) { fim('ERRO ' + e.name); }
        setTimeout(function () { fim('sem resposta em 5 s'); }, 5000);
      })(sistemas[i]);
    }
  } else {
    for (i = 0; i < sistemas.length; i++) resEme[sistemas[i]] = tenta(function () { return v.canPlayType('video/mp4', sistemas[i]); });
    finalizar();
  }

  // 9. Remote keys ----------------------------------------------------------------
  var spanTecla = document.getElementById('tecla');
  document.addEventListener('keydown', function (ev) {
    var info = { tipo: 'tecla', app: 'teste', quando: new Date().toString(), keyCode: ev.keyCode, key: ev.key, code: ev.code, which: ev.which };
    spanTecla.textContent = 'tecla: ' + ev.keyCode + (ev.key ? ' / ' + ev.key : '');
    enviar(info);
    if (ev.keyCode === 38) { window.scrollBy(0, -200); ev.preventDefault(); }
    if (ev.keyCode === 40) { window.scrollBy(0, 200); ev.preventDefault(); }
    if (ev.keyCode === 8 || ev.keyCode === 27 || ev.keyCode === 461 || ev.keyCode === 10009) {
      ev.preventDefault();
      setTimeout(function () { history.back(); }, 300);
    }
  }, true);
})();
