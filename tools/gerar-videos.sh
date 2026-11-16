#!/usr/bin/env bash
# gerar-videos.sh — builds the video-test media (www/video/) in www/midia/ (gitignored).
# Synthetic content (testsrc2 + 440 Hz tone + clock and frame number on screen), nothing downloaded.
# Runs on the [HOST] (Bazzite ships ffmpeg) or in any distrobox with ffmpeg.
#
# Usage: tools/gerar-videos.sh [DURATION_S]     (default 20 s per video; only builds what is missing)
#        REFAZER=1 tools/gerar-videos.sh         (deletes and rebuilds everything)
set -euo pipefail
cd "$(dirname "$0")/.."
DUR="${1:-20}"
OUT=www/midia
command -v ffmpeg >/dev/null || { echo "ERRO: ffmpeg não encontrado" >&2; exit 1; }
[[ "${REFAZER:-}" == 1 ]] && rm -rf "$OUT"
mkdir -p "$OUT"

FF=(ffmpeg -hide_banner -loglevel error -nostdin -y)
# Source: animated pattern + big text with time and frame number (stalls are visible by eye).
fonte() {  # fonte LARGURAxALTURA FPS ROTULO
  local tam=$1 fps=$2 rot=$3
  local fs=$(( ${tam#*x} / 12 ))
  echo "testsrc2=s=$tam:r=$fps:d=$DUR,drawtext=text='$rot  %{pts\\:hms}  q%{n}':fontsize=$fs:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=12:x=(w-tw)/2:y=h-th-$fs"
}
AUDIO=(-f lavfi -i "sine=f=440:r=48000:d=$DUR")

gera() {  # gera ARQUIVO comando...
  local arq=$1; shift
  if [[ -s "$OUT/$arq" ]]; then echo "  já existe: $arq"; return; fi
  echo "  gerando:   $arq"
  "$@" 2> >(grep -v -i vmaf >&2)     # Bazzite's ffmpeg libvmaf complains about a model we don't use
}

echo "Vídeos de ${DUR}s em $OUT/"

# 1. Progressive MP4 (faststart: index at the start, plays without downloading everything)
H264=(-c:v libx264 -preset veryfast -pix_fmt yuv420p -g 60 -keyint_min 60 -sc_threshold 0)
AAC=(-c:a aac -b:a 128k -ac 2)
gera h264-main-720p30-aac.mp4 "${FF[@]}" -f lavfi -i "$(fonte 1280x720 30 'H.264 main 720p30')" "${AUDIO[@]}" \
  "${H264[@]}" -profile:v main -level 3.1 -b:v 3M -maxrate 3M -bufsize 6M "${AAC[@]}" -movflags +faststart -shortest "$OUT/h264-main-720p30-aac.mp4"
gera h264-high-1080p30-aac.mp4 "${FF[@]}" -f lavfi -i "$(fonte 1920x1080 30 'H.264 high 1080p30')" "${AUDIO[@]}" \
  "${H264[@]}" -profile:v high -level 4.0 -b:v 6M -maxrate 6M -bufsize 12M "${AAC[@]}" -movflags +faststart -shortest "$OUT/h264-high-1080p30-aac.mp4"
gera h264-high-1080p60-aac.mp4 "${FF[@]}" -f lavfi -i "$(fonte 1920x1080 60 'H.264 high 1080p60')" "${AUDIO[@]}" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 120 -keyint_min 120 -sc_threshold 0 \
  -profile:v high -level 4.2 -b:v 10M -maxrate 10M -bufsize 20M "${AAC[@]}" -movflags +faststart -shortest "$OUT/h264-high-1080p60-aac.mp4"
gera h264-720p30-ac3.mp4 "${FF[@]}" -f lavfi -i "$(fonte 1280x720 30 'H.264 720p + AC-3')" "${AUDIO[@]}" \
  "${H264[@]}" -profile:v main -b:v 3M -c:a ac3 -b:a 192k -ac 2 -movflags +faststart -shortest "$OUT/h264-720p30-ac3.mp4"
gera hevc-main-1080p30-aac.mp4 "${FF[@]}" -f lavfi -i "$(fonte 1920x1080 30 'HEVC main 1080p30')" "${AUDIO[@]}" \
  -c:v libx265 -preset veryfast -pix_fmt yuv420p -tag:v hvc1 -b:v 4M -x265-params log-level=error "${AAC[@]}" -movflags +faststart -shortest "$OUT/hevc-main-1080p30-aac.mp4"
gera vp9-720p30-opus.webm "${FF[@]}" -f lavfi -i "$(fonte 1280x720 30 'VP9 720p30')" "${AUDIO[@]}" \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -row-mt 1 -b:v 2M -c:a libopus -b:a 96k -shortest "$OUT/vp9-720p30-opus.webm"
gera vp9-720p30-vorbis.webm "${FF[@]}" -f lavfi -i "$(fonte 1280x720 30 'VP9 720p + Vorbis')" "${AUDIO[@]}" \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -row-mt 1 -b:v 2M -c:a libvorbis -b:a 96k -shortest "$OUT/vp9-720p30-vorbis.webm"

# 2. HLS with MPEG-TS segments (what Jellyfin serves by default when transcoding)
hls_ts() {  # hls_ts NOME TAM FPS BITRATE ROTULO
  local nome=$1 tam=$2 fps=$3 br=$4 rot=$5 dir="$OUT/$1"
  if [[ -s "$dir/index.m3u8" ]]; then echo "  já existe: $nome/"; return; fi
  echo "  gerando:   $nome/ (HLS TS)"
  mkdir -p "$dir"
  "${FF[@]}" -f lavfi -i "$(fonte "$tam" "$fps" "$rot")" "${AUDIO[@]}" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -profile:v high -level 4.0 -b:v "$br" -maxrate "$br" -bufsize "$br" \
    -g $((fps * 2)) -keyint_min $((fps * 2)) -sc_threshold 0 "${AAC[@]}" -shortest \
    -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_filename "$dir/s%03d.ts" "$dir/index.m3u8"
}
hls_ts hls-ts-720p30 1280x720 30 3M 'HLS TS 720p30'
hls_ts hls-ts-1080p30 1920x1080 30 6M 'HLS TS 1080p30'

# 3. HLS with fMP4 (CMAF), the newer format
dir="$OUT/hls-fmp4-1080p30"
if [[ -s "$dir/index.m3u8" ]]; then echo "  já existe: hls-fmp4-1080p30/"; else
  echo "  gerando:   hls-fmp4-1080p30/ (HLS fMP4)"
  mkdir -p "$dir"
  "${FF[@]}" -f lavfi -i "$(fonte 1920x1080 30 'HLS fMP4 1080p30')" "${AUDIO[@]}" \
    "${H264[@]}" -profile:v high -level 4.0 -b:v 6M -maxrate 6M -bufsize 6M "${AAC[@]}" -shortest \
    -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
    -hls_segment_filename "$dir/s%03d.m4s" "$dir/index.m3u8"
fi

# 4. Round 2: native player formats (what Jellyfin would serve in direct play / direct stream).
#    Where possible, reuses the already built video (-c:v copy) and only changes container or audio.
M=$OUT
gera h264-1080p30-aac.mkv "${FF[@]}" -i "$M/h264-high-1080p30-aac.mp4" -c copy "$M/h264-1080p30-aac.mkv"
gera h264-1080p30-aac.ts  "${FF[@]}" -i "$M/h264-high-1080p30-aac.mp4" -c copy -f mpegts "$M/h264-1080p30-aac.ts"
gera hevc-1080p30-ac3.mkv "${FF[@]}" -i "$M/hevc-main-1080p30-aac.mp4" "${AUDIO[@]}" -map 0:v -map 1:a \
  -c:v copy -c:a ac3 -b:a 192k -ac 2 -shortest "$M/hevc-1080p30-ac3.mkv"
gera h264-720p30-eac3.mp4 "${FF[@]}" -i "$M/h264-main-720p30-aac.mp4" "${AUDIO[@]}" -map 0:v -map 1:a \
  -c:v copy -c:a eac3 -b:a 192k -ac 2 -movflags +faststart -shortest "$M/h264-720p30-eac3.mp4"
gera h264-720p30-dts.mkv  "${FF[@]}" -i "$M/h264-main-720p30-aac.mp4" "${AUDIO[@]}" -map 0:v -map 1:a \
  -c:v copy -c:a dca -strict -2 -b:a 768k -ac 2 -shortest "$M/h264-720p30-dts.mkv"
gera h264-720p30-flac.mkv "${FF[@]}" -i "$M/h264-main-720p30-aac.mp4" "${AUDIO[@]}" -map 0:v -map 1:a \
  -c:v copy -c:a flac -ac 2 -shortest "$M/h264-720p30-flac.mkv"
gera h264-720p30-mp3.mp4  "${FF[@]}" -i "$M/h264-main-720p30-aac.mp4" "${AUDIO[@]}" -map 0:v -map 1:a \
  -c:v copy -c:a libmp3lame -b:a 192k -ac 2 -movflags +faststart -shortest "$M/h264-720p30-mp3.mp4"
gera h264-720p30-aac51.mp4 "${FF[@]}" -i "$M/h264-main-720p30-aac.mp4" \
  -f lavfi -i "sine=f=440:r=48000:d=$DUR" -filter_complex "[1:a]pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 384k -movflags +faststart -shortest "$M/h264-720p30-aac51.mp4"
gera hevc-main10-1080p30-aac.mp4 "${FF[@]}" -f lavfi -i "$(fonte 1920x1080 30 'HEVC 10 bits 1080p30')" "${AUDIO[@]}" \
  -c:v libx265 -preset veryfast -pix_fmt yuv420p10le -profile:v main10 -tag:v hvc1 -b:v 4M -x265-params log-level=error \
  "${AAC[@]}" -movflags +faststart -shortest "$M/hevc-main10-1080p30-aac.mp4"
gera hevc-2160p30-aac.mp4 "${FF[@]}" -f lavfi -i "$(fonte 3840x2160 30 'HEVC 4K 2160p30')" "${AUDIO[@]}" \
  -c:v libx265 -preset ultrafast -pix_fmt yuv420p -tag:v hvc1 -b:v 15M -x265-params log-level=error \
  "${AAC[@]}" -movflags +faststart -shortest "$M/hevc-2160p30-aac.mp4"
gera h264-2160p30-aac.mp4 "${FF[@]}" -f lavfi -i "$(fonte 3840x2160 30 'H.264 4K 2160p30')" "${AUDIO[@]}" \
  -c:v libx264 -preset superfast -pix_fmt yuv420p -profile:v high -level 5.1 -b:v 20M -maxrate 20M -bufsize 40M \
  "${AAC[@]}" -movflags +faststart -shortest "$M/h264-2160p30-aac.mp4"
dir="$M/hls-fmp4-hevc-1080p30"
if [[ -s "$dir/index.m3u8" ]]; then echo "  já existe: hls-fmp4-hevc-1080p30/"; else
  echo "  gerando:   hls-fmp4-hevc-1080p30/ (HLS fMP4 HEVC)"
  mkdir -p "$dir"
  "${FF[@]}" -i "$M/hevc-main-1080p30-aac.mp4" -c copy -tag:v hvc1 -f hls -hls_time 4 -hls_playlist_type vod \
    -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 -hls_segment_filename "$dir/s%03d.m4s" "$dir/index.m3u8"
fi
# WebVTT subtitle: one line every 2 s, to see whether <track> shows over the native player's video.
if [[ ! -s "$M/legenda.vtt" ]]; then
  echo "  gerando:   legenda.vtt"
  { echo "WEBVTT"; echo
    for ((i = 0; i < DUR; i += 2)); do
      printf '%02d:%02d.000 --> %02d:%02d.900\nLegenda nº %d — ç ã é (aos %d s)\n\n' $((i/60)) $((i%60)) $((i/60)) $(((i+1)%60)) $((i/2+1)) "$i"
    done; } > "$M/legenda.vtt"
fi

# Round 3: HEVC 1080p60 at game-recording bitrate (~20 Mb/s constant), to tell decoder from network apart.
gera hevc-1080p60-20M.mp4 "${FF[@]}" -f lavfi -i "$(fonte 1920x1080 60 'HEVC 1080p60 20 Mb/s')" "${AUDIO[@]}" \
  -c:v libx265 -preset ultrafast -pix_fmt yuv420p -tag:v hvc1 -x265-params "log-level=error:bitrate=20000:vbv-maxrate=20000:vbv-bufsize=20000:strict-cbr=1:keyint=120" \
  "${AAC[@]}" -movflags +faststart -shortest "$M/hevc-1080p60-20M.mp4"

# .ignore: Jellyfin (library /media/teste) skips the folder; otherwise the s00N.ts segments become "movies".
for d in "$M"/hls-*/; do [[ -e "$d.ignore" ]] || : > "$d.ignore"; done

# Same subtitle named after the video: Jellyfin attaches it as an external Portuguese subtitle.
[[ -s "$M/h264-main-720p30-aac.pt.vtt" ]] || cp "$M/legenda.vtt" "$M/h264-main-720p30-aac.pt.vtt"

echo "Pronto:"
du -sh "$OUT"/* | sed 's/^/  /'
