# Cliente Jellyfin do OpenRange

App para a TV Philco (runtime da loja, ~Chrome 56, 1280x720). Servido pelo `tools/portal.py` em `/jellyfin/`.
TV platform rules: `docs/tv-platform.md`. Status/roadmap: `notes/STATE.md`. Old diary (J1–J6 detail):
`notes/archive/jellyfin-progresso.md`.

| Arquivo | Papel |
|---|---|
| `index.html` | estrutura e CSS |
| `jf.js` | API, servidores e sessões, perfil do aparelho, URLs de reprodução, trickplay, segmentos |
| `app.js` | telas (pilha), abas, teclado, servidores, login, ajustes, pareamento, protetor de tela |
| `player.js` | player (`<video src>` nativo), OSD, menu, legendas, áudio, fila, relatórios |
| `celular.html` | página aberta no celular pelo QR Code (gerenciar servidores) |

## Teclas
- Geral: setas, OK, Voltar. Verde/amarelo/azul: ordem/filtro/visão nas bibliotecas. Play: tocar tudo.
- Ajustes: ←/→ muda a opção, OK abre a lista completa.
- Player: OK pausa (ou pula abertura), ←/→ −10/+30 s, 0–9 = 0–90 %, ↓ menu, amarelo legenda, azul áudio,
  verde info, vermelho modo compatível.

## Testes sem TV
`tools/sim/rodar.sh tudo` (credentials from `~/.cache/openrange/sim.env` or `JF_USUARIO=… JF_SENHA=…`)

## Rules (don't break)
- One handler per key (`tv.ao`): keys used both inside and outside the player are registered only in `app.js`,
  which delegates to `jfPlayer`.
- Video only through `<video src>`; HLS only with TS segments; text subtitles = WebVTT `<track>` in hidden mode, drawn by us in `#legenda-tela` (TV font misplaces ê), image subtitles
  burned in (restarts playback).
- Videos shorter than the server's `MinResumeDurationSeconds` (set to 30 s) never show in "Continuar assistindo".
- Caps: direct play 120 Mb/s, transcode 20 Mb/s (`VideoBitrate` in the URL); lower qualities also set
  `MaxWidth/MaxHeight` (720p ≤ 6 Mb/s, 480p ≤ 1.5 Mb/s), the server doesn't lower resolution from bitrate alone.
- Simulation needs the local test user: `~/.cache/openrange/sim.env` (`JF_USUARIO`, `JF_SENHA`; outside git).
