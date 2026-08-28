"""goal.io — content management portal.

    python tools/cms.py            # then open http://localhost:8130

WHY THIS IS NOT STREAMLIT
-------------------------
The brief asks for a Streamlit portal. Streamlit is not installed and cannot be
installed in this environment — there is no pip, no npm, no Node; Python 3
stdlib and a browser is the whole toolchain. A portal that cannot be run is
worth less than one that can.

So this is the same portal on http.server. What matters is that the DATA LAYER
is the part worth designing, and it is identical either way: the portal reads
and writes config/*.json, runs tools/config_validate.py before it will save,
and runs tools/config_build.py to publish. A Streamlit front end can be
dropped on top of these same endpoints the day the dependency exists, and
nothing else has to change.

WHAT IT REFUSES TO DO
---------------------
It will not save a config that fails validation. Content editing is the one
place where a typo ships silently — a level with the ball fifteen metres off
the pitch looks like a renderer bug, not a data entry error — so the validator
is a gate, not a report.

It binds to 127.0.0.1 only. This writes files and runs the build; it is a
local authoring tool and has no business being reachable from anywhere else.
"""

import http.server
import json
import os
import re
import socketserver
import subprocess
import sys
import urllib.parse

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(HERE, "config")
TOOLS = os.path.join(HERE, "tools")
WWW = os.path.join(TOOLS, "cms")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8130

# only these may be written; anything else is a 403 rather than a path to probe
EDITABLE = {"levels", "pitch", "physics", "conditions", "difficulty",
            "ui", "audio", "kits", "progression"}
NAME_OK = re.compile(r"^[a-z0-9-]+$")


def run(script):
    """Run one of the sibling tools and capture what it said."""
    p = subprocess.run([sys.executable, os.path.join(TOOLS, script)],
                       capture_output=True, text=True, cwd=HERE)
    return {"ok": p.returncode == 0,
            "out": (p.stdout or "") + (p.stderr or "")}


def read_all():
    out = {}
    for f in sorted(os.listdir(CONFIG)):
        if not f.endswith(".json"):
            continue
        name = f[:-5]
        try:
            with open(os.path.join(CONFIG, f), encoding="utf-8") as fh:
                out[name] = json.load(fh)
        except Exception as e:
            out[name] = {"$error": str(e)}
    return out


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WWW, **kw)

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------------------------ GET
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/config":
            return self._json(read_all())
        if path == "/api/status":
            return self._json({
                "config": CONFIG,
                "files": sorted(f[:-5] for f in os.listdir(CONFIG) if f.endswith(".json")),
                "editable": sorted(EDITABLE),
                "bundle": os.path.exists(os.path.join(CONFIG, "config.bundle.js")),
            })
        return super().do_GET()

    # ----------------------------------------------------------------- POST
    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n) if n else b"{}"

        if path == "/api/validate":
            return self._json(run("config_validate.py"))

        if path == "/api/build":
            v = run("config_validate.py")
            if not v["ok"]:
                return self._json({"ok": False, "out": "refused to build:\n" + v["out"]})
            return self._json(run("config_build.py"))

        m = re.match(r"^/api/save/([a-z0-9-]+)$", path)
        if m:
            name = m.group(1)
            if name not in EDITABLE or not NAME_OK.match(name):
                return self._json({"ok": False, "out": name + " is not editable"}, 403)
            try:
                data = json.loads(raw.decode("utf-8"))
            except Exception as e:
                return self._json({"ok": False, "out": "not valid JSON: " + str(e)}, 400)

            target = os.path.join(CONFIG, name + ".json")
            backup = None
            if os.path.exists(target):
                with open(target, encoding="utf-8") as fh:
                    backup = fh.read()

            with open(target, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2, ensure_ascii=False)
                fh.write("\n")

            # THE GATE. Validation runs against what is now on disk, and a
            # failure puts the previous file back — so a bad edit cannot be
            # left behind for someone else to find at runtime.
            v = run("config_validate.py")
            if not v["ok"]:
                if backup is not None:
                    with open(target, "w", encoding="utf-8") as fh:
                        fh.write(backup)
                return self._json({"ok": False, "reverted": backup is not None,
                                   "out": v["out"]})
            return self._json({"ok": True, "out": v["out"]})

        return self._json({"ok": False, "out": "no such endpoint"}, 404)

    def log_message(self, *a):
        pass


def main():
    if not os.path.isdir(WWW):
        print("missing " + WWW)
        return 1
    socketserver.TCPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H) as httpd:
        print("goal.io CMS  ->  http://localhost:%d" % PORT)
        print("editing      ->  %s" % CONFIG)
        print("Ctrl-C to stop")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("")
    return 0


if __name__ == "__main__":
    sys.exit(main())
