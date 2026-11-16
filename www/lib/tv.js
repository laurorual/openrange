/* tv.js — base of the OpenRange apps: remote keys, arrow focus, notices and log to the PC.
 *
 * ES5 on purpose: the apps run in the store runtime (QJY, ~Chrome 56), but this way they also open in the
 * Sraf Browser (Chrome 47) for debugging. No dependencies.
 *
 * Uso:
 *   <link rel="stylesheet" href="/lib/tv.css">
 *   <script src="/lib/tv.js"></script>
 *   tv.iniciar({ app: 'inicio', margemBaixo: 90 });   // app = name in the PC log; margins = fixed bars
 *   elements with class="focavel" get focus from the arrows; OK = click() on the focused element
 *   tv.ao('vermelho', function () { ... return true; });   // true = key handled (no default action)
 *   tv.log('texto') / tv.aviso('texto') / tv.json(url, function (erro, dados) { ... })
 *
 * Keys measured in the QJY runtime on 2026-11-15 17:56 (notes/archive/achados-2026-11.md; summary in docs/tv-platform.md). Those marked "?" are the
 * HbbTV/OIPF default and not yet confirmed on this remote.
 */
(function (w, d) {
  'use strict';

  var TECLAS = {
    37: 'esquerda', 38: 'cima', 39: 'direita', 40: 'baixo',
    13: 'ok',                                   // measured: 13 (Enter)
    8: 'voltar', 27: 'voltar', 461: 'voltar', 10009: 'voltar',   // medido: 8 (Backspace)
    403: 'vermelho', 404: 'verde', 405: 'amarelo', 406: 'azul',
    415: 'play', 19: 'pause',
    413: 'stop', 412: 'retroceder', 417: 'avancar',   // measured 2026-11-16
    10252: 'playpause'                          // HbbTV default, not seen on this remote
  };
  for (var n = 0; n < 10; n++) { TECLAS[48 + n] = String(n); TECLAS[96 + n] = String(n); }

  var opcoes = { app: '?', setas: true, margemTopo: 0, margemBaixo: 0 };
  var tratadores = {};
  var atual = null;

  // --- talking to the PC -------------------------------------------------------------
  function enviar(obj) {
    obj.app = opcoes.app;
    obj.quando = new Date().toISOString();
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/relatorio', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(JSON.stringify(obj));
    } catch (e) { /* no network: never mind*/ }
  }

  function texto(args) {
    var partes = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (typeof a === 'string') { partes.push(a); continue; }
      try { partes.push(JSON.stringify(a)); } catch (e) { partes.push(String(a)); }
    }
    return partes.join(' ');
  }

  function log() {
    var msg = texto(arguments);
    if (w.console) console.log(msg);
    enviar({ tipo: 'log', msg: msg });
  }

  function json(url, cb) {
    var x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.timeout = 15000;
    x.onload = function () {
      if (x.status < 200 || x.status >= 300) return cb(new Error('HTTP ' + x.status + ' em ' + url));
      var dados;
      try { dados = JSON.parse(x.responseText); } catch (e) { return cb(e); }
      cb(null, dados);
    };
    x.onerror = function () { cb(new Error('falha de rede em ' + url)); };
    x.ontimeout = function () { cb(new Error('tempo esgotado em ' + url)); };
    x.send();
  }

  // --- on-screen notices -----------------------------------------------------------------
  var caixaAviso = null, timerAviso = null;
  function aviso(msg, ms, tipo) {
    if (!caixaAviso) {
      caixaAviso = d.createElement('div');
      caixaAviso.id = 'tv-aviso';
      d.body.appendChild(caixaAviso);
    }
    caixaAviso.textContent = msg;
    caixaAviso.className = 'visivel' + (tipo ? ' ' + tipo : '');
    clearTimeout(timerAviso);
    timerAviso = setTimeout(function () { caixaAviso.className = ''; }, ms || 3000);
  }

  // No devtools on the TV: every error goes to the screen and to the PC.
  w.onerror = function (msg, src, linha, col, err) {
    enviar({ tipo: 'erro', msg: String(msg), src: src, linha: linha, col: col, pilha: err && err.stack });
    if (d.body) aviso('Erro: ' + msg, 6000, 'erro');
  };
  w.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    enviar({ tipo: 'erro', msg: 'promise rejeitada: ' + (r && r.message || r), pilha: r && r.stack });
  });

  // --- foco por setas -------------------------------------------------------------------
  function visivel(el) {
    return !!(el.offsetWidth || el.offsetHeight) && w.getComputedStyle(el).visibility !== 'hidden';
  }

  function focaveis(raiz) {
    var lista = (raiz || d).querySelectorAll('.focavel'), r = [];
    for (var i = 0; i < lista.length; i++) if (visivel(lista[i])) r.push(lista[i]);
    return r;
  }

  function disparar(el, nome, detalhe) {
    var ev;
    try { ev = new CustomEvent(nome, { bubbles: true, detail: detalhe }); }
    catch (e) { ev = d.createEvent('CustomEvent'); ev.initCustomEvent(nome, true, false, detalhe); }
    el.dispatchEvent(ev);
  }

  function focar(el) {
    if (!el) return;
    if (atual && atual !== el) { atual.classList.remove('foco'); disparar(atual, 'tv:desfoco'); }
    atual = el;
    el.classList.add('foco');
    rolarAte(el);
    disparar(el, 'tv:foco');
  }

  // Scrolls the page only as needed, respecting fixed bars (margemTopo / margemBaixo options).
  // Scrolls as needed for the element to be visible: first each .rolavel box around it
  // (horizontal rows, lists), then the page, respecting fixed bars (margemTopo / margemBaixo).
  // A box with .rolavel-tela scrolls the whole screen, not the window.
  function rolarAte(el) {
    var c = el.parentNode, folga = 24;
    while (c && c.classList) {
      if (c.classList.contains('rolavel')) {
        var rc = c.getBoundingClientRect(), re = el.getBoundingClientRect();
        if (re.bottom > rc.bottom) c.scrollTop += re.bottom - rc.bottom + folga;
        else if (re.top < rc.top) c.scrollTop -= rc.top - re.top + folga;
        if (re.right > rc.right) c.scrollLeft += re.right - rc.right + folga;
        else if (re.left < rc.left) c.scrollLeft -= rc.left - re.left + folga;
        if (c.classList.contains('rolavel-tela')) return;
      }
      c = c.parentNode;
    }
    var r = el.getBoundingClientRect(), topo = opcoes.margemTopo, baixo = w.innerHeight - opcoes.margemBaixo;
    if (r.bottom > baixo) w.scrollBy(0, r.bottom - baixo + 16);
    else if (r.top < topo) w.scrollBy(0, r.top - topo - 16);
  }

  // Picks the neighbour in that direction: distance along the arrow's axis + penalty for drift on the other axis.
  function mover(dir) {
    var els = focaveis();
    if (!els.length) return false;
    if (!atual || els.indexOf(atual) < 0) { focar(els[0]); return true; }
    var a = atual.getBoundingClientRect();
    var ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    var melhor = null, melhorNota = Infinity;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el === atual) continue;
      var r = el.getBoundingClientRect();
      var dx = r.left + r.width / 2 - ax, dy = r.top + r.height / 2 - ay;
      var principal, desvio;
      if (dir === 'direita')       { if (r.left < a.right - a.width / 2) continue; principal = dx;  desvio = Math.abs(dy); }
      else if (dir === 'esquerda') { if (r.right > a.left + a.width / 2) continue; principal = -dx; desvio = Math.abs(dy); }
      else if (dir === 'baixo')    { if (r.top < a.bottom - a.height / 2) continue; principal = dy;  desvio = Math.abs(dx); }
      else                         { if (r.bottom > a.top + a.height / 2) continue; principal = -dy; desvio = Math.abs(dx); }
      var nota = principal + desvio * 2.5;
      if (nota < melhorNota) { melhorNota = nota; melhor = el; }
    }
    if (melhor) { focar(melhor); return true; }
    return false;
  }

  // --- teclado --------------------------------------------------------------------------
  function ao(nome, fn) { tratadores[nome] = fn; }

  function voltar() {
    if (w.history.length > 1) w.history.back();
    else aviso('Nada para voltar');
  }

  d.addEventListener('keydown', function (ev) {
    var nome = TECLAS[ev.keyCode];
    if (!nome) { enviar({ tipo: 'tecla', nome: null, keyCode: ev.keyCode, key: ev.key }); return; }
    var fn = tratadores[nome] || (/^\d$/.test(nome) && tratadores.numero);
    var tratada = fn ? fn(nome, ev) === true : false;
    if (!tratada) {
      if (opcoes.setas && /^(cima|baixo|esquerda|direita)$/.test(nome)) tratada = mover(nome) || true;
      else if (nome === 'ok' && atual) { atual.click(); tratada = true; }
      else if (nome === 'voltar') { voltar(); tratada = true; }
    }
    if (tratada) ev.preventDefault();
  }, false);

  // --- start ----------------------------------------------------------------------------
  function iniciar(o) {
    for (var k in o) if (o.hasOwnProperty(k)) opcoes[k] = o[k];
    enviar({ tipo: 'log', msg: 'aberto: ' + location.href + ' · ' + w.innerWidth + 'x' + w.innerHeight });
  }

  w.tv = {
    iniciar: iniciar, ao: ao, log: log, aviso: aviso, json: json, enviar: enviar,
    focar: focar, mover: mover, focaveis: focaveis, voltar: voltar,
    get atual() { return atual; }
  };
})(window, document);
