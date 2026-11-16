# TV platform reference

Verified facts about the TV. Edit in place when something new is confirmed; no history here.
Evidence: `notes/archive/achados-2026-11.md` (grep by time, e.g. `18:53`).

## Device and network
- Philco PTV42G70N5CF-VA, made by Changhong (UPnP), MStar SoC (update host OUI 00:14:B9, module 0x1122),
  armv7l, 4 cores, 1280x720, DPR 1, ~133 MB JS heap. Firmware v1.1.11 (build 2022-06-21).
- LAN: PC 192.168.15.69 (`enp5s0`), TV 192.168.15.70 (was .13) on **Wi-Fi** (~77 Mb/s PC→TV measured),
  gateway 192.168.15.1. firewalld zone `FedoraWorkstation` opens only 1025–65535 by default → 53/80/443 are
  opened at runtime for the TV's IP only (`tools/firewall.sh`); the phone page uses :8090 because other devices
  can't reach 80.
- Host (Bazzite) SELinux is **enforcing**: systemd (`init_t`) can't execute or append to `user_home_t` files
  (verified with `sesearch` on the host policy) → system units run `/usr/bin/bash|python3 <script>` and log
  to the journal.
- The TV honors the manual DNS and asks only for A records. TV clock runs in **UTC**.
- Manual network setup has **one DNS field** (no DNS 2). With DNS = PC and the PC/service off, the TV has no DNS
  at all: the store and everything else fail with a network error (TV check 2026-11-16).
- **DNS setup (recommended):** router DHCP DNS1 = PC, DNS2 = 1.1.1.1, TV network on automatic (TV check
  2026-11-16, Vivo Fibra router): with the service up the store button always opens our launcher (the TV sticks
  to DNS1); with it stopped the original store opens and other devices keep browsing. Other devices hit firewalld's
  reject on :53 (port opened only for the TV IP) and use DNS2. Needs fixed IPs for PC and TV (DHCP reservation).
- DIAL 2.2 at `http://<TV_IP>:56789/apps/` (YouTube, Netflix only). SSDP `quick_ssdp/1.1`.
- The TV does **not answer ICMP ping** even when on; TCP 56789 (DIAL) does → used as the "TV is on" probe.

## Portal (NetRange)
- Store front-end: opened as `https://ver.netrange.com/portals.portal-frontends-v3/master/v1/index.html?portal=…`,
  which loads `…/2055/index.html` (theme `…/2055/themes/dogue/`). APIs: `https://api-portal-v3.netrange.com/portal/v3/`
  `configlang` (texts, start-page blocks in `specials`), `configstatic` (icon `base_url`), `apps` (catalog).
- **Both domains accept a self-signed cert** (TLS 1.2, SNI sent) → the TV does not validate certificates.
- Apps always open through `appredir?AppId=<id>` → 302 `Location`, in the same window and same runtime.
  `native://` URLs go to `Netrange.launch` instead.
- Front-end filters: drops apps tagged `netflix`; needs `in_target_countries` or `global`; drops `geoblocked`;
  `sticky` apps first (by `sticky_order`), then by name.
- Our app ids: 99000x (`config/openrange.json`). The store is replaced by our launcher; `&openrange=loja` lets the
  real store through.
- Third-party web apps own the Back key (8) on their pages; we can't intercept it. Web Video Caster (BBC TAL,
  `exit/closewindow`) only leaves through its own exit button (`window.close()` → store URL → our launcher).
- Apps that handle Back themselves (Plex) exit to the store URL → with the store replaced, they land on
  our launcher.
- Netflix's row on the home screen comes from `preapp.prod.cloud.netflix.com` (NRDP, in firmware):
  can't change without firmware. Never redirect Netflix domains.

