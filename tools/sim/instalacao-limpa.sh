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

(( erros )) && { echo "instalação limpa: $erros erro(s)"; exit 1; }
echo "instalação limpa ok"
