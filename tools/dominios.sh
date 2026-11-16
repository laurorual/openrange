#!/usr/bin/env bash
# dominios.sh — lists the domains the TV looked up in logs/dns.log, with counts,
# separating "known/ignorable" from "candidates".
#
# Usage: tools/dominios.sh [options] [START [END]]
#   START/END    time HH:MM or HH:MM:SS (END optional; without it, up to the end of the log)
#   -d 'Nov 15'  filter the day (dnsmasq format: English month + day)
#   -a           every client (default: only TV_IP from config/rede.env)
#   -f FILE      another log file (default: logs/dns.log)
#   -t           also show the record types (A, AAAA, ...) per domain
#
# Exemplos:
#   tools/dominios.sh                    # whole session, TV only
#   tools/dominios.sh 14:50 14:55        # only what the TV asked in that window
#   tools/dominios.sh -d 'Nov 15' 20:10  # on the 15th, from 20:10 on
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
LOG="$RAIZ/logs/dns.log"
CLIENTE=""
DIA=""
TIPOS=0

# Patterns (substring, case-insensitive) considered known/ignorable.
IGNORAVEIS="netflix nflx google gstatic youtube ytimg ggpht ntp in-addr.arpa ip6.arpa"

[[ -r $RAIZ/config/rede.env ]] && source "$RAIZ/config/rede.env"
CLIENTE="${TV_IP:-}"

while getopts ":ad:f:th" opt; do
    case $opt in
        a) CLIENTE="" ;;
        d) DIA="$OPTARG" ;;
        f) LOG="$OPTARG" ;;
        t) TIPOS=1 ;;
        h) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "opção inválida; use -h" >&2; exit 1 ;;
    esac
done
shift $((OPTIND - 1))

norm_hora() {  # $1=time  $2=default seconds
    local h="$1"
    [[ $h =~ ^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$ ]] || { echo "horário inválido: $h (use HH:MM)" >&2; exit 1; }
    [[ $h =~ ^[0-9]: ]] && h="0$h"
    [[ $h =~ ^[0-9]{2}:[0-9]{2}$ ]] && h="$h:$2"
    echo "$h"
}
INICIO="00:00:00"; FIM="23:59:59"
[[ $# -ge 1 ]] && INICIO="$(norm_hora "$1" 00)"
[[ $# -ge 2 ]] && FIM="$(norm_hora "$2" 59)"

[[ -e $LOG ]] || { echo "não existe: $LOG" >&2; exit 1; }
[[ -r $LOG ]] || { echo "sem permissão de leitura em $LOG — rode no [HOST]: sudo chmod a+r logs/*" >&2; exit 1; }

# Typical dnsmasq line:
#   Nov 15 14:35:01 dnsmasq[123]: query[A] api.example.com from 192.168.15.13
tabela="$(awk -v ini="$INICIO" -v fim="$FIM" -v cli="$CLIENTE" -v dia="$DIA" -v ign="$IGNORAVEIS" '
BEGIN { n = split(tolower(ign), pad, " ") }
{
    q = 0
    for (i = 4; i <= NF; i++) if (substr($i, 1, 6) == "query[") { q = i; break }
    if (!q || $(q+2) != "from") next
    if (dia != "") { split(dia, dd, " "); if ($1 != dd[1] || $2 + 0 != dd[2] + 0) next }
    hora = $3; if (hora ~ /^[0-9]:/) hora = "0" hora
    if (hora < ini || hora > fim) next
    ip = $(q+3); sub(/\/.*/, "", ip)
    if (cli != "" && ip != cli) next
    tipo = substr($q, 7); sub(/\]$/, "", tipo)
    d = tolower($(q+1))
    total++
    cont[d]++
    if (!(d in prim)) prim[d] = hora
    ult[d] = hora
    if (index("," tipos[d] ",", "," tipo ",") == 0) tipos[d] = (tipos[d] == "" ? tipo : tipos[d] "," tipo)
}
END {
    for (d in cont) {
        cls = "2cand"
        for (j = 1; j <= n; j++) if (index(d, pad[j])) { cls = "1ign"; break }
        printf "%s\t%d\t%s\t%s\t%s\t%s\n", cls, cont[d], prim[d], ult[d], tipos[d], d
    }
}' "$LOG" | sort -t $'\t' -k1,1r -k2,2nr -k6,6)"

alvo="${CLIENTE:-todos os clientes}"
faixa="$INICIO–$FIM${DIA:+ ($DIA)}"
echo "Log: $LOG"
echo "Cliente: $alvo   Faixa: $faixa"

if [[ -z $tabela ]]; then
    echo
    echo "Nenhuma consulta encontrada nesse filtro."
    if [[ -n $CLIENTE ]]; then
        echo "Clientes que aparecem no log (pode ser que a TV não esteja usando este DNS):"
        awk '{ for (i=4;i<=NF;i++) if (substr($i,1,6)=="query[" && $(i+2)=="from") { ip=$(i+3); sub(/\/.*/,"",ip); c[ip]++ } }
             END { for (ip in c) printf "  %6d  %s\n", c[ip], ip }' "$LOG" | sort -rn
    fi
    exit 0
fi

awk -F '\t' -v tipos="$TIPOS" '
function cab(t) {
    printf "\n== %s ==\n", t
    if (tipos) printf "%7s  %-8s  %-8s  %-10s  %s\n", "qtd", "1a vez", "ultima", "tipos", "dominio"
    else       printf "%7s  %-8s  %-8s  %s\n", "qtd", "1a vez", "ultima", "dominio"
}
{
    if ($1 != atual) { atual = $1; cab($1 == "2cand" ? "CANDIDATOS" : "CONHECIDOS / IGNORAVEIS") }
    if (tipos) printf "%7d  %-8s  %-8s  %-10s  %s\n", $2, $3, $4, $5, $6
    else       printf "%7d  %-8s  %-8s  %s\n", $2, $3, $4, $6
    q[$1] += $2; nd[$1]++
}
END {
    printf "\nResumo: %d candidatos (%d consultas), %d ignoraveis (%d consultas)\n",
        nd["2cand"], q["2cand"], nd["1ign"], q["1ign"]
}' <<< "$tabela"