## Runtimes
|                 | Store runtime "QJY" (runs all our apps)              | Sraf Browser                         |
|-----------------|------------------------------------------------------|--------------------------------------|
| UA              | `Chrome/56.77.34.5 … QJY/2.0 PTK5.1 NETRANGEMMH`      | `Chrome/47.0.2526.106 … SRAF/4.0`    |
| JS              | ~ES2017 (async/await, Proxy, WASM); no `?.` `??` spread, no modules | ES2015 partial, no async/destructuring |
| CSS             | flex, variables, sticky, filter; **no grid, no gap** | flex; no grid, no variables          |
| MSE             | H.264 + AAC/AC-3/E-AC-3 (but see Video)              | none usable                          |
| EME             | Widevine, PlayReady, ClearKey                         | Widevine, ClearKey                   |
| Natives         | `QjyScript`, `oipfObjectFactory`, `external`          | `oipfObjectFactory`                  |
- Our code: **ES5 + Promise, no build step, no `?.`/`??`/grid/gap/modules**.
- Keys (QJY, measured): arrows 37–40, red 403, green 404, yellow 405, blue 406 (`key: "Unidentified"`),
  digits 48–57, Play 415, Pause 19, **Back 8** (`Backspace`; `history.back()` returns to the store),
  OK 13 (`Enter`), stop 413, rewind 412, fast-forward 417 (media keys: `key: "Unidentified"`).
  Not seen: a combined play/pause key (10252 mapped just in case; `tv.js` also maps 27/461/10009 to Back).
  Current full map: `www/lib/tv.js`.
- `navigator.language` = `pt-PT`.
- Fonts: the TV's fallback font misplaces diacritics (ê â ô) → always use the bundled Noto Sans
  (`www/lib/fontes/`). Glyphs known safe: ● ○ ▶ ✓ ♥ ← · ‹ ›. Missing (render as boxes): ⌫ ⇧ ▣.
- Performance: parsing 200k JSON objects ≈ 2.8 s → paginate lists (Jellyfin grid: 60 per page).

## Video — only `<video src>` (native hardware player)
- Direct play: containers mp4, mkv, mpegts, webm. Video H.264 ≤ 1080p60, HEVC 8/10-bit ≤ 1080p, VP9 (webm).
  Audio AAC ≤ 5.1, AC-3, E-AC-3, MP3, FLAC, Opus (webm).
- Not supported: 4K (audio plays, picture black), DTS, Vorbis. AV1 untested.
- Native HLS: **TS segments only** (fMP4 → `MEDIA_ERR_SRC_NOT_SUPPORTED`).
- Subtitles: external WebVTT via `<track>` loads fine, but the native cue renderer uses the TV font (misplaced
  circumflex) → track in `hidden` mode, cues drawn by `player.js` in `#legenda-tela` with Noto Sans. Image subs → burn in.
- `canPlayType` is not the truth: in QJY it says no to HEVC, yet `<video src>` plays HEVC (test by playing).
- First frame 1.5–2.7 s, seek 0.3–1.7 s. `videoWidth`, fps and dropped-frame counters are meaningless on
  the native player (they show the box size / zeros).
- **Never MSE** (hls.js/dash.js/Shaka): ~30% dropped frames and stall loops after seek.
- Known issue: tiny audio cuts in the user's HEVC 1080p60 VFR game recordings (AAC copied). Ruled out:
  network, server, container, video decoder (720p transcode still cuts). Next idea: transcode audio only.

## DRM
Widevine/PlayReady in QJY only help the official players of those services. Our apps can't play
protected content; Netflix/Crunchyroll-type services are out of reach this way.

## Jellyfin (seen on the local test server 10.10.7 and the user's own server)
- CORS `*`; Quick Connect on. `MinResumeDurationSeconds` lowered to 30 (default 300 hid short videos).
- Caps in our client: direct play 120 Mb/s, transcode 20 Mb/s (`VideoBitrate` in the URL); lower quality needs
  `MaxWidth/MaxHeight` in the URL (bitrate alone doesn't lower resolution): 720p ≤ 6 Mb/s, 480p ≤ 1.5 Mb/s.
- The user's own server is a Jellyfin-compatible endpoint that **can't transcode**: it ignores
  `EnableDirectPlay=false` and bitrate caps and always answers DirectPlay. The client detects it, says so, and
  hides the quality options for that server.
- `/MediaSegments` is empty without a plugin → skip-intro falls back to chapter names.
