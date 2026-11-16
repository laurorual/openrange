#!/usr/bin/env python3
"""portal.py — the TV's own catalog (Stage 1). Takes ports 80/443 INSTEAD of the probe.

Works with the redirect `api-portal-v3.netrange.com -> PC_IP` active in our DNS:

  api-portal-v3.netrange.com/portal/v3/apps          real + apps from config/apps-proprios.json
  api-portal-v3.netrange.com/portal/v3/configstatic  real, with the icons' base_url -> //PC_IP/icones/
  api-portal-v3.netrange.com/portal/v3/configlang    real, with the "inicio": true apps on the start screen
  api-portal-v3.netrange.com/<other path>            passed through to the real server
  ver.netrange.com/... (only if DNS also redirects this domain) proxy of the real store front-end,
                      except the store's index.html when config/openrange.json has launcher.substituir_loja = true:
                      then the TV goes to our launcher. The real store stays reachable with &openrange=loja in the URL.
                      (the index.html pages the store opens by itself right after pass through for LOJA_JANELA_S)
  PC_IP/icones/...    our apps' icons (generated SVG or uploaded) or a copy from icons.netrange.com (cache/icones/)
  PC_IP/relatorio     POST from our apps: type "relatorio" -> logs/relatorios/<time>.json;
                      "tecla"/"log"/"erro" -> logs/relatorios/eventos.jsonl (and one line in the log)
  PC_IP/api/par/...   TV ↔ phone pairing (memory only, expires in 20 min): the TV creates a code and shows
                      a QR; the phone opens /jellyfin/celular.html?c=CODE and sends commands (add/use/
                      remove server); the TV fetches the commands. The body of these requests NEVER goes to the log
                      nor to disk (it may carry a password).
  PC_IP/painel/       control panel (M3.3, www/painel/ + tools/painel.py): only the PC itself may use /painel/api/
  PC_IP/api/inicio    launcher data: our apps + favorites (launcher.favoritos in config/openrange.json) from the last real catalog
  PC_IP/...           static files from www/

Requests to the real server use curl with the headers the TV sent (nothing more). If the real one
fails, the last copy in captures/api-portal-v3.netrange.com/ is served.

Usage: installed as openrange.service (tools/instalar.sh), or `tools/openrange.sh iniciar` (manual mode)
      DNS=1 ...      also the TV's DNS (tools/dns_openrange.py, port 53)
      OFFLINE=1 ...  never talks to NetRange (captures only)
      PORTA_HTTP=8080 PORTA_HTTPS=8443 ...  to test without root
Log:   terminal + logs/portal.log (tokens masked)
"""
import datetime
import html
import json
import mimetypes
import os
import re
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402  (config/openrange.json — Etapa 3/P1)
import painel  # noqa: E402  (control panel API, M3.3)

