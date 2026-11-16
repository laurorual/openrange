/* app.js — screens of the OpenRange Jellyfin client.
 *
 * Tabs (roots): Home · Favorites · Search. On top of them stack grids (library, folder, season,
 * person) and details (movie, video, episode, series). Back pops the top screen and restores focus.
 * The player lives in player.js.
 *
 * tv.ao takes ONE handler per key: keys used both inside and outside the player (colours, digits) are
 * registered here and delegated — active player → jfPlayer; else → aoVerde/aoAmarelo/aoNumero of the top screen.
 */
(function () {
  'use strict';
  tv.iniciar({ app: 'jellyfin' });

  var CAMPOS = 'PrimaryImageAspectRatio,ProductionYear,RunTimeTicks,UserData,ChildCount,Overview';
  var IMAGENS = 'Primary,Thumb,Backdrop';
  var PAGINA = 60;
  var TIPOS_PASTA = { CollectionFolder: 1, Folder: 1, UserView: 1, Season: 1, BoxSet: 1, Playlist: 1, Person: 1,
                      Genre: 1, Studio: 1, MusicAlbum: 1, MusicArtist: 1, PhotoAlbum: 1 };
  var TIPOS_LARGOS = { Episode: 1, MusicVideo: 1, Video: 1, TvChannel: 1 };
  var COLECOES_LARGAS = { musicvideos: 1, homevideos: 1 };
  var TIPOS_BUSCA = 'Movie,Series,Episode,MusicVideo,Video,BoxSet';
  var ORDENS = [
    { nome: 'Nome', sortBy: 'SortName', sortOrder: 'Ascending' },
    { nome: 'Adicionados por último', sortBy: 'DateCreated,SortName', sortOrder: 'Descending' },
    { nome: 'Lançamento', sortBy: 'PremiereDate,ProductionYear,SortName', sortOrder: 'Descending' },
    { nome: 'Avaliação', sortBy: 'CommunityRating,SortName', sortOrder: 'Descending' },
    { nome: 'Vistos por último', sortBy: 'DatePlayed,SortName', sortOrder: 'Descending' },
    { nome: 'Aleatório', sortBy: 'Random', sortOrder: 'Ascending' }
  ];
  var FILTROS = [
    { nome: 'Todos', filters: '' },
    { nome: 'Não assistidos', filters: 'IsUnplayed' },
    { nome: 'Favoritos', filters: 'IsFavorite' },
    { nome: 'Em andamento', filters: 'IsResumable' }
  ];

  // Views of a library (blue cycles), like the official client's tabs.
  var TIPO_DA_COLECAO = { movies: 'Movie', tvshows: 'Series', musicvideos: 'MusicVideo', boxsets: 'BoxSet', music: 'MusicAlbum' };
  var VISOES = {
    movies: ['Filmes', 'Gêneros'], tvshows: ['Séries', 'Gêneros'], musicvideos: ['Vídeos', 'Gêneros'],
    music: ['Álbuns', 'Artistas', 'Gêneros']
  };
  var TIPOS_QUADRADOS = { MusicAlbum: 1, MusicArtist: 1, Audio: 1, Playlist: 1, MusicGenre: 1 };

  var raiz = document.getElementById('telas');
  var pilha = [];
  var fusoMin = 0;

  // --- utilidades ---------------------------------------------------------------------------
  function el(tag, classe, texto) {
    var e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    return e;
  }
  function doisDig(n) { return (n < 10 ? '0' : '') + n; }
  function duracao(ticks) {
    var s = Math.round(ticks / jf.TICKS), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    if (!h && !m) return s + ' s';
    return h ? h + ' h ' + doisDig(m) + ' min' : m + ' min';
  }
  function relogio(seg) {
    seg = Math.max(0, Math.floor(seg));
    var h = Math.floor(seg / 3600), m = Math.floor(seg % 3600 / 60), s = seg % 60;
    return (h ? h + ':' + doisDig(m) : m) + ':' + doisDig(s);
  }
  function horaLocal(ms) {                       // the TV's clock runs in UTC; the time zone comes from the PC
    var t = new Date((ms || Date.now()) + fusoMin * 60000);
    return doisDig(t.getUTCHours()) + ':' + doisDig(t.getUTCMinutes());
  }
  function erro(onde, e) {
    tv.log('erro em ' + onde + ': ' + (e && e.message || e));
    tv.aviso(onde + ': ' + (e && e.message || e), 6000, 'erro');
  }
  function eLargo(item, pai) {
    return TIPOS_LARGOS[item.Type] || (pai && COLECOES_LARGAS[pai.CollectionType]) || COLECOES_LARGAS[item.CollectionType] ||
           item.Type === 'CollectionFolder';
  }
  function guardar(k, v) { try { localStorage.setItem('jf.' + k, v); } catch (e) {} }
  function lembrar(k) { try { return localStorage.getItem('jf.' + k); } catch (e) { return null; } }
  window.jfUtil = { el: el, duracao: duracao, relogio: relogio, erro: erro, horaLocal: horaLocal };

  // --- pilha de telas -----------------------------------------------------------------------
  function topo() { return pilha[pilha.length - 1]; }
  function empilhar(tela) {
    if (pilha.length) {
      var t = topo();
      t.foco = tv.atual;
      t.div.style.display = 'none';
    }
    tela.div.className += ' tela rolavel rolavel-tela';
    raiz.appendChild(tela.div);
    pilha.push(tela);
    var primeiro = tela.focoInicial ? tela.focoInicial() : tela.div.querySelector('.focavel');
    if (primeiro) tv.focar(primeiro);
  }
  function desempilhar() {
    var tela = pilha.pop();
    if (tela.aoSair) tela.aoSair();
    raiz.removeChild(tela.div);
    var t = topo();
    t.div.style.display = '';
    if (t.aoVoltar) t.aoVoltar();
    if (t.foco && document.body.contains(t.foco)) tv.focar(t.foco);
    else { var f = t.div.querySelector('.focavel'); if (f) tv.focar(f); }
  }
  function limparPilha() {
    while (pilha.length) { var t = pilha.pop(); if (t.aoSair) t.aoSair(); raiz.removeChild(t.div); }
  }
  function trocarRaiz(tela) { limparPilha(); empilhar(tela); }

  // --- barra superior (abas) ------------------------------------------------------------------
  var ABAS = [
    { id: 'inicio', nome: 'Início', abrir: function () { return telaInicio(); } },
    { id: 'favoritos', nome: 'Favoritos', abrir: function () { return telaFavoritos(); } },
    { id: 'busca', nome: 'Busca', abrir: function () { return telaBusca(); } },
    { id: 'ajustes', nome: 'Ajustes', abrir: function () { return telaAjustes(); } }
  ];
  function barra(ativa) {
    var b = el('div', 'barra');
    var logo = el('div', 'logo');
    logo.appendChild(el('span', 'logo-marca', ''));
    logo.appendChild(el('span', null, 'Jellyfin'));
    b.appendChild(logo);
    var abas = el('div', 'abas');
    ABAS.forEach(function (a) {
      var t = el('div', 'aba focavel' + (a.id === ativa ? ' ativa' : ''), a.nome);
      t.setAttribute('data-aba', a.id);
      t.addEventListener('click', function () { if (a.id !== ativa) trocarRaiz(a.abrir()); });
      abas.appendChild(t);
    });
    b.appendChild(abas);
    var dir = el('div', 'barra-dir');
    dir.appendChild(el('span', 'usuario', jf.sessao.nome || ''));
    var hora = el('span', 'hora', horaLocal());
    dir.appendChild(hora);
    b.appendChild(dir);
    b.timer = setInterval(function () { hora.textContent = horaLocal(); }, 10000);
    return b;
  }

  // --- cards ----------------------------------------------------------------------------------
  function cartao(item, pai) {
    var largo = eLargo(item, pai), pessoa = item.Type === 'Person';
    var quadrado = !largo && TIPOS_QUADRADOS[item.Type];
    var c = el('div', 'cartao focavel' + (largo ? ' largo' : '') + (pessoa ? ' pessoa' : '') + (quadrado ? ' quadrado' : ''));
    c.setAttribute('data-id', item.Id);
    var url = largo ? jf.imagem(item, 'Thumb', 400) : jf.imagem(item, 'Primary', 260);
    var capa;
    if (url) { capa = el('img', 'capa'); capa.src = url; capa.alt = ''; capa.onerror = function () { capa.style.visibility = 'hidden'; }; }
    else capa = el('div', 'capa placa', item.Name);
    c.appendChild(capa);
    var ud = item.UserData || {};
    if (ud.PlayedPercentage > 0 && ud.PlayedPercentage < 100) {
      var prog = el('div', 'progresso'), cheio = el('div');
      cheio.style.width = ud.PlayedPercentage.toFixed(0) + '%';
      prog.appendChild(cheio); c.appendChild(prog);
    } else if (ud.Played) c.appendChild(el('div', 'selo visto', '✓'));
    else if (ud.UnplayedItemCount > 0) c.appendChild(el('div', 'selo', String(ud.UnplayedItemCount)));
    if (ud.IsFavorite) c.appendChild(el('div', 'selo fav', '♥'));
    var titulo = item.Type === 'Episode' && item.SeriesName ? item.SeriesName : item.Name;
    c.appendChild(el('div', 'titulo', titulo));
    var sub;
    if (item.Type === 'Episode')
      sub = (item.ParentIndexNumber != null ? 'T' + item.ParentIndexNumber + ':' : '') + (item.IndexNumber != null ? 'E' + item.IndexNumber + ' · ' : '') + item.Name;
    else if (pessoa) sub = item.Role || item.PersonType || '';
    else if (item.Type === 'MusicAlbum' || item.Type === 'Audio') sub = item.AlbumArtist || (item.Artists && item.Artists[0]) || item.ProductionYear || '';
    else if (item.Type === 'Genre' || item.Type === 'MusicGenre' || item.Type === 'MusicArtist') sub = '';
    else sub = item.ProductionYear || (item.ChildCount ? item.ChildCount + ' itens' : '');
    c.appendChild(el('div', 'sub', sub || ''));
    c.addEventListener('click', function () { abrir(item, pai); });
    return c;
  }

  function abrir(item, pai) {
    if (item.Type === 'Series') return empilhar(telaDetalhe(item));
    if (item.Type === 'MusicAlbum') return empilhar(telaAlbum(item));
    if (item.Type === 'Audio') return jfPlayer.tocar(item, 0, null, { fila: [item], iFila: 0 });
    if ((item.Type === 'Genre' || item.Type === 'MusicGenre' || item.Type === 'MusicArtist') && pai && !item.Biblioteca)
      item.Biblioteca = pai.Biblioteca || pai;      // which library it came from (to filter the items)
    if (item.IsFolder || TIPOS_PASTA[item.Type]) return empilhar(telaGrade(item));
    empilhar(telaDetalhe(item));
  }

  function fileira(titulo, itens, pai) {
    var bloco = el('div', 'bloco-fileira');
    bloco.appendChild(el('h2', null, titulo));
    var f = el('div', 'fileira rolavel');
    for (var i = 0; i < itens.length; i++) f.appendChild(cartao(itens[i], pai));
    bloco.appendChild(f);
    return bloco;
  }

  // Replaces the content of a "slot" with a new row, keeping focus and scroll if focus was in it.
  function preencher(tela, onde, titulo, itens, pai) {
    var focoAqui = tv.atual && onde.contains(tv.atual), idFoco = focoAqui && tv.atual.getAttribute('data-id');
    var rolagem = onde.querySelector('.fileira'), x = rolagem ? rolagem.scrollLeft : 0;
    onde.innerHTML = '';
    if (itens && itens.length) {
      onde.appendChild(fileira(titulo, itens, pai));
      onde.querySelector('.fileira').scrollLeft = x;
    }
    if (topo() !== tela) return;
    if (focoAqui) {
      var alvo = (idFoco && onde.querySelector('.cartao[data-id="' + idFoco + '"]')) || onde.querySelector('.focavel');
      if (alvo) return tv.focar(alvo);
    }
    if (tela.focoNosCartoes && (!tv.atual || !document.body.contains(tv.atual) || tv.atual.offsetWidth === 0 ||
                                tv.atual.className.indexOf('aba') >= 0)) {
      var f = tela.div.querySelector('.cartao.focavel'); if (f) tv.focar(f);
    }
  }

  // --- text input (on-screen keyboard) ---------------------------------------------------------
  // telaEntrada({titulo, dica, valor, senha, aoConfirmar(texto, tela)}) — tela.estado(msg) shows a message.
  function telaEntrada(o) {
    var div = el('div', 'tela-entrada');
    div.appendChild(el('h1', null, o.titulo));
    if (o.dica) div.appendChild(el('p', 'dica', o.dica));
    var campo = el('div', 'busca-campo', '');
    div.appendChild(campo);
    var estado = el('p', 'estado', '');
    div.appendChild(estado);
    var teclado = el('div', 'teclado grande');
    div.appendChild(teclado);
    var texto = o.valor || '', maiusc = false, mostrar = !o.senha, letras = [];
    function pinta() {
      campo.textContent = mostrar ? texto : texto.replace(/./g, '•');
      campo.className = 'busca-campo' + (texto ? '' : ' vazio');
    }
    var fila = null;
    function novaFila() { fila = el('div', 'fila-teclas'); teclado.appendChild(fila); }
    function tecla(rotulo, fn, classe) {
      var t = el('div', 'tecla focavel' + (classe ? ' ' + classe : ''), rotulo);
      t.addEventListener('click', function () { fn(t); pinta(); });
      fila.appendChild(t);
      return t;
    }
    // QWERTY in a rectangle: 5 rows of 11 keys (symbols fill the rows) + an actions row.
    var FILEIRAS = ['1234567890-', 'qwertyuiop@', 'asdfghjkl._', 'zxcvbnm:/?!', "#$%&*+=,;~'"];
    FILEIRAS.forEach(function (f) {
      novaFila();
      f.split('').forEach(function (ch) {
        if (!/[a-z]/.test(ch)) return tecla(ch, function () { texto += ch; });
        var t = tecla(ch, function () { texto += maiusc ? ch.toUpperCase() : ch; });
        letras.push([t, ch]);
      });
    });
    novaFila();
    tecla('maiúsculas', function (t) {
      maiusc = !maiusc;
      t.className = 'tecla focavel acao' + (maiusc ? ' ligada' : '') + ' foco';
      letras.forEach(function (l) { l[0].textContent = maiusc ? l[1].toUpperCase() : l[1]; });
    }, 'acao');
    tecla('espaço', function () { texto += ' '; }, 'acao');
    tecla('← apagar', function () { texto = texto.slice(0, -1); }, 'acao');
    tecla('limpar', function () { texto = ''; }, 'acao');
    if (o.senha) tecla('mostrar', function () { mostrar = !mostrar; }, 'acao');
    var ok = tecla('OK  ✓', function () { o.aoConfirmar(texto, tela); }, 'acao confirma');
    pinta();
    var tela = { div: div };
    tela.estado = function (msg, ruim) { estado.textContent = msg || ''; estado.className = 'estado' + (ruim ? ' ruim' : ''); };
    tela.aoNumero = function (n) { texto += n; pinta(); return true; };
    tela.aoPlay = function () { o.aoConfirmar(texto, tela); };        // Play also confirms
    tela.focoInicial = function () { return texto ? ok : teclado.querySelector('.focavel'); };
    return tela;
  }

  // --- servidores ----------------------------------------------------------------------------------
  function recarregar() { tv.aviso('Recarregando…'); setTimeout(function () { location.reload(); }, 300); }

  function telaServidores() {
    var div = el('div', 'tela-lista');
    div.appendChild(el('h1', null, 'Servidores'));
    div.appendChild(el('p', 'dica', 'OK usa o servidor · Vermelho 2× remove o servidor em foco · Voltar fecha'));
    var lista = el('div', 'lista');
    div.appendChild(lista);
    var tela = { div: div }, vermelhoEm = 0, vermelhoEl = null;
    function montar() {
      lista.innerHTML = '';
      jf.servidores.forEach(function (sv, k) {
        var linha = el('div', 'linha focavel');
        linha.setAttribute('data-servidor', k);
        linha.appendChild(el('div', 'linha-titulo', (sv.nome || sv.url) + (k === jf.indiceAtual() && jf.servidor ? '   ● em uso' : '')));
        linha.appendChild(el('div', 'linha-sub', sv.url + (sv.usuario ? '   ·   ' + sv.usuario : '   ·   sem login') + (sv.versao ? '   ·   v' + sv.versao : '')));
        linha.addEventListener('click', function () {
          if (k === jf.indiceAtual() && jf.servidor && pilha.length > 1) return desempilhar();
          jf.usarServidor(k); tv.log('servidor: ' + sv.url); recarregar();
        });
        lista.appendChild(linha);
      });
      var cel = el('div', 'linha focavel');
      cel.setAttribute('data-servidor', 'novo');
      cel.appendChild(el('div', 'linha-titulo', 'Gerenciar pelo celular (QR Code)'));
      cel.appendChild(el('div', 'linha-sub', 'Adicionar, trocar e remover servidores digitando no celular ou no PC'));
      cel.addEventListener('click', function () { empilhar(telaPareamento()); });
      lista.appendChild(cel);
      var mais = el('div', 'linha focavel');
      mais.setAttribute('data-servidor', 'novo');
      mais.appendChild(el('div', 'linha-titulo', '+  Adicionar servidor (teclado da TV)'));
      mais.appendChild(el('div', 'linha-sub', 'Endereço ou IP do Jellyfin (ex.: 192.168.0.10 ou https://jf.exemplo.com)'));
      mais.addEventListener('click', function () { empilhar(telaNovoServidor()); });
      lista.appendChild(mais);
      if (topo() === tela) tv.focar(lista.querySelector('.focavel'));
    }
    montar();
    tela.aoVoltar = montar;
    tela.aoVermelho = function () {
      var f = tv.atual, k = f && f.getAttribute('data-servidor');
      if (k == null || k === 'novo') return;
      if (vermelhoEl === f && Date.now() - vermelhoEm < 3000) {
        var era = +k === jf.indiceAtual();
        tv.log('servidor removido: ' + jf.servidores[+k].url);
        jf.removerServidor(+k);
        if (era) return recarregar();
        return montar();
      }
      vermelhoEl = f; vermelhoEm = Date.now();
      tv.aviso('Aperte vermelho de novo para remover este servidor');
    };
    return tela;
  }

  function telaNovoServidor() {
    return telaEntrada({
      titulo: 'Adicionar servidor',
      dica: 'Digite o endereço do Jellyfin. Só o IP basta (a porta 8096 é tentada sozinha).',
      valor: jf.servidores.length ? '' : jf.servidorPadrao.replace(/^https?:\/\//, ''),
      aoConfirmar: function (texto, tela) {
        tela.estado('Procurando o Jellyfin em "' + texto + '"…');
        jf.acharServidor(texto).then(function (r) {
          tv.log('servidor adicionado: ' + r.url + ' (' + r.info.ServerName + ' ' + r.info.Version + ')');
          jf.adicionarServidor(r.url, r.info);
          recarregar();
        }, function (e) { tela.estado(e.message, true); });
      }
    });
  }

  // --- login: server users, password via the keyboard, or Quick Connect -------------------------
  function telaLogin() {
    var div = el('div', 'tela-lista');
    div.appendChild(el('h1', null, 'Quem está assistindo?'));
    div.appendChild(el('p', 'dica', (jf.atual && jf.atual.nome ? jf.atual.nome + '   ·   ' : '') + jf.servidor));
    var usuarios = el('div', 'fileira rolavel usuarios');
    div.appendChild(usuarios);
    var lista = el('div', 'lista');
    div.appendChild(lista);
    var tela = { div: div };
    function entrar(nome, senha, telaSenha) {
      jf.entrarComSenha(nome, senha).then(function (r) {
        tv.log('login ok (senha): ' + r.User.Name);
        trocarRaiz(telaInicio());
      }, function (e) {
        var msg = e.status === 401 ? 'Usuário ou senha incorretos' : e.message;
        if (telaSenha) telaSenha.estado(msg, true); else tv.aviso(msg, 5000, 'erro');
      });
    }
    function pedirSenha(nome) {
      empilhar(telaEntrada({ titulo: 'Senha de ' + nome, senha: true, dica: 'Play ou "OK ✓" confirma. Sem senha? Confirme vazio.',
                             aoConfirmar: function (senha, t) { t.estado('Entrando…'); entrar(nome, senha, t); } }));
    }
    function linha(titulo, sub, fn) {
      var l = el('div', 'linha focavel');
      l.appendChild(el('div', 'linha-titulo', titulo));
      l.appendChild(el('div', 'linha-sub', sub));
      l.addEventListener('click', fn);
      lista.appendChild(l);
      return l;
    }
    linha('Entrar com usuário e senha', 'Digite o nome do usuário no teclado da tela', function () {
      empilhar(telaEntrada({ titulo: 'Nome do usuário', aoConfirmar: function (nome, t) {
        if (!nome) return t.estado('Digite o nome', true);
        desempilhar(); pedirSenha(nome);
      } }));
    });
    var lQc = linha('Quick Connect', 'Mostra um código para aprovar no celular ou no PC, sem digitar senha', function () { empilhar(telaQuickConnect()); });
    linha('Servidores', 'Trocar, adicionar ou remover servidores', function () { empilhar(telaServidores()); });
    jf.api('GET', '/Users/Public').then(function (us) {
      (us || []).forEach(function (u) {
        var c = cartao({ Id: u.Id, Name: u.Name, Type: 'Person', ImageTags: u.PrimaryImageTag ? { Primary: u.PrimaryImageTag } : null });
        var copia = c.cloneNode(true);               // without the "open person" click
        copia.addEventListener('click', function () { if (u.HasPassword) pedirSenha(u.Name); else entrar(u.Name, ''); });
        usuarios.appendChild(copia);
      });
      if (us && us.length && topo() === tela) tv.focar(usuarios.querySelector('.focavel'));
    }, function () {});
    jf.api('GET', '/QuickConnect/Enabled').then(function (on) { if (on === false) lQc.style.display = 'none'; }, function () {});
    return tela;
  }

  function telaQuickConnect() {
    var div = el('div', 'tela-login');
    div.appendChild(el('h1', null, 'Quick Connect'));
    var codigo = el('div', 'codigo', '······');
    div.appendChild(codigo);
    div.appendChild(el('p', null, 'No celular ou no PC, abra o Jellyfin já logado → Configurações (ícone do usuário) → ' +
                                  'Quick Connect, e digite o código acima.'));
    var estado = el('p', 'estado', 'Pedindo um código ao servidor ' + jf.servidor + '…');
    div.appendChild(estado);
    var qc = jf.quickConnect(function (c) {
      codigo.textContent = c;
      estado.textContent = 'Aguardando aprovação… (servidor ' + jf.servidor + ')';
      tv.log('quick connect: código gerado');
    });
    qc.then(function (r) {
      tv.log('login ok: ' + r.User.Name);
      trocarRaiz(telaInicio());
    }, function (e) {
      estado.textContent = 'Falhou: ' + e.message + '. Volte e tente de novo.';
      erro('quick connect', e);
    });
    return { div: div, aoSair: function () { qc.cancelar(); } };
  }

  function sairDaConta() {
    jf.api('POST', '/Sessions/Logout').then(null, function () {});     // invalida o token no servidor
    jf.sair();
    tv.log('logout');
    var l = telaLogin(); l.ehRaizFixa = true;
    trocarRaiz(l);
  }

  // --- choice list (OK on a Settings option) ------------------------------------------------------
  function telaEscolha(titulo, opcoes, atual, aoEscolher) {
    var div = el('div', 'tela-lista');
    div.appendChild(el('h1', null, titulo));
    var lista = el('div', 'lista');
    div.appendChild(lista);
    var linhas = opcoes.map(function (o, k) {
      var l = el('div', 'linha focavel' + (k === atual ? ' marcada' : ''));
      l.appendChild(el('div', 'linha-titulo', (k === atual ? '●  ' : '○  ') + o[1]));
      l.addEventListener('click', function () { desempilhar(); aoEscolher(k); });
      lista.appendChild(l);
      return l;
    });
    return { div: div, focoInicial: function () { return linhas[atual] || linhas[0]; } };
  }

  // --- phone pairing (QR code): manage servers without typing on the TV -------------------------
  function telaPareamento() {
    var div = el('div', 'tela-par');
    div.appendChild(el('h1', null, 'Gerenciar servidores pelo celular'));
    var corpo = el('div', 'par-corpo');
    var qr = el('div', 'par-qr', '…');
    corpo.appendChild(qr);
    var txt = el('div', 'par-txt');
    txt.appendChild(el('p', null, 'Aponte a câmera do celular para o código, ou abra no navegador do celular/PC (na mesma rede):'));
    var link = el('div', 'par-link', '');
    txt.appendChild(link);
    txt.appendChild(el('p', 'dica', 'Lá você adiciona (com usuário e senha, se quiser), troca e remove servidores. Esta tela aplica na hora.'));
    var estado = el('p', 'estado', 'Criando o código…');
    txt.appendChild(estado);
    var b = el('div', 'botao focavel', 'Concluir');
    b.addEventListener('click', function () { desempilhar(); });
    txt.appendChild(b);
    corpo.appendChild(txt);
    div.appendChild(corpo);
    var tela = { div: div }, codigo = null, timer = null, mudou = false, vivo = true, usoInicial = jf.indiceAtual();

    function post(caminho, dados) {
      return new Promise(function (resolve, reject) {
        var x = new XMLHttpRequest();
        x.open('POST', caminho, true);
        x.setRequestHeader('Content-Type', 'application/json');
        x.onload = function () { try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(e); } };
        x.onerror = function () { reject(new Error('sem resposta do PC')); };
        x.send(JSON.stringify(dados));
      });
    }
    function estadoAtual() {
      return { servidores: jf.servidores.map(function (sv, k) {
        return { url: sv.url, nome: sv.nome || '', usuario: sv.usuario || '', emUso: k === jf.indiceAtual() };
      }) };
    }
    function publicar(resultado) { return post('/api/par/' + codigo + '/estado', { estado: estadoAtual(), resultado: resultado || null }); }
    function indiceDe(url) { for (var k = 0; k < jf.servidores.length; k++) if (jf.servidores[k].url === url) return k; return -1; }

    function executar(c) {
      var k;
      if (c.tipo === 'adicionar') {
        estado.textContent = 'Procurando o Jellyfin em "' + c.url + '"…';
        return jf.acharServidor(c.url).then(function (r) {
          var eraAtual = jf.indiceAtual();
          k = jf.adicionarServidor(r.url, r.info);
          mudou = true;
          var nome = r.info.ServerName || r.url;
          if (!c.usuario) { if (!c.usar && jf.servidores.length > 1) jf.usarServidor(eraAtual); return { ok: true, msg: 'Adicionado: ' + nome }; }
          return jf.entrarEm(k, c.usuario, c.senha).then(function () {
            if (!c.usar && jf.servidores.length > 1) jf.usarServidor(eraAtual);
            return { ok: true, msg: 'Adicionado e logado como ' + c.usuario + ': ' + nome };
          }, function (e) {
            if (!c.usar && jf.servidores.length > 1) jf.usarServidor(eraAtual);
            return { ok: false, msg: 'Servidor adicionado, mas o login falhou: ' + e.message };
          });
        }, function (e) { return { ok: false, msg: e.message }; });
      }
      k = indiceDe(c.url);
      if (k < 0) return Promise.resolve({ ok: false, msg: 'servidor não está na lista' });
      if (c.tipo === 'usar') { jf.usarServidor(k); mudou = true; return Promise.resolve({ ok: true, msg: 'Em uso: ' + (jf.servidores[k].nome || c.url) }); }
      if (c.tipo === 'remover') { jf.removerServidor(k); mudou = true; return Promise.resolve({ ok: true, msg: 'Removido: ' + c.url }); }
      if (c.tipo === 'entrar') return jf.entrarEm(k, c.usuario, c.senha).then(function () { mudou = true; return { ok: true, msg: 'Logado como ' + c.usuario }; },
                                                                              function (e) { return { ok: false, msg: e.message }; });
      return Promise.resolve({ ok: false, msg: 'comando desconhecido' });
    }
    function buscar() {
      if (!vivo) return;
      tv.json('/api/par/' + codigo + '/comandos', function (e, d) {
        if (!vivo) return;
        if (e) { estado.textContent = 'Sem resposta do PC (' + e.message + ')'; timer = setTimeout(buscar, 4000); return; }
        var fila = d.comandos || [], p = Promise.resolve();
        fila.forEach(function (c) {
          p = p.then(function () { return executar(c); }).then(function (r) {
            tv.log('celular: ' + c.tipo + ' → ' + r.msg);
            estado.textContent = r.msg;
            estado.className = 'estado' + (r.ok ? '' : ' ruim');
            return publicar(r);
          });
        });
        p.then(null, function () {}).then(function () { timer = setTimeout(buscar, 2000); });
      });
    }
    post('/api/par/novo', estadoAtual()).then(function (r) {
      codigo = r.codigo;
      // the portal builds the URL on the phone port (80/443 only accept the TV in the firewall)
      var url = r.url || (location.protocol + '//' + location.host + '/jellyfin/celular.html?c=' + codigo);
      link.textContent = url;
      try {
        var q = qrcode(0, 'M'); q.addData(url); q.make();
        qr.innerHTML = q.createImgTag(6, 12);
      } catch (x) { qr.textContent = 'QR indisponível'; }
      estado.textContent = 'Aguardando o celular… (código ' + codigo + ', vale 20 min)';
      buscar();
    }, function (e) { estado.textContent = 'Não consegui criar o código: ' + e.message + ' (o portal do PC precisa estar atualizado)'; estado.className = 'estado ruim'; });
    tela.aoSair = function () {
      vivo = false; clearTimeout(timer);
      if (mudou) recarregar();                       // apply the server in use / removals
    };
    tela.focoInicial = function () { return b; };
    return tela;
  }

  // --- ajustes -----------------------------------------------------------------------------------
  var QUALIDADES = [[0, 'Automática (direto quando dá)'], [20e6, '1080p · 20 Mb/s'], [10e6, '1080p · 10 Mb/s'],
                    [6e6, '720p · 6 Mb/s'], [3e6, '720p · 3 Mb/s'], [1.5e6, '480p · 1,5 Mb/s']];
  var IDIOMAS = [['', 'Padrão do arquivo'], ['por', 'Português'], ['eng', 'Inglês'], ['spa', 'Espanhol'], ['jpn', 'Japonês'],
                 ['fra', 'Francês'], ['deu', 'Alemão'], ['ita', 'Italiano'], ['kor', 'Coreano']];
  var MODOS_LEGENDA = [['Default', 'Padrão (segue as marcações do arquivo)'], ['Smart', 'Inteligente (só se o áudio for estrangeiro)'],
                       ['OnlyForced', 'Só as forçadas'], ['Always', 'Sempre'], ['None', 'Nunca']];
  function telaAjustes() {
    var div = el('div', 'tela-inicio');
    var b = barra('ajustes');
    div.appendChild(b);
    var lista = el('div', 'lista ajustes');
    div.appendChild(lista);
    var tela = { div: div }, conf = null, uid = jf.sessao.userId;
    function titulo(t) { lista.appendChild(el('h2', null, t)); }
    function linha(nome, valor, fn) {
      var l = el('div', 'linha focavel');
      l.appendChild(el('div', 'linha-titulo', nome));
      var v = el('div', 'linha-valor', valor());
      l.appendChild(v);
      l.addEventListener('click', function () { fn(); v.textContent = valor(); });
      lista.appendChild(l);
      return l;
    }
    // Multiple-choice option: ←/→ moves to the previous/next; OK opens the full list.
    function ciclo(nome, opcoes, ler, gravar) {
      function i() { var a = ler(); for (var k = 0; k < opcoes.length; k++) if (String(opcoes[k][0]) === String(a)) return k; return 0; }
      function texto() { return '‹  ' + opcoes[i()][1] + '  ›'; }
      var l = linha(nome, texto, function () {
        empilhar(telaEscolha(nome, opcoes, i(), function (k) { gravar(opcoes[k][0]); l.querySelector('.linha-valor').textContent = texto(); }));
      });
      l.aoSeta = function (dir) {
        var n = opcoes.length;
        gravar(opcoes[(i() + (dir === 'direita' ? 1 : n - 1)) % n][0]);
        l.querySelector('.linha-valor').textContent = texto();
        return true;
      };
      return l;
    }
    function local(chave, pad) { return function () { var x = lembrar(chave); return x == null ? pad : x; }; }
    function salvaLocal(chave) { return function (v) { guardar(chave, String(v)); }; }
    var SIMNAO = [['1', 'Sim'], ['0', 'Não']];
    function doServidor(campo) { return function () { return conf[campo] == null ? '' : conf[campo]; }; }
    function noServidor(campo) {
      return function (v) {
        conf[campo] = v;
        jf.api('POST', '/Users/Configuration', { userId: uid }, conf).then(function () { tv.log('ajuste ' + campo + ' = ' + v); },
                                                                           function (e) { erro('salvar ajuste', e); });
      };
    }
    function montar() {
      lista.innerHTML = '';
      titulo('Reprodução');
      ciclo('Qualidade padrão', QUALIDADES, local('qualidade', '0'), salvaLocal('qualidade'));
      ciclo('Tocar o próximo episódio sozinho', SIMNAO, local('autoprox', '1'), salvaLocal('autoprox'));
      ciclo('Pular aberturas sozinho', SIMNAO, local('autopular', '0'), salvaLocal('autopular'));
      if (conf) {
        titulo('Idiomas (guardado no servidor, vale para todos os aparelhos)');
        ciclo('Idioma de áudio preferido', IDIOMAS, doServidor('AudioLanguagePreference'), noServidor('AudioLanguagePreference'));
        ciclo('Idioma de legenda preferido', IDIOMAS, doServidor('SubtitleLanguagePreference'), noServidor('SubtitleLanguagePreference'));
        ciclo('Mostrar legendas', MODOS_LEGENDA, doServidor('SubtitleMode'), noServidor('SubtitleMode'));
      }
      titulo('Conta e servidor');
      linha('Usuário', function () { return (jf.sessao.nome || '?') + '   ·   OK para sair / trocar'; }, sairDaConta);
      linha('Servidor', function () { return (jf.atual && jf.atual.nome ? jf.atual.nome + '   ·   ' : '') + jf.servidor + '   ·   OK para gerenciar'; },
            function () { empilhar(telaServidores()); });
      titulo('Diagnóstico');
      linha('Testar a rede (PC → TV)', function () { return 'baixa 2 × 20 MB e mede'; }, testarRede);
      linha('Recarregar o app', function () { return 'cliente OpenRange ' + jf.VERSAO + (jf.atual && jf.atual.versao ? '   ·   servidor ' + jf.atual.versao : ''); },
            function () { location.reload(); });
    }
    montar();
    jf.api('GET', '/Users/Me').then(function (u) {
      conf = u.Configuration || null;
      var foco = tv.atual && lista.contains(tv.atual) ? Array.prototype.indexOf.call(lista.querySelectorAll('.focavel'), tv.atual) : -1;
      montar();
      if (foco >= 0 && topo() === tela) tv.focar(lista.querySelectorAll('.focavel')[foco]);
    }, function () {});
    tela.aoSair = function () { clearInterval(b.timer); };
    tela.focoInicial = function () { return div.querySelector('.aba.ativa'); };
    return tela;
  }

  // --- home ------------------------------------------------------------------------------------
  function telaInicio() {
    var div = el('div', 'tela-inicio');
    var b = barra('inicio');
    div.appendChild(b);
    var corpo = el('div', 'corpo');
    div.appendChild(corpo);
    div.appendChild(el('div', 'dica', 'Amarelo testa a rede · Vermelho recarrega · Azul 2× troca de usuário'));
    var tela = { div: div, ehInicio: true, focoNosCartoes: true };
    var lugares = {};
    function lugar(chave) {
      if (!lugares[chave]) { lugares[chave] = el('div'); corpo.appendChild(lugares[chave]); }
      return lugares[chave];
    }
    var uid = jf.sessao.userId;
    function carregar() {
      var lViews = lugar('views'), lResume = lugar('resume'), lNextUp = lugar('nextup');
      jf.api('GET', '/UserViews', { userId: uid }).then(function (r) {
        var views = (r.Items || []).filter(function (v) { return v.CollectionType !== 'livetv'; });
        preencher(tela, lViews, 'Minha mídia', views);
        views.forEach(function (v) {
          var l = lugar('latest-' + v.Id);
          jf.api('GET', '/Items/Latest', { userId: uid, parentId: v.Id, limit: 16, fields: CAMPOS, enableImageTypes: IMAGENS })
            .then(function (itens) { preencher(tela, l, 'Recentemente adicionado em ' + v.Name, itens, v); },
                  function (e) { erro('recentes ' + v.Name, e); });
        });
      }, function (e) { erro('bibliotecas', e); });
      jf.api('GET', '/UserItems/Resume', { userId: uid, limit: 16, fields: CAMPOS, mediaTypes: 'Video', enableImageTypes: IMAGENS })
        .then(function (r) { preencher(tela, lResume, 'Continuar assistindo', r.Items); }, function (e) { erro('continuar', e); });
      jf.api('GET', '/Shows/NextUp', { userId: uid, limit: 16, fields: CAMPOS, enableImageTypes: IMAGENS })
        .then(function (r) { preencher(tela, lNextUp, 'A seguir', r.Items); }, function (e) { erro('a seguir', e); });
    }
    carregar();
    tela.aoSair = function () { clearInterval(b.timer); };
    tela.aoVoltar = carregar;                      // "Continue watching" and ✓ change after watching
    tela.aoAmarelo = testarRede;
    return tela;
  }

  // --- favoritos --------------------------------------------------------------------------------
  function telaFavoritos() {
    var div = el('div', 'tela-inicio');
    var b = barra('favoritos');
    div.appendChild(b);
    var corpo = el('div', 'corpo');
    div.appendChild(corpo);
    var tela = { div: div };
    var grupos = [['Filmes', 'Movie'], ['Séries', 'Series'], ['Episódios', 'Episode'], ['Vídeos', 'Video,MusicVideo'],
                  ['Coleções', 'BoxSet'], ['Pessoas', 'Person']];
    var vazio = el('p', 'vazio', 'Nenhum favorito ainda. Abra um título e escolha ♡ Favoritar.');
    var lugares = grupos.map(function () { var d = el('div'); corpo.appendChild(d); return d; });
    function carregar() {
      var achou = 0, faltam = grupos.length;
      grupos.forEach(function (g, i) {
        var p = g[1] === 'Person'
          ? jf.api('GET', '/Persons', { userId: jf.sessao.userId, isFavorite: true, limit: 30 })
          : jf.api('GET', '/Items', { userId: jf.sessao.userId, recursive: true, filters: 'IsFavorite', includeItemTypes: g[1],
                                      sortBy: 'SortName', limit: 40, fields: CAMPOS, enableImageTypes: IMAGENS });
        p.then(function (r) {
          achou += (r.Items || []).length;
          preencher(tela, lugares[i], g[0], r.Items);
        }, function (e) { erro('favoritos', e); }).then(function () {
          if (--faltam) return;
          if (!achou) corpo.appendChild(vazio); else if (vazio.parentNode) corpo.removeChild(vazio);
        });
      });
    }
    carregar();
    tela.aoSair = function () { clearInterval(b.timer); };
    tela.aoVoltar = carregar;
    tela.focoInicial = function () { return div.querySelector('.aba.ativa'); };
    return tela;
  }

  // --- search (on-screen keyboard) --------------------------------------------------------------
  function telaBusca() {
    var div = el('div', 'tela-busca');
    var b = barra('busca');
    div.appendChild(b);
    var area = el('div', 'busca-area');
    var esq = el('div', 'busca-esq');
    var campo = el('div', 'busca-campo', '');
    esq.appendChild(campo);
    var teclado = el('div', 'teclado');
    var termo = lembrar('busca') || '', timer = null, pedido = 0;
    var filaT = null;
    function tecla(rotulo, id, fn, classe) {
      var t = el('div', 'tecla focavel' + (classe ? ' ' + classe : ''), rotulo);
      t.setAttribute('data-tecla', id);
      t.addEventListener('click', function () { fn(); mudou(); });
      filaT.appendChild(t);
    }
    ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL-', "ZXCVBNM.'&"].forEach(function (f) {   // QWERTY em retângulo 10×4
      filaT = el('div', 'fila-teclas'); teclado.appendChild(filaT);
      f.split('').forEach(function (ch) { tecla(ch, ch, function () { termo += ch; }); });
    });
    filaT = el('div', 'fila-teclas'); teclado.appendChild(filaT);
    tecla('espaço', 'espaco', function () { if (termo && termo.slice(-1) !== ' ') termo += ' '; }, 'acao');
    tecla('← apagar', 'apagar', function () { termo = termo.slice(0, -1); }, 'acao');
    tecla('limpar', 'limpar', function () { termo = ''; }, 'acao');
    esq.appendChild(teclado);
    esq.appendChild(el('div', 'dica', 'Os números do controle também digitam.'));
    area.appendChild(esq);
    var dir = el('div', 'busca-dir');
    var resumo = el('div', 'contagem', 'Digite para buscar');
    dir.appendChild(resumo);
    var grade = el('div', 'grade');
    dir.appendChild(grade);
    area.appendChild(dir);
    div.appendChild(area);

    function mudou() {
      campo.textContent = termo;
      campo.className = 'busca-campo' + (termo ? '' : ' vazio');
      guardar('busca', termo);
      clearTimeout(timer);
      timer = setTimeout(buscar, 500);
    }
    function buscar() {
      var t = termo.replace(/\s+$/, ''), meu = ++pedido;
      grade.innerHTML = '';
      if (t.length < 2) { resumo.textContent = t ? 'Continue digitando…' : 'Digite para buscar'; return; }
      resumo.textContent = 'Buscando "' + t + '"…';
      var uid = jf.sessao.userId;
      Promise.all([
        jf.api('GET', '/Items', { userId: uid, searchTerm: t, recursive: true, includeItemTypes: TIPOS_BUSCA, limit: 30,
                                  fields: CAMPOS, enableImageTypes: IMAGENS }),
        jf.api('GET', '/Persons', { userId: uid, searchTerm: t, limit: 10 }).then(null, function () { return { Items: [] }; })
      ]).then(function (rs) {
        if (meu !== pedido) return;                 // an answer to an old search arrived
        var itens = (rs[0].Items || []).concat(rs[1].Items || []);
        resumo.textContent = itens.length ? itens.length + ' resultado' + (itens.length > 1 ? 's' : '') + ' para "' + t + '"'
                                          : 'Nada encontrado para "' + t + '"';
        itens.forEach(function (it) { grade.appendChild(cartao(it)); });
        tv.log('busca "' + t + '": ' + itens.length);
      }, function (e) { if (meu === pedido) erro('busca', e); });
    }
    mudou();
    var tela = { div: div };
    tela.aoSair = function () { clearInterval(b.timer); clearTimeout(timer); };
    tela.aoNumero = function (n) { termo += n; mudou(); return true; };
    tela.focoInicial = function () { return teclado.querySelector('.focavel'); };
    return tela;
  }

  // --- grid (library, folder, season, collection, person) --------------------------------------
  function telaGrade(pai) {
    var div = el('div', 'tela-grade');
    var titulo = pai.Type === 'Season' && pai.SeriesName ? pai.SeriesName + ' · ' + pai.Name : pai.Name;
    div.appendChild(el('h1', null, titulo));
    var contagem = el('div', 'contagem', 'carregando…');
    div.appendChild(contagem);
    var grade = el('div', 'grade');
    div.appendChild(grade);
    var fixa = pai.Type === 'Season' || pai.Type === 'Person' || pai.Type === 'Playlist';   // no sorting/filtering
    var visoes = VISOES[pai.CollectionType] || null, iVisao = 0;
    var chave = 'grade.' + pai.Id;
    var salvo = (lembrar(chave) || '0,0').split(',');
    var iOrdem = fixa ? 0 : Math.min(+salvo[0] || 0, ORDENS.length - 1), iFiltro = fixa ? 0 : Math.min(+salvo[1] || 0, FILTROS.length - 1);
    var carregados = 0, total = null, carregando = false, geracao = 0;
    var tela = { div: div };

    function consulta(inicio) {
      var uid = jf.sessao.userId, ct = pai.CollectionType;
      if (pai.Type === 'Season')
        return jf.api('GET', '/Shows/' + pai.SeriesId + '/Episodes', { userId: uid, seasonId: pai.Id, fields: CAMPOS });
      if (pai.Type === 'Playlist')
        return jf.api('GET', '/Playlists/' + pai.Id + '/Items', { userId: uid, startIndex: inicio, limit: PAGINA, fields: CAMPOS });
      var visao = visoes && visoes[iVisao];
      if (visao === 'Gêneros')
        return jf.api('GET', '/Genres', { userId: uid, parentId: pai.Id, startIndex: inicio, limit: PAGINA, sortBy: 'SortName',
                                          enableImageTypes: IMAGENS });
      if (visao === 'Artistas')
        return jf.api('GET', '/Artists/AlbumArtists', { userId: uid, parentId: pai.Id, startIndex: inicio, limit: PAGINA,
                                                        enableImageTypes: IMAGENS });
      var q = { userId: uid, startIndex: inicio, limit: PAGINA, fields: CAMPOS, enableImageTypes: IMAGENS, imageTypeLimit: 1,
                sortBy: ORDENS[iOrdem].sortBy, sortOrder: ORDENS[iOrdem].sortOrder, filters: FILTROS[iFiltro].filters };
      if (pai.Type === 'Person') { q.personIds = pai.Id; q.recursive = true; q.includeItemTypes = 'Movie,Series,Episode,MusicVideo,Video'; }
      else if (pai.Type === 'Genre' || pai.Type === 'MusicGenre') {
        q.genreIds = pai.Id; q.recursive = true;
        q.includeItemTypes = (pai.Biblioteca && TIPO_DA_COLECAO[pai.Biblioteca.CollectionType]) || 'Movie,Series';
        if (pai.Biblioteca) q.parentId = pai.Biblioteca.Id;
      }
      else if (pai.Type === 'MusicArtist') { q.albumArtistIds = pai.Id; q.recursive = true; q.includeItemTypes = 'MusicAlbum'; }
      else if (pai.Type === 'Studio') { q.studioIds = pai.Id; q.recursive = true; q.includeItemTypes = 'Movie,Series'; }
      else {
        q.parentId = pai.Id;
        var tipos = TIPO_DA_COLECAO[ct];
        if (tipos) { q.recursive = true; q.includeItemTypes = tipos; }
      }
      return jf.api('GET', '/Items', q);
    }

    function rotulo() {
      var t = total === null ? 'carregando…' : total + (total === 1 ? ' item' : ' itens');
      var emItens = !visoes || iVisao === 0;
      if (!fixa && emItens) t += '   ·   Ordem: ' + ORDENS[iOrdem].nome + ' (verde)   ·   Filtro: ' + FILTROS[iFiltro].nome + ' (amarelo)';
      if (visoes) t += '   ·   Ver: ' + visoes[iVisao] + ' (azul)';
      if (tocaveis()) t += '   ·   Play toca tudo';
      contagem.textContent = t;
    }

    // Playlist, collection and season: the Play key plays everything as a queue, in screen order.
    var itensCarregados = [];
    function tocaveis() { return pai.Type === 'Playlist' || pai.Type === 'BoxSet' || pai.Type === 'Season'; }
    function mais() {
      if (carregando || (total !== null && carregados >= total)) return;
      carregando = true;
      var minha = geracao;
      consulta(carregados).then(function (r) {
        if (minha !== geracao) return;               // a ordem/filtro mudou enquanto carregava
        carregando = false;
        var itens = r.Items || [], primeira = carregados === 0;
        itensCarregados = itensCarregados.concat(itens);
        total = pai.Type === 'Season' ? itens.length : (r.TotalRecordCount != null ? r.TotalRecordCount : itens.length);
        itens.forEach(function (it) {
          var c = cartao(it, pai);
          c.addEventListener('tv:foco', function () {  // near the end? fetch the next page
            if (carregados - Array.prototype.indexOf.call(grade.children, c) < 14) mais();
          });
          grade.appendChild(c);
        });
        carregados += itens.length;
        rotulo();
        if (!total) grade.appendChild(el('p', 'vazio', iFiltro ? 'Nada com este filtro.' : 'Nada aqui.'));
        if (primeira && topo() === tela) { var f = grade.querySelector('.focavel'); if (f) tv.focar(f); }
      }, function (e) { if (minha === geracao) { carregando = false; erro('lista', e); } });
    }
    function recomecar() {
      geracao++; carregados = 0; total = null; carregando = false; itensCarregados = [];
      grade.innerHTML = '';
      div.scrollTop = 0;
      guardar(chave, iOrdem + ',' + iFiltro);
      rotulo();
      mais();
    }
    if (visoes) tela.aoAzul = function () { iVisao = (iVisao + 1) % visoes.length; tv.aviso('Ver: ' + visoes[iVisao]); recomecar(); };
    if (tocaveis()) tela.aoPlay = function () {
      var fila = itensCarregados.filter(function (x) { return !x.IsFolder; });
      if (!fila.length) return;
      tv.log('tocar tudo: ' + pai.Name + ' (' + fila.length + ')');
      jfPlayer.tocar(fila[0], 0, null, { fila: fila, iFila: 0 });
    };
    if (!fixa) {
      tela.aoVerde = function () { if (visoes && iVisao) return; iOrdem = (iOrdem + 1) % ORDENS.length; tv.aviso('Ordem: ' + ORDENS[iOrdem].nome); recomecar(); };
      tela.aoAmarelo = function () { if (visoes && iVisao) return; iFiltro = (iFiltro + 1) % FILTROS.length; tv.aviso('Filtro: ' + FILTROS[iFiltro].nome); recomecar(); };
    }
    rotulo();
    mais();
    return tela;
  }

  // --- album (cover + track list) ------------------------------------------------------------------
  function telaAlbum(album) {
    var div = el('div', 'tela-album');
    var topoDiv = el('div', 'album-topo');
    var capaUrl = jf.imagem(album, 'Primary', 400);
    var capa = capaUrl ? el('img', 'album-capa') : el('div', 'album-capa placa', album.Name);
    if (capaUrl) capa.src = capaUrl;
    topoDiv.appendChild(capa);
    var info = el('div', 'album-info');
    info.appendChild(el('h1', null, album.Name));
    var meta = el('div', 'meta', [album.AlbumArtist, album.ProductionYear].filter(Boolean).join('   ·   '));
    info.appendChild(meta);
    var botoes = el('div', 'botoes');
    info.appendChild(botoes);
    topoDiv.appendChild(info);
    div.appendChild(topoDiv);
    var lista = el('div', 'faixas-lista');
    div.appendChild(lista);
    var tela = { div: div }, faixas = [];
    function tocar(i, embaralhar) {
      var fila = faixas.slice();
      if (embaralhar) for (var k = fila.length - 1; k > 0; k--) { var j = Math.floor(Math.random() * (k + 1)), x = fila[k]; fila[k] = fila[j]; fila[j] = x; }
      jfPlayer.tocar(fila[i], 0, null, { fila: fila, iFila: i });
    }
    function botao(texto, fn) { var b = el('div', 'botao focavel', texto); b.addEventListener('click', fn); botoes.appendChild(b); return b; }
    botao('▶  Tocar', function () { if (faixas.length) tocar(0); }).setAttribute('data-botao', 'play');
    botao('Aleatório', function () { if (faixas.length) tocar(0, true); });
    jf.api('GET', '/Items', { userId: jf.sessao.userId, parentId: album.Id, sortBy: 'ParentIndexNumber,IndexNumber,SortName',
                              fields: 'RunTimeTicks,UserData', includeItemTypes: 'Audio' }).then(function (r) {
      faixas = r.Items || [];
      var total = 0;
      faixas.forEach(function (f, i) {
        total += f.RunTimeTicks || 0;
        var linha = el('div', 'faixa focavel');
        linha.appendChild(el('span', 'num', f.IndexNumber != null ? f.IndexNumber : i + 1));
        linha.appendChild(el('span', 'nome', f.Name));
        linha.appendChild(el('span', 'dur', f.RunTimeTicks ? relogio(f.RunTimeTicks / jf.TICKS) : ''));
        linha.addEventListener('click', function () { tocar(i); });
        lista.appendChild(linha);
      });
      meta.textContent += '   ·   ' + faixas.length + ' faixas   ·   ' + duracao(total);
    }, function (e) { erro('álbum', e); });
    tela.aoPlay = function () { if (faixas.length) tocar(0); };
    return tela;
  }

  // --- details (movie, video, episode, series) --------------------------------------------------
  function telaDetalhe(itemBase) {
    var div = el('div', 'tela-detalhe');
    var fundo = el('div', 'fundo');
    div.appendChild(fundo);
    var conteudo = el('div', 'conteudo');
    div.appendChild(conteudo);
    conteudo.appendChild(el('p', 'vazio', 'carregando…'));
    var extras = el('div', 'extras');
    div.appendChild(extras);
    var tela = { div: div };
    var escolha = { audio: null, legenda: null };   // null = server default
    var uid = jf.sessao.userId;

    function montar(item, proximoEp) {
      var focoAntes = tv.atual && conteudo.contains(tv.atual) ? tv.atual.getAttribute('data-botao') : null;
      conteudo.innerHTML = '';
      var bd = jf.imagem(item, 'Backdrop', 1280);
      if (bd) fundo.style.backgroundImage = 'url("' + bd + '")';
      var lado = el('div', 'lado');
      var capaUrl = jf.imagem(item, 'Primary', 300);
      if (capaUrl) { var img = el('img', 'poster'); img.src = capaUrl; lado.appendChild(img); }
      conteudo.appendChild(lado);
      var info = el('div', 'info');
      if (item.Type === 'Episode' && item.SeriesName) info.appendChild(el('div', 'serie', item.SeriesName +
        (item.ParentIndexNumber != null ? ' · T' + item.ParentIndexNumber : '') + (item.IndexNumber != null ? ':E' + item.IndexNumber : '')));
      info.appendChild(el('h1', null, item.Name));
      if (item.OriginalTitle && item.OriginalTitle !== item.Name) info.appendChild(el('div', 'original', item.OriginalTitle));

      var alvo = item.Type === 'Series' ? proximoEp : item;     // what the watch button plays
      var ms = alvo && alvo.MediaSources && alvo.MediaSources[0];
      var streams = (ms && ms.MediaStreams) || (alvo && alvo.MediaStreams) || [];
      var vid = streams.filter(function (s) { return s.Type === 'Video'; })[0];
      var audios = streams.filter(function (s) { return s.Type === 'Audio'; });
      var legs = streams.filter(function (s) { return s.Type === 'Subtitle'; });
      var pos = alvo && alvo.UserData && alvo.UserData.PlaybackPositionTicks || 0;

      var meta = [];
      if (item.Type === 'Series') {
        if (item.ProductionYear) meta.push(item.ProductionYear + (item.Status === 'Continuing' ? ' – presente' :
          (item.EndDate ? ' – ' + item.EndDate.slice(0, 4) : '')));
        if (item.ChildCount) meta.push(item.ChildCount + (item.ChildCount === 1 ? ' temporada' : ' temporadas'));
      } else if (item.ProductionYear) meta.push(item.ProductionYear);
      if (item.RunTimeTicks && item.Type !== 'Series') meta.push(duracao(item.RunTimeTicks));
      if (item.OfficialRating) meta.push(item.OfficialRating);
      if (item.CommunityRating) meta.push('★ ' + item.CommunityRating.toFixed(1));
      if (item.CriticRating) meta.push('Crítica ' + item.CriticRating + '%');
      if (vid && item.Type !== 'Series') meta.push((vid.Height >= 2000 ? '4K' : vid.Height >= 1000 ? '1080p' : vid.Height >= 700 ? '720p' : 'SD') +
        ' ' + (vid.Codec || '').toUpperCase() + (vid.VideoRangeType && vid.VideoRangeType !== 'SDR' ? ' ' + vid.VideoRangeType : ''));
      if (item.RunTimeTicks && item.Type !== 'Series')
        meta.push('Termina às ' + horaLocal(Date.now() + (item.RunTimeTicks - pos) / 10000));
      info.appendChild(el('div', 'meta', meta.join('   ·   ')));
      if (item.Genres && item.Genres.length) info.appendChild(el('div', 'generos', item.Genres.slice(0, 5).join(', ')));
      if (item.Taglines && item.Taglines[0]) info.appendChild(el('div', 'tagline', item.Taglines[0]));
      if (item.Overview) info.appendChild(el('p', 'sinopse', item.Overview));

      var botoes = el('div', 'botoes');
      function botao(id, texto, fn) {
        var b = el('div', 'botao focavel', texto);
        b.setAttribute('data-botao', id);
        b.addEventListener('click', function () { fn(b); });
        botoes.appendChild(b);
        return b;
      }
      function tocar(oque, ticks) {
        var padrao = ms && ms.DefaultAudioStreamIndex;
        jfPlayer.tocar(oque, ticks, carregar, { audio: escolha.audio, legenda: escolha.legenda,
                                               semDireto: escolha.audio != null && escolha.audio !== padrao });
      }
      if (alvo && item.Type === 'Series') {
        var rot = 'T' + alvo.ParentIndexNumber + ':E' + alvo.IndexNumber;
        botao('play', (pos > 0 ? '▶  Continuar ' : '▶  Assistir ') + rot + (pos > 0 ? ' de ' + relogio(pos / jf.TICKS) : ''),
              function () { tocar(alvo, pos); });
      } else if (item.Type !== 'Series') {
        if (pos > 0) {
          botao('play', '▶  Continuar de ' + relogio(pos / jf.TICKS), function () { tocar(item, pos); });
          botao('inicio', 'Do início', function () { tocar(item, 0); });
        } else botao('play', '▶  Assistir', function () { tocar(item, 0); });
      }
      // Track choice (like the official client): every OK moves to the next.
      function seletor(id, nome, lista, campoEscolha, padraoIdx, comDesligado) {
        if (lista.length < (comDesligado ? 1 : 2)) return;
        var opcoes = (comDesligado ? [{ Index: -1, DisplayTitle: 'Desligada' }] : []).concat(lista);
        function atual() {
          var idx = escolha[campoEscolha] != null ? escolha[campoEscolha] : padraoIdx;
          for (var i = 0; i < opcoes.length; i++) if (opcoes[i].Index === idx) return i;
          return 0;
        }
        function pinta() { var o = opcoes[atual()]; b.textContent = nome + ': ' + (o.DisplayTitle || o.Language || o.Codec || '#' + o.Index); }
        var b = botao(id, '', function () {
          escolha[campoEscolha] = opcoes[(atual() + 1) % opcoes.length].Index;
          pinta();
        });
        b.className += ' seletor';
        pinta();
      }
      if (item.Type !== 'Series') {
        seletor('audio', 'Áudio', audios, 'audio', ms ? ms.DefaultAudioStreamIndex : null, false);
        seletor('legenda', 'Legenda', legs, 'legenda', ms && ms.DefaultSubtitleStreamIndex != null ? ms.DefaultSubtitleStreamIndex : -1, true);
      }
      var ud = item.UserData || {};
      function alternar(id, texto, ligado, caminho) {
        botao(id, texto(ligado), function (b) {
          jf.api(ligado ? 'DELETE' : 'POST', caminho + item.Id, { userId: uid }).then(function () {
            ligado = !ligado;
            b.textContent = texto(ligado);
            tv.log((ligado ? '+ ' : '- ') + caminho + ' ' + item.Name);
          }, function (x) { erro('marcar', x); });
        });
      }
      alternar('visto', function (on) { return on ? '✓ Visto' : 'Marcar como visto'; }, !!ud.Played, '/UserPlayedItems/');
      alternar('fav', function (on) { return on ? '♥ Favorito' : '♡ Favoritar'; }, !!ud.IsFavorite, '/UserFavoriteItems/');
      info.appendChild(botoes);
      var ficha = [];
      var diretores = (item.People || []).filter(function (p) { return p.Type === 'Director'; }).map(function (p) { return p.Name; });
      if (diretores.length) ficha.push('Direção: ' + diretores.slice(0, 3).join(', '));
      if (item.Studios && item.Studios.length) ficha.push('Estúdio: ' + item.Studios.slice(0, 2).map(function (s) { return s.Name; }).join(', '));
      if (ficha.length) info.appendChild(el('div', 'faixas', ficha.join('   ·   ')));
      conteudo.appendChild(info);
      if (topo() === tela && (!tv.atual || !extras.contains(tv.atual)))
        tv.focar((focoAntes && botoes.querySelector('[data-botao="' + focoAntes + '"]')) || botoes.querySelector('.focavel'));
    }

    // Rows below: seasons, more from the season, cast, similar. Loaded once.
    function montarExtras(item) {
      extras.innerHTML = '';
      function lugar() { var d = el('div'); extras.appendChild(d); return d; }
      if (item.Type === 'Series') {
        var lT = lugar();
        jf.api('GET', '/Shows/' + item.Id + '/Seasons', { userId: uid, fields: CAMPOS })
          .then(function (r) { preencher(tela, lT, 'Temporadas', r.Items, item); }, function (e) { erro('temporadas', e); });
      }
      if (item.Type === 'Episode' && item.SeriesId && item.SeasonId) {
        var lE = lugar();
        jf.api('GET', '/Shows/' + item.SeriesId + '/Episodes', { userId: uid, seasonId: item.SeasonId, fields: CAMPOS })
          .then(function (r) {
            preencher(tela, lE, 'Mais de ' + (item.SeasonName || 'esta temporada'),
                      (r.Items || []).filter(function (x) { return x.Id !== item.Id; }), item);
          }, function () {});
      }
      var elenco = (item.People || []).filter(function (p) { return p.Type === 'Actor' || p.Type === 'GuestStar'; }).slice(0, 20)
        .map(function (p) { return { Id: p.Id, Name: p.Name, Type: 'Person', Role: p.Role, ImageTags: p.PrimaryImageTag ? { Primary: p.PrimaryImageTag } : null }; });
      if (elenco.length) { var lP = lugar(); preencher(tela, lP, 'Elenco', elenco); }
      var lS = lugar();
      jf.api('GET', '/Items/' + item.Id + '/Similar', { userId: uid, limit: 12, fields: CAMPOS })
        .then(function (r) { preencher(tela, lS, 'Mais como este', r.Items); }, function () {});
    }

    var primeiraVez = true;
    function carregar() {
      jf.api('GET', '/Items/' + itemBase.Id, { userId: uid }).then(function (item) {
        if (primeiraVez) { primeiraVez = false; montarExtras(item); }
        if (item.Type !== 'Series') return montar(item);
        // Series: the main button plays the next episode (or the first, if there's no "next up").
        return jf.api('GET', '/Shows/NextUp', { userId: uid, seriesId: item.Id, limit: 1, fields: 'MediaSources' })
          .then(function (r) {
            if (r.Items && r.Items[0]) return r.Items[0];
            return jf.api('GET', '/Shows/' + item.Id + '/Episodes', { userId: uid, limit: 1, fields: 'MediaSources' })
              .then(function (e) { return e.Items && e.Items[0]; });
          }).then(function (ep) { montar(item, ep || null); }, function () { montar(item, null); });
      }).then(null, function (e) { erro('detalhe', e); });
    }
    carregar();
    tela.aoVoltar = carregar;                      // back from the player/season: refresh "Continue from…"
    return tela;
  }

  // --- global keys (delegated to the player when it is active) -------------------------------
  var azulEm = 0;
  function daTela(nome) { var t = topo(); if (t && t[nome]) { t[nome](); return true; } return false; }
  tv.ao('voltar', function () {
    if (jfPlayer.ativo()) { jfPlayer.parar(); return true; }
    if (pilha.length > 1) { desempilhar(); return true; }
    var t = topo();                                // on a tab other than Home, Back goes Home
    if (t && !t.ehInicio && !t.ehRaizFixa && jf.sessao.token) { trocarRaiz(telaInicio()); return true; }
    return false;                                  // on Home: back to the launcher
  });
  tv.ao('vermelho', function () {
    if (jfPlayer.ativo()) { jfPlayer.modoCompativel(); return true; }
    if (daTela('aoVermelho')) return true;
    var t = topo();
    if (t && t.ehInicio) location.reload();           // reload only on the home screen (and in Settings)
    return true;
  });
  tv.ao('verde', function () {
    if (jfPlayer.ativo()) { jfPlayer.alternarInfo(); return true; }
    return daTela('aoVerde');
  });
  tv.ao('amarelo', function () {
    if (jfPlayer.ativo()) { jfPlayer.trocarLegenda(); return true; }
    return daTela('aoAmarelo');
  });
  tv.ao('azul', function () {
    if (jfPlayer.ativo()) { jfPlayer.trocarAudio(); return true; }
    if (daTela('aoAzul')) return true;
    if (!topo() || !topo().ehInicio) return true;   // switch user only on the home screen
    if (Date.now() - azulEm < 3000) sairDaConta();
    else { azulEm = Date.now(); tv.aviso('Aperte azul de novo para trocar de usuário'); }
    return true;
  });
  tv.ao('play', function () {
    if (jfPlayer.ativo()) return jfPlayer.play();
    return daTela('aoPlay');
  });
  tv.ao('numero', function (n) {
    if (jfPlayer.ativo()) return jfPlayer.numero(n);
    var t = topo();
    return t && t.aoNumero ? t.aoNumero(n) : false;
  });

  // --- network test: downloads 20 MB from the portal (PC :80) and from Jellyfin (:8096) and measures ---
  function baixar(url, bytes) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest(), t0 = Date.now();
      x.open('GET', url, true);
      x.responseType = 'arraybuffer';
      x.setRequestHeader('Range', 'bytes=0-' + (bytes - 1));
      x.timeout = 60000;
      x.onload = function () {
        var n = x.response ? x.response.byteLength : 0, ms = Date.now() - t0;
        if (x.status !== 200 && x.status !== 206) return reject(new Error('HTTP ' + x.status));
        resolve({ mb: n / 1e6, ms: ms, mbps: n * 8 / 1000 / ms });
      };
      x.onerror = function () { reject(new Error('falha de rede')); };
      x.ontimeout = function () { reject(new Error('tempo esgotado')); };
      x.send();
    });
  }
  function testarRede() {
    var BYTES = 20 * 1000 * 1000, res = [];
    tv.aviso('Testando a rede (2 × 20 MB)…', 60000);
    jf.api('GET', '/Items', { userId: jf.sessao.userId, recursive: true, includeItemTypes: 'Movie,Video,MusicVideo,Episode',
                              sortBy: 'Random', limit: 1, minWidth: 1280 })
      .then(function (r) {
        var it = r.Items && r.Items[0];
        return baixar('/midia/h264-2160p30-aac.mp4', BYTES).then(function (a) {
          res.push('portal ' + a.mbps.toFixed(0) + ' Mb/s');
          if (!it) return;
          return baixar(jf.servidor + '/Videos/' + it.Id + '/stream?Static=true&api_key=' + jf.sessao.token, BYTES).then(function (b) {
            res.push('Jellyfin ' + b.mbps.toFixed(0) + ' Mb/s (' + b.mb.toFixed(0) + ' MB de "' + it.Name + '")');
          });
        });
      })
      .then(function () {
        var msg = 'Rede PC → TV: ' + res.join(' · ');
        tv.log(msg); tv.aviso(msg, 10000);
      }, function (x) { erro('teste de rede', x); });
  }

  // --- screensaver (J6): 10 min without a key outside the player → a clock that moves around ------
  var protetor = document.getElementById('protetor'), ultimaTecla = Date.now();
  document.addEventListener('keydown', function (ev) {
    ultimaTecla = Date.now();
    if (protetor.className) { protetor.className = ''; ev.stopImmediatePropagation(); ev.preventDefault(); }   // the first key only wakes up
  }, true);
  setInterval(function () {
    if (jfPlayer.ativo()) { ultimaTecla = Date.now(); return; }
    if (Date.now() - ultimaTecla < 10 * 60000) return;
    protetor.className = 'visivel';
    protetor.firstChild.textContent = horaLocal();
    protetor.firstChild.style.left = Math.floor(Math.random() * 900 + 60) + 'px';
    protetor.firstChild.style.top = Math.floor(Math.random() * 480 + 60) + 'px';
  }, 20000);

  // --- app start ---------------------------------------------------------------------------------
  tv.json('/api/inicio', function (e, d) { if (!e && d) fusoMin = d.fuso_min || 0; });

  function iniciarApp() {
    if (!jf.servidor) {
      // First time: tries the PC's own Jellyfin; if there's none, asks for the address.
      return jf.infoDe(jf.servidorPadrao).then(function (info) {
        tv.log('servidor padrão encontrado: ' + jf.servidorPadrao);
        jf.adicionarServidor(jf.servidorPadrao, info);
        location.reload();
      }, function () {
        var t = telaServidores(); t.ehRaizFixa = true;
        empilhar(t);
      });
    }
    if (!jf.sessao.token) { var l = telaLogin(); l.ehRaizFixa = true; return empilhar(l); }
    jf.api('GET', '/Users/Me').then(function (u) {
      tv.log('sessão ok: ' + u.Name + ' em ' + jf.servidor);
      empilhar(telaInicio());
    }, function (e) {
      if (e.status === 401) { jf.sair(); var l = telaLogin(); l.ehRaizFixa = true; return empilhar(l); }
      var d = el('div', 'tela-lista');
      d.appendChild(el('h1', null, 'Sem conexão com o servidor'));
      d.appendChild(el('p', 'dica', jf.servidor + '   ·   ' + e.message));
      var lista = el('div', 'lista');
      d.appendChild(lista);
      [['Tentar de novo', function () { location.reload(); }], ['Servidores', function () { empilhar(telaServidores()); }]].forEach(function (o) {
        var l = el('div', 'linha focavel');
        l.appendChild(el('div', 'linha-titulo', o[0]));
        l.addEventListener('click', o[1]);
        lista.appendChild(l);
      });
      empilhar({ div: d, ehRaizFixa: true });
    });
  }
  // ←/→ outside the player (called by player.js, which owns these keys): the focused element may handle them.
  function seta(dir) { var f = tv.atual; return !!(f && f.aoSeta && f.aoSeta(dir)); }
  window.jfApp = { empilhar: empilhar, desempilhar: desempilhar, topo: topo, abrir: abrir, seta: seta };
  iniciarApp();
})();
