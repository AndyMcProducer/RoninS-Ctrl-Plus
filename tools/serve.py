#!/usr/bin/env python3
"""Dependency-free static server for the portable macOS bundle.

Used when Node.js is not installed but Python 3 is. Behaviour matches
tools/serve.mjs: the UI is served from web/, while docs/, bridge/, README.md
and LICENSE are served from the project root so the in-app links work.

    python3 tools/serve.py [port]
"""

import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEB = os.path.join(ROOT, "web")

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "127.0.0.1")

# Paths that live outside web/ but are linked from the UI.
ROOT_PREFIXES = ("/docs", "/bridge")
ROOT_FILES = ("/README.md", "/LICENSE", "/START-HERE.txt")


class Handler(SimpleHTTPRequestHandler):
    server_version = "RoninS-Ctrl-Plus/0.1"

    def translate_path(self, path):
        url_path = unquote(urlsplit(path).path)
        use_root = (
            any(url_path == p or url_path.startswith(p + "/") for p in ROOT_PREFIXES)
            or url_path in ROOT_FILES
        )
        base = ROOT if use_root else WEB
        relative = url_path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(base, relative))

        # Never serve outside the chosen base.
        if full != base and not full.startswith(base + os.sep):
            return os.path.join(WEB, "__not_found__")
        return full

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stdout.write("%s  %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()


Handler.extensions_map = SimpleHTTPRequestHandler.extensions_map.copy()
Handler.extensions_map.update(
    {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".md": "text/markdown; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".svg": "image/svg+xml",
        ".wasm": "application/wasm",
    }
)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("")
    print("  RoninS-Ctrl-Plus")
    print("  http://localhost:%d" % PORT)
    print("")
    print("  Open it in Chrome or Edge. Press Ctrl+C to stop.")
    print("")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except OSError as error:
        print("Could not start the server on %s:%d: %s" % (HOST, PORT, error))
        print("Try a different port, for example: python3 tools/serve.py 8081")
        sys.exit(1)
