#!/usr/bin/env bash
# firewall.sh (gate) — tools/firewall.sh abrir against a FAKE firewall-cmd: rules left for an old TV IP are removed,
# the current TV's rules and unrelated rules are kept. Nothing touches the real firewall. Prints "firewall ok".
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
eval "$(OPENRANGE_SO_LER=1 python3 "$RAIZ/tools/config.py" env)"
cat > "$T/firewall-cmd" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "$T/chamadas"
case "\$*" in
  *--state*|*--info-zone*) exit 0 ;;
  *--query-rich-rule*) exit 1 ;;
  *--list-rich-rules*)
    echo 'rule family="ipv4" source address="$TV_IP" port port="$PORTA_HTTP" protocol="tcp" accept'
    echo 'rule family="ipv4" source address="10.9.9.9" port port="$PORTA_DNS" protocol="udp" accept'
    echo 'rule family="ipv4" source address="10.9.9.9" port port="$PORTA_HTTPS" protocol="tcp" accept'
    echo 'rule family="ipv4" source address="10.9.9.9" port port="22" protocol="tcp" accept' ;;
esac
exit 0
STUB
chmod +x "$T/firewall-cmd"
PATH="$T:$PATH" bash "$RAIZ/tools/firewall.sh" abrir >/dev/null
removidas=$(grep -c -- '--remove-rich-rule' "$T/chamadas")
adicionadas=$(grep -c -- '--add-rich-rule' "$T/chamadas")
ruins=$(grep -- '--remove-rich-rule' "$T/chamadas" | grep -c -e "$TV_IP" -e 'port="22"')
esperadas=$((5 + $(wc -w <<<"$PAINEL_IPS")))      # 5 for the TV + 1 per painel.ips_extras entry of this config
if [[ $removidas == 2 && $adicionadas == $esperadas && $ruins == 0 ]]; then echo "firewall ok (2 regras do IP antigo removidas, $esperadas adicionadas)"
else echo "ERRO firewall: removidas=$removidas adicionadas=$adicionadas erradas=$ruins"; cat "$T/chamadas"; exit 1; fi