RAIZ = Path(__file__).resolve().parent.parent
WWW = RAIZ / "www"
CACHE_ICONES = RAIZ / "cache" / "icones"
RELATORIOS = RAIZ / "logs" / "relatorios"
CAPTURAS = RAIZ / "captures" / "api-portal-v3.netrange.com"
APPS_PROPRIOS = RAIZ / "config" / "apps-proprios.json"
INICIO = RAIZ / "config" / "inicio.json"
CATALOGO_CACHE = RAIZ / "cache" / "catalogo.json"     # last real /apps, without our changes
MIME_EXTRA = {".woff": "font/woff", ".woff2": "font/woff2", ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".m4s": "video/iso.segment",
              ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska", ".vtt": "text/vtt", ".mpd": "application/dash+xml", ".js": "text/javascript"}
ICONE_PADRAO = "portals/v3/prod/app/{id}/type019-192x250/default/192x250.jpg"
CERT, CHAVE = RAIZ / "certs" / "cert.pem", RAIZ / "certs" / "key.pem"
HOST_API = "api-portal-v3.netrange.com"
HOST_LOJA = "ver.netrange.com"
RE_LOJA_INDEX = re.compile(r"^/portals\.portal-frontends-v3/.+/index\.html$")
LOJA_URL = RAIZ / "cache" / "loja-url.txt"           # store opening URL, as the TV asked for it
# The real store entry page navigates by itself to themes/<x>/index.html with a NEW query (no openrange=loja).
# After a launcher-initiated open (openrange=loja), store index pages from that TV pass through for this long.
LOJA_JANELA_S = 15
loja_liberada = {}                                   # client IP -> time.monotonic() deadline
ICONES_REAL = "https://icons.netrange.com/"
MAX_CORPO = 512 * 1024
CFG = config.carregar()
PORTA_HTTP = int(os.environ.get("PORTA_HTTP", CFG["portas"]["http"]))
PORTA_HTTPS = int(os.environ.get("PORTA_HTTPS", CFG["portas"]["https"]))
# Port for the phone/PC (QR page, control panel). 80/443 only accept the TV in the firewall; the FedoraWorkstation
# zone already opens 1025–65535 to the LAN, so a high port works without touching any rule.
PORTA_CELULAR = int(os.environ.get("PORTA_CELULAR", CFG["portas"]["celular"]))
OFFLINE = os.environ.get("OFFLINE") == "1"   # never talks to NetRange: captures only

_lock = threading.Lock()
(RAIZ / "logs").mkdir(exist_ok=True)
(RAIZ / "logs").mkdir(exist_ok=True)                 # fresh clone: logs/ is not in git
_log = open(RAIZ / "logs" / "portal.log", "a", buffering=1)
_uas_vistos = set()
RE_SEGREDO = re.compile(r"[0-9a-fA-F]{24,}")


def mascarar(s):
    return RE_SEGREDO.sub(lambda m: f"{m[0][:4]}…{m[0][-4:]}", s)


def log(msg):
    linha = f"{datetime.datetime.now():%H:%M:%S} {mascarar(msg)}"
    with _lock:
        print(linha, flush=True)
        _log.write(linha + "\n")


PC_IP = CFG["rede"]["pc_ip"]


def ler_proprios():
    """Re-read on every request: editing the JSON needs no restart."""
    try:
        dados = json.loads(APPS_PROPRIOS.read_text())
    except (OSError, ValueError) as e:
        log(f"AVISO: não consegui ler {APPS_PROPRIOS.name}: {e}")
        return []
    apps = []
    for a in dados.get("apps", []):
        if not isinstance(a.get("id"), int) or a["id"] < 990001 or not a.get("name") or not a.get("url"):
            log(f"AVISO: app ignorado (precisa de id >= 990001, name e url): {a}")
            continue
        apps.append(dict(a, url=a["url"].replace("{PC_IP}", PC_IP)))
    return apps


# --- servidor real -------------------------------------------------------------

def buscar_real(url, headers):
    """GET on the real server with the TV's headers.
    Returns (status, content_type, body, location) or None. curl doesn't follow redirects: the 302 and
    Location go to the TV as they came (that's how the portal opens apps, via /appredir)."""
    if OFFLINE:
        return None
    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        caminho = tmp.name
    try:
        cmd = ["curl", "-sS", "--compressed", "--max-time", "15", "-o", caminho,
               "-w", "%{http_code}\t%{content_type}\t%{redirect_url}"]
        for k, v in headers:
            if k.lower() not in ("host", "connection", "content-length"):
                cmd += ["-H", f"{k}: {v}"]
        res = subprocess.run(cmd + [url], capture_output=True, text=True, timeout=20)
        if res.returncode != 0:
            log(f"      servidor real falhou: {res.stderr.strip()}")
            return None
        status, ctype, location = (res.stdout.split("\t") + ["", ""])[:3]
        return (int(status), ctype or "application/octet-stream", Path(caminho).read_bytes(),
                location.strip())
    except (subprocess.SubprocessError, ValueError, OSError) as e:
        log(f"      servidor real falhou: {e}")
        return None
    finally:
        try:
            os.unlink(caminho)
        except OSError:
            pass


def captura_mais_recente(nome):
    """Last captured body for /portal/v3/<name> (fallback when the real one fails)."""
    achados = sorted(CAPTURAS.glob(f"*/*-portal_v3_{nome}.body"))
    return achados[-1].read_bytes() if achados else None


# --- catalog changes --------------------------------------------------------

def mexer_apps(dados, proprios):
    agora = int(time.time())
    nossos_ids = {p["id"] for p in proprios}
    novos = []
    for ordem, p in enumerate(proprios):
        novos.append({
            "id": p["id"], "created": agora, "added": agora,
            "name": p["name"], "description": p.get("description", ""),
            "categories": p.get("categories", [5]), "languages": p.get("languages", [7]),
            "url": p["url"], "global": True, "in_target_countries": True,
            "mouse_support": True, "resolution": 0, "sticky": True, "sticky_order": ordem,
        })
    originais = [a for a in dados.get("apps", []) if a.get("id") not in nossos_ids]
    dados["apps"] = novos + originais
    return f"+{len(novos)} apps nossos, {len(originais)} originais"


def mexer_configstatic(dados):
    d = dados.get("icons", {}).get("icon_type_defaults")
    if not d:
        return "sem icon_type_defaults (nada mudado)"
    d["base_url"] = f"//{PC_IP}/icones/"
    return f"base_url dos ícones -> //{PC_IP}/icones/"


def mexer_configlang(dados, proprios):
    inicio = [p for p in proprios if p.get("inicio")]
    if not inicio:
        return "nenhum app com inicio=true"
    for esp in dados.get("specials", []):
        if esp.get("type") != "start_page_block_type":
            continue
        blocos = esp.get("blocks", [])
        fixos = [b for b in blocos if "app_id" not in b]           # logo etc.
        apps = [b for b in blocos if "app_id" in b and b["app_id"] not in {p["id"] for p in inicio}]
        tipo = apps[0]["type"] if apps else "Starfish Twelve"
        nossos = [{"app_id": p["id"], "type": tipo} for p in inicio]
        # keep the number of blocks (the layout is a grid): the last original ones drop out
        juntos = (nossos + apps)[:max(len(apps), len(nossos))]
        for i, b in enumerate(juntos, start=1):
            b["block_id"] = i
        esp["blocks"] = fixos + juntos
        return f"tela inicial: {len(nossos)} nossos na frente, {len(juntos)} blocos de app"
    return "sem start_page_block_type (nada mudado)"


# --- launcher -------------------------------------------------------------------

def salvar_catalogo(corpo):
    try:
        CATALOGO_CACHE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CATALOGO_CACHE.with_suffix(".tmp")
        tmp.write_bytes(corpo)
        tmp.replace(CATALOGO_CACHE)
    except OSError as e:
        log(f"AVISO: não salvei {CATALOGO_CACHE.name}: {e}")


def catalogo_real():
    """Apps from the last real catalog (cache/ or, without it, the latest capture)."""
    for corpo in (CATALOGO_CACHE.read_bytes() if CATALOGO_CACHE.is_file() else None,
                  captura_mais_recente("apps")):
        if corpo:
            try:
                return json.loads(corpo).get("apps", [])
            except ValueError:
                pass
    return []


def ler_inicio():
    """"launcher" section of config/openrange.json (re-read on every request: editing needs no restart)."""
    try:
        return config.carregar(regerar_antigos=False)["launcher"]
    except SystemExit as e:
        log(f"AVISO: {e}")
        return {}


def dados_inicio():
    def item(a, proprio):
        d = {"id": a["id"], "name": a["name"], "url": a["url"], "description": a.get("description", ""),
             "proprio": proprio, "icone": "/icones/" + ICONE_PADRAO.format(id=a["id"])}
        if proprio:
            d["secao"] = a.get("secao") or painel.SECAO_PADRAO
            p = painel.icone_proprio(a["id"])
            if p:                                      # new file name per upload: the TV may have cached the old one
                d["icone"] += f"?v={int(p.stat().st_mtime)}"
        return d
    conf = ler_inicio()
    por_id = {a.get("id"): a for a in catalogo_real() if a.get("url")}
    favoritos, faltando = [], []
    for i in conf.get("favoritos", []):
        (favoritos.append(item(por_id[i], False)) if i in por_id else faltando.append(i))
    fuso = datetime.datetime.now().astimezone().utcoffset()
    loja = LOJA_URL.read_text().strip() if LOJA_URL.is_file() else ""
    return {
        "loja": (loja + ("&" if "?" in loja else "?") + "openrange=loja") if loja else "",
        "proprios": [item(a, True) for a in ler_proprios()],
        "favoritos": favoritos,
        "faltando": faltando,
        "fuso_min": int(fuso.total_seconds() // 60) if fuso else 0,   # the TV's clock runs in UTC
        "agora_ms": int(time.time() * 1000),
    }


# --- TV <-> phone pairing (memory) ------------------------------------------------

PARES = {}                 # codigo -> {"criado", "estado", "comandos": [], "resultado"}
PAR_VALIDADE = 20 * 60
ALFABETO_PAR = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"      # no 0/O/1/I


def par(metodo, partes, corpo):
    """Returns (status, dict). partes = path after /api/par/."""
    import secrets
    agora = time.time()
    with _lock:
        for c in [c for c, v in PARES.items() if agora - v["criado"] > PAR_VALIDADE]:
            del PARES[c]
        try:
            dados = json.loads(corpo) if corpo else {}
        except ValueError:
            return 400, {"erro": "json inválido"}
        if metodo == "POST" and partes == ["novo"]:
            if len(PARES) > 50:
                return 429, {"erro": "pareamentos demais"}
            codigo = "".join(secrets.choice(ALFABETO_PAR) for _ in range(6))
            PARES[codigo] = {"criado": agora, "estado": dados, "comandos": [], "resultado": None}
            return 200, {"codigo": codigo, "url": f"http://{PC_IP}:{PORTA_CELULAR}/jellyfin/celular.html?c={codigo}"}
        if not partes or partes[0].upper() not in PARES:
            return 404, {"erro": "código inválido ou expirado"}
        p = PARES[partes[0].upper()]
        acao = partes[1] if len(partes) > 1 else ""
        if metodo == "GET" and not acao:                       # celular: estado atual
            return 200, {"estado": p["estado"], "resultado": p["resultado"], "pendentes": len(p["comandos"])}
        if metodo == "POST" and acao == "comando":             # celular -> TV
            if len(p["comandos"]) >= 20 or not isinstance(dados, dict):
                return 429, {"erro": "fila cheia"}
            p["comandos"].append(dados)
            p["resultado"] = None
            return 200, {"ok": True}
        if metodo == "GET" and acao == "comandos":             # TV: retira os comandos
            cmds, p["comandos"] = p["comandos"], []
            return 200, {"comandos": cmds}
        if metodo == "POST" and acao == "estado":              # TV: new state + result of the last command
            p["estado"] = dados.get("estado", p["estado"])
            p["resultado"] = dados.get("resultado")
            return 200, {"ok": True}
        return 404, {"erro": "rota desconhecida"}


# --- icons ---------------------------------------------------------------------

RE_ICONE = re.compile(r"^portals/v3/prod/app/(\d+)/([\w-]+)/([\w-]+)/(\d+)x(\d+)[\w]*\.(\w+)$")


def svg_icone(app, w, h):
    rotulo = app.get("rotulo") or app["name"]
    palavras, linhas, atual = rotulo.split(), [], ""
    for p in palavras:
        if len(atual) + len(p) + 1 > 12 and atual:
            linhas.append(atual)
            atual = p
        else:
            atual = f"{atual} {p}".strip()
    linhas.append(atual)
    linhas = linhas[:3]
    fs = max(10, int(min(h / (len(linhas) + 1.5), w / 8)))
    y0 = h / 2 - (len(linhas) - 1) * fs * 0.6
    tspans = "".join(
        f'<tspan x="{w / 2:.0f}" y="{y0 + i * fs * 1.2:.0f}">{html.escape(t)}</tspan>' for i, t in enumerate(linhas))
    cor = html.escape(app.get("cor", "#444"))
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
            f'<rect width="{w}" height="{h}" fill="{cor}"/>'
            f'<text font-family="Roboto,Arial,sans-serif" font-weight="700" font-size="{fs}" fill="#fff" '
            f'text-anchor="middle" dominant-baseline="middle">{tspans}</text></svg>').encode()


# --- HTTP ----------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "openrange-portal"
    sys_version = ""

    def log_message(self, *args):
        pass

    @property
    def esquema(self):
        return "https" if self.server.ctx else "http"

    def responder(self, status, corpo=b"", ctype="text/plain; charset=utf-8", origem="", location="", cache="no-store",
                  cors=True):
        self.send_response(status)
        if location:
            self.send_header("Location", location)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(corpo)))
        if cors:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(corpo)
        log(f"{self.client_address[0]} {self.esquema.upper()} {self.command} "
            f"{self.host}{self.path} -> {status} {len(corpo)}B {origem}"
            + (f" -> Location: {mascarar(location)}" if location else ""))

    def preparar(self):
        self.host = (self.headers.get("Host") or "?").split(":")[0].lower()
        ua = self.headers.get("User-Agent", "")
        if ua and ua not in _uas_vistos:
            _uas_vistos.add(ua)
            log(f"{self.client_address[0]} novo User-Agent: {ua}")
        painel.visto(self.client_address[0], self.path, ua)

    def do_OPTIONS(self):
        self.preparar()
        if urlsplit(self.path).path.startswith("/painel/api/"):     # no CORS for the panel: same-origin only
            return self.responder(403, b"", origem="painel: preflight recusado", cors=False)
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", self.headers.get("Access-Control-Request-Headers", "*"))
        self.send_header("Content-Length", "0")
        self.end_headers()
        log(f"{self.client_address[0]} {self.esquema.upper()} OPTIONS {self.host}{self.path} -> 204")

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self.preparar()
        caminho = urlsplit(self.path).path
        if self.host == HOST_API:
            return self.api(caminho)
        if self.host == HOST_LOJA:
            return self.loja(caminho)
        if caminho.startswith("/icones/"):
            return self.icone(caminho[len("/icones/"):])
        if caminho.startswith("/api/par/"):
            return self.responder_par("GET", caminho, b"")
        if caminho.startswith("/painel/api/"):
            return self.responder_painel("GET", caminho, b"")
        if caminho == "/api/inicio":
            corpo = json.dumps(dados_inicio(), ensure_ascii=False).encode()
            return self.responder(200, corpo, "application/json; charset=utf-8", origem="api")
        return self.estatico(caminho)

    def do_POST(self):
        self.preparar()
        n = int(self.headers.get("Content-Length") or 0)
        corpo = self.rfile.read(min(n, MAX_CORPO))
        caminho = urlsplit(self.path).path
        if self.host != HOST_API and caminho.startswith("/api/par/"):
            return self.responder_par("POST", caminho, corpo)
        if self.host != HOST_API and caminho.startswith("/painel/api/"):
            return self.responder_painel("POST", caminho, corpo)
        if self.host != HOST_API and caminho == "/relatorio":
            RELATORIOS.mkdir(parents=True, exist_ok=True)
            try:
                dados = json.loads(corpo)
                tipo = dados.get("tipo", "?") if isinstance(dados, dict) else "?"
            except ValueError:
                dados, tipo = None, "json inválido"
            if tipo in ("tecla", "log", "erro", "video"):
                linha = {"pc": f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S.%f}"[:-3], **dados}
                with _lock, open(RELATORIOS / "eventos.jsonl", "a") as f:
                    f.write(json.dumps(linha, ensure_ascii=False) + "\n")
                resumo = {
                    "tecla": lambda: f"{dados.get('nome') or dados.get('key') or '?'} ({dados.get('keyCode')})",
                    "video": lambda: f"{dados.get('teste')} -> {dados.get('resultado')} {dados.get('resumo', '')}",
                }.get(tipo, lambda: str(dados.get("msg", ""))[:200])()
                return self.responder(204, origem=f"{tipo} [{dados.get('app', '?')}]: {resumo}")
            arq = RELATORIOS / f"{datetime.datetime.now():%Y%m%d-%H%M%S-%f}.json"
            arq.write_bytes(corpo)
            return self.responder(204, origem=f"relatório '{tipo}' -> {arq.relative_to(RAIZ)}")
        log(f"      [corpo] {corpo[:300]!r}")
        self.responder(404, origem="(POST não tratado)")

    # ver.netrange.com (store front-end)
    def loja(self, caminho):
        query = parse_qs(urlsplit(self.path).query)
        ip = self.client_address[0]
        if RE_LOJA_INDEX.match(caminho) and "openrange" in query:
            loja_liberada[ip] = time.monotonic() + LOJA_JANELA_S
        elif RE_LOJA_INDEX.match(caminho) and time.monotonic() < loja_liberada.get(ip, 0):
            pass                                     # inner navigation of a store opened from the launcher
        elif RE_LOJA_INDEX.match(caminho):
            try:
                LOJA_URL.parent.mkdir(parents=True, exist_ok=True)
                LOJA_URL.write_text(f"https://{HOST_LOJA}{self.path}\n")
            except OSError as e:
                log(f"AVISO: não salvei {LOJA_URL.name}: {e}")
            if ler_inicio().get("substituir_loja"):
                return self.responder(302, b"", origem="loja substituída pelo launcher",
                                      location=f"http://{PC_IP}/inicio/")
        real = buscar_real(f"https://{HOST_LOJA}{self.path}", list(self.headers.items()))
        if not real:
            return self.responder(502, b"upstream falhou", origem="loja real falhou")
        status, ctype, corpo, location = real
        self.responder(status, corpo, ctype, origem="loja real", location=location)

    def responder_par(self, metodo, caminho, corpo):
        status, dados = par(metodo, [x for x in caminho[len("/api/par/"):].split("/") if x], corpo)
        # only the path is logged; the body (may hold a password) never is
        self.responder(status, json.dumps(dados, ensure_ascii=False).encode(), "application/json; charset=utf-8", origem="par")

    def responder_painel(self, metodo, caminho, corpo):
        recusa = painel.permitido(self.client_address[0], self.headers.get("Host"), self.headers.get("X-OpenRange"))
        if recusa:
            status, dados = 403, {"erro": recusa}
        elif metodo == "POST" and corpo and not (self.headers.get("Content-Type") or "").startswith("application/json"):
            status, dados = 415, {"erro": "Content-Type: application/json"}
        else:
            status, dados = painel.tratar(metodo, caminho[len("/painel/api/"):], parse_qs(urlsplit(self.path).query), corpo)
        # the body (icons, config) is never logged
        self.responder(status, json.dumps(dados, ensure_ascii=False).encode(), "application/json; charset=utf-8",
                       origem="painel" + (f": {dados.get('erro')}" if status >= 400 else ""), cors=False)

    # api-portal-v3.netrange.com
    def api(self, caminho):
        if caminho == "/portal/v3/appredir":
            # The portal opens every app through here; the real one doesn't know our ids.
            app_id = parse_qs(urlsplit(self.path).query).get("AppId", [""])[0]
            for a in ler_proprios():
                if str(a["id"]) == app_id:
                    return self.responder(302, b"", origem=f"app nosso {app_id}", location=a["url"])
        url = f"https://{HOST_API}{self.path}"
        real = buscar_real(url, list(self.headers.items()))
        nome = caminho.rstrip("/").rsplit("/", 1)[-1]
        if real and real[0] == 200:
            status, ctype, corpo, _ = real
            origem = "real"
        else:
            corpo = captura_mais_recente(nome) if caminho.startswith("/portal/v3/") else None
            if corpo is None:
                status, ctype, corpo, location = real if real else (502, "text/plain", b"upstream falhou", "")
                return self.responder(status, corpo, ctype, origem="real (sem captura p/ fallback)",
                                      location=location)
            status, ctype, origem = 200, "application/json", "CAPTURA (real falhou)"
        if caminho in ("/portal/v3/apps", "/portal/v3/configstatic", "/portal/v3/configlang"):
            try:
                dados = json.loads(corpo)
                if nome == "apps":
                    if origem == "real":
                        salvar_catalogo(corpo)
                    nota = mexer_apps(dados, ler_proprios())
                elif nome == "configstatic":
                    nota = mexer_configstatic(dados)
                else:
                    nota = mexer_configlang(dados, ler_proprios())
                corpo = json.dumps(dados, ensure_ascii=False).encode()
                ctype = "application/json"
                origem += f"; {nota}"
            except (ValueError, AttributeError, TypeError) as e:
                origem += f"; NÃO modificado ({e})"
        self.responder(status, corpo, ctype, origem)

    def icone(self, resto):
        m = RE_ICONE.match(resto)
        if m:
            app_id, w, h = int(m[1]), int(m[4]), int(m[5])
            for app in ler_proprios():
                if app["id"] == app_id:
                    proprio = painel.icone_proprio(app_id)
                    if proprio:
                        ctype = MIME_EXTRA.get(proprio.suffix) or mimetypes.guess_type(proprio.name)[0] or "image/png"
                        return self.responder(200, proprio.read_bytes(), ctype, origem="ícone próprio")
                    return self.responder(200, svg_icone(app, w, h), "image/svg+xml", origem="ícone gerado")
        if ".." in resto or not re.fullmatch(r"[\w./-]+", resto):
            return self.responder(400, origem="caminho de ícone inválido")
        arq = CACHE_ICONES / resto
        if not arq.is_file():
            real = buscar_real(ICONES_REAL + resto, [(k, v) for k, v in self.headers.items()
                                                    if k.lower() in ("user-agent", "accept", "accept-language")])
            if not real or real[0] != 200:
                return self.responder(real[0] if real else 502, origem="ícone real indisponível")
            arq.parent.mkdir(parents=True, exist_ok=True)
            arq.write_bytes(real[2])
            origem = "ícone real (baixado)"
        else:
            origem = "ícone real (cache)"
        ctype = mimetypes.guess_type(arq.name)[0] or "application/octet-stream"
        self.responder(200, arq.read_bytes(), ctype, origem=origem)

    def estatico(self, caminho):
        alvo = (WWW / caminho.lstrip("/")).resolve()
        if not alvo.is_relative_to(WWW.resolve()):
            return self.responder(403, origem="fora de www/")
        if alvo.is_dir():
            if not caminho.endswith("/"):
                self.send_response(301)
                self.send_header("Location", caminho + "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return log(f"{self.client_address[0]} {self.esquema.upper()} GET {self.host}{self.path} -> 301")
            alvo = alvo / "index.html"
        if not alvo.is_file():
            return self.responder(404, origem="(não existe em www/)")
        ctype = MIME_EXTRA.get(alvo.suffix.lower()) or mimetypes.guess_type(alvo.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        if alvo.stat().st_size <= 2 * 1024 * 1024 and "Range" not in self.headers:
            fixo = caminho.startswith(("/lib/fontes/", "/lib/vendor/"))          # never change: the TV may cache them
            return self.responder(200, alvo.read_bytes(), ctype, origem="www",
                                  cache="public, max-age=604800" if fixo else "no-store")
        self.enviar_arquivo(alvo, ctype)

    def enviar_arquivo(self, alvo, ctype):
        """Big file (video): in chunks, with support for one `Range: bytes=a-b` interval."""
        total = alvo.stat().st_size
        ini, fim, status = 0, total - 1, 200
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", (self.headers.get("Range") or "").strip())
        if m and (m[1] or m[2]):
            if m[1]:
                ini, fim = int(m[1]), min(int(m[2]) if m[2] else total - 1, total - 1)
            else:                                  # "bytes=-N": the last N bytes
                ini = max(0, total - int(m[2]))
            if ini > fim or ini >= total:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{total}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return log(f"{self.client_address[0]} {self.esquema.upper()} {self.command} {self.host}{self.path} -> 416")
            status = 206
        tamanho = fim - ini + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(tamanho))
        self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {ini}-{fim}/{total}")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        enviados = 0
        if self.command != "HEAD":
            try:
                with open(alvo, "rb") as f:
                    f.seek(ini)
                    while enviados < tamanho:
                        bloco = f.read(min(256 * 1024, tamanho - enviados))
                        if not bloco:
                            break
                        self.wfile.write(bloco)
                        enviados += len(bloco)
            except (BrokenPipeError, ConnectionResetError):
                pass                               # the player cancelled (normal when seeking elsewhere)
        faixa = f" bytes {ini}-{fim}/{total}" if status == 206 else ""
        log(f"{self.client_address[0]} {self.esquema.upper()} {self.command} {self.host}{self.path} -> "
            f"{status} {enviados}B www{faixa}")


class Servidor(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, porta, ctx=None):
        super().__init__(("0.0.0.0", porta), Handler)
        self.ctx = ctx

    def finish_request(self, sock, addr):
        if self.ctx:
            sock.settimeout(15)
            try:
                sock = self.ctx.wrap_socket(sock, server_side=True)
            except (ssl.SSLError, OSError) as e:
                log(f"{addr[0]} TLS falhou: {getattr(e, 'reason', None) or e}")
                return
            sock.settimeout(60)
        super().finish_request(sock, addr)


def checar():
    erros = []
    if not CERT.is_file() or not CHAVE.is_file():
        erros.append("faltam certs/cert.pem e certs/key.pem")
    for host in (HOST_API, HOST_LOJA):
        try:
            ip = socket.gethostbyname(host)
            if ip == PC_IP:
                erros.append(f"{host} resolve para o próprio PC ({ip}) neste container: o portal entraria em loop")
        except OSError as e:
            erros.append(f"não consegui resolver {host}: {e}")
    if subprocess.run(["curl", "--version"], capture_output=True).returncode != 0:
        erros.append("curl não encontrado")
    for pagina in ("teste", "inicio"):
        if not (WWW / pagina / "index.html").is_file():
            erros.append(f"falta www/{pagina}/index.html")
    if erros:
        sys.exit("ERRO:\n  " + "\n  ".join(erros))


def main():
    checar()
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.MINIMUM_SUPPORTED
    try:
        ctx.set_ciphers("ALL:@SECLEVEL=0")
    except ssl.SSLError:
        pass
    ctx.load_cert_chain(CERT, CHAVE)
    painel.configurar(pc_ip=PC_IP, log=log, catalogo=catalogo_real, dns=None, porta=PORTA_CELULAR)
    for porta, c in ((PORTA_HTTP, None), (PORTA_HTTPS, ctx), (PORTA_CELULAR, None)):
        threading.Thread(target=Servidor(porta, c).serve_forever, daemon=True).start()
    for g in config.girar_logs(CFG):
        log(f"log girado: {g}")
    def girar_de_hora_em_hora():
        while True:
            time.sleep(3600)
            for g in config.girar_logs():
                log(f"log girado: {g}")
    threading.Thread(target=girar_de_hora_em_hora, daemon=True).start()
    if CFG["_ip_mudou"]:
        log(f"ATENÇÃO: o IP do PC mudou de {CFG['_ip_mudou']} para {PC_IP}. Na TV, o DNS precisa ser {PC_IP}.")
    if os.environ.get("DNS", "1" if CFG["dns"]["embutido"] else "0") == "1":
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import dns_openrange
        porta_dns = int(os.environ.get("DNS_PORTA", CFG["portas"]["dns"]))
        try:
            painel.CTX["dns"] = dns_openrange.Servico(PC_IP, porta_dns, os.environ.get("DNS_ENDERECO", PC_IP)).iniciar()
        except OSError as e:
            sys.exit(f"ERRO: o DNS embutido não abriu {PC_IP}:{porta_dns} ({e}). Rode como root, pare o dnsmasq antigo "
                     f"(tools/openrange.sh parar) ou use DNS=0 para subir só o HTTP.")
        log(f"DNS embutido no ar em {PC_IP}:{porta_dns} (redirects: {', '.join(CFG['redirects']) or 'nenhum'})")
    nomes = ", ".join(f"{a['id']}={a['name']}" for a in ler_proprios()) or "nenhum"
    log(f"painel de controle: http://localhost:{PORTA_CELULAR}/painel/ (só neste PC)")
    log(f"portal no ar em :{PORTA_HTTP}, :{PORTA_HTTPS} e :{PORTA_CELULAR} (celular) (PC {PC_IP}){' OFFLINE' if OFFLINE else ''}. Apps nossos: {nomes}. Ctrl+C para sair.")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        log("encerrado")


if __name__ == "__main__":
    main()
