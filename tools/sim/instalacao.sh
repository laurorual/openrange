#!/usr/bin/env bash
# instalacao.sh — checks tools/instalar.sh without installing anything (uses --simular). Part of rodar.sh.
#   - the generated openrange.service is SELinux-safe: every Exec*= starts a program outside $HOME (systemd/init_t
#     can't execute user_home_t files) and no output is appended to a file (init_t can't write user_home_t);
#   - systemd-analyze verify accepts the unit;
#   - the polkit rule allows only start/stop/restart-like verbs on openrange.service for this user (polkit-regra.js);
#   - nothing Jellyfin-related is installed (no Quadlet, no linger: the TV uses the user's own server);
#   - "remover" removes the rule and closes the firewall.
# Prints "ERRO ..." lines on failure and ends with "instalação ok".
set -uo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"; RAIZ="$(cd "$AQUI/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
erros=0; erro() { echo "ERRO instalação: $*"; erros=$((erros + 1)); }

"$RAIZ/tools/instalar.sh" --simular > "$TMP/inst.txt" 2>&1 || erro "instalar.sh --simular saiu com erro ($(tail -1 "$TMP/inst.txt"))"
"$RAIZ/tools/instalar.sh" --simular remover > "$TMP/rem.txt" 2>&1 || erro "instalar.sh --simular remover saiu com erro"

# extract a file printed by escreve() in --simular: "[simular] gravaria DEST:" followed by "      | " lines
extrai() { awk -v d="$1" 'index($0, "[simular] gravaria " d ":") {on=1; next} on && /^      \| ?/ {sub(/^      \| ?/, ""); print; next} on {exit}' "$TMP/inst.txt"; }
extrai /etc/systemd/system/openrange.service > "$TMP/openrange.service"
extrai /etc/polkit-1/rules.d/50-openrange.rules > "$TMP/50-openrange.rules"
[[ -s $TMP/openrange.service ]] || erro "unit não encontrada na saída do --simular"
[[ -s $TMP/50-openrange.rules ]] || erro "regra do polkit não encontrada na saída do --simular"

# SELinux-safe Exec lines
while IFS= read -r linha; do
  prog="${linha#*=}"; prog="${prog#[+!@:-]}"; prog="${prog#[+!@:-]}"; prog="${prog%% *}"
  case "$prog" in
    /usr/*|/bin/*) ;;
    *) erro "Exec executa algo fora do sistema (SELinux bloqueia no boot): $linha" ;;
  esac
done < <(grep -E '^Exec[A-Za-z]*=' "$TMP/openrange.service")
grep -qE '^Exec(Start|StartPre|StopPost)=' "$TMP/openrange.service" || erro "unit sem ExecStart/ExecStartPre/ExecStopPost"
grep -qE '^Standard(Output|Error)=(append|file|truncate):' "$TMP/openrange.service" && erro "unit grava a saída num arquivo (SELinux: init_t não escreve em user_home_t)"
grep -q '^ExecStartPre=+.*firewall.sh abrir' "$TMP/openrange.service" || erro "unit não abre o firewall ao subir"
grep -q '^ExecStopPost=+.*firewall.sh fechar' "$TMP/openrange.service" || erro "unit não fecha o firewall ao parar"

if command -v systemd-analyze >/dev/null && [[ -s $TMP/openrange.service ]]; then
  v="$(systemd-analyze verify "$TMP/openrange.service" 2>&1 | grep -v '^$' || true)"
  [[ -z $v ]] || erro "systemd-analyze verify: $(echo "$v" | head -3 | tr '\n' ' ')"
fi

[[ -s $TMP/50-openrange.rules ]] && { node "$AQUI/polkit-regra.js" "$TMP/50-openrange.rules" "$(id -un)" || erros=$((erros + 1)); }

grep -qiE 'jellyfin|quadlet|enable-linger' "$TMP/inst.txt" && erro "instalar.sh ainda instala algo do servidor Jellyfin"
# order: enable --now after the polkit rule
n_regra=$(grep -n 'gravaria /etc/polkit-1' "$TMP/inst.txt" | head -1 | cut -d: -f1)
n_enable=$(grep -n 'systemctl enable --now openrange' "$TMP/inst.txt" | head -1 | cut -d: -f1)
[[ -n $n_regra && -n $n_enable && $n_regra -lt $n_enable ]] || erro "regra do polkit não vem antes do enable --now"

grep -q 'rm -f /etc/polkit-1/rules.d/50-openrange.rules' "$TMP/rem.txt" || erro "remover não apaga a regra do polkit"
grep -q 'firewall.sh fechar' "$TMP/rem.txt" || erro "remover não fecha o firewall"

(( erros )) && { echo "instalação: $erros erro(s)"; exit 1; }
echo "instalação ok"
