#!/usr/bin/env python3
"""
infra/serve_node_web.py — 为 Node Web 生产构建提供服务

功能:
  1. 静态文件服务（dist/ 目录）
  2. /auth/* 和 /node/* 代理到 Node Server
  3. SPA 回退（所有未知路由返回 index.html）
  4. COOP/COEP 头（SharedArrayBuffer 支持）

用法:
  python3 infra/serve_node_web.py
  PORT=5173 NODE_SERVER=http://localhost:8282 DIST_DIR=open-im-node-web/dist python3 infra/serve_node_web.py
"""

import os
import sys
import http.server
import urllib.request
import urllib.error

PORT      = int(os.getenv("PORT", "5173"))
NODE_SERVER = os.getenv("NODE_SERVER", "http://localhost:8282")
DIST_DIR  = os.getenv("DIST_DIR", os.path.join(os.path.dirname(__file__),
                                                 "..", "open-im-node-web", "dist"))

COOP_COEP_HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
}

PROXY_PREFIXES = ("/auth/", "/auth", "/node/", "/node")


class NodeWebHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIST_DIR, **kwargs)

    def log_message(self, format, *args):
        pass  # Suppress access logs

    def _add_headers(self):
        for k, v in COOP_COEP_HEADERS.items():
            self.send_header(k, v)

    def _proxy(self, target_url: str):
        """转发请求到 Node Server。"""
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else None

        req = urllib.request.Request(target_url, data=body, method=self.command)
        for h in ("Content-Type", "Authorization", "Origin"):
            if v := self.headers.get(h):
                req.add_header(h, v)

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() not in ("transfer-encoding", "connection"):
                        self.send_header(k, v)
                self._add_headers()
                self.end_headers()
                self.wfile.write(resp.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self._add_headers()
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.send_error(502, f"Proxy error: {e}")

    def do_GET(self):
        path = self.path.split("?")[0]
        if any(path.startswith(p) for p in PROXY_PREFIXES):
            self._proxy(NODE_SERVER + self.path)
            return
        # SPA fallback: if file doesn't exist, serve index.html
        if not os.path.exists(os.path.join(DIST_DIR, path.lstrip("/"))):
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        if any(path.startswith(p) for p in PROXY_PREFIXES):
            self._proxy(NODE_SERVER + self.path)
            return
        self.send_error(405)

    def do_OPTIONS(self):
        path = self.path.split("?")[0]
        if any(path.startswith(p) for p in PROXY_PREFIXES):
            self._proxy(NODE_SERVER + self.path)
            return
        self.send_response(204)
        self._add_headers()
        self.end_headers()

    def send_response(self, code, message=None):
        super().send_response(code, message)

    def end_headers(self):
        # Ensure COOP/COEP on every response (for static files)
        for k, v in COOP_COEP_HEADERS.items():
            self.send_header(k, v)
        super().end_headers()


if __name__ == "__main__":
    if not os.path.isdir(DIST_DIR):
        print(f"ERROR: dist dir not found: {DIST_DIR}")
        print(f"  Run: cd open-im-node-web && ./node_modules/.bin/vite build")
        sys.exit(1)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), NodeWebHandler)
    print(f"Serving Node Web on http://localhost:{PORT}")
    print(f"  dist: {DIST_DIR}")
    print(f"  proxy /auth,/node → {NODE_SERVER}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
