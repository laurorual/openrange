#!/usr/bin/env python3
"""jf-perfil.py — asks Jellyfin, for every video in the libraries, how it would play on the TV.

Uses the SAME DeviceProfile as the client (www/jellyfin/jf.js, read with node) and prints a table:
name | container | video | audio | method (DirectPlay / Transcode) | transcode reasons.

First login: Quick Connect (approve the code in Jellyfin: Settings → Quick Connect) or, with
--usuario NAME, user and password (from JF_SENHA or prompted; never stored).
The token is kept in ~/.cache/openrange/jellyfin-token.json (outside the project).
Only talks to the LAN server.

Usage: [HOST] or [tvlab-tools]   python3 tools/jf-perfil.py [--servidor URL] [--usuario NAME] [--limite 200] [--sair]
"""
import argparse
import getpass
import os
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
TOKEN = Path.home() / ".cache" / "openrange" / "jellyfin-token.json"
DEVICE_ID = "openrange-jf-perfil"
TICKS = 10_000_000


def rede():
    env = {}
    for linha in (RAIZ / "config" / "rede.env").read_text().splitlines():
        if "=" in linha and not linha.lstrip().startswith("#"):
            k, v = linha.split("=", 1)
            env[k.strip()] = v.split("#")[0].strip()
    return env


def perfil_do_cliente():
    """Runs jf.js in node with a fake window and returns jf.perfil()."""
    js = (RAIZ / "www" / "jellyfin" / "jf.js").read_text()
    stub = ("var window={location:{search:'',protocol:'http:',hostname:'x'},localStorage:{getItem:function(){return null},"
            "setItem:function(){},removeItem:function(){}}};")
    saida = subprocess.run(["node", "-e", stub + js + ";process.stdout.write(JSON.stringify(window.jf.perfil()))"],
                           capture_output=True, text=True, check=True)
    return json.loads(saida.stdout)


class Jellyfin:
    def __init__(self, servidor, token=None):
        self.servidor, self.token = servidor.rstrip("/"), token

    def _auth(self):
        h = f'MediaBrowser Client="openrange-perfil", Device="PC", DeviceId="{DEVICE_ID}", Version="0.1.0"'
        return h + (f', Token="{self.token}"' if self.token else "")

    def api(self, metodo, caminho, query=None, corpo=None):
        url = self.servidor + caminho + ("?" + urllib.parse.urlencode(query) if query else "")
        dados = json.dumps(corpo).encode() if corpo is not None else None
        req = urllib.request.Request(url, data=dados, method=metodo, headers={"Authorization": self._auth()})
        if dados is not None:
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=30) as r:
            texto = r.read()
        return json.loads(texto) if texto else None


def login(jf, usuario=None):
    if TOKEN.is_file():
        salvo = json.loads(TOKEN.read_text())
        if salvo.get("servidor") == jf.servidor:
            jf.token = salvo["token"]
            try:
                jf.api("GET", "/Users/Me")
                return salvo["userId"]
            except urllib.error.HTTPError as e:
                if e.code != 401:
                    raise
                print("token salvo expirou; novo Quick Connect")
    jf.token = None
    if usuario:
        senha = os.environ.get("JF_SENHA")
        if senha is None:
            senha = getpass.getpass(f"senha de {usuario}: ")
        r = jf.api("POST", "/Users/AuthenticateByName", corpo={"Username": usuario, "Pw": senha})
        return guardar(jf, r)
    qc = jf.api("POST", "/QuickConnect/Initiate")
    print(f"\n  Código Quick Connect: {qc['Code']}\n  Aprove no Jellyfin (Configurações → Quick Connect). Aguardando…")
    for _ in range(200):
        time.sleep(3)
        if jf.api("GET", "/QuickConnect/Connect", {"secret": qc["Secret"]}).get("Authenticated"):
            break
    else:
        sys.exit("ninguém aprovou o código a tempo")
    return guardar(jf, jf.api("POST", "/Users/AuthenticateWithQuickConnect", corpo={"Secret": qc["Secret"]}))


