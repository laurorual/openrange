#!/usr/bin/env bash
# openrange.sh — start/stop/check everything in the project. Run on the [HOST].
#
#   tools/openrange.sh iniciar     start portal + DNS
#   tools/openrange.sh parar       stop everything and remove OpenRange's firewall rules
#   tools/openrange.sh reiniciar   restart portal + DNS (e.g. after changing tools/*.py)
#   tools/openrange.sh estado      what is running (fast)
#   tools/openrange.sh saude       full check, with what to do on each failure (no sudo needed)
#
# Two modes, picked automatically:
#   - installed (tools/instalar.sh): openrange.service (starts on boot). start/stop/restart need no password
#     (polkit rule from instalar.sh); without the rule it falls back to sudo.
#   - manual (before instalar.sh): portal runs as root through sudo, on the host (needs the password).
# No Jellyfin server here: the TV client uses the user's own server. The local test server is
# tools/sim/jellyfin-teste.sh, started only by the simulation gate.
# Config: config/openrange.json (python3 tools/config.py mostrar). DNSMASQ=1 uses the old dnsmasq (manual mode).
# The TV's DNS is set manually to the PC; with the PC off the TV has no DNS (switch it back to automatic).
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"
AVISOS_CFG="$(mktemp)"; trap 'rm -f "$AVISOS_CFG"' EXIT
eval "$(python3 tools/config.py env 2>"$AVISOS_CFG")"
[[ -s "$AVISOS_CFG" ]] && sed 's/^/!! /' "$AVISOS_CFG"
PADRAO_DNS="dnsmasq .*config/dnsmasq.conf"       # doesn't match libvirt's dnsmasq
PADRAO_PORTAL="tools/portal.py"
UNIT=/etc/systemd/system/openrange.service
SERVICO=0; [[ -f $UNIT ]] && SERVICO=1
SAIDA_PORTAL="logs/portal.out"; (( SERVICO )) && SAIDA_PORTAL="journalctl -u openrange -n 30"

rodando() { pgrep -f "$1" >/dev/null 2>&1; }

# --- installed mode -----------------------------------------------------------------------------------
# systemctl for openrange.service: passwordless through the polkit rule; sudo only if polkit says no (older install).
servico() {
  local err
  err=$(LC_ALL=C systemctl --no-ask-password "$1" openrange.service 2>&1) && return 0
  case "$err" in
    *uthenticat*|*"Access denied"*|*"not authorized"*|*"Permission denied"*) sudo systemctl "$1" openrange.service ;;
    *) echo "$err" >&2; echo "   erro em: journalctl -u openrange -n 30" >&2; return 1 ;;
  esac
}
iniciar_servico() {
  echo "== openrange.service (portal + DNS; firewall de runtime aberto pelo próprio serviço)"
  servico start
  sleep 3
  estado
}
parar_servico() {
  echo "== openrange.service"
  servico stop || true
  sleep 1
  estado
  echo; echo "O serviço volta sozinho no próximo boot (desligar de vez: sudo systemctl disable openrange)."
}

reiniciar_servico() {
  echo "== openrange.service (reiniciando)"
  servico restart
  sleep 3
  estado
}

# --- manual mode (rootful distrobox), as before instalar.sh ------------------------------------------
iniciar_manual() {
  echo "== firewall (só runtime, só para a TV $TV_IP)"
  sudo tools/firewall.sh abrir
  echo "== redirects (config/openrange.json)"
  for d in $REDIRECTS; do echo "   $d"; done
  local cmd="" dns_env="DNS=1"
  if [[ "${DNSMASQ:-0}" == 1 || "$DNS_EMBUTIDO" == 0 ]]; then
    dns_env="DNS=0"
    VARIOS=1 tools/gerar-dnsmasq.sh >/dev/null
    rodando "$PADRAO_DNS" || cmd+="dnsmasq -C '$RAIZ/config/dnsmasq.conf'; "          # without -k: becomes a daemon
  elif rodando "$PADRAO_DNS"; then
    echo "   (há um dnsmasq do OpenRange rodando: parando, o DNS agora é o do portal)"
    sudo pkill -f "$PADRAO_DNS" || true; sleep 1
  fi
  echo "== portal$([[ $dns_env == DNS=1 ]] && echo ' + DNS') (sudo, no host)"
  rodando "$PADRAO_PORTAL" || cmd+="cd '$RAIZ' && $dns_env setsid nohup python3 $PADRAO_PORTAL >> logs/portal.out 2>&1 < /dev/null & "
  if [[ -n "$cmd" ]]; then sudo sh -c "$cmd"; sleep 3; fi
  sleep 2
  estado
}
parar_manual() {
  echo "== portal (e DNS) e dnsmasq"
  rodando "$PADRAO_PORTAL" && sudo pkill -f "$PADRAO_PORTAL" || true
  rodando "$PADRAO_DNS"    && sudo pkill -f "$PADRAO_DNS"    || true
  echo "== firewall"
  sudo tools/firewall.sh fechar || true
  sleep 1
  estado
  echo; echo "Se for usar a TV sem o PC: na TV, volte o DNS para automático."
}

