#!/usr/bin/env python3
"""painel.py — web control panel API (M3.3), served by tools/portal.py under /painel/api/ (page: www/painel/).

Only the PC itself may use it: the client must be loopback or the PC's own IP, the Host header must name this PC
(blocks DNS rebinding) and every call carries `X-OpenRange: 1` (a cross-site page can't send it without a CORS
preflight, which the portal refuses for /painel/). Other LAN devices get 403.

  GET  estado                  service, TV contact (ping, last DNS/HTTP), network, pending restart
  POST diagnostico             output of `tools/openrange.sh saude`
  POST teste-dns               resolves each redirect and example.com through our own DNS
  GET  config / POST config    editable parts of config/openrange.json (TV IP, redirects, DNS, launcher, logs)
  POST reiniciar               systemctl restart openrange (installed mode only)
  GET  apps / POST apps        config/apps-proprios.json (the whole list; order = launcher order)
  POST apps/<id>/icone         {tipo, dados(base64)} or {remover: true}: own icon in config/icones/
  GET  catalogo?q=             store catalog (last real copy) for picking favorites
  POST favoritos               launcher.favoritos (store app ids, in order)
  GET  logs?arquivo=&desde=    tail of portal|eventos|dns logs from a byte offset (masked)
  GET  vizinhos                LAN neighbours (ip neigh) + who used our DNS: picks the TV IP in the first-run steps
Tested by tools/sim/painel.py (gate).
"""
import base64
import ipaddress
import json
import os
import re
import socket
import struct
import subprocess
import threading
import time
from pathlib import Path

import config

RAIZ = Path(__file__).resolve().parent.parent
APPS = RAIZ / "config" / "apps-proprios.json"
ICONES = RAIZ / "config" / "icones"
LOGS = {"portal": RAIZ / "logs" / "portal.log", "eventos": RAIZ / "logs" / "relatorios" / "eventos.jsonl",
        "dns": RAIZ / "logs" / "dns.log"}
