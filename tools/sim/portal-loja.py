#!/usr/bin/env python3
"""portal-loja.py — checks how tools/portal.py routes the real store's index pages (part of rodar.sh).

Scenario from the TV (2026-11-16): "Loja da TV" in the launcher opens master/v1/index.html?...&openrange=loja; the store
then navigates by itself to themes/dogue/index.html with a new query (no openrange). That inner page must pass through,
while the TV's own store button (no openrange, no recent launcher open) must still go to our launcher.
Nothing is fetched from NetRange (buscar_real is faked) and cache/loja-url.txt is not touched.
Prints "ERRO ..." on failure and ends with "loja ok".
"""
import os
import sys
import tempfile
from pathlib import Path

os.environ["OPENRANGE_SO_LER"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import portal  # noqa: E402

tmp = Path(tempfile.mkdtemp())
portal.LOJA_URL = tmp / "loja-url.txt"
portal.buscar_real = lambda url, headers: (200, "text/html", b"real", "")
portal.ler_inicio = lambda: {"substituir_loja": True}
portal.log = lambda msg: None
erros = 0
agora = [1000.0]
portal.time.monotonic = lambda: agora[0]


def pedir(caminho, ip="192.168.15.13"):
    h = portal.Handler.__new__(portal.Handler)
    h.path, h.client_address, h.headers = caminho, (ip, 1234), {}
    saida = {}
    h.responder = lambda status, corpo=b"", ctype="", origem="", location="", cache="": saida.update(s=status, loc=location)
    h.loja(caminho.split("?")[0])
    return saida


def espera(nome, r, launcher):
    global erros
    foi = r.get("s") == 302 and r.get("loc", "").endswith("/inicio/")
    if foi != launcher:
        erros += 1
        print(f"ERRO loja: {nome}: esperava {'launcher' if launcher else 'loja real'}, veio {r}")


BASE = "/portals.portal-frontends-v3/master/v1"
espera("botão da loja (sem openrange)", pedir(BASE + "/index.html?portal=x&version=v3"), True)
salva = portal.LOJA_URL.read_text().strip() if portal.LOJA_URL.is_file() else ""
if "master/v1/index.html" not in salva:
    erros += 1
    print(f"ERRO loja: URL de entrada não foi salva ({salva!r})")
espera("Loja da TV (openrange=loja)", pedir(BASE + "/index.html?portal=x&openrange=loja"), False)
espera("2055/index.html com openrange", pedir(BASE + "/2055/index.html?portal=x&openrange=loja"), False)
agora[0] += 1
espera("tema aberto pela própria loja (sem openrange)", pedir(BASE + "/2055/themes/dogue/index.html?portal=x&country=BRA"), False)
if "themes" in portal.LOJA_URL.read_text():
    erros += 1
    print("ERRO loja: a navegação interna sobrescreveu a URL de entrada salva")
espera("outra TV no mesmo instante", pedir(BASE + "/index.html?portal=x", ip="192.168.15.99"), True)
agora[0] += portal.LOJA_JANELA_S + 1
espera("botão da loja depois da janela", pedir(BASE + "/index.html?portal=x"), True)

if erros:
    print(f"loja: {erros} erro(s)")
    sys.exit(1)
print("loja ok")
