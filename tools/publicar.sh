#!/usr/bin/env bash
# publicar.sh — builds the PUBLIC snapshot of OpenRange (M3.6): the committed tree (HEAD) minus the private/agent
# files, as a fresh git repo with ONE commit (the private history, with logs of the user's TV, never leaves this PC).
#
#   tools/publicar.sh DEST          creates DEST (must not exist), scans it, commits it
#   tools/publicar.sh --checar      scans a temp snapshot of the working tree (used by tools/sim/rodar.sh)
#
# Excluded: notes/ (agent journal and recon archive), CLAUDE.md, .claude/, docs/s20-root.md (personal plan).
# Scan: fails on MAC addresses, e-mails, home paths, the local user name, NetRange portal/device ids, keys/certs.
# Pushing is done by hand: cd DEST && git remote add origin … && git push -u origin main
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"
EXCLUIR=(notes CLAUDE.md .claude docs/s20-root.md)

DEST="${1:-}"; CHECAR=0
[[ $DEST == --checar ]] && { CHECAR=1; DEST="$(mktemp -d)/openrange"; trap 'rm -rf "$(dirname "$DEST")"' EXIT; }
[[ -n $DEST ]] || { echo "uso: $0 DEST | --checar" >&2; exit 2; }
[[ -e $DEST ]] && { echo "$DEST já existe" >&2; exit 1; }

mkdir -p "$DEST"
if (( CHECAR )); then   # the gate checks the working tree as a fresh clone would have it (tracked + new, nothing ignored)
  git ls-files -co --exclude-standard -z | tar --null -T - -c | tar -x -C "$DEST"
else
  git archive HEAD | tar -x -C "$DEST"
fi
for e in "${EXCLUIR[@]}"; do rm -rf "${DEST:?}/$e"; done

# --- privacy scan ----------------------------------------------------------------------------------------------
usuario="$(id -un)"
padroes=(
  '([0-9A-Fa-f]{2}(:|%3A|%253A)){5}[0-9A-Fa-f]{2}'      # MAC address (also URL-encoded, as in the portal's userID)
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}'       # e-mail
  '/(var/)?home/[a-z_][a-z0-9_-]+/'                     # someone's home path
  '[0-9a-f]{40}\.[0-9a-f]{32}'                          # NetRange portal id
  'BEGIN [A-Z ]*PRIVATE KEY'
  '(api_key|AccessToken|X-Emby-Token)["=: ]+[A-Za-z0-9]{24,}'   # a real-looking Jellyfin token (tests use tok123)
)
[[ $usuario =~ ^(root|teste|user)$ ]] || padroes+=("\\b$usuario\\b")
achados="$(cd "$DEST" && grep -rInE "$(IFS='|'; echo "${padroes[*]}")" . \
  | grep -vE '^\./www/lib/(vendor/|fontes/)' \
  | grep -vE 'noreply@|@example\.|@exemplo\.|git@github\.com|/home/teste/' || true)"
if [[ -n $achados ]]; then
  echo "publicar: dados possivelmente privados no snapshot:"; echo "$achados" | cut -c1-200 | head -20
  exit 1
fi
for f in captures logs certs firmware config/openrange.json config/rede.env cache; do
  [[ -e $DEST/$f ]] && { echo "publicar: $f não devia estar no snapshot"; exit 1; }
done
[[ -f $DEST/LICENSE && -f $DEST/README.md ]] || { echo "publicar: falta LICENSE ou README.md"; exit 1; }
n=$(cd "$DEST" && find . -type f | wc -l)
if (( CHECAR )); then echo "privacidade ok ($n arquivos no snapshot público)"; exit 0; fi

cd "$DEST"
git init -q -b main
git add -A
git commit -q -m "OpenRange $(date +%Y-%m-%d)"
echo "Snapshot público em $DEST ($n arquivos, 1 commit, autor: $(git log -1 --format='%an'))."
echo "Confira o e-mail do autor antes de publicar (o GitHub mostra): git -C $DEST log -1 --format=%ae"
