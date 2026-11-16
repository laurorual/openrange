/* OpenRange control panel (M3.3). Runs in the PC's browser (not on the TV): modern JS is fine here.
   Talks only to /painel/api/* (tools/painel.py). Tested by tools/sim/painel-ui.js. */
'use strict';
(function () {
  const $ = (s, el) => (el || document).querySelector(s);
  const el = (tag, props, ...filhos) => {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    filhos.forEach((f) => e.append(f));
    return e;
  };
  const PC = '{PC_IP}';
  let estadoAtual = null, configAtual = null, apps = [], secaoPadrao = 'Nossos apps', dnsOk = false;

  // --- API + feedback ---------------------------------------------------------------------------------
  async function api(metodo, rota, corpo) {
    const opcoes = { method: metodo, headers: { 'X-OpenRange': '1' } };
    if (corpo !== undefined) { opcoes.headers['Content-Type'] = 'application/json'; opcoes.body = JSON.stringify(corpo); }
    const r = await fetch('/painel/api/' + rota, opcoes);
    let d = {};
    try { d = await r.json(); } catch (x) { /* empty body */ }
    if (r.status === 403) bloquear(d.erro || 'acesso recusado');
    if (!r.ok) throw new Error(d.erro || 'HTTP ' + r.status);
    return d;
  }
  let timerRecado = null;
  function recado(msg, tipo) {
    const r = $('#recado');
    r.textContent = msg;
    r.className = 'visivel ' + (tipo || '');
    clearTimeout(timerRecado);
    timerRecado = setTimeout(() => { r.className = ''; }, tipo === 'ruim' ? 7000 : 3500);
  }
  const falhou = (x) => recado(x.message, 'ruim');
  function bloquear(msg) {
    document.body.classList.add('bloqueado');
    $('#bloqueio-msg').textContent = 'O painel recusou este acesso: ' + msg + '.';
    $('#resumo').textContent = 'sem acesso';
  }
  function ha(ts) {
    if (!ts) return 'nunca';
    const s = Math.max(0, Math.round((estadoAtual ? estadoAtual.agora : Date.now() / 1000) - ts));
    if (s < 60) return 'há ' + s + ' s';
    if (s < 3600) return 'há ' + Math.round(s / 60) + ' min';
    if (s < 86400) return 'há ' + Math.round(s / 3600) + ' h';
    return 'há ' + Math.round(s / 86400) + ' dias';
  }
  const tamanho = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';

  // --- tabs -----------------------------------------------------------------------------------------
  const carregadores = { estado: atualizarEstado, passos: carregarPassos, apps: carregarApps, loja: carregarLoja,
                         rede: carregarRede, logs: () => { log.desde = null; $('#log-texto').textContent = ''; log.linhas = []; return puxarLog(); } };
  function mostrarAba() {
    let aba = location.hash.slice(1);
    if (!carregadores[aba]) aba = 'estado';
    document.querySelectorAll('main > section').forEach((s) => s.classList.toggle('ativa', s.id === 'aba-' + aba));
    document.querySelectorAll('#abas a').forEach((a) => a.classList.toggle('ativa', a.dataset.aba === aba));
    carregadores[aba]().catch(falhou);
    if (!estadoAtual && aba !== 'estado' && aba !== 'passos') atualizarEstado().catch(() => {});   // header summary
  }
  const abaAtiva = () => (document.querySelector('#abas a.ativa') || {}).dataset?.aba;

  // --- status -----------------------------------------------------------------------------------------
  function linha(k, v, classe) {
    const d = el('div', { className: 'linha ' + (classe || '') });
    if (k) d.append(el('span', { className: 'k', textContent: k }));
    const s = el('span');
    if (classe) s.append(el('span', { className: 'ponto' }));
    s.append(v);
    d.append(s);
    return d;
  }
  function cartao(titulo, linhas) {
    const c = el('div', { className: 'cartao' }, el('h3', { textContent: titulo }));
    linhas.forEach((l) => c.append(l));
    return c;
  }
  const recente = (ts, s) => ts && estadoAtual.agora - ts < s;
  async function atualizarEstado() {
    const e = estadoAtual = await api('GET', 'estado');
    const tv = e.tv;
    $('#resumo').textContent = `PC ${e.pc_ip} · TV ${e.tv_ip} · ${e.modo === 'servico' ? 'serviço instalado' : 'modo manual'}` +
      (e.versao ? ' · ' + e.versao : '');
    $('#faixa').classList.toggle('visivel', !!e.reiniciar);
    const c = $('#cartoes');
    c.replaceChildren(
      cartao('Serviço', [
        linha('Modo', e.modo === 'servico' ? 'instalado (sobe no boot)' : 'manual (tools/openrange.sh)', e.modo === 'servico' ? 'ok' : 'aviso'),
        linha('No ar', ha(e.inicio).replace('há ', '')),
        linha('DNS', e.dns_embutido ? 'embutido, porta ' + e.portas.dns : 'desligado', e.dns_embutido ? 'ok' : 'aviso'),
        el('div', { className: 'acoes' }, el('button', { textContent: 'Reiniciar serviço', disabled: e.modo !== 'servico', onclick: reiniciar })),
      ]),
      cartao('TV ' + e.tv_ip, [
        linha('Rede', tv.ping || recente(tv.http, 120) || recente(tv.dns, 120) ? 'ligada' : 'não responde (desligada ou em standby?)',
              tv.ping || recente(tv.http, 120) || recente(tv.dns, 120) ? 'ok' : 'aviso'),
        linha('Usou o DNS', ha(tv.dns) + (tv.dns_nome ? ' · ' + tv.dns_nome : ''), recente(tv.dns, 900) ? 'ok' : 'aviso'),
        linha('Pedido', ha(tv.http) + (tv.http_caminho ? ' · ' + tv.http_caminho.slice(0, 40) : ''), recente(tv.http, 900) ? 'ok' : 'aviso'),
        linha('Launcher', ha(tv.inicio)),
      ]),
      cartao('PC', [
        linha('IP', e.pc_ip + (e.auto.pc_ip ? ' (automático)' : '')),
        linha('Interface', e.interface || '?'),
        linha('Roteador', e.gateway || '?'),
        linha('Portas', `HTTP ${e.portas.http} · HTTPS ${e.portas.https} · painel ${e.portas.celular}`),
      ]),
      cartao('Redirects', e.redirects.map((d) => linha('', d, 'ok')).concat(
        e.problemas.map((p) => linha('', p, 'ruim')),
        e.redirects.length ? [] : [linha('', 'nenhum: a TV vê a loja original', 'aviso')])),
      cartao('Logs', Object.keys(e.logs).map((k) => linha(k, tamanho(e.logs[k])))),
    );
    atualizarPassos();
  }
  async function diagnostico() {
    const b = $('[data-acao="diagnostico"]');
    b.disabled = true;
    $('#diag-estado').textContent = 'rodando (até 60 s)…';
    try {
      const d = await api('POST', 'diagnostico');
      const pre = $('#diag-saida');
      pre.hidden = false;
      pre.textContent = d.saida;
      $('#diag-estado').textContent = d.ok ? 'tudo certo' : 'há falhas: veja abaixo';
    } finally { b.disabled = false; }
  }
  async function reiniciar() {
    const antes = estadoAtual && estadoAtual.inicio;
    await api('POST', 'reiniciar');
    recado('Reiniciando o serviço…');
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const e = await api('GET', 'estado');
        if (e.inicio !== antes) { recado('Serviço reiniciado', 'ok'); return mostrarAba(); }
      } catch (x) { /* still restarting */ }
    }
    recado('O serviço não voltou em 30 s: rode tools/openrange.sh saude', 'ruim');
  }

  // --- first steps -------------------------------------------------------------------------------------
  function marcar(n, ok, texto) {
    $('#passo-' + n).classList.toggle('ok', !!ok);
    if (texto !== undefined && $('#passo-' + n + '-estado')) $('#passo-' + n + '-estado').textContent = texto;
  }
  function atualizarPassos() {
    const e = estadoAtual;
    if (!e) return;
    if (document.activeElement !== $('#tv-ip')) $('#tv-ip').value = e.tv_ip;
    $('#pc-ip').textContent = e.pc_ip;
    marcar(1, e.tv_ip && e.tv.ping);
    marcar(2, recente(e.tv.dns, 1800), e.tv.dns ? `A TV usou este DNS ${ha(e.tv.dns)} (${e.tv.dns_nome}).`
      : 'Ainda não vi a TV usar este DNS. Depois de mudar, desligue e ligue a TV.');
    marcar(3, dnsOk);
    marcar(4, !!e.tv.inicio, e.tv.inicio ? `A TV abriu o launcher ${ha(e.tv.inicio)}.` : 'A TV ainda não abriu o launcher desde que o serviço subiu.');
  }
  async function carregarPassos() {
    await atualizarEstado();
    const d = await api('GET', 'vizinhos');
    const t = $('#vizinhos');
    t.replaceChildren(el('tr', {}, el('th', { textContent: 'IP' }), el('th', { textContent: 'MAC' }), el('th', { textContent: 'Usou o DNS' }), el('th')));
    d.vizinhos.forEach((v) => t.append(el('tr', {},
      el('td', { textContent: v.ip + (v.ip === d.tv_ip ? ' (TV atual)' : '') }), el('td', { textContent: v.mac || '—' }),
      el('td', { textContent: v.dns ? ha(v.dns) + ' · ' + v.dns_nome : '—' }),
      el('td', {}, el('button', { className: 'mini', textContent: 'usar', onclick: () => { $('#tv-ip').value = v.ip; } })))));
    if (!d.vizinhos.length) t.append(el('tr', {}, el('td', { textContent: 'nenhum aparelho na tabela ARP do PC ainda' })));
  }
  async function salvarTvIp() {
    const r = await api('POST', 'config', { rede: { tv_ip: $('#tv-ip').value.trim() } });
    recado(r.reiniciar ? 'Salvo. Reinicie o serviço para valer (firewall e DNS).' : 'Salvo', 'ok');
    await atualizarEstado();
  }
  async function testeDns() {
    const d = await api('POST', 'teste-dns');
    dnsOk = d.ok;
    for (const id of ['#dns-resultado', '#dns-resultado-2']) {
      const t = $(id);
      t.replaceChildren(el('tr', {}, el('th', { textContent: 'Domínio' }), el('th', { textContent: 'Resposta' }), el('th', { textContent: 'Esperado' })));
      if (d.erro) t.append(el('tr', {}, el('td', { textContent: d.erro, colSpan: 3 })));
      d.resultados.forEach((r) => t.append(el('tr', { className: r.ok ? 'ok' : 'ruim' },
        el('td', {}, el('span', { className: 'ponto' }), r.nome), el('td', { textContent: r.resposta || 'sem resposta' }),
        el('td', { textContent: r.esperado }))));
    }
    recado(d.ok ? 'DNS ok' : 'DNS com problema: veja a tabela', d.ok ? 'ok' : 'ruim');
    atualizarPassos();
  }

  // --- own apps ------------------------------------------------------------------------------------------
  const iconeUrl = (a) => `/icones/portals/v3/prod/app/${a.id}/type019-192x250/default/192x250.jpg` + (a.icone_v ? '?v=' + a.icone_v : '?c=' + encodeURIComponent((a.cor || '') + (a.rotulo || a.name)));
  // same drawing as svg_icone() in tools/portal.py: preview before saving
  function iconeGerado(nome, cor) {
    const w = 192, h = 250, linhas = [];
    let atual = '';
    nome.split(/\s+/).filter(Boolean).forEach((p) => {
      if (atual && atual.length + p.length + 1 > 12) { linhas.push(atual); atual = p; } else atual = (atual + ' ' + p).trim();
    });
    linhas.push(atual);
    const ls = linhas.slice(0, 3), fs = Math.max(10, Math.floor(Math.min(h / (ls.length + 1.5), w / 8)));
    const y0 = h / 2 - (ls.length - 1) * fs * 0.6;
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const t = ls.map((l, i) => `<tspan x="96" y="${Math.round(y0 + i * fs * 1.2)}">${esc(l)}</tspan>`).join('');
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<rect width="${w}" height="${h}" fill="${esc(cor)}"/><text font-family="Roboto,Arial,sans-serif" font-weight="700" font-size="${fs}" ` +
      `fill="#fff" text-anchor="middle" dominant-baseline="middle">${t}</text></svg>`);
  }
  function grupos() {
    const ordem = [], g = {};
    apps.forEach((a) => {
      const s = a.secao || secaoPadrao;
      if (!g[s]) { g[s] = []; ordem.push(s); }
      g[s].push(a);
    });
    return ordem.map((s) => ({ nome: s, apps: g[s] }));
  }
  async function carregarApps() {
    const d = await api('GET', 'apps');
    apps = d.apps; secaoPadrao = d.secao_padrao;
    desenharApps();
  }
  function desenharApps() {
    const lista = $('#lista-apps');
    lista.replaceChildren();
    const gs = grupos();
    $('#secoes').replaceChildren(...gs.map((g) => el('option', { value: g.nome })));
    gs.forEach((g, gi) => {
      lista.append(el('div', { className: 'secao-titulo' }, g.nome + ' ',
        el('button', { className: 'mini', textContent: '↑', title: 'subir a seção', disabled: gi === 0, onclick: () => moverSecao(gi, -1) }), ' ',
        el('button', { className: 'mini', textContent: '↓', title: 'descer a seção', disabled: gi === gs.length - 1, onclick: () => moverSecao(gi, 1) })));
      g.apps.forEach((a, i) => {
        const url = a.url.replace(PC, (estadoAtual && estadoAtual.pc_ip) || PC);
        lista.append(el('div', { className: 'app' },
          el('img', { src: iconeUrl(a), alt: '', loading: 'lazy' }),
          el('div', { className: 'info' }, el('b', {}, a.name, a.inicio ? el('span', { className: 'etiqueta', textContent: 'tela inicial' }) : '',
                                                     a.icone_proprio ? el('span', { className: 'etiqueta', textContent: 'ícone próprio' }) : ''),
            el('small', { textContent: url }), el('small', { textContent: a.description || '' })),
          el('div', { className: 'botoes' },
            el('button', { className: 'mini', textContent: '↑', disabled: i === 0, onclick: () => moverApp(g, i, -1) }),
            el('button', { className: 'mini', textContent: '↓', disabled: i === g.apps.length - 1, onclick: () => moverApp(g, i, 1) }),
            el('button', { className: 'mini', textContent: 'Editar', onclick: () => editar(a) }),
            el('button', { className: 'mini perigo', textContent: 'Remover', onclick: () => remover(a) }))));
      });
    });
    if (!apps.length) lista.append(el('p', { className: 'dica', textContent: 'Nenhum app. O launcher da TV fica só com os da loja.' }));
  }
  async function salvarApps(nova) {
    const d = await api('POST', 'apps', { apps: nova });
    apps = d.apps;
    desenharApps();
    return d.apps;
  }
  function moverApp(g, i, passo) {
    const lista = g.apps.slice();
    [lista[i], lista[i + passo]] = [lista[i + passo], lista[i]];
    const nova = grupos().flatMap((x) => (x.nome === g.nome ? lista : x.apps));
    salvarApps(nova).then(() => recado('Ordem salva', 'ok'), falhou);
  }
  function moverSecao(gi, passo) {
    const gs = grupos();
    [gs[gi], gs[gi + passo]] = [gs[gi + passo], gs[gi]];
    salvarApps(gs.flatMap((g) => g.apps)).then(() => recado('Ordem salva', 'ok'), falhou);
  }
  function remover(a) {
    if (!confirm(`Remover "${a.name}" do launcher e da loja?`)) return;
    salvarApps(apps.filter((x) => x.id !== a.id)).then(() => recado('Removido', 'ok'), falhou);
  }
  let editando = null, arquivoIcone = null;
  function editar(a) {
    editando = a || null;
    arquivoIcone = null;
    $('#editor-titulo').textContent = a ? 'Editar ' + a.name : 'Novo app';
    $('#ed-nome').value = a ? a.name : '';
    $('#ed-secao').value = a ? (a.secao || secaoPadrao) : secaoPadrao;
    $('#ed-url').value = a ? a.url : 'http://{PC_IP}/';
    $('#ed-desc').value = a ? a.description || '' : '';
    $('#ed-inicio').checked = a ? !!a.inicio : false;
    $('#ed-cor').value = a && /^#[0-9a-f]{6}$/i.test(a.cor || '') ? a.cor : '#316dca';
    $('#ed-rotulo').value = a ? a.rotulo || '' : '';
    $('#ed-arquivo').value = '';
    $('#ed-remover-icone').hidden = !(a && a.icone_proprio);
    previa();
    $('#editor').classList.add('visivel');
    $('#ed-nome').focus();
  }
  function previa() {
    const img = $('#ed-previa');
    if (arquivoIcone) img.src = 'data:' + arquivoIcone.tipo + ';base64,' + arquivoIcone.dados;
    else if (editando && editando.icone_proprio) img.src = iconeUrl(editando);
    else img.src = iconeGerado($('#ed-rotulo').value.trim() || $('#ed-nome').value.trim() || '?', $('#ed-cor').value);
  }
  function lerArquivo() {
    const f = $('#ed-arquivo').files[0];
    if (!f) { arquivoIcone = null; return previa(); }
    if (f.size > 300 * 1024) { $('#ed-arquivo').value = ''; return recado('Ícone até 300 KB', 'ruim'); }
    const r = new FileReader();
    r.onload = () => { arquivoIcone = { tipo: f.type, dados: String(r.result).split(',')[1] }; previa(); };
    r.readAsDataURL(f);
  }
  async function salvarApp() {
    const novo = Object.assign({}, editando || {}, {
      name: $('#ed-nome').value.trim(), url: $('#ed-url').value.trim(), description: $('#ed-desc').value.trim(),
      secao: $('#ed-secao').value.trim() || secaoPadrao, inicio: $('#ed-inicio').checked, cor: $('#ed-cor').value,
      rotulo: $('#ed-rotulo').value.trim(),
    });
    delete novo.icone_proprio; delete novo.icone_v;
    const antes = new Set(apps.map((a) => a.id));
    const nova = editando ? apps.map((a) => (a.id === editando.id ? novo : a)) : apps.concat([novo]);
    const salvos = await salvarApps(nova);
    const id = editando ? editando.id : (salvos.find((a) => !antes.has(a.id)) || {}).id;
    if (arquivoIcone && id) {
      const d = await api('POST', `apps/${id}/icone`, arquivoIcone);
      apps = d.apps;
      desenharApps();
    }
    $('#editor').classList.remove('visivel');
    recado('App salvo. Na TV: vermelho no launcher recarrega.', 'ok');
  }
  async function removerIcone() {
    const d = await api('POST', `apps/${editando.id}/icone`, { remover: true });
    apps = d.apps;
    editando = apps.find((a) => a.id === editando.id) || null;
    $('#ed-remover-icone').hidden = true;
    previa();
    desenharApps();
    recado('Ícone gerado de volta', 'ok');
  }

  // --- store favorites -----------------------------------------------------------------------------------
  let favoritos = [];
  const iconeLoja = (id) => `/icones/portals/v3/prod/app/${id}/type019-192x250/default/192x250.jpg`;
  function itemLoja(a, botoes) {
    return el('div', { className: 'app' }, el('img', { src: iconeLoja(a.id), alt: '', loading: 'lazy' }),
      el('div', { className: 'info' }, el('b', { textContent: a.name }), el('small', { textContent: '#' + a.id + (a.description ? ' · ' + a.description : '') })),
      el('div', { className: 'botoes' }, ...botoes));
  }
  async function carregarLoja() {
    const [c] = await Promise.all([api('GET', 'catalogo?q=' + encodeURIComponent($('#busca-loja').value)),
                                   api('GET', 'config').then((x) => { configAtual = x; $('#substituir-loja').checked = !!x.launcher.substituir_loja; })]);
    favoritos = c.favoritos;
    $('#cat-conta').textContent = c.total ? `(${c.total} apps; mostrando ${c.resultados.length})` : '(ainda sem catálogo: abra a loja na TV uma vez)';
    desenharFavoritos();
    const ids = new Set(favoritos.map((f) => f.id));
    $('#catalogo').replaceChildren(...c.resultados.map((a) => itemLoja(a, [
      el('button', { className: 'mini', textContent: ids.has(a.id) ? 'já está' : '+ favorito', disabled: ids.has(a.id),
                     onclick: () => salvarFavoritos(favoritos.concat([a])).then(carregarLoja, falhou) })])));
  }
  function desenharFavoritos() {
    $('#fav-conta').textContent = `(${favoritos.length})`;
    $('#favoritos').replaceChildren(...favoritos.map((a, i) => itemLoja(a, [
      el('button', { className: 'mini', textContent: '↑', disabled: i === 0, onclick: () => moverFav(i, -1) }),
      el('button', { className: 'mini', textContent: '↓', disabled: i === favoritos.length - 1, onclick: () => moverFav(i, 1) }),
      el('button', { className: 'mini perigo', textContent: '✕', title: 'tirar dos favoritos',
                     onclick: () => salvarFavoritos(favoritos.filter((f) => f.id !== a.id)).then(carregarLoja, falhou) })])));
    if (!favoritos.length) $('#favoritos').append(el('p', { className: 'dica', textContent: 'Nenhum favorito.' }));
  }
  async function salvarFavoritos(lista) {
    await api('POST', 'favoritos', { favoritos: lista.map((f) => f.id) });
    favoritos = lista;
    recado('Favoritos salvos', 'ok');
  }
  function moverFav(i, passo) {
    const l = favoritos.slice();
    [l[i], l[i + passo]] = [l[i + passo], l[i]];
    salvarFavoritos(l).then(desenharFavoritos, falhou);
  }

  // --- network ---------------------------------------------------------------------------------------------
  async function carregarRede() {
    if (!estadoAtual) await atualizarEstado();
    const c = configAtual = await api('GET', 'config');
    const e = estadoAtual;
    $('#rede-tv').value = c.rede.tv_ip;
    $('#rede-pc').textContent = e.pc_ip + (c.rede.pc_ip === 'auto' ? ' (automático: o IP que alcança a TV)' : '');
    $('#rede-if').textContent = e.interface || '?';
    $('#rede-portas').textContent = `DNS ${c.portas.dns} · HTTP ${c.portas.http} · HTTPS ${c.portas.https} · painel ${c.portas.celular}`;
    $('#dns-embutido').checked = c.dns.embutido !== false;
    $('#dns-ups').value = (c.dns.upstreams || []).join('\n');
    $('#redirects').value = c.redirects.join('\n');
    $('#logs-mb').value = c.logs.max_mb;
    $('#logs-manter').value = c.logs.manter;
  }
  async function salvarRede() {
    const linhas = (s) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    const r = await api('POST', 'config', {
      rede: { tv_ip: $('#rede-tv').value.trim() }, redirects: linhas($('#redirects').value),
      dns: { embutido: $('#dns-embutido').checked, upstreams: linhas($('#dns-ups').value) },
      logs: { max_mb: +$('#logs-mb').value, manter: +$('#logs-manter').value },
    });
    recado(r.reiniciar ? 'Salvo. Reinicie o serviço para valer.' : 'Salvo (já vale: o DNS relê os redirects sozinho)', 'ok');
    await atualizarEstado();
    await carregarRede();
  }

  // --- logs --------------------------------------------------------------------------------------------------
  const log = { desde: null, linhas: [], ocupado: false };
  function desenharLog() {
    const pre = $('#log-texto'), f = $('#log-filtro').value.toLowerCase();
    const noFim = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
    pre.textContent = (f ? log.linhas.filter((l) => l.toLowerCase().includes(f)) : log.linhas).join('\n');
    if (noFim) pre.scrollTop = pre.scrollHeight;
  }
  async function puxarLog() {
    if (log.ocupado) return;
    log.ocupado = true;
    try {
      const arq = $('#log-arquivo').value;
      const d = await api('GET', `logs?arquivo=${arq}` + (log.desde === null ? '' : '&desde=' + log.desde));
      if (arq !== $('#log-arquivo').value) return;
      if (log.desde !== null && d.fim < log.desde) log.linhas = [];          // rotated
      log.desde = d.fim;
      if (d.texto) {
        log.linhas = log.linhas.concat(d.texto.replace(/\n$/, '').split('\n')).slice(-3000);
        desenharLog();
      }
    } finally { log.ocupado = false; }
  }

  // --- wiring ----------------------------------------------------------------------------------------------
  const acoes = {
    diagnostico, reiniciar, 'teste-dns': testeDns, 'salvar-tv-ip': salvarTvIp, 'novo-app': () => editar(null),
    'salvar-app': salvarApp, 'cancelar-app': () => $('#editor').classList.remove('visivel'), 'remover-icone': removerIcone,
    'salvar-rede': salvarRede, 'log-limpar': () => { log.linhas = []; desenharLog(); },
  };
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-acao]');
    if (!b || !acoes[b.dataset.acao]) return;
    ev.preventDefault();
    Promise.resolve().then(acoes[b.dataset.acao]).catch(falhou);
  });
  ['#ed-nome', '#ed-rotulo', '#ed-cor'].forEach((s) => $(s).addEventListener('input', () => { if (!arquivoIcone && !(editando && editando.icone_proprio)) previa(); }));
  $('#ed-arquivo').addEventListener('change', lerArquivo);
  let timerBusca = null;
  $('#busca-loja').addEventListener('input', () => { clearTimeout(timerBusca); timerBusca = setTimeout(() => carregarLoja().catch(falhou), 250); });
  $('#substituir-loja').addEventListener('change', () => api('POST', 'config', { launcher: { substituir_loja: $('#substituir-loja').checked } })
    .then(() => recado('Salvo', 'ok'), falhou));
  $('#log-arquivo').addEventListener('change', () => carregadores.logs().catch(falhou));
  $('#log-filtro').addEventListener('input', desenharLog);
  window.addEventListener('hashchange', mostrarAba);

  setInterval(() => {
    if (document.hidden || document.body.classList.contains('bloqueado')) return;
    if (abaAtiva() === 'logs' && $('#log-vivo').checked) puxarLog().catch(() => {});
  }, 2000);
  setInterval(() => {
    if (document.hidden || document.body.classList.contains('bloqueado')) return;
    const aba = abaAtiva();
    if (aba === 'estado' || aba === 'passos') atualizarEstado().catch(() => {});
  }, 4000);
  mostrarAba();
  window.painel = { api, recado, iconeGerado };    // for the gate (tools/sim/painel-ui.js)
})();
