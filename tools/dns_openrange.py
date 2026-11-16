#!/usr/bin/env python3
"""dns_openrange.py — OpenRange's DNS in pure Python (Stage 3/P1: replaces dnsmasq; runs anywhere with Python).

- "redirects" domains in config/openrange.json (and subdomains) → PC_IP for type A; AAAA for them → empty answer
  (the TV uses A). Netflix (`netflix`, `nflx`) is refused.
- Everything else is forwarded as is (UDP, TCP if the answer comes back truncated) to 1.1.1.1 / 8.8.8.8.
- Log in logs/dns.log in the SAME format as dnsmasq (tools/dominios.sh keeps working):
    Nov 15 15:09:36 dnsmasq[openrange]: query[A] example.com from 192.168.15.13
- config/openrange.json is re-read when it changes (no restart): redirects and upstreams.

Alone:          sudo python3 tools/dns_openrange.py            (port 53; DNS_PORTA=15353 to test without root)
From the portal: DNS=1 python3 tools/portal.py             (one process for DNS + HTTP/HTTPS)
"""
import datetime
import os
import socket
import socketserver
import struct
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402

RAIZ = Path(__file__).resolve().parent.parent
LOG = Path(os.environ.get("DNS_LOG", RAIZ / "logs" / "dns.log"))
UPSTREAMS = [("1.1.1.1", 53), ("8.8.8.8", 53)]
TIPOS = {1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 12: "PTR", 15: "MX", 16: "TXT", 28: "AAAA", 33: "SRV", 65: "HTTPS", 255: "ANY"}
PROIBIDOS = ("netflix", "nflx")


class Redirects:
    """Redirects and upstreams from config/openrange.json; re-read when the file changes."""

    def __init__(self, ip):
        self.ip, self.mtime, self.dominios = ip, None, set()
        self.trava = threading.Lock()

    def atuais(self):
        global UPSTREAMS
        try:
            m = config.ARQ.stat().st_mtime
        except OSError:
            m = 0
        with self.trava:
            if m != self.mtime:
                self.mtime = m
                try:
                    cfg = config.carregar(regerar_antigos=False)
                except SystemExit as e:
                    print(f"dns: config inválida, mantendo a anterior: {e}", file=sys.stderr)
                    return self.dominios
                for problema in cfg["_problemas"]:
                    print(f"dns: recusado — {problema}", file=sys.stderr)
                self.dominios = set(cfg["redirects"])
                UPSTREAMS = [(h, 53) for h in cfg["dns"]["upstreams"]] or UPSTREAMS
                print(f"dns: redirects → {self.ip}: {', '.join(sorted(self.dominios)) or 'nenhum'}", file=sys.stderr)
            return self.dominios

    def alvo(self, nome):
        nome = nome.lower().rstrip(".")
        return any(nome == d or nome.endswith("." + d) for d in self.atuais())


def ler_pergunta(pacote):
    """(id, name, type, end_of_question) of the first entry in the question section."""
    if len(pacote) < 12:
        raise ValueError("curto")
    ident, _, qd = struct.unpack(">HHH", pacote[:6])
    if qd < 1:
        raise ValueError("sem pergunta")
    i, partes = 12, []
    while True:
        n = pacote[i]
        if n == 0:
            i += 1
            break
        if n & 0xC0:
            raise ValueError("compressão na pergunta")
        partes.append(pacote[i + 1:i + 1 + n].decode("ascii", "replace"))
        i += 1 + n
    tipo, _classe = struct.unpack(">HH", pacote[i:i + 4])
    return ident, ".".join(partes), tipo, i + 4


def resposta_local(pacote, fim, tipo, ip):
    """Authoritative answer: A → ip; other types → no records (NOERROR)."""
    flags_pedido = struct.unpack(">H", pacote[2:4])[0]
    rd = flags_pedido & 0x0100
    flags = 0x8000 | 0x0400 | rd | 0x0080            # QR, AA, RD copiado, RA
    pergunta = pacote[12:fim]
    if tipo == 1:
        rr = b"\xc0\x0c" + struct.pack(">HHIH", 1, 1, 60, 4) + socket.inet_aton(ip)
        return pacote[:2] + struct.pack(">HHHHH", flags, 1, 1, 0, 0) + pergunta + rr
    return pacote[:2] + struct.pack(">HHHHH", flags, 1, 0, 0, 0) + pergunta


