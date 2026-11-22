#!/usr/bin/env bash
# firewall.sh — OpenRange's RUNTIME firewalld rules (never --permanent): DNS, HTTP, HTTPS and the phone port (8090),
# open only to the TV's IP.
#   sudo tools/firewall.sh abrir | fechar | ver      tools/firewall.sh zona   (no sudo: prints the zone used)
# openrange.service calls "abrir" on start and "fechar" on stop. "fechar" removes only these rules (no --reload, which
# would wipe other runtime rules of the machine). Without firewalld it does nothing (e.g. Debian/Ubuntu default).
# Zone: config rede.zona_firewall; "auto" (default) = the zone of the interface that reaches the TV, else the
# default zone (FedoraWorkstation on Fedora desktops, FedoraServer, public, ...).
set -euo pipefail
cd "$(dirname "$0")/.."
eval "$(OPENRANGE_SO_LER=1 python3 tools/config.py env)"
command -v firewall-cmd >/dev/null || { echo "firewall.sh: sem firewall-cmd, nada a fazer"; exit 0; }
firewall-cmd -q --state 2>/dev/null || { echo "firewall.sh: firewalld parado, nada a fazer"; exit 0; }
if [[ -z $FW_ZONE || $FW_ZONE == auto ]] || ! firewall-cmd -q --info-zone="$FW_ZONE" >/dev/null 2>&1; then
  FW_ZONE="$(firewall-cmd --get-zone-of-interface="$IFACE" 2>/dev/null || firewall-cmd --get-default-zone)"
fi
regras=()
for p in "$PORTA_DNS/udp" "$PORTA_DNS/tcp" "$PORTA_HTTP/tcp" "$PORTA_HTTPS/tcp" "$PORTA_CELULAR/tcp"; do
  regras+=("rule family=ipv4 source address=$TV_IP port port=${p%/*} protocol=${p#*/} accept")
done
for ip in $PAINEL_IPS; do      # painel.ips_extras, validated by config.py
  regras+=("rule family=ipv4 source address=$ip port port=$PORTA_CELULAR protocol=tcp accept")
done
case "${1:-ver}" in
  abrir)  # rules for an OLD TV IP (rede.tv_ip changed): same shape and ports as ours, other source → removed
          portas_re="($PORTA_DNS|$PORTA_HTTP|$PORTA_HTTPS|$PORTA_CELULAR)"
          while IFS= read -r r; do
            [[ $r =~ ^rule\ family=\"?ipv4\"?\ source\ address=\"?([0-9./]+)\"?\ port\ port=\"?$portas_re\"?\ protocol=\"?(tcp|udp)\"?\ accept$ ]] || continue
            [[ ${BASH_REMATCH[1]} == "$TV_IP" ]] && continue
            [[ ${BASH_REMATCH[2]} == "$PORTA_CELULAR" && " $PAINEL_IPS " == *" ${BASH_REMATCH[1]} "* ]] && continue
            firewall-cmd -q --zone="$FW_ZONE" --remove-rich-rule="$r" && echo "firewall: regra antiga removida ($r)"
          done < <(firewall-cmd --zone="$FW_ZONE" --list-rich-rules 2>/dev/null)
          for r in "${regras[@]}"; do firewall-cmd -q --zone="$FW_ZONE" --query-rich-rule="$r" || firewall-cmd -q --zone="$FW_ZONE" --add-rich-rule="$r"; done
          echo "firewall: liberado para a TV $TV_IP (zona $FW_ZONE, só runtime)" ;;
  fechar) for r in "${regras[@]}"; do firewall-cmd -q --zone="$FW_ZONE" --query-rich-rule="$r" && firewall-cmd -q --zone="$FW_ZONE" --remove-rich-rule="$r" || true; done
          echo "firewall: regras do OpenRange removidas" ;;
  ver)    firewall-cmd --zone="$FW_ZONE" --list-rich-rules ;;
  zona)   echo "$FW_ZONE" ;;
  *)      echo "uso: $0 abrir|fechar|ver|zona" >&2; exit 2 ;;
esac
