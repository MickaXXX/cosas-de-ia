"""Prueba de humo de la interfaz con Chromium real (Playwright). Guarda capturas en docs/capturas.

Uso: python scripts/ui_smoke.py --base http://127.0.0.1:8000 --email ... --password ... --sector <id> --model <id>
Requiere `pip install playwright` en un entorno de herramientas y un Chromium (PLAYWRIGHT_CHROMIUM o /opt/pw-browsers/chromium).
"""
import argparse
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parents[1] / "docs" / "capturas"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--sector", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--prefix", default="")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    errors = []
    exe = os.environ.get("PLAYWRIGHT_CHROMIUM", "/opt/pw-browsers/chromium")
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=exe, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        for label, vp in (("escritorio", {"width": 1440, "height": 900}), ("movil", {"width": 390, "height": 844})):
            ctx = b.new_context(viewport=vp, device_scale_factor=1, is_mobile=label == "movil", has_touch=label == "movil")
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(f"{label}: {e}"))
            page.on("console", lambda m: m.type == "error" and errors.append(f"{label} console: {m.text}"))
            page.goto(a.base + "/")
            page.fill("input[type=email]", a.email)
            page.fill("input[type=password]", a.password)
            page.click("button:has-text('Ingresar')")
            page.wait_for_selector("h1:has-text('Proyectos')")
            page.screenshot(path=OUT / f"{a.prefix}{label}-1-proyectos.png")
            page.goto(f"{a.base}/#/s/{a.sector}/captura")
            page.wait_for_selector("text=Diagnóstico de captura", timeout=20000)
            page.wait_for_timeout(1500)
            page.screenshot(path=OUT / f"{a.prefix}{label}-2-captura.png", full_page=label == "escritorio")
            page.goto(f"{a.base}/#/s/{a.sector}/reconstruccion")
            page.wait_for_selector("text=Motor:", timeout=60000)
            page.wait_for_timeout(1500)
            page.screenshot(path=OUT / f"{a.prefix}{label}-3-reconstruccion.png", full_page=label == "escritorio")
            page.goto(f"{a.base}/#/s/{a.sector}/visor/{a.model}")
            page.wait_for_function("!document.body.innerText.includes('Cargando modelo')", timeout=120000)
            page.wait_for_timeout(2500)
            page.screenshot(path=OUT / f"{a.prefix}{label}-4-visor-orbita.png")
            page.click("button:has-text('Planta')") if label == "escritorio" else page.click("button[title^='Vista de planta']")
            page.wait_for_timeout(1500)
            page.screenshot(path=OUT / f"{a.prefix}{label}-5-visor-planta.png")
            if label == "escritorio":
                page.click("button:has-text('Órbita')")
                page.click("button:has-text('Fotos')")
                page.wait_for_timeout(500)
                first = page.locator(".side .body .row").first
                if first.count():
                    first.click()
                    page.wait_for_timeout(2500)
                    page.screenshot(path=OUT / f"{a.prefix}{label}-6-visor-desde-foto.png")
            ctx.close()
        b.close()
    print("capturas en", OUT)
    if errors:
        print("ERRORES DE NAVEGADOR:")
        print("\n".join(errors))
        sys.exit(1)


if __name__ == "__main__":
    main()
