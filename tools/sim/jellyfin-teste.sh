#!/usr/bin/env bash
# jellyfin-teste.sh — local TEST Jellyfin (rootless podman, nothing installed on the host). Not part of OpenRange:
# the TV client uses the user's own server. This one exists only so the simulation gate (rodar.sh tudo) can test
# the client against a real Jellyfin with known synthetic media, without touching the user's real server.
#
#   tools/sim/jellyfin-teste.sh [subir]   start (test library = www/midia/); waits until it answers
#   tools/sim/jellyfin-teste.sh parar     stop and remove the container (config/cache stay in jellyfin/)
#   tools/sim/jellyfin-teste.sh ativo     exit 0 if it is answering
#   tools/sim/jellyfin-teste.sh log       follow the log
#   MIDIA=~/Vídeos tools/sim/jellyfin-teste.sh   also mount a folder of yours, read-only, at /media/meus
#
# Data (test user, libraries) lives in jellyfin/ (gitignored). Panel: http://<PC_IP>:8096
set -euo pipefail
cd "$(dirname "$0")/../.."
eval "$(OPENRANGE_SO_LER=1 python3 tools/config.py env)"
NOME=openrange-jellyfin
IMAGEM=docker.io/jellyfin/jellyfin:10.10.7
URL="http://$PC_IP:8096"
ativo() { curl -s -m 3 "$URL/System/Info/Public" | grep -q Version; }

case "${1:-subir}" in
  parar) podman rm -f "$NOME" >/dev/null 2>&1 || true; exit 0 ;;
  ativo) ativo; exit ;;
  log)   exec podman logs -f "$NOME" ;;
  subir) ;;
  *)     echo "uso: $0 [subir|parar|ativo|log]" >&2; exit 2 ;;
esac

ativo && { echo "Jellyfin de teste já responde em $URL"; exit 0; }
mkdir -p jellyfin/config jellyfin/cache
volumes=(-v "$PWD/jellyfin/config:/config:Z" -v "$PWD/jellyfin/cache:/cache:Z"
         -v "$PWD/www/midia:/media/teste:ro,z")
if [[ -n "${MIDIA:-}" ]]; then
  [[ -d "$MIDIA" ]] || { echo "ERRO: MIDIA=$MIDIA não é uma pasta" >&2; exit 1; }
  # ",z" (lowercase) = shared SELinux label: doesn't change anything other programs use
  volumes+=(-v "$(realpath "$MIDIA"):/media/meus:ro,z")
fi
podman run -d --replace --name "$NOME" -p 8096:8096 "${volumes[@]}" \
  -e JELLYFIN_PublishedServerUrl="$URL" "$IMAGEM" >/dev/null
for _ in $(seq 60); do ativo && { echo "Jellyfin de teste no ar em $URL"; exit 0; }; sleep 1; done
echo "ERRO: o Jellyfin de teste não respondeu em 60 s (tools/sim/jellyfin-teste.sh log)" >&2; exit 1
