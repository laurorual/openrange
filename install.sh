#!/usr/bin/env bash
# install.sh — one-command install and update of OpenRange from GitHub (needs curl, tar, python3; no git).
#
#   curl -fsSL https://raw.githubusercontent.com/laurorual/openrange/main/install.sh -o install.sh
#   bash install.sh
#
# First run: downloads the main branch into ~/openrange (or $OPENRANGE_DIR) and runs tools/instalar.sh, which installs
# the systemd service and asks for the TV's IP.
# Later runs: compares the installed files with main and applies only the differences:
#   - new files are added, changed files replaced, files gone from main removed;
#   - a code file you edited is replaced too, but your copy is kept in .openrange/backup/<date>/ first;
#   - your settings are never overwritten: config/apps-proprios.json and config/inicio.json once you changed them,
#     and everything that is not in the repository (config/openrange.json, config/icones/, certs/, logs/, cache/);
#   - then the service restarts (or tools/instalar.sh runs again when the installer or the firewall script changed).
# OPENRANGE_URL overrides the tarball (the clean-install test uses file://).
set -euo pipefail
URL="${OPENRANGE_URL:-https://github.com/laurorual/openrange/archive/refs/heads/main.tar.gz}"
UNIT=/etc/systemd/system/openrange.service
PRESERVAR=(config/apps-proprios.json config/inicio.json)      # edited by the control panel

[[ $EUID -eq 0 ]] && { echo "Rode como seu usuário, sem sudo (o instalador pede a senha quando precisa)." >&2; exit 1; }
for c in curl tar sha256sum python3; do command -v "$c" >/dev/null || { echo "Falta o comando: $c" >&2; exit 1; }; done

# Where: the folder of an already installed service wins over the default.
DIR="${OPENRANGE_DIR:-$HOME/openrange}"
if [[ -f $UNIT ]]; then
  d="$(sed -n 's/^WorkingDirectory=//p' "$UNIT" | head -1)"
  [[ -n $d ]] && DIR="$d"
fi
if [[ -e $DIR/.git ]]; then
  echo "$DIR é um clone git (instalação de desenvolvimento): atualize com git pull, não com este script." >&2; exit 1
fi
META="$DIR/.openrange"; MANIF="$META/manifesto"
if [[ -d $DIR && -n "$(ls -A "$DIR" 2>/dev/null)" && ! -f $MANIF && ! -f $DIR/tools/instalar.sh ]]; then
  echo "$DIR já existe e não é o OpenRange. Use outra pasta: OPENRANGE_DIR=/outra/pasta bash install.sh" >&2; exit 1
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "== Baixando o OpenRange"
curl -fsSL "$URL" -o "$TMP/openrange.tar.gz" || { echo "Não consegui baixar $URL" >&2; exit 1; }
mkdir "$TMP/novo"
tar -xzf "$TMP/openrange.tar.gz" -C "$TMP/novo" --strip-components=1
[[ -f $TMP/novo/tools/instalar.sh ]] || { echo "Download inesperado (sem tools/instalar.sh)." >&2; exit 1; }

sha() { sha256sum "$1" | cut -d' ' -f1; }
preservar() { local p; for p in "${PRESERVAR[@]}"; do [[ $1 == "$p" ]] && return 0; done; return 1; }
declare -A ANTIGO=() NOVO=()
[[ -f $MANIF ]] && while read -r h f; do ANTIGO["$f"]="$h"; done < "$MANIF"
ATUALIZACAO=0; [[ -f $MANIF || -f $DIR/tools/instalar.sh ]] && ATUALIZACAO=1
mkdir -p "$DIR" "$META"
BACKUP="$META/backup/$(date +%Y%m%d-%H%M%S)"
guarda() { mkdir -p "$BACKUP/$(dirname "$1")"; cp -p "$DIR/$1" "$BACKUP/$1"; }
copia() { install -D -m "$(stat -c %a "$TMP/novo/$1")" "$TMP/novo/$1" "$DIR/$1"; }
novos=0; alterados=0; removidos=0; mantidos=0; instalador=0

echo "== Comparando com a versão do GitHub ($DIR)"
while IFS= read -r -d '' f; do
  f="${f#./}"; h="$(sha "$TMP/novo/$f")"; NOVO["$f"]="$h"
  if [[ ! -e $DIR/$f ]]; then
    copia "$f"; novos=$((novos + 1)); (( ATUALIZACAO )) && echo "   novo: $f"
  else
    atual="$(sha "$DIR/$f")"
    [[ $atual == "$h" ]] && continue
    antigo="${ANTIGO[$f]:-}"
    if preservar "$f" && [[ $atual != "$antigo" ]]; then        # you changed it (or no record): keep yours
      mantidos=$((mantidos + 1)); echo "   mantido (sua versão): $f"; continue
    fi
    [[ $atual != "$antigo" ]] && guarda "$f"                     # edited by you: keep a copy before replacing
    copia "$f"; alterados=$((alterados + 1)); echo "   atualizado: $f"
  fi
  case $f in tools/instalar.sh|tools/firewall.sh) instalador=1 ;; esac
done < <(cd "$TMP/novo" && find . -type f -print0 | sort -z)

for f in "${!ANTIGO[@]}"; do
  [[ -n ${NOVO[$f]:-} || ! -e $DIR/$f ]] && continue
  [[ "$(sha "$DIR/$f")" != "${ANTIGO[$f]}" ]] && guarda "$f"
  rm -f "$DIR/$f"; removidos=$((removidos + 1)); echo "   removido: $f"
done

for f in "${!NOVO[@]}"; do printf '%s  %s\n' "${NOVO[$f]}" "$f"; done | sort -k2 > "$MANIF"
[[ -d $BACKUP ]] && echo "   cópias dos arquivos que você tinha alterado: $BACKUP"
mudou=$((novos + alterados + removidos))
cd "$DIR"

if [[ ! -f $UNIT ]]; then
  echo "== Instalando o serviço ($novos arquivos em $DIR)"
  tools/instalar.sh
elif (( mudou == 0 )); then
  echo "Já está na versão mais recente ($DIR)."
else
  echo "== $novos novo(s), $alterados atualizado(s), $removidos removido(s), $mantidos mantido(s)"
  if (( instalador )); then tools/instalar.sh          # unit/rules may have changed; it restarts the service
  else tools/openrange.sh reiniciar; fi
  echo; echo "Novidades (Changelog do README):"
  awk '/^## Changelog/{c=1; next} c && /^### /{n++} c && n==2{exit} c && n>=1' README.md | head -20
fi
