"""Serve only public app assets; .env and project internals are never served."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import os

ROOT = Path(__file__).resolve().parent.parent
ASSETS = {"index.html", "style.css", "app.js", "api.js", "journey.js", "targeted.js", "plan-model.js", "map-style.json"}
ASSETS.update({"route-geometry.js", "shape-cache.js", "network-view.js", "data/apartment-labels.geojson", "data/dong-labels.geojson"})
ASSETS.update("regions/" + name for name in ("index.js", "jeonju.js"))
ASSETS.update({"design-system/bw.css", "ui-layout.js", "navigation.js"})
ASSETS.update("vendor/" + name for name in (
    "maplibre-gl.mjs", "maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs",
    "maplibre-gl.css", "maplibre-LICENSE.txt",
))

class PublicHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        path = unquote(urlsplit(self.path).path)
        asset = "index.html" if path == "/" else path.removeprefix("/")
        if asset not in ASSETS:
            self.send_error(404)
            return None
        return super().send_head()

if __name__ == "__main__":
    os.chdir(ROOT)
    print("Busmap: http://127.0.0.1:8000 (public assets only)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8000), PublicHandler).serve_forever()
