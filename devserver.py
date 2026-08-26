import http.server, socketserver, os, sys, base64, json

ROOT = sys.argv[1]
SHOTS = sys.argv[2]
PORT = int(sys.argv[3])
os.makedirs(SHOTS, exist_ok=True)


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        try:
            data = json.loads(body)
            name = os.path.basename(data["name"])
            raw = data["png"].split(",", 1)[1]
            path = os.path.join(SHOTS, name)
            with open(path, "wb") as f:
                f.write(base64.b64decode(raw))
            msg = json.dumps({"ok": True, "path": path}).encode()
        except Exception as e:
            msg = json.dumps({"ok": False, "err": str(e)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(msg)))
        self.end_headers()
        self.wfile.write(msg)

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer.allow_reuse_address = True
with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H) as httpd:
    print("serving", ROOT, "shots ->", SHOTS, "on", PORT, flush=True)
    httpd.serve_forever()
