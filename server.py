"""HTTP server: static files, Server-Sent Events for state, JSON POST for actions."""
import json
import os
import queue
import signal
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from board import board_data
from game import Game, GameError

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png",
         ".webp": "image/webp"}

GAME = Game(dev=os.environ.get("DEV") == "1")
LOCK = threading.Lock()
SUBSCRIBERS = set()
BOARD_JSON = json.dumps(board_data()).encode()


def broadcast():
    """Push the current state to every open event stream. Call with LOCK held."""
    data = json.dumps(GAME.state())
    for q in list(SUBSCRIBERS):
        q.put(data)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send_body(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/events":
            return self.events(urllib.parse.parse_qs(url.query).get("token", [""])[0])
        if url.path == "/board.json":
            return self.send_body(200, BOARD_JSON)
        if url.path == "/healthz":
            return self.send_body(200, b"ok", "text/plain")
        name = "index.html" if url.path == "/" else url.path.lstrip("/")
        path = os.path.normpath(os.path.join(STATIC, name))
        ext = os.path.splitext(path)[1]
        if not path.startswith(STATIC + os.sep) or ext not in TYPES or not os.path.isfile(path):
            return self.send_body(404, b"not found", "text/plain")
        with open(path, "rb") as f:
            self.send_body(200, f.read(), TYPES[ext])

    def do_POST(self):
        if self.path != "/action":
            return self.send_body(404, b"not found", "text/plain")
        try:
            length = min(int(self.headers.get("Content-Length", 0)), 65536)
            msg = json.loads(self.rfile.read(length) or b"{}")
            with LOCK:
                result = GAME.act(msg.get("token"), msg.get("type"), msg.get("data") or {})
                broadcast()
            self.send_body(200, json.dumps(result).encode())
        except (GameError, ValueError, KeyError, TypeError, AttributeError) as e:
            self.send_body(400, json.dumps({"error": str(e) or "Invalid request."}).encode())

    def events(self, token):
        q = queue.Queue()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        with LOCK:
            SUBSCRIBERS.add(q)
            GAME.connect(token, 1)
            broadcast()
        try:
            while True:
                try:
                    data = q.get(timeout=15)
                    while not q.empty():  # only the newest state matters
                        data = q.get_nowait()
                    self.wfile.write(f"data: {data}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except OSError:
            pass
        finally:
            with LOCK:
                SUBSCRIBERS.discard(q)
                GAME.connect(token, -1)
                broadcast()


def main():
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    # As PID 1 in a container, SIGTERM is ignored unless handled; treat it like Ctrl+C
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    print(f"Duopoly running on http://0.0.0.0:{port}{' (dev mode)' if GAME.dev else ''}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
