#!/usr/bin/env python3
"""config.py — single OpenRange configuration (Stage 3/P1): config/openrange.json.

Source of truth for network, redirects, ports, DNS and launcher. The first time it is created from the
old files (config/rede.env, config/redirects.txt, config/inicio.json). For scripts that still read
the old ones, they are REGENERATED from openrange.json (with a "don't edit" notice) whenever the config is read.

"auto" in pc_ip/interface/gateway = found from the route to the TV (a new network/DHCP lease breaks nothing).

Usage (on the [HOST] or any distrobox):
  python3 tools/config.py mostrar     effective config ("auto" already resolved)
  python3 tools/config.py env         KEY=value lines for `eval` in bash (and regenerates rede.env/redirects.txt)
  python3 tools/config.py migrar      (re)creates config/openrange.json from the old files
Em Python:  sys.path.insert(0, "tools"); import config; cfg = config.carregar()
OPENRANGE_SO_LER=1 → writes nothing (no rede.env/redirects.txt, no last IP): for whoever runs as root.
"""
import copy
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
ARQ = RAIZ / "config" / "openrange.json"
ARQ_ANTIGO = RAIZ / "config" / "tvlab.json"          # name before the project was renamed (2026-11-16)
if not ARQ.exists() and ARQ_ANTIGO.is_file():
    try:
        ARQ_ANTIGO.rename(ARQ)                        # one-time migration; as root (read-only mode) just read it
        ARQ_ANTIGO.symlink_to(ARQ.name)               # a still-running old service keeps finding its config
    except OSError:
        ARQ = ARQ_ANTIGO
REDE_ENV = RAIZ / "config" / "rede.env"
REDIRECTS_TXT = RAIZ / "config" / "redirects.txt"
INICIO_JSON = RAIZ / "config" / "inicio.json"
ULTIMO_IP = RAIZ / "cache" / "ultimo-pc-ip"
PROIBIDOS = ("netflix", "nflx")
RE_DOMINIO = re.compile(r"^([a-z0-9-]+\.)+[a-z]{2,}$")

PADRAO = {
    "_leia": "Configuração do OpenRange. 'auto' = descobrir sozinho. Editar não exige reiniciar o DNS (redirects) nem o "
             "launcher; rede e portas valem na próxima subida (tools/openrange.sh parar && iniciar).",
    "rede": {"tv_ip": "", "pc_ip": "auto", "interface": "auto", "gateway": "auto", "zona_firewall": "auto"},
    "redirects": ["api-portal-v3.netrange.com", "ver.netrange.com"],
    "dns": {"embutido": True, "upstreams": ["1.1.1.1", "8.8.8.8"]},
    "portas": {"dns": 53, "http": 80, "https": 443, "celular": 8090},
    "launcher": {"favoritos": [], "substituir_loja": True},
    "logs": {"max_mb": 5, "manter": 3},
    "painel": {"ips_extras": []},
}


# --- reading the old files (migration) -------------------------------------------------------
def _ler_env(arq):
    env = {}
    if arq.is_file():
        for linha in arq.read_text().splitlines():
            linha = linha.split("#", 1)[0].strip()
            if "=" in linha:
                k, v = linha.split("=", 1)
                env[k.strip()] = v.strip().strip('"')
    return env


def _ler_redirects_txt(arq):
    if not arq.is_file():
        return None
    r = []
    for linha in arq.read_text().splitlines():
        d = linha.split("#", 1)[0].strip().lower().rstrip(".")
        if d:
            r.append(d)
    return r


def migrar():
    cfg = copy.deepcopy(PADRAO)
    env = _ler_env(REDE_ENV)
    if env.get("TV_IP"):
        cfg["rede"]["tv_ip"] = env["TV_IP"]
    if env.get("FW_ZONE"):
        cfg["rede"]["zona_firewall"] = env["FW_ZONE"]
    # old PC_IP/IFACE/GATEWAY become "auto": the route to the TV tells what they are
    red = _ler_redirects_txt(REDIRECTS_TXT)
    if red is not None and not REDIRECTS_TXT.read_text().startswith("# GERADO"):
        cfg["redirects"] = red
    try:
        ini = json.loads(INICIO_JSON.read_text())
        cfg["launcher"]["favoritos"] = ini.get("favoritos", [])
        cfg["launcher"]["substituir_loja"] = bool(ini.get("substituir_loja", True))
    except (OSError, ValueError):
        pass
    salvar(cfg)
    return cfg


def salvar(cfg):
    ARQ.parent.mkdir(exist_ok=True)
    tmp = ARQ.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
    tmp.replace(ARQ)


