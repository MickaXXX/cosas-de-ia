"""Renderiza la escena de control a JPEG + verdad de terreno (truth.json). Uso: python render.py <salida>"""
import base64
import functools
import http.server
import json
import os
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]  # planta3d/
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
port = httpd.server_address[1]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM", "/opt/pw-browsers/chromium"),
                          args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page()
    pg.goto(f"http://127.0.0.1:{port}/scripts/synthetic/scene.html")
    pg.wait_for_function("window.ready === true", timeout=60000)
    shots = pg.evaluate("window.renderAll()")
    truth = pg.evaluate("window.TRUTH")
    focal = pg.evaluate("window.FOCAL_PX")
    b.close()
httpd.shutdown()
cams = []
for s in shots:
    (out / s["name"]).write_bytes(base64.b64decode(s["data"].split(",", 1)[1]))
    cams.append({"name": s["name"], "center": s["center"]})
(out.parent / "truth.json").write_text(json.dumps({"objects": truth, "cameras": cams, "focal_px": focal,
                                                   "units": "m"}, indent=1))
print(f"{len(shots)} imágenes en {out}; focal {focal:.1f} px")
