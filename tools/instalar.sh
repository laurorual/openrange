#!/usr/bin/env bash
# instalar.sh — installs OpenRange so it starts on boot. Run on the [HOST] as your user (not root):
#
#   tools/instalar.sh                  install/update (calls sudo when it needs it)
#   tools/instalar.sh --simular        print everything it would do, with the generated files; changes nothing
#   tools/instalar.sh remover          undo (service, polkit/sudoers rule, runtime firewall); keeps config and logs
#   tools/instalar.sh --simular remover
#
# Steps:
#   1. dependencies (python3 >= 3.9, curl, openssl, systemctl)
#   2. config/openrange.json (asks for the TV IP if missing) and the certificate in certs/ (if missing)
#   3. give back to the user the files left owned by root (logs/, cache/, config/, certs/) by the old rootful mode
#   4. /etc/systemd/system/openrange.service: portal + DNS on the host as YOUR user, only CAP_NET_BIND_SERVICE;
#      opens/closes the RUNTIME firewall on start/stop; starts on boot
#   5. /etc/polkit-1/rules.d/50-openrange.rules: this user may start/stop/restart openrange.service without a password
#      (only that unit, only those verbs; enable/disable and every other unit still need sudo).
#      polkit < 0.106 (e.g. Ubuntu 22.04, Debian 11) has no JS rules and its .pkla files can't filter by unit,
#      so there /etc/sudoers.d/openrange allows exactly "systemctl start|stop|restart openrange.service" without a password.
#   6. stop the old manual mode, enable the service, check that a passwordless restart works
# No Jellyfin server is installed: the TV client talks to the user's own server(s). The local test server used
# by the simulation gate lives in tools/sim/jellyfin-teste.sh and is started only by the gate.
# Never installs packages, never uses rpm-ostree, never adds --permanent firewall rules.
#
# SELinux (Fedora/Bazzite, enforcing): systemd (init_t) may neither execute nor append to files labeled
# user_home_t (checked with sesearch against the host policy). So every Exec*= runs an interpreter from /usr/bin
# with our script as an argument, and stdout/stderr go to the journal, not to a file under logs/.
# tools/sim/instalacao.sh guards this and tests the polkit rule.
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"
SIMULAR=0; ACAO=instalar
for a in "$@"; do case "$a" in --simular) SIMULAR=1 ;; remover) ACAO=remover ;; *) echo "uso: $0 [--simular] [remover]" >&2; exit 2 ;; esac; done
[[ $EUID -eq 0 ]] && { echo "Rode como seu usuário (o script chama o sudo sozinho)." >&2; exit 1; }
USUARIO="$(id -un)"; GRUPO="$(id -gn)"
[[ $USUARIO =~ ^[a-z_][a-z0-9_.-]*$ ]] || { echo "Nome de usuário inesperado: $USUARIO" >&2; exit 1; }
UNIT=/etc/systemd/system/openrange.service
POLKIT=/etc/polkit-1/rules.d/50-openrange.rules
SUDOERS=/etc/sudoers.d/openrange