TIPOS_ICONE = {"image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "image/webp": "webp"}
MAX_ICONE = 300 * 1024
LOG_JANELA = 64 * 1024
ID_MIN = 990001
SECAO_PADRAO = "Nossos apps"
RE_COR = re.compile(r"^#[0-9a-fA-F]{6}$")
RE_IP = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
# long hex ids/tokens and long base64url blobs (server URLs with embedded credentials)
RE_SEGREDO = re.compile(r"[0-9a-fA-F]{24,}|[A-Za-z0-9_\-]{40,}")

_trava = threading.Lock()
CTX = {"pc_ip": "", "log": print, "catalogo": lambda: [], "dns": None, "inicio": time.time(), "base": {}}
TV = {"http": 0.0, "http_caminho": "", "ua": "", "inicio": 0.0}      # last requests seen from the TV's IP
_ping = {"t": 0.0, "ok": None, "ip": ""}


def configurar(**kw):
    """Called once by portal.py: pc_ip, log, catalogo (fn → store apps), dns (dns_openrange.Servico or None)."""
    CTX.update(kw)
    CTX["base"] = _base_reinicio()
    try:
        _semear_do_log()
    except (OSError, ValueError):
        pass


def _ler_cauda(p, n=256 * 1024):
    if not p.is_file():
        return []
    with open(p, "rb") as f:
        f.seek(max(0, p.stat().st_size - n))
        return f.read().decode("utf-8", "replace").splitlines()[1:]


def _semear_do_log():
    """After a restart the in-memory 'last seen' is empty: recover the TV's last request from the tail of
    portal.log ("HH:MM:SS ip ...", today) and its last DNS query from dns.log ("Mon DD HH:MM:SS ... from ip")."""
    import datetime
    ip = _tv_ip_atual()
    if not ip:
        return
    hoje = datetime.date.today()
    for linha in reversed(_ler_cauda(LOGS["portal"])):
        p = linha.split(" ", 5)
        if len(p) > 4 and p[1] == ip and re.fullmatch(r"\d\d:\d\d:\d\d", p[0]):
            t = datetime.datetime.combine(hoje, datetime.time.fromisoformat(p[0])).timestamp()
            if t <= time.time():
                TV.update(http=t, http_caminho=mascarar(p[4])[:120])
            break
    for linha in reversed(_ler_cauda(LOGS["dns"])):
        if linha.endswith(" from " + ip) and "query[" in linha:
            t = datetime.datetime.strptime(f"{hoje.year} {linha[:15]}", "%Y %b %d %H:%M:%S").timestamp()
            if t <= time.time():
                _dns_semente[ip] = (t, linha.split("] ", 1)[1].split(" from ")[0])
            break


_dns_semente = {}           # last DNS query per client recovered from dns.log (until the live DNS sees one)


def _base_reinicio():
    """What needs a restart to take effect (network, ports, embedded DNS on/off)."""
    try:
        bruto = json.loads(config.ARQ.read_text())
    except (OSError, ValueError):
        return {}
    return {k: bruto.get(k) for k in ("rede", "portas")} | {"dns_embutido": (bruto.get("dns") or {}).get("embutido", True)}


def mascarar(s):
    return RE_SEGREDO.sub(lambda m: f"{m[0][:4]}…{m[0][-4:]}", s)


_tv_ip = {"mtime": None, "ip": ""}


def _tv_ip_atual():
    """rede.tv_ip, re-read only when config/openrange.json changes (called on every request)."""
    try:
        m = config.ARQ.stat().st_mtime
        if m != _tv_ip["mtime"]:
            _tv_ip.update(mtime=m, ip=json.loads(config.ARQ.read_text())["rede"]["tv_ip"])
    except (OSError, ValueError, KeyError):
        pass
    return _tv_ip["ip"]


def visto(ip, caminho, ua):
    """portal.py calls this for every request; we keep the TV's."""
    if ip != _tv_ip_atual():
        return
    agora = time.time()
    TV.update(http=agora, http_caminho=mascarar(caminho)[:120], ua=ua or TV["ua"])
    if caminho.startswith("/inicio/"):
        TV["inicio"] = agora


# --- access control ---------------------------------------------------------------------------------
def permitido(cliente, host, cabecalho):
    """None if allowed, else the reason (Portuguese, shown on the page)."""
    pc = CTX["pc_ip"]
    try:
        local = ipaddress.ip_address(cliente).is_loopback or cliente == pc
    except ValueError:
        local = False
    if not local:
        return f"o painel só funciona no próprio PC: abra http://localhost:{CTX.get('porta', 8090)}/painel/ nele"
    h = (host or "").strip().lower()
    nome = h[1:h.find("]")] if h.startswith("[") else h.split(":")[0]
    if nome not in ("localhost", "127.0.0.1", "::1", pc, socket.gethostname().lower()):
        return "Host desconhecido"
    if cabecalho != "1":
        return "falta o cabeçalho X-OpenRange"
    return None


# --- helpers ----------------------------------------------------------------------------------------
def _ler_bruto():
    return json.loads(config.ARQ.read_text())


PORTA_DIAL = 56789     # the TV ignores ICMP ping, but its DIAL server (docs/tv-platform.md) answers TCP


def _ping_tv(ip):
    """Is the TV on the network? TCP connect to its DIAL port, then ICMP ping as a fallback (cached 5 s)."""
    agora = time.time()
    if _ping["ip"] == ip and agora - _ping["t"] < 5:
        return _ping["ok"]
    ok = False
    try:
        with socket.create_connection((ip, PORTA_DIAL), timeout=1):
            ok = True
    except OSError:
        try:
            ok = subprocess.run(["ping", "-c1", "-W1", ip], capture_output=True, timeout=3).returncode == 0
        except (OSError, subprocess.SubprocessError):
            pass
    _ping.update(t=agora, ok=ok, ip=ip)
    return ok


def _modo():
    return "servico" if os.environ.get("INVOCATION_ID") else "manual"


def _versao():
    try:
        return subprocess.run(["git", "-C", str(RAIZ), "log", "-1", "--format=%h %cs"], capture_output=True,
                              text=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def _consulta_dns(nome, servidor, porta, tempo=2.0):
    """A-record lookup straight to our DNS (no resolver cache in between). Returns the first IPv4 or ''."""
    qid = int(time.time() * 1000) & 0xFFFF
    pergunta = struct.pack(">HHHHHH", qid, 0x0100, 1, 0, 0, 0)
    pergunta += b"".join(bytes([len(p)]) + p.encode() for p in nome.split(".")) + b"\0" + struct.pack(">HH", 1, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(tempo)
        s.sendto(pergunta, (servidor, porta))
        dados, _ = s.recvfrom(4096)
    _id, _flags, qd, an = struct.unpack(">HHHH", dados[:8])
    i = 12
    for _ in range(qd):                      # skip the question
        while dados[i]:
            i += dados[i] + 1
        i += 5
    for _ in range(an):
        if dados[i] & 0xC0 == 0xC0:
            i += 2
        else:
            while dados[i]:
                i += dados[i] + 1
            i += 1
        tipo, _cl, _ttl, n = struct.unpack(">HHIH", dados[i:i + 10])
        i += 10
        if tipo == 1 and n == 4:
            return socket.inet_ntoa(dados[i:i + 4])
        i += n
    return ""


# --- endpoints --------------------------------------------------------------------------------------
def estado():
    cfg = config.carregar(regerar_antigos=False)
    rede = cfg["rede"]
    dns = CTX["dns"]
    ultimo_dns = (dns.clientes.get(rede["tv_ip"]) if dns is not None and hasattr(dns, "clientes") else None) \
        or _dns_semente.get(rede["tv_ip"])
    tamanhos = {k: (p.stat().st_size if p.is_file() else 0) for k, p in LOGS.items()}
    return {
        "modo": _modo(), "versao": _versao(), "inicio": CTX["inicio"], "agora": time.time(),
        "pc_ip": rede["pc_ip"], "tv_ip": rede["tv_ip"], "interface": rede["interface"], "gateway": rede["gateway"],
        "auto": cfg["_auto"], "portas": cfg["portas"], "redirects": cfg["redirects"], "problemas": cfg["_problemas"],
        "dns_embutido": dns is not None,
        "tv": {"ping": _ping_tv(rede["tv_ip"]), "http": TV["http"] or None, "http_caminho": TV["http_caminho"],
               "inicio": TV["inicio"] or None, "dns": ultimo_dns[0] if ultimo_dns else None,
               "dns_nome": ultimo_dns[1] if ultimo_dns else "", "ua": TV["ua"]},
        "reiniciar": _base_reinicio() != CTX["base"],
        "logs": tamanhos,
    }


def diagnostico():
    try:
        r = subprocess.run(["bash", str(RAIZ / "tools" / "openrange.sh"), "saude"], capture_output=True, text=True,
                           timeout=60, cwd=RAIZ, env=dict(os.environ, LC_ALL="C.UTF-8"))
        return {"ok": r.returncode == 0, "saida": mascarar(r.stdout + r.stderr)}
    except subprocess.TimeoutExpired:
        return {"ok": False, "saida": "o diagnóstico passou de 60 s"}


def teste_dns():
    cfg = config.carregar(regerar_antigos=False)
    pc, porta = cfg["rede"]["pc_ip"], cfg["portas"]["dns"]
    if CTX["dns"] is None:
        return {"ok": False, "erro": "o DNS embutido está desligado (dns.embutido = false ou DNS=0)", "resultados": []}
    res = []
    for nome, esperado in [(d, pc) for d in cfg["redirects"]] + [("example.com", "")]:
        try:
            r = _consulta_dns(nome, pc, porta)
        except OSError as e:
            r = f"sem resposta ({e})"
        res.append({"nome": nome, "resposta": r, "esperado": esperado or "um IP da internet",
                    "ok": r == pc if esperado else bool(RE_IP.match(r or "")) and r != pc})
    return {"ok": all(x["ok"] for x in res), "resultados": res}


def ler_config():
    b = _ler_bruto()
    return {"rede": {"tv_ip": b["rede"].get("tv_ip", ""), "pc_ip": b["rede"].get("pc_ip", "auto")},
            "redirects": b.get("redirects", []), "dns": b.get("dns", {}),
            "launcher": {"substituir_loja": b.get("launcher", {}).get("substituir_loja", True)},
            "logs": b.get("logs", {}), "portas": b.get("portas", {})}


def salvar_config(novo):
    b = _ler_bruto()
    erros = []
    rede = novo.get("rede") or {}
    if "tv_ip" in rede:
        ip = str(rede["tv_ip"]).strip()
        if not RE_IP.match(ip) or any(int(x) > 255 for x in ip.split(".")):
            erros.append(f"IP da TV inválido: {ip!r}")
        else:
            b["rede"]["tv_ip"] = ip
    if "redirects" in novo:
        ok, ruins = config.validar_redirects([x for x in novo["redirects"] if str(x).strip()])
        erros += ruins
        b["redirects"] = ok
    dns = novo.get("dns") or {}
    if "upstreams" in dns:
        ups = [str(x).strip() for x in dns["upstreams"] if str(x).strip()]
        ruins = [x for x in ups if not RE_IP.match(x)]
        if ruins or not ups:
            erros.append("DNS de fora: um ou mais IPs, ex. 1.1.1.1" + (f" (inválido: {', '.join(ruins)})" if ruins else ""))
        else:
            b.setdefault("dns", {})["upstreams"] = ups
    if "embutido" in dns:
        b.setdefault("dns", {})["embutido"] = bool(dns["embutido"])
    lan = novo.get("launcher") or {}
    if "substituir_loja" in lan:
        b.setdefault("launcher", {})["substituir_loja"] = bool(lan["substituir_loja"])
    logs = novo.get("logs") or {}
    for k, lo, hi in (("max_mb", 1, 100), ("manter", 1, 10)):
        if k in logs:
            try:
                v = int(logs[k])
                if not lo <= v <= hi:
                    raise ValueError
                b.setdefault("logs", {})[k] = v
            except (TypeError, ValueError):
                erros.append(f"logs.{k}: número de {lo} a {hi}")
    if erros:
        return 400, {"erro": "; ".join(erros)}
    with _trava:
        config.salvar(b)
    CTX["log"]("painel: config/openrange.json salvo")
    return 200, {"ok": True, "reiniciar": _base_reinicio() != CTX["base"]}


def reiniciar():
    if _modo() != "servico":
        return 409, {"erro": "modo manual: reinicie com tools/openrange.sh reiniciar (ou instale o serviço)"}
    CTX["log"]("painel: reiniciando o openrange.service")
    # --no-block: the reply goes out before systemd stops this process
    subprocess.Popen(["systemctl", "--no-ask-password", "--no-block", "restart", "openrange.service"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return 200, {"ok": True}


# --- own apps -----------------------------------------------------------------------------------------
def _ler_apps():
    try:
        return json.loads(APPS.read_text())
    except (OSError, ValueError):
        return {"apps": []}


def icone_proprio(app_id):
    for ext in TIPOS_ICONE.values():
        p = ICONES / f"{app_id}.{ext}"
        if p.is_file():
            return p
    return None


def listar_apps():
    apps = []
    for a in _ler_apps().get("apps", []):
        p = icone_proprio(a.get("id"))
        apps.append(dict(a, secao=a.get("secao") or SECAO_PADRAO, icone_proprio=bool(p),
                         icone_v=int(p.stat().st_mtime) if p else 0))
    return {"apps": apps, "secao_padrao": SECAO_PADRAO}


def _validar_app(a, ids):
    erros = []
    nome = str(a.get("name", "")).strip()
    url = str(a.get("url", "")).strip()
    if not 1 <= len(nome) <= 60:
        erros.append("nome: 1 a 60 caracteres")
    if not re.match(r"^https?://\S+$", url):
        erros.append("endereço: precisa começar com http:// ou https:// (use {PC_IP} para este PC)")
    cor = str(a.get("cor") or "#444444")
    if not RE_COR.match(cor):
        erros.append(f"cor inválida: {cor}")
    app = {"id": a.get("id"), "name": nome, "url": url, "description": str(a.get("description", "")).strip()[:300],
           "cor": cor, "inicio": bool(a.get("inicio"))}
    rot = str(a.get("rotulo", "")).strip()[:30]
    if rot:
        app["rotulo"] = rot
    secao = str(a.get("secao", "")).strip()[:40]
    if secao and secao != SECAO_PADRAO:
        app["secao"] = secao
    for k in ("categories", "languages"):                    # store fields we don't edit: kept as they were
        if isinstance(a.get(k), list):
            app[k] = a[k]
    if not isinstance(app["id"], int) or app["id"] < ID_MIN or app["id"] in ids:
        app["id"] = None                                      # new (or a clash): gets a free id below
    return app, erros


def salvar_apps(lista):
    if not isinstance(lista, list) or len(lista) > 100:
        return 400, {"erro": "lista de apps inválida"}
    novos, erros, ids = [], [], set()
    for i, a in enumerate(lista):
        if not isinstance(a, dict):
            return 400, {"erro": f"app {i + 1}: inválido"}
        app, e = _validar_app(a, ids)
        erros += [f"{app['name'] or f'app {i + 1}'}: {x}" for x in e]
        if app["id"] is not None:
            ids.add(app["id"])
        novos.append(app)
    if erros:
        return 400, {"erro": "; ".join(erros)}
    proximo = max(ids | {ID_MIN - 1}) + 1
    for app in novos:
        if app["id"] is None:
            app["id"], proximo = proximo, proximo + 1
            ids.add(app["id"])
    with _trava:
        dados = _ler_apps()
        removidos = {a.get("id") for a in dados.get("apps", [])} - ids
        dados["apps"] = novos
        tmp = APPS.with_suffix(".tmp")
        tmp.write_text(json.dumps(dados, ensure_ascii=False, indent=2) + "\n")
        tmp.replace(APPS)
        for r in removidos:
            p = icone_proprio(r)
            if p:
                p.unlink()
    CTX["log"](f"painel: {len(novos)} apps nossos salvos" + (f" (removidos: {sorted(removidos)})" if removidos else ""))
    return 200, listar_apps()


def salvar_icone(app_id, corpo):
    if app_id not in {a.get("id") for a in _ler_apps().get("apps", [])}:
        return 404, {"erro": "app não existe (salve o app antes de pôr o ícone)"}
    with _trava:
        velho = icone_proprio(app_id)
        if corpo.get("remover"):
            if velho:
                velho.unlink()
            return 200, listar_apps()
        ext = TIPOS_ICONE.get(corpo.get("tipo"))
        if not ext:
            return 400, {"erro": "ícone: use PNG, JPEG, WebP ou SVG"}
        try:
            dados = base64.b64decode(corpo.get("dados") or "", validate=True)
        except ValueError:
            return 400, {"erro": "ícone: base64 inválido"}
        if not dados or len(dados) > MAX_ICONE:
            return 400, {"erro": f"ícone: até {MAX_ICONE // 1024} KB"}
        if ext == "svg" and re.search(rb"<script|\bon\w+\s*=|javascript:", dados, re.I):
            return 400, {"erro": "ícone SVG com script não é aceito"}
        ICONES.mkdir(parents=True, exist_ok=True)
        if velho:
            velho.unlink()
        (ICONES / f"{app_id}.{ext}").write_bytes(dados)
    CTX["log"](f"painel: ícone próprio do app {app_id} ({ext}, {len(dados)} B)")
    return 200, listar_apps()


# --- store favorites ---------------------------------------------------------------------------------
def catalogo(q):
    q = (q or "").strip().lower()
    favs = config.carregar(regerar_antigos=False)["launcher"].get("favoritos", [])
    apps = [a for a in CTX["catalogo"]() if a.get("id") and a.get("name") and a.get("id") < ID_MIN]
    por_id = {a["id"]: a for a in apps}
    achados = [a for a in apps if not q or q in a["name"].lower() or q == str(a["id"])]
    achados.sort(key=lambda a: a["name"].lower())
    def item(a):
        desc = " ".join((a.get("description") or "").split())
        return {"id": a["id"], "name": a["name"], "description": desc[:70] + ("…" if len(desc) > 70 else "")}
    return {"total": len(apps), "resultados": [item(a) for a in achados[:60]],
            "favoritos": [item(por_id[i]) if i in por_id else {"id": i, "name": f"#{i} (fora do catálogo)", "description": ""}
                          for i in favs]}


def salvar_favoritos(ids):
    if not isinstance(ids, list) or not all(isinstance(i, int) and 0 < i < ID_MIN for i in ids) or len(ids) > 60:
        return 400, {"erro": "favoritos: lista de ids da loja"}
    b = _ler_bruto()
    b.setdefault("launcher", {})["favoritos"] = list(dict.fromkeys(ids))
    with _trava:
        config.salvar(b)
    CTX["log"](f"painel: favoritos = {b['launcher']['favoritos']}")
    return 200, {"ok": True}


# --- logs / neighbours --------------------------------------------------------------------------------
def logs(arquivo, desde):
    p = LOGS.get(arquivo)
    if not p:
        return 400, {"erro": "arquivo: portal, eventos ou dns"}
    tamanho = p.stat().st_size if p.is_file() else 0
    primeira = desde is None or desde < 0 or desde > tamanho   # first read, or the log was rotated
    if primeira:
        desde = max(0, tamanho - LOG_JANELA)
    with open(p, "rb") if p.is_file() else open(os.devnull, "rb") as f:
        f.seek(desde)
        bruto = f.read(min(tamanho - desde, 4 * LOG_JANELA))
    fim = desde + len(bruto)
    if bruto and not bruto.endswith(b"\n"):                   # half-written line: next poll takes it
        corte = bruto.rfind(b"\n") + 1
        fim, bruto = desde + corte, bruto[:corte]
    texto = bruto.decode("utf-8", "replace")
    if primeira and desde:
        texto = texto.split("\n", 1)[-1]                       # first read: drop the partial first line
    return 200, {"texto": mascarar(texto), "fim": fim, "tamanho": tamanho}


def vizinhos():
    cfg = config.carregar(regerar_antigos=False)
    dns = CTX["dns"]
    vistos = dict(getattr(dns, "clientes", {}) or {})
    lista = {}
    try:
        saida = subprocess.run(["ip", "-4", "neigh", "show"], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        saida = ""
    for linha in saida.splitlines():
        p = linha.split()
        if len(p) >= 5 and "lladdr" in p and p[0] != cfg["rede"]["gateway"]:
            lista[p[0]] = {"ip": p[0], "mac": p[p.index("lladdr") + 1], "estado": p[-1]}
    for ip, (t, nome) in vistos.items():
        if ip in (cfg["rede"]["pc_ip"], "127.0.0.1"):
            continue
        lista.setdefault(ip, {"ip": ip, "mac": "", "estado": ""}).update(dns=t, dns_nome=nome)
    itens = sorted(lista.values(), key=lambda x: (-(x.get("dns") or 0), [int(n) for n in x["ip"].split(".")]))
    return {"vizinhos": itens, "tv_ip": cfg["rede"]["tv_ip"], "pc_ip": cfg["rede"]["pc_ip"]}


# --- dispatcher ---------------------------------------------------------------------------------------
def tratar(metodo, caminho, query, corpo):
    """(status, dict). caminho = what follows /painel/api/."""
    try:
        dados = json.loads(corpo) if corpo else {}
    except ValueError:
        return 400, {"erro": "JSON inválido"}
    try:
        if metodo == "GET" and caminho == "estado":
            return 200, estado()
        if metodo == "POST" and caminho == "diagnostico":
            return 200, diagnostico()
        if metodo == "POST" and caminho == "teste-dns":
            return 200, teste_dns()
        if caminho == "config":
            return (200, ler_config()) if metodo == "GET" else salvar_config(dados)
        if metodo == "POST" and caminho == "reiniciar":
            return reiniciar()
        if caminho == "apps":
            return (200, listar_apps()) if metodo == "GET" else salvar_apps(dados.get("apps"))
        m = re.fullmatch(r"apps/(\d+)/icone", caminho)
        if metodo == "POST" and m:
            return salvar_icone(int(m[1]), dados)
        if metodo == "GET" and caminho == "catalogo":
            return 200, catalogo(query.get("q", [""])[0])
        if metodo == "POST" and caminho == "favoritos":
            return salvar_favoritos(dados.get("favoritos"))
        if metodo == "GET" and caminho == "logs":
            d = query.get("desde", [""])[0]
            return logs(query.get("arquivo", ["portal"])[0], int(d) if d.lstrip("-").isdigit() else None)
        if metodo == "GET" and caminho == "vizinhos":
            return 200, vizinhos()
    except SystemExit as e:                      # config.carregar refuses a broken openrange.json
        return 500, {"erro": str(e)}
    except (OSError, KeyError, TypeError, ValueError) as e:
        CTX["log"](f"painel: erro em {metodo} {caminho}: {e!r}")
        return 500, {"erro": f"{type(e).__name__}: {e}"}
    return 404, {"erro": "rota desconhecida"}
