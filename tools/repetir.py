#!/usr/bin/env python3
"""repetir.py — replays with curl the GET requests the TV made and the probe logged.

Uses ONLY the captured headers (nothing more) and saves the response body + headers in captures/.

Usage: python3 -I tools/repetir.py --host api-portal-v3.netrange.com [--desde 15:55] [--dry-run]

--dry-run only shows what would be requested (IDs/tokens masked).
"""
import argparse
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

RAIZ = Path(__file__).resolve().parent.parent
LOG = RAIZ / "logs" / "sonda.log"
RE_REQ = re.compile(r"^(\d\d:\d\d:\d\d) (\S+) (HTTPS?) (\w+) (\S+)$")
RE_HDR = re.compile(r"^(\d\d:\d\d:\d\d) {6}([^:\[]+): (.*)$")
RE_SEGREDO = re.compile(r"[0-9a-fA-F]{24,}")


def mascarar(s):
    return RE_SEGREDO.sub(lambda m: f"{m[0][:4]}…{m[0][-4:]}", s)


def ler_log(caminho):
    reqs, atual = [], None
    for linha in caminho.read_text(errors="replace").splitlines():
        m = RE_REQ.match(linha)
        if m:
            atual = {"hora": m[1], "cliente": m[2], "metodo": m[4], "url": m[5], "headers": []}
            reqs.append(atual)
            continue
        h = RE_HDR.match(linha)
        if h and atual is not None:
            atual["headers"].append((h[2], h[3]))
        elif not linha.startswith(" "):
            atual = None if not h else atual
    return reqs


def nome_arquivo(url, hora):
    p = urlsplit(url)
    caminho = re.sub(r"[^A-Za-z0-9._-]+", "_", p.path.strip("/")) or "raiz"
    return f"{hora.replace(':', '')}-{caminho}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True, help="host exato das requisições a repetir")
    ap.add_argument("--desde", default="00:00:00", help="HH:MM[:SS] mínimo no sonda.log")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    desde = a.desde if a.desde.count(":") == 2 else a.desde + ":00"

    if not LOG.is_file():
        sys.exit(f"não achei {LOG}")
    reqs = [r for r in ler_log(LOG)
            if r["metodo"] == "GET" and urlsplit(r["url"]).hostname == a.host and r["hora"] >= desde]
    unicas = {}
    for r in reqs:                      # keep the last occurrence of each URL
        unicas[r["url"]] = r
    if not unicas:
        sys.exit(f"nenhum GET para {a.host} desde {desde} em {LOG}")

    destino = RAIZ / "captures" / a.host / datetime.now().strftime("%Y%m%d-%H%M%S")
    if not a.dry_run:
        destino.mkdir(parents=True, exist_ok=True)

    for r in unicas.values():
        # --compressed only decodes the response: with -H Accept-Encoding curl sends the captured value
        # (tested). BunnyCDN sometimes answers br even when the TV asks for "gzip, deflate".
        cmd = ["curl", "-sS", "--compressed", "--max-time", "20"]
        for k, v in r["headers"]:
            if k.lower() != "host":        # curl sends Host from the URL (same as captured)
                cmd += ["-H", f"{k}: {v}"]
        print(f"[{r['hora']}] GET {mascarar(r['url'])}")
        if a.dry_run:
            for k, v in r["headers"]:
                print(f"      {k}: {mascarar(v)}")
            continue
        base = destino / nome_arquivo(r["url"], r["hora"])
        cmd += ["-D", str(base) + ".headers", "-o", str(base) + ".body", "-w", "%{http_code} %{size_download}B %{content_type}", r["url"]]
        res = subprocess.run(cmd, capture_output=True, text=True)
        print(f"      -> {res.stdout.strip()} {res.stderr.strip()}")
    if not a.dry_run:
        print(f"salvo em {destino}")


if __name__ == "__main__":
    main()
