"""Static file server for local preview: python3 scripts/serve_static.py, then open http://localhost:8000/heat/."""

import functools
import http.server
import os

PORT = 8000
# Repo root (parent of scripts/), so /heat/ paths work from any checkout.
DIRECTORY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DIRECTORY)

if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Serving {DIRECTORY} at http://127.0.0.1:{PORT}")
        httpd.serve_forever()