passo() { echo; echo "== $*"; }
faz() {   # faz CMD...  (only printed with --simular)
  if (( SIMULAR )); then printf '   [simular]'; printf ' %q' "$@"; echo; else "$@"; fi
}
escreve() {   # escreve DEST [sudo [MODE]] < content
  local destino="$1" com_sudo="${2:-}" modo="${3:-644}" tmp
  tmp="$(mktemp)"; cat > "$tmp"
  if (( SIMULAR )); then echo "   [simular] gravaria $destino:"; sed 's/^/      | /' "$tmp"; rm -f "$tmp"; return; fi
  if [[ -n "$com_sudo" ]]; then sudo install -m "$modo" "$tmp" "$destino"; else install -D -m "$modo" "$tmp" "$destino"; fi
  rm -f "$tmp"
}
# polkit with JS rules (>= 0.106; versions are "0.105" or "122"). POLKIT_VERSAO overrides (tests).
polkit_js() {
  local v="${POLKIT_VERSAO:-$(pkaction --version 2>/dev/null | awk '{print $NF}')}"
  [[ -n $v ]] || return 1
  [[ $v == 0.* ]] && (( ${v#0.} >= 106 )) && return 0
  [[ $v != 0.* ]]
}

# ---------------------------------------------------------------------------------------------------
if [[ $ACAO == remover ]]; then
  passo "Removendo o serviço do sistema (openrange.service)"
  if [[ -f $UNIT ]]; then
    faz sudo systemctl disable --now openrange.service || true
    faz sudo rm -f "$UNIT"
    faz sudo systemctl daemon-reload
    faz sudo systemctl reset-failed openrange.service 2>/dev/null || true
  else echo "   não está instalado"; fi
  passo "Fechando o firewall de runtime do OpenRange (se ficou algo)"
  faz sudo /usr/bin/bash "$RAIZ/tools/firewall.sh" fechar || true
  passo "Removendo a regra do polkit ($POLKIT)"
  faz sudo rm -f "$POLKIT"     # rules.d is not readable by the user: remove unconditionally (idempotent)
  passo "Removendo a regra do sudoers ($SUDOERS)"
  faz sudo rm -f "$SUDOERS"
  passo "Pronto. Modo manual: tools/openrange.sh iniciar. Na TV, volte o DNS para automático se não for mais usar o openrange."
  exit 0
fi

# ---------------------------------------------------------------------------------------------------
# Before the rename (2026-11-16) the project was "tvlab": remove its unit and rules so only one service owns :53/:80.
if [[ -f /etc/systemd/system/tvlab.service ]]; then
  passo "0. Removendo a instalação antiga (tvlab.service)"
  faz sudo systemctl disable --now tvlab.service || true
  faz sudo rm -f /etc/systemd/system/tvlab.service /etc/polkit-1/rules.d/50-tvlab.rules /etc/sudoers.d/tvlab
  faz sudo systemctl daemon-reload
  faz sudo systemctl reset-failed tvlab.service 2>/dev/null || true
fi

passo "1. Dependências"
falta=0
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null \
  && echo "   python3 $(python3 -c 'import platform; print(platform.python_version())')" || { echo "   FALTA: python3 ≥ 3.9"; falta=1; }
for c in curl openssl systemctl; do command -v "$c" >/dev/null && echo "   $c ok" || { echo "   FALTA: $c"; falta=1; }; done
# The unit must use the system interpreters: a python3/bash under $HOME (e.g. linuxbrew) is user_home_t for SELinux.
PY=/usr/bin/python3; [[ -x $PY ]] || PY="$(command -v python3)"
BASH_BIN=/usr/bin/bash; [[ -x $BASH_BIN ]] || BASH_BIN=/bin/bash
case "$PY" in /home/*|/var/home/*|"$HOME"/*) echo "   AVISO: python3 em $PY (no home): o systemd pode não conseguir executá-lo" ;; esac
command -v firewall-cmd >/dev/null && echo "   firewall-cmd ok" || echo "   firewall-cmd ausente: sem regras de firewall (ok se não houver firewalld)"
# ufw (Ubuntu/Debian) is not managed by OpenRange: its rules would be permanent
if command -v ufw >/dev/null && systemctl is-active -q ufw 2>/dev/null; then
  echo "   AVISO: ufw ativo; se ele estiver bloqueando, libere a TV uma vez: sudo ufw allow from <IP da TV>"
fi
if polkit_js; then echo "   polkit ok (regras JS)"
else echo "   polkit sem regras JS (ou ausente): uso uma regra do sudoers só para o openrange.service"
     command -v visudo >/dev/null || echo "   AVISO: sem visudo: não consigo validar a regra do sudoers"; fi
(( falta )) && { echo "Instale o que falta e rode de novo." >&2; exit 1; }

passo "2. Configuração e certificado"
if [[ ! -f config/openrange.json ]] && ! grep -qs '^TV_IP=' config/rede.env; then
  if (( SIMULAR )); then echo "   [simular] perguntaria o IP da TV"; else
    read -r -p "   IP da TV (veja em Configurações → Rede na TV): " ip
    python3 tools/config.py tv "$ip"
  fi
fi
(( SIMULAR )) || python3 tools/config.py env >/dev/null
eval "$(OPENRANGE_SO_LER=1 python3 tools/config.py env 2>/dev/null || python3 tools/config.py env)"
echo "   PC $PC_IP ($IFACE) · TV $TV_IP · redirects: $REDIRECTS"
if [[ -s certs/cert.pem && -s certs/key.pem ]]; then
  echo "   certificado: $(openssl x509 -in certs/cert.pem -noout -enddate | cut -d= -f2)"
else
  faz mkdir -p certs
  faz openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=openrange" -keyout certs/key.pem -out certs/cert.pem
  faz chmod 600 certs/key.pem
fi

passo "3. Arquivos que ficaram do root (de quando o portal rodava no distrobox rootful)"
mapfile -t donos_root < <(find logs cache config certs www -xdev ! -user "$USUARIO" 2>/dev/null | head -n 2000)
if (( ${#donos_root[@]} )); then
  echo "   ${#donos_root[@]} arquivo(s), ex.: ${donos_root[0]}"
  faz sudo chown -R "$USUARIO:$GRUPO" logs cache config certs
else echo "   nenhum"; fi

passo "4. Serviço do sistema: $UNIT"
escreve "$UNIT" sudo <<EOF
# Generated by tools/instalar.sh — OpenRange: portal (80/443/8090) + DNS (53) for the TV. Undo: tools/instalar.sh remover
# SELinux: Exec*= must start interpreters from /usr/bin (scripts under \$HOME can't be executed by systemd),
# and output goes to the journal (journalctl -u openrange), not to a file under logs/.
[Unit]
Description=openrange — portal e DNS da TV ($TV_IP)
Wants=network-online.target
After=network-online.target firewalld.service

[Service]
Type=simple
User=$USUARIO
Group=$GRUPO
WorkingDirectory=$RAIZ
Environment=PYTHONUNBUFFERED=1
# only the right to bind ports < 1024; nothing else from root
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
# "+" = these two run as root (runtime firewall); the portal runs as $USUARIO
ExecStartPre=+$BASH_BIN $RAIZ/tools/firewall.sh abrir
ExecStart=$PY $RAIZ/tools/portal.py
ExecStopPost=+$BASH_BIN $RAIZ/tools/firewall.sh fechar
Restart=on-failure
RestartSec=5
SyslogIdentifier=openrange

[Install]
WantedBy=multi-user.target
EOF
if (( ! SIMULAR )); then
  systemd-analyze verify "$UNIT" 2>&1 | grep -v "^$" | sed 's/^/   verify: /' || true
fi

SYSTEMCTL="$(command -v systemctl)"
if polkit_js; then
  passo "5. Regra do polkit: $POLKIT"
  [[ -f $SUDOERS ]] && faz sudo rm -f "$SUDOERS"
  escreve "$POLKIT" sudo <<EOF
// Generated by tools/instalar.sh — OpenRange. Undo: tools/instalar.sh remover
// Lets "$USUARIO" start/stop/restart openrange.service without a password (systemctl restart openrange).
// Only this unit and these verbs; enable/disable (manage-unit-files) and every other unit still ask for sudo.
polkit.addRule(function (action, subject) {
  var verbos = ["start", "stop", "restart", "try-restart", "reload-or-restart", "reload-or-try-restart", "reset-failed"];
  if (action.id == "org.freedesktop.systemd1.manage-units" &&
      action.lookup("unit") == "openrange.service" &&
      subject.user == "$USUARIO" &&
      verbos.indexOf(action.lookup("verb")) >= 0) {
    return polkit.Result.YES;
  }
  return polkit.Result.NOT_HANDLED;
});
EOF
else
  passo "5. Regra do sudoers (polkit sem regras JS): $SUDOERS"
  escreve "$SUDOERS" sudo 440 <<EOF
# Generated by tools/instalar.sh — OpenRange. Undo: tools/instalar.sh remover
# Lets $USUARIO start/stop/restart openrange.service without a password (old polkit can't filter by unit).
$USUARIO ALL=(root) NOPASSWD: $SYSTEMCTL start openrange.service, $SYSTEMCTL stop openrange.service, $SYSTEMCTL restart openrange.service, $SYSTEMCTL reset-failed openrange.service
EOF
  if (( ! SIMULAR )) && ! sudo visudo -cqf "$SUDOERS"; then
    echo "   ERRO: visudo recusou $SUDOERS; removendo" >&2; sudo rm -f "$SUDOERS"; exit 1
  fi
fi

passo "6. Parando o modo antigo (distrobox) e ligando o serviço"
if pgrep -f "python3 tools/portal.py" >/dev/null || pgrep -f "dnsmasq .*config/dnsmasq.conf" >/dev/null; then
  faz sudo pkill -f "python3 tools/portal.py" || true
  faz sudo pkill -f "dnsmasq .*config/dnsmasq.conf" || true
  faz sleep 2
fi
faz sudo systemctl daemon-reload
faz sudo systemctl enable --now openrange.service
faz sleep 3

passo "Pronto"
if (( SIMULAR )); then echo "   (simulação: nada foi mudado)"; exit 0; fi
# Done-when check of M3.1: a restart as this user, without sudo (polkit may take a moment to reload its rules).
sem_senha=0
for _ in 1 2 3 4 5; do
  if LC_ALL=C systemctl --no-ask-password restart openrange.service 2>/dev/null \
     || { ! polkit_js && sudo -k -n "$SYSTEMCTL" restart openrange.service 2>/dev/null; }; then sem_senha=1; break; fi
  sleep 1
done
(( sem_senha )) && echo "   systemctl restart openrange sem senha: ok" || echo "   AVISO: systemctl restart openrange ainda pede senha (polkit/sudoers)"
sleep 3
tools/openrange.sh saude || true
cat <<EOF

O OpenRange agora sobe sozinho no boot. DNS da TV = $PC_IP. Melhor no roteador (LAN/DHCP): DNS 1 = $PC_IP,
DNS 2 = 1.1.1.1 e a rede da TV em automático (PC desligado → a TV volta para a loja original).
  tools/openrange.sh estado | saude | reiniciar | parar | iniciar   (sem sudo; usam o serviço)
  journalctl -u openrange -f   ou   tail -f logs/portal.log
  tools/instalar.sh remover                                     (desfaz)
EOF
