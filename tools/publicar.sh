#!/usr/bin/env bash
# publicar.sh — publishes OpenRange to GitHub (https://github.com/laurorual/openrange, branch main).
# The public repo gets the committed tree (HEAD) minus the private/agent files, one commit per publish, on top of
# what is already there (the private history, with logs of the user's TV, never leaves this PC).
#
#   tools/publicar.sh [-m "message"]   sync HEAD into cache/publico (a clone of the public repo), scan, commit, push
#   tools/publicar.sh --checar         only scan a temp snapshot of the working tree (gate: tools/sim/rodar.sh)
#   tools/publicar.sh --tar FILE       working-tree snapshot as a GitHub-like tarball (openrange-main/…), for tests
#
# Excluded: notes/ (agent journal and recon archive), CLAUDE.md, .claude/, docs/s20-root.md (personal plan).
# Scan: fails on MAC addresses, e-mails, home paths, the local user name, NetRange portal/device ids, keys/tokens.
# Commits use the author set once in cache/publico's git config (GitHub noreply e-mail, never the personal one).
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"
EXCLUIR=(notes CLAUDE.md .claude docs/s20-root.md)
REMOTO=git@github.com:laurorual/openrange.git
PUB="$RAIZ/cache/publico"

MODO=publicar; MSG=""; TAR=""
while (( $# )); do
  case "$1" in
    --checar) MODO=checar ;;
    --tar) MODO=tar; TAR="$(realpath -m "${2:?--tar FILE}")"; shift ;;
    -m) MSG="${2:?-m MENSAGEM}"; shift ;;
    *) echo "uso: $0 [-m MENSAGEM] | --checar | --tar ARQUIVO" >&2; exit 2 ;;
  esac
  shift
done

# snapshot DEST: public file set into DEST (working tree for checar/tar, HEAD for publishing)
snapshot() {
  mkdir -p "$1"
  if [[ $MODO == publicar ]]; then git archive HEAD | tar -x -C "$1"
  else git ls-files -co --exclude-standard -z | tar --null -T - -c | tar -x -C "$1"; fi
  local e; for e in "${EXCLUIR[@]}"; do rm -rf "${1:?}/$e"; done
}

# checar DIR: privacy scan + required files; prints the problems and fails
checar() {
  local usuario achados f padroes=(
    '([0-9A-Fa-f]{2}(:|%3A|%253A)){5}[0-9A-Fa-f]{2}'    # MAC address (also URL-encoded, as in the portal's userID)
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}'     # e-mail
    '/(var/)?home/[a-z_][a-z0-9_-]+/'                   # someone's home path
    '[0-9a-f]{40}\.[0-9a-f]{32}'                        # NetRange portal id
    'BEGIN [A-Z ]*PRIVATE KEY'
    '(api_key|AccessToken|X-Emby-Token)["=: ]+[A-Za-z0-9]{24,}'   # a real-looking Jellyfin token (tests use tok123)
  )
  usuario="$(id -un)"
  [[ $usuario =~ ^(root|teste|user)$ ]] || padroes+=("\\b$usuario\\b")
  achados="$(cd "$1" && grep -rInE --exclude-dir=.git "$(IFS='|'; echo "${padroes[*]}")" . \
    | grep -vE '^\./www/lib/(vendor/|fontes/)' \
    | grep -vE 'noreply@|@users\.noreply\.github\.com|@example\.|@exemplo\.|git@github\.com|/home/teste/' || true)"
  if [[ -n $achados ]]; then
    echo "publicar: dados possivelmente privados no snapshot:"; echo "$achados" | cut -c1-200 | head -20; return 1
  fi
  for f in captures logs certs firmware config/openrange.json config/rede.env cache; do
    [[ -e $1/$f ]] && { echo "publicar: $f não devia estar no snapshot"; return 1; }
  done
  [[ -f $1/LICENSE && -f $1/README.md && -f $1/install.sh ]] || { echo "publicar: falta LICENSE, README.md ou install.sh"; return 1; }
}

case $MODO in
  checar|tar)
    T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
    snapshot "$T/openrange-main"
    checar "$T/openrange-main"
    n=$(find "$T/openrange-main" -type f | wc -l)
    if [[ $MODO == tar ]]; then tar -czf "$TAR" -C "$T" openrange-main; echo "tarball: $TAR ($n arquivos)"
    else echo "privacidade ok ($n arquivos no snapshot público)"; fi
    exit 0 ;;
esac

# --- publish ---------------------------------------------------------------------------------------------------
[[ -z "$(git status --porcelain --untracked-files=no -- . ':!notes')" ]] \
  || { echo "Há mudanças sem commit: faça o commit antes (o público sai do HEAD)." >&2; exit 1; }
if [[ ! -d $PUB/.git ]]; then rm -rf "$PUB"; git clone -q "$REMOTO" "$PUB"; fi
[[ "$(git -C "$PUB" config user.email || true)" == *@users.noreply.github.com ]] || {
  echo "Defina o autor público uma vez: git -C cache/publico config user.name NOME;" \
       "git -C cache/publico config user.email ID+USUARIO@users.noreply.github.com" >&2; exit 1; }
git -C "$PUB" fetch -q origin main && git -C "$PUB" checkout -q main && git -C "$PUB" reset -q --hard origin/main
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
snapshot "$T/s"
checar "$T/s"
find "$PUB" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +       # the snapshot replaces the whole tree
cp -a "$T/s/." "$PUB/"
git -C "$PUB" add -A
if git -C "$PUB" diff --cached --quiet; then echo "Nada a publicar: o GitHub já tem esta versão."; exit 0; fi
git -C "$PUB" diff --cached --stat | tail -1
git -C "$PUB" commit -q -m "${MSG:-$(git log -1 --format=%s)}"
git -C "$PUB" push -q origin main
echo "Publicado: $(git -C "$PUB" log -1 --format='%h %s') → https://github.com/laurorual/openrange"
