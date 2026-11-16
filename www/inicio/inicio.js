/* OpenRange launcher: our apps + store favorites (config/openrange.json), via /api/inicio.*/
(function () {
  'use strict';
  tv.iniciar({ app: 'inicio', margemBaixo: 90 });

  var secoes = document.getElementById('secoes');
  var descricao = document.getElementById('descricao');
  var fusoMin = 0;
  var ultimoFoco = null;
  try { ultimoFoco = sessionStorage.getItem('inicio.foco'); } catch (e) {}

  // The TV's clock runs in UTC (report from 17:56): use the time zone the PC reports.
  var DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  function doisDig(n) { return (n < 10 ? '0' : '') + n; }
  function relogio() {
    var t = new Date(Date.now() + fusoMin * 60000);
    document.getElementById('relogio').textContent = doisDig(t.getUTCHours()) + ':' + doisDig(t.getUTCMinutes());
    document.getElementById('data').textContent =
      DIAS[t.getUTCDay()] + ', ' + doisDig(t.getUTCDate()) + '/' + doisDig(t.getUTCMonth() + 1);
  }

  function bloco(app) {
    var el = document.createElement('div');
    el.className = 'bloco focavel';
    el.setAttribute('data-id', app.id);
    var img;
    if (app.icone) {
      img = document.createElement('img');
      img.src = app.icone;
      img.alt = '';
      img.onerror = function () { img.style.visibility = 'hidden'; };
    } else {                                     // no icon: plate with the name
      img = document.createElement('div');
      img.className = 'placa';
      img.textContent = app.name;
    }
    var nome = document.createElement('div');
    nome.className = 'nome';
    nome.textContent = app.name;
    el.appendChild(img);
    el.appendChild(nome);
    el.addEventListener('tv:foco', function () {
      descricao.textContent = app.description || app.name;
      try { sessionStorage.setItem('inicio.foco', String(app.id)); } catch (e) {}
    });
    el.addEventListener('click', function () { abrir(app); });
    return el;
  }

  function abrir(app) {
    tv.log('abrindo ' + app.id + ' ' + app.name + ' -> ' + app.url);
    tv.aviso('Abrindo ' + app.name + '…', 8000);
    // Same window, as the portal does: Back in the app returns here.
    setTimeout(function () { window.location.href = app.url; }, 50);
  }

  function secao(titulo, apps, vazio) {
    var h = document.createElement('h2');
    h.textContent = titulo;
    secoes.appendChild(h);
    var f = document.createElement('div');
    f.className = 'fileira';
    if (!apps.length) {
      var p = document.createElement('p');
      p.className = 'vazio';
      p.textContent = vazio;
      f.appendChild(p);
    }
    for (var i = 0; i < apps.length; i++) f.appendChild(bloco(apps[i]));
    secoes.appendChild(f);
  }

  function carregar() {
    tv.json('/api/inicio', function (erro, d) {
      if (erro) {
        secoes.innerHTML = '<p class="vazio">Não consegui falar com o PC: ' + erro.message + '</p>';
        return tv.aviso('Sem resposta do PC', 5000, 'erro');
      }
      fusoMin = d.fuso_min || 0;
      relogio();
      secoes.innerHTML = '';
      var meus = [];
      for (var i = 0; i < d.proprios.length; i++)
        if (d.proprios[i].url.split('#')[0] !== location.href.split('#')[0]) meus.push(d.proprios[i]);
      // own apps grouped by "secao" (set in the control panel), sections in the order they first appear
      var ordem = [], grupos = {};
      for (var j = 0; j < meus.length; j++) {
        var nomeSecao = meus[j].secao || 'Nossos apps';
        if (!grupos[nomeSecao]) { grupos[nomeSecao] = []; ordem.push(nomeSecao); }
        grupos[nomeSecao].push(meus[j]);
      }
      if (!ordem.length) secao('Nossos apps', [], 'Nenhum app: adicione no painel do PC (porta 8090, /painel/)');
      for (var k = 0; k < ordem.length; k++) secao(ordem[k], grupos[ordem[k]], '');
      var daLoja = d.favoritos.slice();
      if (d.loja) daLoja.unshift({ id: 'loja', name: 'Loja da TV', url: d.loja, icone: '',
                                   description: 'A loja original da NetRange (com os nossos apps no começo).' });
      secao('Da loja', daLoja, 'Escolha os favoritos no painel do PC (aba Loja)');
      if (d.faltando && d.faltando.length) tv.log('favoritos fora do catálogo: ' + d.faltando.join(', '));
      var alvo = ultimoFoco && document.querySelector('.bloco[data-id="' + ultimoFoco + '"]');
      tv.focar(alvo || tv.focaveis()[0]);
    });
  }

  tv.ao('vermelho', function () { location.reload(); return true; });
  tv.ao('azul', function () { window.location.href = '/teste/'; return true; });

  relogio();
  setInterval(relogio, 10000);
  carregar();
})();