def repassar(pacote, tcp=False):
    for host, porta in UPSTREAMS:
        try:
            if tcp:
                with socket.create_connection((host, porta), timeout=4) as s:
                    s.sendall(struct.pack(">H", len(pacote)) + pacote)
                    n = struct.unpack(">H", s.recv(2))[0]
                    dados = b""
                    while len(dados) < n:
                        bloco = s.recv(n - len(dados))
                        if not bloco:
                            break
                        dados += bloco
                    return dados
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.settimeout(3)
                s.sendto(pacote, (host, porta))
                dados, _ = s.recvfrom(4096)
                if dados[:2] != pacote[:2]:
                    continue
                if struct.unpack(">H", dados[2:4])[0] & 0x0200:      # TC: truncada → TCP
                    return repassar(pacote, tcp=True)
                return dados
        except (OSError, struct.error):
            continue
    return None


class Servico:
    def __init__(self, ip, porta=53, endereco="0.0.0.0"):
        self.ip, self.porta, self.endereco = ip, porta, endereco
        self.redirects = Redirects(ip)
        LOG.parent.mkdir(exist_ok=True)
        self.log = open(LOG, "a", buffering=1)
        os.chmod(LOG, 0o644)
        self.trava = threading.Lock()
        self.clientes = {}          # client IP -> (time, last name asked): the control panel shows when the TV last used us

    def registrar(self, tipo, nome, cliente, extra=None):
        agora = datetime.datetime.now()
        self.clientes[cliente] = (time.time(), nome)
        linha = f"{agora:%b} {agora.day:2d} {agora:%H:%M:%S} dnsmasq[openrange]: query[{TIPOS.get(tipo, 'type=%d' % tipo)}] {nome} from {cliente}"
        with self.trava:
            self.log.write(linha + "\n")
            if extra:
                self.log.write(f"{agora:%b} {agora.day:2d} {agora:%H:%M:%S} dnsmasq[openrange]: {extra}\n")

    def tratar(self, pacote, cliente, tcp=False):
        try:
            _id, nome, tipo, fim = ler_pergunta(pacote)
        except (ValueError, IndexError, struct.error):
            return None
        if self.redirects.alvo(nome):
            self.registrar(tipo, nome, cliente, f"config {nome} is {self.ip if tipo == 1 else 'NODATA'}")
            return resposta_local(pacote, fim, tipo, self.ip)
        self.registrar(tipo, nome, cliente)
        return repassar(pacote, tcp)

    def iniciar(self):
        servico = self

        class UDP(socketserver.BaseRequestHandler):
            def handle(self):
                dados, sock = self.request
                r = servico.tratar(dados, self.client_address[0])
                if r:
                    sock.sendto(r, self.client_address)

        class TCP(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.settimeout(5)
                try:
                    n = struct.unpack(">H", self.request.recv(2))[0]
                    dados = self.request.recv(n)
                except (OSError, struct.error):
                    return
                r = servico.tratar(dados, self.client_address[0], tcp=True)
                if r:
                    self.request.sendall(struct.pack(">H", len(r)) + r)

        class UDPServ(socketserver.ThreadingMixIn, socketserver.UDPServer):
            daemon_threads, allow_reuse_address = True, True

        class TCPServ(socketserver.ThreadingMixIn, socketserver.TCPServer):
            daemon_threads, allow_reuse_address = True, True

        self.servidores = [UDPServ((self.endereco, self.porta), UDP), TCPServ((self.endereco, self.porta), TCP)]
        for s in self.servidores:
            threading.Thread(target=s.serve_forever, daemon=True).start()
        self.redirects.atuais()
        return self


def main():
    cfg = config.carregar()
    ip = cfg["rede"]["pc_ip"]
    porta = int(os.environ.get("DNS_PORTA", cfg["portas"]["dns"]))
    Servico(ip, porta, os.environ.get("DNS_ENDERECO", ip)).iniciar()
    print(f"dns: no ar em {os.environ.get('DNS_ENDERECO', ip)}:{porta} (UDP+TCP). Ctrl+C para sair.", file=sys.stderr)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
