# OpenRange

Your own apps on a NetRange smart TV. OpenRange runs on a Linux PC on your home network and takes the place of the
TV's app store (the NetRange portal): the store button opens a launcher you control, with a Jellyfin client, your own
web apps and your favorite apps from the original store.

It was built for and tested on a **Philco PTV42G70N5CF-VA** (Changhong, "NetReady"), but it should work on other TVs
that use the NetRange portal (`ver.netrange.com` / `api-portal-v3.netrange.com`).

> OpenRange is an independent hobby project. It is not affiliated with, endorsed by or connected to NetRange,
> Philco, Changhong or Jellyfin. Use it only on TVs you own. It never changes the TV's firmware.

## How it works

1. The TV asks DNS for the portal's domains. OpenRange's DNS answers with the PC's IP and forwards every other name
   to a public resolver (Netflix domains are never redirected).
2. The TV opens the portal from the PC. OpenRange relays the real catalog, adds its own apps to it, and serves its
   launcher instead of the store's start page. The TV accepts the self-signed certificate.
3. Apps run in the TV's own browser runtime (about Chrome 56, 1280x720). Video plays through the TV's native player
   (`<video src>`: MP4, MKV, HLS with TS segments).

What you get:
- **Launcher**: your apps first, then favorites from the original store. The original store stays one click away.
- **Jellyfin client** for the TV: libraries, series, music, resume, subtitles (drawn by the app), audio tracks,
  trickplay and Quick Connect. It talks to your own Jellyfin server; servers can be added from a phone with a QR code.
- **Control panel** in the PC's browser at `http://localhost:8090/painel/`: status, first steps, apps and icons,
  store favorites, network/DNS and live logs.
- Feature and video test pages for the TV's browser.

The user interface is in Portuguese (Brazil).

## Requirements

- A Linux PC that stays on while you use the TV, on the same network: Python ≥ 3.9, systemd, curl, openssl.
  Tested on Fedora 43 / Bazzite, Debian 12 and Ubuntu 22.04. Nothing is installed from the network.
- Ports 53, 80, 443 and 8090 free on the PC.
- A way to point the TV's DNS at the PC: your router's DHCP settings (recommended) or the TV's manual network setup.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/laurorual/openrange/main/install.sh -o install.sh
bash install.sh
```

Run it as your user (not root); it calls `sudo` when needed and asks for the TV's IP. It downloads the project into
`~/openrange` (choose another folder with `OPENRANGE_DIR=/path bash install.sh`) and runs `tools/instalar.sh`, which
creates `config/openrange.json` and a self-signed certificate, and installs:
- `/etc/systemd/system/openrange.service`: portal and DNS, running as **your** user with only `CAP_NET_BIND_SERVICE`;
- a polkit rule (or, on old polkit, a sudoers rule) so your user can start, stop and restart that one unit without a
  password;
- firewalld rules **at runtime only** (never `--permanent`), opening 53/80/443/8090 to the TV's IP. They are added
  when the service starts and removed when it stops.

Check everything with `~/openrange/tools/openrange.sh saude`.

### Update

Run the same two commands again. `install.sh` compares your installation with the `main` branch and applies only the
differences, then restarts the service. Your settings stay as they are: `config/openrange.json`, your apps and
icons, the store favorites, certificates and logs. If you had edited a code file, your copy is saved in
`~/openrange/.openrange/backup/` before it is replaced. There are no releases: `main` is always the current version,
and the changelog at the end of this page says what changed.

## Point the TV at OpenRange

**Recommended: on the router.** In the LAN/DHCP settings set DNS 1 = the PC's IP and DNS 2 = `1.1.1.1`, and give the
PC and the TV fixed IPs (DHCP reservation). Put the TV's network on automatic. While the PC is up the TV uses
OpenRange; when the PC is off the TV falls back to DNS 2 and the original store opens. Other devices are refused by
the PC's firewall on port 53 and use DNS 2 right away.

**Only on the TV:** network → manual setup → DNS = the PC's IP. Simple, but with the PC off the TV has no DNS at all
until you switch its network back to automatic.

Then press the TV's store button: the OpenRange launcher should open. The panel's "Primeiros passos" tab walks
through the same steps and shows what the PC sees.

## Use

Commands run from the install folder (`cd ~/openrange`).

| Command | What it does |
|---|---|
| `tools/openrange.sh estado` | quick status |
| `tools/openrange.sh saude` | full check, with what to do for each problem |
| `tools/openrange.sh reiniciar` / `parar` / `iniciar` | restart / stop / start (no password) |
| `journalctl -u openrange -f`, `logs/portal.log` | service and request logs |

Settings live in `config/openrange.json` (edit them in the panel). Redirects and the launcher reload on their own;
network and port changes need a restart.

## Uninstall

```sh
~/openrange/tools/instalar.sh remover
rm -rf ~/openrange
```

The first command removes the unit, the polkit/sudoers rule and any runtime firewall rule. Then undo the DNS change on the router
or set the TV's network back to automatic.

## Troubleshooting

- **The store button opens the original store:** the TV is not using the PC for DNS. Check the router/TV DNS, the
  TV's IP in the panel, and `tools/openrange.sh saude`.
- **"Network error" on the TV:** the TV's DNS is the PC and the service is down. Start it, or use the router setup.
- **Port 53 is busy:** another DNS server (dnsmasq, systemd-resolved stub on the LAN address, a VM network) is bound
  to the PC's IP. `sudo ss -lunp 'sport = :53'` shows which process holds it.
- **A video does not play:** the TV's player handles H.264/HEVC up to 1080p in MP4/MKV/TS. Other formats need a
  Jellyfin server that can transcode.

## Development

There is no build step. `www/` holds the TV apps (plain ES5 for the TV's old browser) and `tools/` the Python portal,
DNS and scripts. The simulation gate runs without a TV:

```sh
tools/sim/rodar.sh          # Jellyfin client against a fake API, installer, store routing, panel, privacy scan
tools/sim/rodar.sh tudo     # also against a throwaway local Jellyfin in podman
tools/sim/rodar.sh limpa    # real install/remove in clean Fedora, Debian and Ubuntu containers
```

`docs/tv-platform.md` lists what is known about the TV's browser, player and portal.

## License

GPL-3.0-or-later (see `LICENSE`). Bundled third-party files keep their own licenses: hls.js (Apache-2.0),
qrcode-generator by Kazuhiko Arase (MIT) and the Noto Sans fonts (SIL OFL 1.1, `www/lib/fontes/OFL.txt`).

## Changelog

Newest first. Dates are when the change reached `main`.

### 2026-11-16
- One-command install and update: `install.sh` downloads `main`, installs the service, and on later runs applies only
  what changed, keeping your settings.
- First public version: launcher replacing the store, Jellyfin client, phone pairing by QR code, control panel,
  installer for Fedora/Debian/Ubuntu, router DNS setup with automatic fallback to the original store.
