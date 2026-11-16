#!/usr/bin/env bash
# rodar.sh — simulation gate. Runs without the TV.
#   tools/sim/rodar.sh [-v]        Jellyfin client (www/jellyfin/) in node + jsdom against a fake API, the
#                                  privacy scan of the public snapshot (tools/publicar.sh --checar), the
#                                  installer check (tools/sim/instalacao.sh, nothing is installed), the
#                                  portal's store routing (tools/sim/portal-loja.py) and the control panel
#                                  (tools/sim/painel.py + painel-ui.js, on a temp copy of the project)
#   tools/sim/rodar.sh [-v] tudo   also the tests against the local TEST Jellyfin (tools/sim/jellyfin-teste.sh,
#                                  started here if it is down and stopped again at the end; token from tools/jf-perfil.py);
#                                  login/pairing tests need JF_USUARIO/JF_SENHA (env, or ~/.cache/openrange/sim.env);
#                                  pairing starts a test portal on :18080
#   tools/sim/rodar.sh [-v] limpa  real install → remove → reinstall on clean Fedora 43 / Debian 12 / Ubuntu 22.04
#                                  systemd containers (tools/sim/instalacao-limpa.sh; minutes, needs internet once)
# Without -v only step titles and errors are shown. Ends with "simulação ok" only if every test passed.
# First run installs jsdom in ~/.cache/openrange/sim (outside the project).
set -uo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
DEPS="$HOME/.cache/openrange/sim"
VERBOSO=0; TUDO=0; LIMPA=0
for a in "$@"; do case "$a" in -v) VERBOSO=1 ;; tudo) TUDO=1 ;; limpa) LIMPA=1 ;; *) echo "uso: $0 [-v] [tudo] [limpa]" >&2; exit 2 ;; esac; done
if [[ ! -d "$DEPS/node_modules/jsdom" ]]; then
  mkdir -p "$DEPS" && (cd "$DEPS" && npm init -y >/dev/null && npm i --silent jsdom@24.1.3) || { echo "FALHOU: npm i jsdom"; exit 1; }
fi
export NODE_PATH="$DEPS/node_modules"
# local test Jellyfin user, kept outside git (the environment wins if JF_USUARIO is already set)
if [[ -z "${JF_USUARIO:-}" && -f "$HOME/.cache/openrange/sim.env" ]]; then set -a; . "$HOME/.cache/openrange/sim.env"; set +a; fi
falhas=0

# r TITLE PATTERN CMD... — runs a test; fails on non-zero exit or an error line in the output
r() {
  local titulo="$1" padrao="$2" saida rc; shift 2
  echo; echo "=== $titulo"
  saida="$("$@" 2>&1)"; rc=$?
  if (( VERBOSO )); then echo "$saida"; else echo "$saida" | grep -E "$padrao" | cut -c1-220; fi
  if (( rc != 0 )) || echo "$saida" | grep -qE "ERRO|!!|TypeError"; then
    echo "--- FALHOU: $titulo (saída $rc)"; falhas=$((falhas + 1))
  fi
}

r "cliente Jellyfin (API falsa)" "^## |ERRO|!!|TypeError|Error" timeout 180 node "$AQUI/jellyfin-sim.js"
r "instalação (--simular)" "ERRO|ok$" "$AQUI/instalacao.sh"
r "privacidade do snapshot público" "publicar|ok" "$AQUI/../publicar.sh" --checar
r "portal: loja real vs. launcher" "ERRO|ok$" python3 "$AQUI/portal-loja.py"
r "firewall: regras de IP antigo da TV" "ERRO|ok" "$AQUI/firewall.sh"
r "painel de controle (API + página)" "ERRO|^## |ok$" timeout 240 python3 "$AQUI/painel.py"

if (( TUDO )); then
  if ! "$AQUI/jellyfin-teste.sh" ativo; then
    echo; echo "=== subindo o Jellyfin de teste"
    if "$AQUI/jellyfin-teste.sh" subir; then trap '"$AQUI/jellyfin-teste.sh" parar' EXIT
    else echo "--- FALHOU: Jellyfin de teste"; falhas=$((falhas + 1)); fi
  fi
  r "servidor real (J3/J4)" "ERRO|suspeitos" timeout 180 node "$AQUI/jellyfin-real.js"
  if [[ -n "${JF_USUARIO:-}" ]]; then
    r "J5 (login, ajustes, servidores)" "ERRO|ok \(" timeout 180 node "$AQUI/jellyfin-j5.js"
    (cd "$AQUI/../.." && DNS=0 PORTA_HTTP=18080 PORTA_HTTPS=18443 PORTA_CELULAR=18090 timeout 120 python3 tools/portal.py >/dev/null 2>&1 &)
    sleep 2
    r "pareamento com o celular" "ERRO|pareamento ok|ocorrências" timeout 100 node "$AQUI/jellyfin-par.js"
  else
    echo; echo "!! defina JF_USUARIO e JF_SENHA: os testes de login e pareamento fazem parte do portão"; falhas=$((falhas + 1))
  fi
fi

(( LIMPA )) && r "instalação em sistemas limpos" "ERRO|^[a-z]+: polkit|^remoto:|ok$" timeout 1800 "$AQUI/instalacao-limpa.sh"

echo
(( falhas )) && { echo "FALHOU: $falhas teste(s) (veja com -v)"; exit 1; }
echo "simulação ok"