# --- "auto" -------------------------------------------------------------------------------------------
def _ip_local_para(destino):
    """This computer's IP on the route to `destino` (sends nothing: a UDP connect only picks the route)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect((destino, 9))
        return s.getsockname()[0]


def _interface_de(ip):
    try:
        saida = subprocess.run(["ip", "-o", "-4", "addr", "show"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return ""
    for linha in saida.splitlines():
        p = linha.split()
        if len(p) >= 4 and p[3].split("/")[0] == ip:
            return p[1]
    return ""


def _gateway():
    try:
        saida = subprocess.run(["ip", "-4", "route", "show", "default"], capture_output=True, text=True, timeout=5).stdout
        m = re.search(r"default via (\S+)", saida)
        return m.group(1) if m else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _mesclar(base, extra):
    r = copy.deepcopy(base)
    for k, v in (extra or {}).items():
        r[k] = _mesclar(r[k], v) if isinstance(v, dict) and isinstance(r.get(k), dict) else v
    return r


def validar_ips_painel(lista):
    """(valid, problems) for painel.ips_extras: IPv4 addresses or networks of the LAN (private ranges, at most /16).
    The panel has no password, so a typo must never open it to the internet."""
    ok, ruins = [], []
    for x in lista if isinstance(lista, list) else [lista]:
        try:
            rede = ipaddress.ip_network(str(x).strip(), strict=False)
        except ValueError:
            rede = None
        if rede and rede.version == 4 and rede.prefixlen >= 16 and rede.is_private and not rede.is_loopback:
            ok.append(str(rede.network_address) if rede.prefixlen == 32 else str(rede))
        else:
            ruins.append(f"painel.ips_extras: {x!r} ignorado (só IPv4 da rede local, ex. 192.168.0.20 ou 192.168.0.0/24)")
    return ok, ruins


def validar_redirects(lista):
    """(valid, problems). Refuses Netflix (project rule) and invalid names."""
    ok, ruins = [], []
    for d in lista:
        d = str(d).strip().lower().rstrip(".")
        if any(p in d for p in PROIBIDOS):
            ruins.append(f"{d}: Netflix nunca é redirecionada")
        elif not RE_DOMINIO.match(d):
            ruins.append(f"{d}: domínio inválido")
        elif d not in ok:
            ok.append(d)
    return ok, ruins


SO_LER = os.environ.get("OPENRANGE_SO_LER") == "1"


def carregar(regerar_antigos=True):
    """Config efetiva (dict). 'auto' resolvido em cfg['rede'] e o original em cfg['_auto']."""
    regerar_antigos = regerar_antigos and not SO_LER
    if ARQ.is_file():
        try:
            bruto = json.loads(ARQ.read_text())
        except ValueError as e:
            raise SystemExit(f"config/openrange.json inválido: {e}")
    elif SO_LER:
        raise SystemExit("config/openrange.json não existe (rode tools/instalar.sh ou python3 tools/config.py migrar)")
    else:
        bruto = migrar()
    cfg = _mesclar(PADRAO, bruto)
    rede, auto = cfg["rede"], {}
    if not rede.get("tv_ip"):
        raise SystemExit("config/openrange.json: defina rede.tv_ip (o IP da TV)")
    if rede.get("pc_ip", "auto") == "auto":
        auto["pc_ip"] = True
        rede["pc_ip"] = _ip_local_para(rede["tv_ip"])
    if rede.get("interface", "auto") == "auto":
        auto["interface"] = True
        rede["interface"] = _interface_de(rede["pc_ip"])
    if rede.get("gateway", "auto") == "auto":
        auto["gateway"] = True
        rede["gateway"] = _gateway()
    cfg["_auto"] = auto
    cfg["redirects"], cfg["_problemas"] = validar_redirects(cfg.get("redirects", []))
    cfg["_ip_mudou"] = _checar_ip(rede["pc_ip"])
    if regerar_antigos:
        _regerar_antigos(cfg)
    return cfg


def _checar_ip(ip):
    """Previous IP if it changed since last time (the TV needs the new DNS!), else None."""
    if SO_LER:
        return None
    try:
        antes = ULTIMO_IP.read_text().strip() if ULTIMO_IP.is_file() else ""
        if antes != ip:
            ULTIMO_IP.parent.mkdir(exist_ok=True)
            ULTIMO_IP.write_text(ip + "\n")
            return antes or None
    except OSError:
        pass
    return None


def _escrever_se_mudou(arq, texto):
    try:
        if arq.is_file() and arq.read_text() == texto:
            return
        tmp = arq.with_suffix(arq.suffix + ".tmp")
        tmp.write_text(texto)
        tmp.replace(arq)
    except OSError as e:
        print(f"config: não consegui atualizar {arq.name}: {e}", file=sys.stderr)


def _regerar_antigos(cfg):
    r = cfg["rede"]
    cab = "# GERADO de config/openrange.json por tools/config.py — NÃO EDITE (edite o openrange.json)\n"
    _escrever_se_mudou(REDE_ENV, cab + f"PC_IP={r['pc_ip']}\nTV_IP={r['tv_ip']}\nIFACE={r['interface']}\n"
                                       f"GATEWAY={r['gateway']}\nFW_ZONE={r['zona_firewall']}\n")
    if REDIRECTS_TXT.is_file() and not REDIRECTS_TXT.read_text().startswith("# GERADO"):
        antigo = REDIRECTS_TXT.with_name("redirects.txt.antigo")
        if not antigo.exists():
            antigo.write_text(REDIRECTS_TXT.read_text())          # keeps the comments/history
    _escrever_se_mudou(REDIRECTS_TXT, cab + "\n".join(cfg["redirects"]) + "\n")


def girar_logs(cfg=None):
    """Rotates big logs: x.log → x.log.1 → … (keeps N). Called by the portal on start and every hour."""
    cfg = cfg or carregar(regerar_antigos=False)
    limite = cfg["logs"]["max_mb"] * 1024 * 1024
    manter = max(1, int(cfg["logs"]["manter"]))
    girados = []
    for arq in [RAIZ / "logs" / "portal.log", RAIZ / "logs" / "dns.log", RAIZ / "logs" / "portal.out",
                RAIZ / "logs" / "relatorios" / "eventos.jsonl"]:
        try:
            if not arq.is_file() or arq.stat().st_size < limite:
                continue
            for i in range(manter, 0, -1):
                velho = arq.with_name(f"{arq.name}.{i}")
                if i == manter and velho.exists():
                    velho.unlink()
                elif velho.exists():
                    velho.rename(arq.with_name(f"{arq.name}.{i + 1}"))
            # copy and truncate (instead of rename): whoever has the file open keeps writing to it
            arq.with_name(arq.name + ".1").write_bytes(arq.read_bytes())
            with open(arq, "r+b") as f:
                f.truncate(0)
            girados.append(arq.name)
        except OSError:
            continue
    return girados


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "mostrar"
    if cmd == "tv":                                 # python3 tools/config.py tv 192.168.0.50
        cfg = json.loads(ARQ.read_text()) if ARQ.is_file() else migrar()
        ip = sys.argv[2] if len(sys.argv) > 2 else ""
        if not re.match(r"^\d{1,3}(\.\d{1,3}){3}$", ip):
            raise SystemExit("uso: config.py tv IP_DA_TV")
        cfg.setdefault("rede", {})["tv_ip"] = ip
        salvar(cfg)
        print(f"rede.tv_ip = {ip}")
        return
    if cmd == "migrar":
        cfg = migrar()
        print(f"config/openrange.json criado: tv {cfg['rede']['tv_ip']}, redirects {cfg['redirects']}")
        return
    cfg = carregar()
    for p in cfg["_problemas"]:
        print(f"config: redirect ignorado — {p}", file=sys.stderr)
    if cfg["_ip_mudou"]:
        print(f"config: ATENÇÃO, o IP do PC mudou de {cfg['_ip_mudou']} para {cfg['rede']['pc_ip']}: "
              f"ponha {cfg['rede']['pc_ip']} como DNS na TV.", file=sys.stderr)
    if cmd == "env":
        r = cfg["rede"]
        painel_ips, ruins = validar_ips_painel(cfg["painel"]["ips_extras"])
        for p in ruins:
            print(f"config: {p}", file=sys.stderr)
        for k, v in (("PC_IP", r["pc_ip"]), ("TV_IP", r["tv_ip"]), ("IFACE", r["interface"]), ("GATEWAY", r["gateway"]),
                     ("FW_ZONE", r["zona_firewall"]), ("PORTA_DNS", cfg["portas"]["dns"]), ("PORTA_HTTP", cfg["portas"]["http"]),
                     ("PORTA_HTTPS", cfg["portas"]["https"]), ("PORTA_CELULAR", cfg["portas"]["celular"]),
                     ("DNS_EMBUTIDO", "1" if cfg["dns"]["embutido"] else "0"),
                     ("REDIRECTS", " ".join(cfg["redirects"])), ("PAINEL_IPS", " ".join(painel_ips))):
            print(f"{k}='{v}'")
    elif cmd == "mostrar":
        print(json.dumps({k: v for k, v in cfg.items() if not k.startswith("_") or k == "_auto"}, ensure_ascii=False, indent=2))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
