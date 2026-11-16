#!/usr/bin/env bash
# gerar-dnsmasq.sh — builds config/dnsmasq.conf from config/rede.env
# and config/redirects.txt. No root needed; the user starts dnsmasq.
#
# Usage: tools/gerar-dnsmasq.sh            (builds and shows the active redirects)
#        VARIOS=1 tools/gerar-dnsmasq.sh   (allows more than one redirect; avoid)
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
python3 "$RAIZ/tools/config.py" env >/dev/null   # regera rede.env/redirects.txt de config/openrange.json
ENV_ARQ="$RAIZ/config/rede.env"
REDIRECTS="$RAIZ/config/redirects.txt"
SAIDA="$RAIZ/config/dnsmasq.conf"
LOG_DNS="$RAIZ/logs/dns.log"

erro() { echo "ERRO: $*" >&2; exit 1; }

[[ -r $ENV_ARQ ]] || erro "não achei $ENV_ARQ"
# shellcheck source=/dev/null
source "$ENV_ARQ"

re_ip='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
[[ ${PC_IP:-} =~ $re_ip ]] || erro "PC_IP inválido em rede.env: '${PC_IP:-}'"
[[ ${TV_IP:-} =~ $re_ip ]] || erro "TV_IP inválido em rede.env: '${TV_IP:-}'"

# --- read the redirects ------------------------------------------------------
re_dom='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
dominios=()
if [[ -r $REDIRECTS ]]; then
    n=0
    while IFS= read -r linha || [[ -n $linha ]]; do
        n=$((n + 1))
        linha="${linha%%#*}"                          # strip comment
        linha="$(echo "$linha" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
        [[ -z $linha ]] && continue
        [[ $linha =~ $re_dom ]] || erro "redirects.txt:$n: domínio inválido '$linha'"
        if [[ $linha == *netflix* || $linha == *nflx* ]]; then
            erro "redirects.txt:$n: '$linha' é da Netflix. Regra do projeto: nunca redirecionar."
        fi
        dominios+=("$linha")
    done < "$REDIRECTS"
fi

if (( ${#dominios[@]} > 1 )) && [[ ${VARIOS:-0} != 1 ]]; then
    erro "${#dominios[@]} redirects ativos (${dominios[*]}). A regra é um por vez; use VARIOS=1 se for intencional."
fi

# --- escreve o conf ---------------------------------------------------------
mkdir -p "$RAIZ/logs"
# Pre-create the log as the regular user: dnsmasq (root) only appends and the file
# stays readable without chmod. If dnsmasq created it, it would be root:root 0640.
[[ -e $LOG_DNS ]] || { touch "$LOG_DNS"; chmod 644 "$LOG_DNS"; }
tmp="$(mktemp "$SAIDA.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
{
    echo "# GERADO por tools/gerar-dnsmasq.sh em $(date '+%F %T'). Não edite à mão."
    echo "# Fontes: config/rede.env, config/redirects.txt"
    echo
    echo "# Escuta só no IP do PC na LAN (não briga com systemd-resolved nem libvirt)"
    echo "port=53"
    echo "listen-address=$PC_IP"
    echo "bind-interfaces"
    echo
    echo "# Upstream fixo; ignora /etc/resolv.conf e /etc/hosts do container"
    echo "no-resolv"
    echo "no-poll"
    echo "no-hosts"
    echo "server=1.1.1.1"
    echo "server=8.8.8.8"
    echo "domain-needed"
    echo "bogus-priv"
    echo
    echo "# Log de cada consulta (query/forwarded/reply) com o IP de quem perguntou"
    echo "log-queries"
    echo "log-facility=$LOG_DNS"
    echo
    echo "# Continua root: o home é 0700 e o usuário 'dnsmasq' não alcançaria o log."
    echo "# Modo manual antigo (DNSMASQ=1): roda no host via sudo."
    echo "user=root"
    echo "pid-file=/run/dnsmasq-openrange.pid"
    echo
    echo "# Redirects (TV_IP=$TV_IP vai bater na sonda em $PC_IP)"
    if (( ${#dominios[@]} == 0 )); then
        echo "# (nenhum: modo só-log)"
    fi
    for d in "${dominios[@]}"; do
        echo "address=/$d/$PC_IP"
    done
} > "$tmp"
mv "$tmp" "$SAIDA"
trap - EXIT
chmod 644 "$SAIDA"

echo "gerado: $SAIDA"
echo "  escuta: $PC_IP:53   log: $LOG_DNS"
if (( ${#dominios[@]} == 0 )); then
    echo "  redirects: nenhum (só log)"
else
    for d in "${dominios[@]}"; do echo "  redirect: $d (e subdomínios) -> $PC_IP"; done
fi
echo "Reinicie o dnsmasq (tools/openrange.sh reiniciar) para aplicar."