def guardar(jf, r):
    jf.token = r["AccessToken"]
    TOKEN.parent.mkdir(parents=True, exist_ok=True)
    TOKEN.touch(mode=0o600)
    TOKEN.write_text(json.dumps({"servidor": jf.servidor, "token": jf.token, "userId": r["User"]["Id"]}))
    print(f"  ok, logado como {r['User']['Name']}\n")
    return r["User"]["Id"]


def descrever(ms):
    s = ms.get("MediaStreams", [])
    v = next((x for x in s if x["Type"] == "Video"), {})
    a = next((x for x in s if x["Type"] == "Audio" and x["Index"] == ms.get("DefaultAudioStreamIndex")),
             next((x for x in s if x["Type"] == "Audio"), {}))
    vid = f"{v.get('Codec', '?')} {v.get('Width', '?')}x{v.get('Height', '?')}" + (
        f" {v['BitDepth']}b" if v.get("BitDepth", 8) != 8 else "")
    aud = f"{a.get('Codec', '-')} {a.get('Channels', '')}ch" if a else "-"
    leg = ",".join(x.get("Codec", "?") for x in s if x["Type"] == "Subtitle")
    return vid, aud, leg


def main():
    env = rede()
    ap = argparse.ArgumentParser()
    ap.add_argument("--servidor", default=f"http://{env['PC_IP']}:8096")
    ap.add_argument("--usuario", help="login por usuário/senha em vez de Quick Connect")
    ap.add_argument("--limite", type=int, default=200)
    ap.add_argument("--sair", action="store_true", help="apaga o token salvo e sai")
    args = ap.parse_args()
    if args.sair:
        TOKEN.unlink(missing_ok=True)
        return print("token apagado")
    jf = Jellyfin(args.servidor)
    uid = login(jf, args.usuario)
    perfil = perfil_do_cliente()
    itens = jf.api("GET", "/Items", {"userId": uid, "recursive": "true", "limit": args.limite, "sortBy": "SortName",
                                     "includeItemTypes": "Movie,Episode,MusicVideo,Video", "fields": "Path"})["Items"]
    print(f"{len(itens)} vídeos (perfil: {perfil['Name']})\n")
    print(f"{'nome':34} {'cont.':9} {'vídeo':22} {'áudio':10} {'leg.':8} {'método':12} motivos")
    contagem = {}
    for it in itens:
        r = jf.api("POST", f"/Items/{it['Id']}/PlaybackInfo", {"userId": uid}, {
            "UserId": uid, "DeviceProfile": perfil, "MaxStreamingBitrate": 120000000, "IsPlayback": False,
            "AutoOpenLiveStream": False, "EnableDirectPlay": True, "EnableDirectStream": True, "EnableTranscoding": True,
            "AllowVideoStreamCopy": True, "AllowAudioStreamCopy": True})
        ms = (r.get("MediaSources") or [{}])[0]
        vid, aud, leg = descrever(ms)
        if ms.get("SupportsDirectPlay"):
            metodo, motivos = "DirectPlay", ""
        elif ms.get("TranscodingUrl"):
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(ms["TranscodingUrl"]).query)
            metodo = "Transcode"
            motivos = q.get("TranscodeReasons", [""])[0]
        else:
            metodo, motivos = "NADA", r.get("ErrorCode", "")
        contagem[metodo] = contagem.get(metodo, 0) + 1
        print(f"{it['Name'][:34]:34} {ms.get('Container', '?')[:9]:9} {vid[:22]:22} {aud[:10]:10} {leg[:8]:8} {metodo:12} {motivos}")
    print("\n" + ", ".join(f"{k}: {v}" for k, v in sorted(contagem.items())))


if __name__ == "__main__":
    main()