# --- status and health ---------------------------------------------------------------------------------
estado() {
  local s
  if (( SERVICO )); then s="openrange.service: $(systemctl is-active openrange.service 2>/dev/null || true)"
  else rodando "$PADRAO_PORTAL" && s="no ar (manual)" || s="parado (manual)"; fi
  echo "portal+DNS: $s  (log: logs/portal.log)"
  rodando "$PADRAO_DNS" && echo "dnsmasq:    rodando (modo antigo)"
  command -v dig >/dev/null && echo "DNS teste:  ${REDIRECTS%% *} -> $(dig +short +time=2 +tries=1 @"$PC_IP" "${REDIRECTS%% *}" 2>/dev/null | head -1)"
  curl -s -o /dev/null -m 3 -w "portal:     /api/inicio -> HTTP %{http_code}\n" "http://$PC_IP/api/inicio" || echo "portal:     sem resposta em :$PORTA_HTTP"
}

saude() {
  local falhas=0 avisos=0
  ok()    { echo "  ✓ $*"; }
  ruim()  { echo "  ✗ $1"; [[ -n "${2:-}" ]] && echo "      → $2"; falhas=$((falhas + 1)); }
  aviso() { echo "  ! $1"; [[ -n "${2:-}" ]] && echo "      → $2"; avisos=$((avisos + 1)); }
  echo "openrange — saúde ($(date '+%d/%m %H:%M'))   PC $PC_IP ($IFACE) · TV $TV_IP · modo $( (( SERVICO )) && echo instalado || echo manual)"
  echo "Configuração"
  [[ -s "$AVISOS_CFG" ]] && while read -r l; do aviso "$l" "DNS da TV = $PC_IP (roteador: DHCP DNS 1, ou na TV: DNS manual)"; done < "$AVISOS_CFG"
  [[ -n "$REDIRECTS" ]] && ok "redirects: $REDIRECTS" || aviso "nenhum redirect em config/openrange.json" "sem redirect a TV usa a loja original"
  local dias
  dias=$(( ( $(date -d "$(openssl x509 -in certs/cert.pem -noout -enddate 2>/dev/null | cut -d= -f2)" +%s 2>/dev/null || echo 0) - $(date +%s) ) / 86400 ))
  (( dias > 30 )) && ok "certificado válido por mais $dias dias" || ruim "certificado vence em $dias dias (ou falta)" "apague certs/*.pem e rode tools/instalar.sh"
  echo "Serviços"
  if (( SERVICO )); then
    systemctl is-active -q openrange.service && ok "openrange.service ativo" || ruim "openrange.service parado" "tools/openrange.sh iniciar · erro em: journalctl -u openrange -n 30"
    systemctl is-enabled -q openrange.service 2>/dev/null && ok "openrange.service sobe no boot" || aviso "openrange.service não sobe no boot" "sudo systemctl enable openrange"
    # reset-failed goes through the same polkit check as restart, without touching a running service
    # (sudo -k -n: ignores cached sudo credentials, so only a NOPASSWD rule passes)
    if LC_ALL=C systemctl --no-ask-password reset-failed openrange.service >/dev/null 2>&1; then
      ok "systemctl start/stop/restart openrange sem senha (polkit)"
    elif sudo -k -n "$(command -v systemctl)" reset-failed openrange.service >/dev/null 2>&1; then
      ok "systemctl start/stop/restart openrange sem senha (sudoers)"
    else aviso "systemctl do OpenRange pede senha" "rode tools/instalar.sh de novo (instala a regra do polkit/sudoers)"; fi
  else
    rodando "$PADRAO_PORTAL" && ok "portal rodando (modo manual)" || ruim "portal parado" "tools/openrange.sh iniciar"
    aviso "modo manual: não sobe no boot" "tools/instalar.sh"
  fi
  rodando "$PADRAO_DNS" && aviso "dnsmasq antigo rodando" "tools/openrange.sh parar && tools/openrange.sh iniciar (o DNS é do portal agora)"
  echo "Rede (o que a TV usa)"
  if command -v dig >/dev/null; then
    local r1 r2 alvo="${REDIRECTS%% *}"
    if [[ -n "$alvo" ]]; then
      r1=$(dig +short +time=2 +tries=1 @"$PC_IP" -p "$PORTA_DNS" "$alvo" 2>/dev/null | tail -1)
      [[ "$r1" == "$PC_IP" ]] && ok "DNS: $alvo → $PC_IP" || ruim "DNS: $alvo → '${r1:-sem resposta}'" "o portal subiu com DNS? veja $SAIDA_PORTAL"
    fi
    r2=$(dig +short +time=3 +tries=1 @"$PC_IP" -p "$PORTA_DNS" example.com 2>/dev/null | tail -1)
    [[ -n "$r2" ]] && ok "DNS repassa o resto (example.com → $r2)" || ruim "DNS não repassa outros domínios" "internet do PC? upstreams em config/openrange.json (dns.upstreams)"
  else aviso "sem o comando dig: DNS não testado"; fi
  local c
  c=$(curl -s -o /dev/null -m 4 -w "%{http_code}" "http://$PC_IP:$PORTA_HTTP/api/inicio" || true)
  [[ "$c" == 200 ]] && ok "HTTP :$PORTA_HTTP (launcher)" || ruim "HTTP :$PORTA_HTTP → ${c:-000}" "portal parado ou porta ocupada (ss -ltnp | grep :$PORTA_HTTP)"
  c=$(curl -sk -o /dev/null -m 4 -w "%{http_code}" "https://$PC_IP:$PORTA_HTTPS/" || true)
  [[ "$c" != 000 && -n "$c" ]] && ok "HTTPS :$PORTA_HTTPS (TLS da loja)" || ruim "HTTPS :$PORTA_HTTPS não responde" "certs/ legíveis pelo seu usuário?"
  c=$(curl -s -o /dev/null -m 4 -w "%{http_code}" "http://$PC_IP:$PORTA_CELULAR/jellyfin/celular.html" || true)
  [[ "$c" == 200 ]] && ok "celular :$PORTA_CELULAR (QR Code)" || ruim "celular :$PORTA_CELULAR → ${c:-000}" "portal antigo? reinicie (parar/iniciar)"
  if command -v firewall-cmd >/dev/null && firewall-cmd -q --state 2>/dev/null; then
    local n zona; zona=$(tools/firewall.sh zona 2>/dev/null || echo "$FW_ZONE")
    n=$(firewall-cmd --zone="$zona" --list-rich-rules 2>/dev/null | grep -c "address=\"$TV_IP\"" || true)
    (( n >= 5 )) && ok "firewall: $n regras para a TV (zona $zona, runtime)" || ruim "firewall: só $n de 5 regras para a TV (zona $zona)" "sudo tools/firewall.sh abrir (o serviço faz isso ao subir)"
  fi
  # the TV ignores ICMP ping; its DIAL server (TCP 56789) answers while it is on
  if timeout 2 bash -c "exec 3<>/dev/tcp/$TV_IP/56789" 2>/dev/null || ping -c1 -W1 "$TV_IP" >/dev/null 2>&1; then ok "TV ligada na rede ($TV_IP)"
  else aviso "TV não responde ($TV_IP)" "desligada, em standby ou outro IP (config/openrange.json → rede.tv_ip)"; fi
  c=$(curl -s -o /dev/null -m 6 -w "%{http_code}" https://api-portal-v3.netrange.com/ || true)
  [[ "$c" != 000 && -n "$c" ]] && ok "internet: NetRange alcançável (o catálogo real funciona)" || aviso "NetRange inalcançável" "a TV verá só as capturas guardadas (sem internet no PC?)"
  echo "Logs"
  du -sh logs 2>/dev/null | awk '{print "  · logs/: "$1" (rotação a cada 5 MB, 3 cópias)"}'
  rodando "tcpdump .*logs/" && aviso "tcpdump gravando em logs/ (cresce sem parar com vídeo)" "sudo pkill -f 'tcpdump .*logs/'"
  local grande; grande=$(find logs -maxdepth 1 -name '*.pcap*' -size +200M -printf '%f (%s B)\n' 2>/dev/null | head -3)
  [[ -n "$grande" ]] && aviso "captura grande: $(echo $grande)" "apague quando não precisar: sudo rm logs/*.pcap (tem tráfego da TV)"
  echo
  (( falhas )) && { echo "$falhas falha(s), $avisos aviso(s)."; return 1; }
  echo "Tudo certo ($avisos aviso(s))."
}

case "${1:-estado}" in
  iniciar|start) if (( SERVICO )); then iniciar_servico; else iniciar_manual; fi ;;
  parar|stop)    if (( SERVICO )); then parar_servico; else parar_manual; fi ;;
  reiniciar|restart) if (( SERVICO )); then reiniciar_servico; else parar_manual; iniciar_manual; fi ;;
  estado|status) estado ;;
  saude|saúde|check) saude ;;
  *) echo "uso: $0 iniciar|parar|reiniciar|estado|saude" >&2; exit 2 ;;
esac
