#!/usr/bin/env python3
"""painel.py (gate) — control panel API + page, against a throwaway copy of the project.

Copies tools/ and config/ to a temp dir (www/ and certs/ are symlinked), sets the "TV" to 127.0.0.1 and high ports,
starts portal.py there (OFFLINE, embedded DNS on a high port) and drives /painel/api/*; then runs painel-ui.js
(jsdom) against the same server. Nothing in the real config/ is touched. Prints "painel ok" at the end; any
problem is an "ERRO" line.
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
PORTAS = {"dns": 15354, "http": 18081, "https": 18444, "celular": 18091}
BASE = f"http://127.0.0.1:{PORTAS['celular']}"
erros = []


def erro(msg):
    erros.append(msg)
    print("ERRO", msg)


def pedir(metodo, rota, corpo=None, cabecalhos=None, bruto=False):
    h = {"X-OpenRange": "1"}
    if corpo is not None:
        h["Content-Type"] = "application/json"
    h.update(cabecalhos or {})
    dados = json.dumps(corpo).encode() if corpo is not None else None
    req = urllib.request.Request(BASE + rota, data=dados, method=metodo, headers={k: v for k, v in h.items() if v is not None})
    try:
        with urllib.request.urlopen(req, timeout=70) as r:
            status, corpo_r, hdr = r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        status, corpo_r, hdr = e.code, e.read(), e.headers
    if bruto:
        return status, corpo_r, hdr
    try:
        return status, json.loads(corpo_r or b"{}")
    except ValueError:
        return status, {"_bruto": corpo_r[:200]}


def checar(cond, msg):
    if not cond:
        erro(msg)
    return cond


def preparar(tmp):
    shutil.copytree(RAIZ / "tools", tmp / "tools", ignore=shutil.ignore_patterns("__pycache__", "sim"))
    (tmp / "www").symlink_to(RAIZ / "www")
    (tmp / "config").mkdir()
    shutil.copy(RAIZ / "config" / "apps-proprios.json", tmp / "config" / "apps-proprios.json")
    if (RAIZ / "certs" / "cert.pem").is_file():
        (tmp / "certs").symlink_to(RAIZ / "certs")
    else:
        (tmp / "certs").mkdir()
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=openrange-teste",
                        "-keyout", str(tmp / "certs" / "key.pem"), "-out", str(tmp / "certs" / "cert.pem")],
                       capture_output=True, check=True)
    cfg = {"rede": {"tv_ip": "127.0.0.1", "pc_ip": "auto", "interface": "auto", "gateway": "auto", "zona_firewall": "auto"},
           "redirects": ["api-portal-v3.netrange.com", "ver.netrange.com"], "dns": {"embutido": True, "upstreams": ["1.1.1.1", "8.8.8.8"]},
           "portas": PORTAS, "launcher": {"favoritos": [55], "substituir_loja": True}, "logs": {"max_mb": 5, "manter": 3}}
    (tmp / "config" / "openrange.json").write_text(json.dumps(cfg, indent=2))
    (tmp / "cache").mkdir()
    catalogo = {"apps": [{"id": 55, "name": "Deezer", "url": "https://x/55"}, {"id": 829, "name": "YouTube", "url": "https://x/829", "description": "Vídeos " * 40},
                         {"id": 870, "name": "Pluto TV", "url": "https://x/870"}, {"id": 39, "name": "Buceadores TV", "url": "https://x/39"}]}
    (tmp / "cache" / "catalogo.json").write_text(json.dumps(catalogo))


def main():
    tmp = Path(tempfile.mkdtemp(prefix="openrange-painel-"))
    proc = None
    try:
        preparar(tmp)
        env = {k: v for k, v in os.environ.items() if k != "INVOCATION_ID"}
        env.update(OFFLINE="1", DNS="1", DNS_PORTA=str(PORTAS["dns"]), DNS_ENDERECO="127.0.0.1", PORTA_HTTP=str(PORTAS["http"]),
                   PORTA_HTTPS=str(PORTAS["https"]), PORTA_CELULAR=str(PORTAS["celular"]), PYTHONDONTWRITEBYTECODE="1")
        saida = open(tmp / "portal.out", "w")
        proc = subprocess.Popen([sys.executable, str(tmp / "tools" / "portal.py")], cwd=tmp, env=env, stdout=saida, stderr=subprocess.STDOUT)
        for _ in range(50):
            time.sleep(0.2)
            try:
                if pedir("GET", "/painel/")[0] in (200, 404):
                    break
            except OSError:
                continue
        else:
            erro("portal de teste não subiu: " + (tmp / "portal.out").read_text()[-500:])
            return
        testes_api(tmp)
        ui = subprocess.run(["node", str(RAIZ / "tools" / "sim" / "painel-ui.js"), BASE], capture_output=True, text=True, timeout=120)
        print(ui.stdout.rstrip())
        if ui.returncode or "ERRO" in ui.stdout or ui.stderr.strip():
            erro("painel-ui.js: " + (ui.stderr.strip()[-600:] or "falhou"))
    finally:
        if proc:
            proc.terminate()
            proc.wait(timeout=10)
        shutil.rmtree(tmp, ignore_errors=True)
    if erros:
        sys.exit(1)
    print("painel ok")


def testes_api(tmp):
    # --- access control
    checar(pedir("GET", "/painel/api/estado", cabecalhos={"X-OpenRange": None})[0] == 403, "sem X-OpenRange devia dar 403")
    checar(pedir("GET", "/painel/api/estado", cabecalhos={"Host": "malvado.example:18091"})[0] == 403, "Host estranho devia dar 403 (DNS rebinding)")
    st, _, hdr = pedir("OPTIONS", "/painel/api/config", bruto=True, cabecalhos={"Access-Control-Request-Method": "POST", "Origin": "http://malvado.example"})
    checar(st == 403 and not hdr.get("Access-Control-Allow-Origin"), f"preflight do painel devia ser recusado (status {st})")
    req = urllib.request.Request(BASE + "/painel/api/config", data=b'{"redirects":[]}', method="POST", headers={"X-OpenRange": "1", "Content-Type": "text/plain"})
    try:
        urllib.request.urlopen(req, timeout=5)
        erro("POST text/plain devia ser recusado")
    except urllib.error.HTTPError as e:
        checar(e.code == 415, f"POST text/plain → {e.code}, esperado 415")
    sys.path.insert(0, str(tmp / "tools"))
    import painel                                   # the copy in tmp (its config.ARQ is the temp config)
    painel.CTX["pc_ip"] = "192.168.15.69"
    checar(painel.permitido("192.168.15.50", "192.168.15.69:8090", "1"), "outro aparelho da LAN devia ser recusado")
    checar(painel.permitido("192.168.15.69", "192.168.15.69:8090", "1") is None, "o próprio PC pelo IP da LAN devia passar")
    checar(painel.permitido("::1", "[::1]:8090", "1") is None, "localhost IPv6 devia passar")
    checar(painel.permitido("127.0.0.1", "openrange.attacker.com", "1"), "rebinding (Host de fora) devia ser recusado")

    # --- status (the test client is the "TV": it is 127.0.0.1)
    pedir("GET", "/inicio/")
    st, e = pedir("GET", "/painel/api/estado")
    checar(st == 200 and e.get("tv_ip") == "127.0.0.1" and e.get("modo") == "manual", f"estado: {st} {str(e)[:200]}")
    checar(e.get("tv", {}).get("inicio"), "estado: o pedido de /inicio/ da 'TV' não foi visto")
    checar(e.get("reiniciar") is False, "estado: reiniciar devia começar false")
    st, d = pedir("POST", "/painel/api/teste-dns")
    red = [r for r in d.get("resultados", []) if r["nome"] != "example.com"]
    checar(st == 200 and red and all(r["ok"] for r in red), f"teste-dns: {d}")
    ex = [r for r in d.get("resultados", []) if r["nome"] == "example.com"]
    if ex and not ex[0]["ok"]:
        print("  aviso: example.com não resolveu pelo DNS de teste (sem internet?)")
    st, e = pedir("GET", "/painel/api/estado")
    checar(e.get("tv", {}).get("dns"), "estado: a consulta DNS de 127.0.0.1 não foi registrada")
    print(f"## estado ok · teste-dns: {', '.join(r['nome'] + '→' + r['resposta'] for r in d['resultados'])}")

    # --- config
    st, d = pedir("POST", "/painel/api/config", {"redirects": ["ver.netrange.com", "www.netflix.com"]})
    checar(st == 400 and "Netflix" in d.get("erro", ""), f"config: netflix devia ser recusada ({st} {d})")
    st, d = pedir("POST", "/painel/api/config", {"rede": {"tv_ip": "999.1.1.1"}})
    checar(st == 400, "config: IP 999.1.1.1 devia ser recusado")
    st, d = pedir("POST", "/painel/api/config", {"redirects": ["api-portal-v3.netrange.com", "ver.netrange.com", "Exemplo.COM."],
                                                 "dns": {"upstreams": ["9.9.9.9"]}, "logs": {"max_mb": 7}})
    salvo = json.loads((tmp / "config" / "openrange.json").read_text())
    checar(st == 200 and d.get("reiniciar") is False and salvo["redirects"][-1] == "exemplo.com" and salvo["dns"]["upstreams"] == ["9.9.9.9"]
           and salvo["logs"]["max_mb"] == 7 and salvo["portas"] == PORTAS, f"config: salvar ({st} {d}) → {salvo}")
    st, d = pedir("POST", "/painel/api/config", {"rede": {"tv_ip": "127.0.0.2"}})
    checar(st == 200 and d.get("reiniciar") is True, "config: trocar o IP da TV devia pedir reinício")
    pedir("POST", "/painel/api/config", {"rede": {"tv_ip": "127.0.0.1"}, "redirects": ["api-portal-v3.netrange.com", "ver.netrange.com"]})
    checar(pedir("GET", "/painel/api/estado")[1].get("reiniciar") is False, "config: voltar o IP devia tirar o aviso de reinício")
    checar(pedir("POST", "/painel/api/reiniciar")[0] == 409, "reiniciar no modo manual devia dar 409")
    print("## config ok (netflix recusada, IP inválido recusado, reinício pendente detectado)")

    # --- own apps
    st, d = pedir("GET", "/painel/api/apps")
    lista = d.get("apps", [])
    checar(st == 200 and len(lista) >= 3, f"apps: {st}")
    novo = {"name": "Rádio", "url": "http://{PC_IP}/radio/", "description": "teste", "cor": "#123abc", "secao": "Música", "inicio": False}
    st, d = pedir("POST", "/painel/api/apps", {"apps": lista + [dict(novo, url="ftp://x")]})
    checar(st == 400 and "endereço" in d.get("erro", ""), f"apps: url ftp devia ser recusada ({st} {d})")
    st, d = pedir("POST", "/painel/api/apps", {"apps": [novo] + lista})
    ids = [a["id"] for a in d.get("apps", [])]
    checar(st == 200 and ids[0] == max(a["id"] for a in lista) + 1 and ids[1:] == [a["id"] for a in lista], f"apps: id novo/ordem {ids}")
    nid = ids[0]
    arquivo = json.loads((tmp / "config" / "apps-proprios.json").read_text())
    checar("_leia" in arquivo and arquivo["apps"][0]["secao"] == "Música" and "icone_proprio" not in arquivo["apps"][0], "apps: arquivo salvo errado")
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
    st, d = pedir("POST", f"/painel/api/apps/{nid}/icone", {"tipo": "image/png", "dados": base64.b64encode(png).decode()})
    checar(st == 200 and d["apps"][0]["icone_proprio"], f"ícone: upload ({st})")
    st, corpo, hdr = pedir("GET", f"/icones/portals/v3/prod/app/{nid}/type019-192x250/default/192x250.jpg", bruto=True)
    checar(st == 200 and corpo == png and hdr.get("Content-Type") == "image/png", f"ícone próprio não servido ({st} {hdr.get('Content-Type')})")
    st, d = pedir("POST", f"/painel/api/apps/{nid}/icone", {"tipo": "image/svg+xml", "dados": base64.b64encode(b"<svg onload='x()'/>").decode()})
    checar(st == 400, "ícone: SVG com script devia ser recusado")
    st, ini = pedir("GET", "/api/inicio")
    meu = [a for a in ini.get("proprios", []) if a["id"] == nid]
    checar(meu and meu[0]["secao"] == "Música" and "?v=" in meu[0]["icone"] and meu[0]["url"] == "http://127.0.0.1/radio/", f"/api/inicio: {meu}")
    checar(all(a.get("secao") for a in ini.get("proprios", [])), "/api/inicio: app sem seção")
    st, d = pedir("POST", "/painel/api/apps", {"apps": lista})
    checar(st == 200 and not list((tmp / "config" / "icones").glob(f"{nid}.*")), "apps: remover devia apagar o ícone próprio")
    print(f"## apps ok (novo id {nid}, ícone próprio servido, seção no /api/inicio, remoção limpa o ícone)")

    # --- store favorites
    st, d = pedir("GET", "/painel/api/catalogo?q=you")
    checar(st == 200 and [a["name"] for a in d["resultados"]] == ["YouTube"] and d["favoritos"][0]["name"] == "Deezer", f"catálogo: {d}")
    checar(len(d["resultados"][0]["description"]) <= 71, "catálogo: descrição longa devia ser cortada em 70")
    checar(pedir("POST", "/painel/api/favoritos", {"favoritos": [990002]})[0] == 400, "favoritos: id nosso devia ser recusado")
    st, d = pedir("POST", "/painel/api/favoritos", {"favoritos": [829, 55, 829]})
    checar(st == 200 and json.loads((tmp / "config" / "openrange.json").read_text())["launcher"]["favoritos"] == [829, 55], "favoritos: salvar")
    st, ini = pedir("GET", "/api/inicio")
    checar([a["name"] for a in ini["favoritos"]] == ["YouTube", "Deezer"], f"/api/inicio favoritos: {ini.get('favoritos')}")
    print("## loja ok (busca, favoritos na ordem, sem repetidos)")

    # --- logs, neighbours, diagnosis
    st, d = pedir("GET", "/painel/api/logs?arquivo=portal")
    checar(st == 200 and "painel" in d.get("texto", "") and d["fim"] > 0, "logs: portal.log vazio")
    st, d2 = pedir("GET", f"/painel/api/logs?arquivo=portal&desde={d['fim']}")
    checar(st == 200 and "/painel/api/logs" in d2["texto"] and d2["fim"] > d["fim"], f"logs: incremental ({d2.get('texto', '')[:120]!r})")
    checar(pedir("GET", "/painel/api/logs?arquivo=../../etc/passwd")[0] == 400, "logs: arquivo arbitrário devia ser recusado")
    checar(painel.mascarar("https://x/jellyfin/" + "eyJpIjoidWkrMlZWM0UzVU9odnlzWk56ak5xQT09IiwiZSI6") == "https://x/jellyfin/eyJp…ZSI6", "mascarar: token base64")
    st, d = pedir("GET", "/painel/api/vizinhos")
    checar(st == 200 and isinstance(d.get("vizinhos"), list), "vizinhos")
    st, d = pedir("POST", "/painel/api/diagnostico")
    checar(st == 200 and "saúde" in d.get("saida", ""), f"diagnóstico: {str(d)[:200]}")
    print(f"## logs/vizinhos/diagnóstico ok ({len(d['saida'].splitlines())} linhas de saúde)")


if __name__ == "__main__":
    main()
