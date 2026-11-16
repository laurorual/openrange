#!/usr/bin/env bash
# instalacao-limpa.sh — M3.2: runs tools/instalar.sh for real on clean systems (rootless podman containers that
# boot systemd), from a copy of this working tree, as a normal user. Nothing touches the host.
#
#   tools/sim/instalacao-limpa.sh [fedora|debian|ubuntu ...]     default: all three
#
#   fedora = Fedora 43 (polkit JS rules), debian = Debian 12 (polkit 122, JS rules),
#   ubuntu = Ubuntu 22.04 (polkit 0.105: no JS rules → sudoers fallback; systemd-resolved owns 127.0.0.53:53).
# Per system: install (TV IP typed at the prompt) → the user, WITHOUT sudo rights, can restart openrange.service but
# not another unit and not disable it → portal answers HTTP and DNS redirects → remover leaves nothing behind →
# reinstall works again. Prints "ERRO ..." on failure, ends with "instalação limpa ok". Needs internet (images).
set -uo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"; RAIZ="$(cd "$AQUI/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"; for c in "${CONTAINERS[@]}"; do podman rm -f "$c" >/dev/null 2>&1; done' EXIT
CONTAINERS=()
SISTEMAS=("$@"); (( ${#SISTEMAS[@]} )) || SISTEMAS=(fedora debian ubuntu)
TV=192.0.2.10                                         # TEST-NET: only needs a route, nothing answers there
erros=0; erro() { echo "ERRO limpa[$S]: $*"; erros=$((erros + 1)); }

imagem() {   # builds localhost/openrange-limpa-<sys> once (cached by podman)
  local f="$TMP/Containerfile.$1"
  case "$1" in
    fedora) cat > "$f" <<'EOF'
FROM registry.fedoraproject.org/fedora:43
RUN dnf -y install systemd polkit dbus-broker sudo python3 curl openssl iproute bind-utils procps-ng findutils && dnf clean all
EOF
    ;;
    debian) cat > "$f" <<'EOF'
FROM docker.io/library/debian:12
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus \
    polkitd sudo python3 curl openssl ca-certificates iproute2 dnsutils procps && rm -rf /var/lib/apt/lists/*
EOF
    ;;
    ubuntu) cat > "$f" <<'EOF'
FROM docker.io/library/ubuntu:22.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus \
    policykit-1 systemd-resolved sudo python3 curl openssl ca-certificates iproute2 dnsutils procps && rm -rf /var/lib/apt/lists/* \
 || (apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus \
    policykit-1 sudo python3 curl openssl ca-certificates iproute2 dnsutils procps && rm -rf /var/lib/apt/lists/*)
EOF
    ;;
    *) echo "sistema desconhecido: $1" >&2; return 1 ;;
  esac
  # test image only: polkitd's unit (sandboxing + User=) can't start in a rootless container (status=217/USER),
  # so it is replaced by a plain unit running the same polkitd. Doesn't change what is tested (installer + rule).
  cat >> "$f" <<'EOF'
RUN u=/usr/lib/systemd/system/polkit.service; [ -f $u ] || u=/lib/systemd/system/polkit.service; \
    printf '[Unit]\nDescription=polkit (test container, no sandbox)\n[Service]\nType=dbus\nBusName=org.freedesktop.PolicyKit1\nExecStart=%s\n' \
      "$(grep '^ExecStart=' $u | cut -d= -f2-)" > /etc/systemd/system/polkit.service
EOF
  podman build -q -t "localhost/openrange-limpa-$1" -f "$f" "$TMP" >/dev/null
}

raiz() { podman exec "$C" bash -c "$1"; }
usuario() { podman exec -u teste -w /home/teste/openrange "$C" bash -c "$1"; }

# a copy of the working tree as a fresh clone would have it (tracked + new files, nothing ignored)
(cd "$RAIZ" && git ls-files -co --exclude-standard -z | tar --null -T - -cf "$TMP/openrange.tar")

for S in "${SISTEMAS[@]}"; do
  echo "--- $S"
  imagem "$S" || { erro "não consegui montar a imagem"; continue; }
  C="openrange-limpa-$S-$$"; CONTAINERS+=("$C")
  podman run -d --name "$C" --systemd=always --hostname "limpa-$S" "localhost/openrange-limpa-$S" /sbin/init >/dev/null \
    || { erro "container não subiu"; continue; }
  for _ in $(seq 30); do raiz 'systemctl is-system-running 2>/dev/null | grep -qE "running|degraded"' && break; sleep 1; done
  raiz 'useradd -m -s /bin/bash teste && echo "teste ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/90-teste-instalador && chmod 440 /etc/sudoers.d/90-teste-instalador
        printf "[Service]\nType=oneshot\nExecStart=/bin/true\n" > /etc/systemd/system/outro.service
        # an install from before the rename (tvlab): the installer must remove it
        printf "[Service]\nExecStart=/bin/sleep infinity\n[Install]\nWantedBy=multi-user.target\n" > /etc/systemd/system/tvlab.service
        mkdir -p /etc/polkit-1/rules.d && echo "// old" > /etc/polkit-1/rules.d/50-tvlab.rules && echo "# old" > /etc/sudoers.d/tvlab
        systemctl daemon-reload && systemctl enable --now tvlab.service >/dev/null 2>&1'
  podman cp "$TMP/openrange.tar" "$C:/tmp/openrange.tar"
  raiz 'mkdir /home/teste/openrange && tar -xf /tmp/openrange.tar -C /home/teste/openrange && chown -R teste: /home/teste/openrange'

  # 1. install as the user (sudo works, like the real user typing the password); the TV IP comes from the prompt
  usuario "echo $TV | tools/instalar.sh" > "$TMP/$S.inst" 2>&1 || erro "instalar.sh falhou: $(tail -3 "$TMP/$S.inst" | tr '\n' ' ')"
  grep -q 'restart openrange sem senha: ok' "$TMP/$S.inst" || erro "o instalador não confirmou o restart sem senha"
  PC=$(usuario 'eval "$(python3 tools/config.py env)"; echo $PC_IP')

  # 2. without sudo rights: openrange.service yes, anything else no
  raiz 'rm -f /etc/sudoers.d/90-teste-instalador'
  usuario 'systemctl --no-ask-password restart openrange.service 2>/dev/null || sudo -k -n "$(command -v systemctl)" restart openrange.service' \
    >/dev/null 2>&1 || erro "usuário não consegue reiniciar o openrange.service sem senha"
  usuario 'systemctl --no-ask-password restart outro.service 2>/dev/null || sudo -k -n "$(command -v systemctl)" restart outro.service 2>/dev/null' \
    && erro "usuário reiniciou OUTRA unit sem senha (regra larga demais)"
  usuario 'systemctl --no-ask-password disable openrange.service 2>/dev/null || sudo -k -n "$(command -v systemctl)" disable openrange.service 2>/dev/null' \
    && erro "usuário desabilitou o openrange.service sem senha"
  sleep 3
  raiz 'ls /etc/systemd/system/tvlab.service /etc/polkit-1/rules.d/50-tvlab.rules /etc/sudoers.d/tvlab 2>/dev/null' | grep . \
    && erro "a instalação antiga (tvlab) ficou para trás"
  raiz 'systemctl is-active -q tvlab.service' && erro "tvlab.service antigo ainda rodando"
  raiz 'systemctl is-active -q openrange.service' || erro "openrange.service não está ativo: $(raiz 'journalctl -u openrange -n 5 --no-pager' | tr '\n' ' ')"
  raiz 'systemctl is-enabled -q openrange.service' || erro "openrange.service não sobe no boot"
  c=$(raiz "curl -s -o /dev/null -m 5 -w '%{http_code}' http://$PC/api/inicio")
  [[ $c == 200 ]] || erro "portal: /api/inicio → $c"
  d=$(raiz "dig +short +time=2 +tries=1 @$PC api-portal-v3.netrange.com | tail -1")
  [[ $d == "$PC" ]] || erro "DNS: api-portal-v3.netrange.com → '$d' (esperava $PC)"
  usuario 'tools/openrange.sh saude' > "$TMP/$S.saude" 2>&1
  grep -qE '✓ systemctl start/stop/restart openrange sem senha' "$TMP/$S.saude" || erro "saude não vê o restart sem senha"
  raiz 'ps -o user= -C python3' | grep -qx teste || erro "o portal não roda como o usuário"

  # 3. remover (sudo again), nothing left; then reinstall
  raiz 'echo "teste ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/90-teste-instalador && chmod 440 /etc/sudoers.d/90-teste-instalador'
  usuario 'tools/instalar.sh remover' > "$TMP/$S.rem" 2>&1 || erro "remover falhou: $(tail -3 "$TMP/$S.rem" | tr '\n' ' ')"
  raiz 'ls /etc/systemd/system/openrange.service /etc/polkit-1/rules.d/50-openrange.rules /etc/sudoers.d/openrange 2>/dev/null' | grep . \
    && erro "remover deixou arquivos"
  raiz 'systemctl is-active -q openrange.service' && erro "openrange.service ainda ativo depois do remover"
  raiz "curl -s -m 3 http://$PC/ >/dev/null" && erro "porta 80 ainda responde depois do remover"
  # manual mode (no unit): portal + DNS through sudo on the host, then stopped again
  usuario 'tools/openrange.sh iniciar' > "$TMP/$S.manual" 2>&1 || erro "modo manual: iniciar falhou: $(tail -3 "$TMP/$S.manual" | tr '\n' ' ')"
  d=$(raiz "dig +short +time=2 +tries=1 @$PC api-portal-v3.netrange.com | tail -1")
  [[ $d == "$PC" ]] || erro "modo manual: DNS → '$d' (esperava $PC)"
  c=$(raiz "curl -s -o /dev/null -m 5 -w '%{http_code}' http://$PC/api/inicio")
  [[ $c == 200 ]] || erro "modo manual: /api/inicio → $c"
  usuario 'tools/openrange.sh parar' >> "$TMP/$S.manual" 2>&1
  sleep 1; raiz "curl -s -m 3 http://$PC/ >/dev/null" && erro "modo manual: porta 80 ainda responde depois do parar"
  usuario 'tools/instalar.sh' > "$TMP/$S.reinst" 2>&1 || erro "reinstalação falhou: $(tail -3 "$TMP/$S.reinst" | tr '\n' ' ')"
  sleep 2
  c=$(raiz "curl -s -o /dev/null -m 5 -w '%{http_code}' http://$PC/api/inicio")
  [[ $c == 200 ]] || erro "depois de reinstalar: /api/inicio → $c"
  echo "$S: polkit $(raiz 'pkaction --version 2>/dev/null | awk "{print \$NF}"') · $(grep -oiE 'regra (do polkit|do sudoers)' "$TMP/$S.inst" | head -1) · PC $PC"
  podman rm -f "$C" >/dev/null
done

# 4. one-command install/update (install.sh) from tarballs shaped like GitHub's (Fedora only: same code everywhere)
if [[ " ${SISTEMAS[*]} " == *" fedora "* ]]; then
  S=remoto; echo "--- install.sh (fedora)"
  "$RAIZ/tools/publicar.sh" --tar "$TMP/v1.tar.gz" >/dev/null || erro "publicar.sh --tar falhou"
  mkdir -p "$TMP/v2" && tar -xzf "$TMP/v1.tar.gz" -C "$TMP/v2"
  V2="$TMP/v2/openrange-main"
  echo "<!-- v2 -->" >> "$V2/www/index.html"                       # changed upstream
  echo "novo" > "$V2/www/novo.txt"                                 # added upstream
  rm "$V2/www/video/index.html"                                    # removed upstream
  echo '[]' > "$V2/config/apps-proprios.json"                      # upstream changes a file the user edited
  tar -czf "$TMP/v2.tar.gz" -C "$TMP/v2" openrange-main
  C="openrange-remoto-$$"; CONTAINERS+=("$C")
  podman run -d --name "$C" --systemd=always --hostname remoto localhost/openrange-limpa-fedora /sbin/init >/dev/null || erro "container não subiu"
  for _ in $(seq 30); do raiz 'systemctl is-system-running 2>/dev/null | grep -qE "running|degraded"' && break; sleep 1; done
  raiz 'useradd -m -s /bin/bash teste && echo "teste ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/90-teste && chmod 440 /etc/sudoers.d/90-teste'
  for f in v1.tar.gz v2.tar.gz; do podman cp "$TMP/$f" "$C:/tmp/$f"; done
  podman cp "$RAIZ/install.sh" "$C:/tmp/install.sh"
  em_casa() { podman exec -u teste -w /home/teste "$C" bash -c "$1"; }
  em_casa "echo $TV | OPENRANGE_URL=file:///tmp/v1.tar.gz bash /tmp/install.sh" > "$TMP/r1" 2>&1 \
    || erro "install.sh (1ª vez) falhou: $(tail -3 "$TMP/r1" | tr '\n' ' ')"
  raiz 'systemctl is-active -q openrange.service' || erro "install.sh: serviço não ficou ativo"
  raiz 'grep -qx "WorkingDirectory=/home/teste/openrange" /etc/systemd/system/openrange.service' || erro "install.sh: pasta errada"
  PC=$(em_casa 'cd openrange && eval "$(python3 tools/config.py env)"; echo $PC_IP')
  c=$(raiz "curl -s -o /dev/null -m 5 -w '%{http_code}' http://$PC/api/inicio"); [[ $c == 200 ]] || erro "install.sh: /api/inicio → $c"
  # the user edits settings (panel) and a code file
  em_casa 'echo >> openrange/config/apps-proprios.json; echo "# meu" >> openrange/tools/repetir.py'
  t1=$(raiz 'systemctl show -p ActiveEnterTimestampMonotonic --value openrange.service')
  em_casa "OPENRANGE_URL=file:///tmp/v2.tar.gz bash /tmp/install.sh" > "$TMP/r2" 2>&1 \
    || erro "install.sh (atualização) falhou: $(tail -3 "$TMP/r2" | tr '\n' ' ')"
  em_casa 'grep -q "v2" openrange/www/index.html' || erro "atualização: arquivo alterado não veio"
  em_casa 'test -f openrange/www/novo.txt' || erro "atualização: arquivo novo não veio"
  em_casa 'test -e openrange/www/video/index.html' && erro "atualização: arquivo removido continua lá"
  em_casa 'test "$(cat openrange/config/apps-proprios.json)" != "[]"' || erro "atualização: sobrescreveu a configuração do usuário"
  em_casa 'grep -q "# meu" openrange/tools/repetir.py' && erro "atualização: código editado não voltou ao do GitHub"
  em_casa 'ls openrange/.openrange/backup/*/tools/repetir.py >/dev/null 2>&1' || erro "atualização: sem cópia do código editado"
  em_casa 'test -f openrange/config/openrange.json && test -s openrange/certs/cert.pem' || erro "atualização: perdeu config/certificado"
  t2=$(raiz 'systemctl show -p ActiveEnterTimestampMonotonic --value openrange.service')
  [[ $t2 != "$t1" ]] || erro "atualização: serviço não reiniciou"
  raiz 'systemctl is-active -q openrange.service' || erro "atualização: serviço parado"
  em_casa "OPENRANGE_URL=file:///tmp/v2.tar.gz bash /tmp/install.sh" 2>&1 | grep -q "versão mais recente" \
    || erro "3ª vez: devia dizer que já está atualizado"
  echo "remoto: $(grep -c '^   ' "$TMP/r2") mudanças na atualização · $(grep -o 'mantido (sua versão): [^ ]*' "$TMP/r2" | head -1)"
  podman rm -f "$C" >/dev/null
fi

(( erros )) && { echo "instalação limpa: $erros erro(s)"; exit 1; }
echo "instalação limpa ok"
