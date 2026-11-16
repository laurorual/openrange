#!/usr/bin/env python3
"""sonda.py — logs everything the TV asks for over HTTP (:80) and HTTPS (:443).

Usage: sudo python3 tools/sonda.py     (from the project root)
Cert: certs/cert.pem e certs/key.pem
Log:  terminal output + logs/sonda.log

On :443 it uses a self-signed certificate on purpose: if the TV completes the
handshake, it does NOT validate certificates (great for us). If it refuses, the
TLS alert reason shows up in the log.
"""
import datetime
import os
import socket
import ssl
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORTA_HTTP = int(os.environ.get("PORTA_HTTP", 80))
PORTA_HTTPS = int(os.environ.get("PORTA_HTTPS", 443))
RAIZ = Path(__file__).resolve().parent.parent
CERT, CHAVE = RAIZ / "certs" / "cert.pem", RAIZ / "certs" / "key.pem"
(RAIZ / "logs").mkdir(exist_ok=True)
_log_lock = threading.Lock()
_log_arq = open(RAIZ / "logs" / "sonda.log", "a", buffering=1)


def log(msg):
    linha = f"{datetime.datetime.now():%H:%M:%S} {msg}"
    with _log_lock:
        print(linha, flush=True)
        _log_arq.write(linha + "\n")


class Handler(BaseHTTPRequestHandler):
    def _registrar(self):
        esquema = "https" if self.server.ctx else "http"
        log(f"{self.client_address[0]} {esquema.upper()} {self.command} "
            f"{esquema}://{self.headers.get('Host', '?')}{self.path}")
        for k, v in self.headers.items():
            log(f"      {k}: {v}")
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            log(f"      [corpo] {self.rfile.read(min(n, 4096))!r}")
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_GET = do_POST = do_HEAD = do_PUT = do_OPTIONS = _registrar

    def log_message(self, *args):  # silence http.server's default log
        pass


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
            except ssl.SSLError as e:
                motivo = e.reason or str(e)
                log(f"{addr[0]} TLS RECUSADO: {motivo}  -> {interpretar(motivo)}")
                return
            except (OSError, socket.timeout) as e:
                log(f"{addr[0]} TLS caiu sem alerta ({e}) -> provavelmente valida o certificado")
                return
            log(f"{addr[0]} TLS OK com cert autoassinado ({sock.version()}) -> a TV NAO valida certificado!")
        super().finish_request(sock, addr)


def interpretar(motivo):
    m = motivo.upper()
    if any(x in m for x in ("UNKNOWN_CA", "BAD_CERTIFICATE", "CERTIFICATE_UNKNOWN", "DECRYPT_ERROR")):
        return "a TV VALIDA o certificado"
    if any(x in m for x in ("NO_SHARED_CIPHER", "UNSUPPORTED_PROTOCOL", "WRONG_VERSION", "VERSION_TOO_LOW", "NO_CIPHERS")):
        return "TLS antigo demais: ative a politica LEGACY no distrobox e repita"
    if "EOF" in m:
        return "a TV desligou no meio do handshake: provavelmente VALIDA o certificado"
    if "HTTP_REQUEST" in m:
        return "a TV mandou HTTP puro na porta 443"
    return "inconclusivo, me mande essa linha"


def sni_cb(sock, nome, _ctx):
    try:
        ip = sock.getpeername()[0]
    except OSError:
        ip = "?"
    log(f"{ip} TLS ClientHello  SNI={nome}")


def main():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.MINIMUM_SUPPORTED
    try:
        ctx.set_ciphers("ALL:@SECLEVEL=0")
    except ssl.SSLError:
        pass
    ctx.load_cert_chain(CERT, CHAVE)
    ctx.sni_callback = sni_cb

    for porta, c in ((PORTA_HTTP, None), (PORTA_HTTPS, ctx)):
        threading.Thread(target=Servidor(porta, c).serve_forever, daemon=True).start()
    log(f"sonda ouvindo em :{PORTA_HTTP} (HTTP) e :{PORTA_HTTPS} (HTTPS). Ctrl+C para sair.")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        log("encerrado")


if __name__ == "__main__":
    main()
