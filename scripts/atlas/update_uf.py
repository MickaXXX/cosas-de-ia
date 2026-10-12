#!/usr/bin/env python3
"""
Valor de la UF (Unidad de Fomento) — docs/atlas/data/uf.json

Fuentes, en orden:
  1. CMF (api.cmfchile.cl) si existe la variable CMF_API_KEY (gratuita, se pide en
     https://api.cmfchile.cl/). Es la fuente oficial con API documentada.
  2. SII (sii.cl/valores_y_fechas/uf/ufAAAA.htm): tabla oficial pública, sin clave.
  3. mindicador.cl (sin clave). Republica los valores del Banco Central; desde los
     runners de GitHub suele cortar la conexión, por eso va al final.

La UF cambia todos los días, pero su valor se conoce por anticipado: el Banco Central
publica cada mes los valores del 10 de ese mes al 9 del siguiente. Por eso el job
diario basta.

Si ninguna fuente responde, el archivo anterior se conserva con status
"desactualizado" y la fecha del último intento. Nunca se escribe un cero.
"""
from __future__ import annotations

import os
import sys
import re
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CONFIG, DATA, SANTIAGO, http_get, http_json, iso, load_json, log, santiago_now, write_json  # noqa: E402

OUT = DATA / "uf.json"


def parse_clp(text: str) -> float:
    """'39.485,65' → 39485.65 (formato chileno de la CMF)."""
    return float(str(text).replace(".", "").replace(",", "."))


def from_cmf(cfg: dict, key: str) -> dict:
    year = santiago_now().year
    url = f"{cfg['uf']['cmf_url']}/periodo/{year - 1}/01/{year}/12"
    res = http_json(url, params={"apikey": key, "formato": "json"}, timeout=40)
    serie = [{"date": u["Fecha"][:10], "value": parse_clp(u["Valor"])} for u in res.get("UFs", [])]
    if not serie:
        raise RuntimeError("CMF respondió sin valores de UF")
    return {"series": serie, "source": "CMF Chile (API oficial)", "source_url": "https://api.cmfchile.cl/"}


MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre",
         "octubre", "noviembre", "diciembre"]


def _cells(row_html: str) -> list[str]:
    raw = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row_html, re.S | re.I)
    return [re.sub(r"<[^>]+>|&nbsp;|\s", "", c) for c in raw]


def _valid(v: float) -> bool:
    return 10000 < v < 200000


def parse_sii(html: str, year: int) -> list[dict]:
    """Lee la tabla de UF del SII. Soporta dos formatos: secciones por mes
    (id="mes_enero" … con pares día/valor) y la grilla clásica (fila = día, 12 columnas)."""
    out: dict[str, float] = {}
    low = html.lower()
    marks = [(low.find(f'id="mes_{m}"'), i + 1) for i, m in enumerate(MESES)]
    marks = sorted((pos, mo) for pos, mo in marks if pos >= 0)
    if marks:
        for k, (pos, mo) in enumerate(marks):
            end = marks[k + 1][0] if k + 1 < len(marks) else len(html)
            sec = html[pos:end]
            cells = _cells(sec)
            for a, b in zip(cells, cells[1:]):
                if a.isdigit() and 1 <= int(a) <= 31 and re.fullmatch(r"[\d.]+,\d+", b or ""):
                    try:
                        d = date(year, mo, int(a))
                    except ValueError:
                        continue
                    v = parse_clp(b)
                    if _valid(v):
                        out[d.isoformat()] = v
    if not out:
        for row in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S | re.I):
            cells = _cells(row)
            if len(cells) >= 13 and cells[0].isdigit() and 1 <= int(cells[0]) <= 31:
                for mo in range(1, 13):
                    val = cells[mo]
                    if not re.fullmatch(r"[\d.]+,\d+", val or ""):
                        continue
                    try:
                        d = date(year, mo, int(cells[0]))
                    except ValueError:
                        continue
                    v = parse_clp(val)
                    if _valid(v):
                        out[d.isoformat()] = v
    return [{"date": k, "value": v} for k, v in sorted(out.items())]


def from_sii(cfg: dict) -> dict:
    year = santiago_now().year
    serie = []
    for y in (year - 1, year):
        url = f"https://www.sii.cl/valores_y_fechas/uf/uf{y}.htm"
        try:
            html = http_get(url, timeout=40, headers={"Accept": "text/html"}).decode("utf-8", "replace")
        except RuntimeError as e:
            log(f"  · {url}: {e}")
            continue
        serie += parse_sii(html, y)
    if not serie:
        raise RuntimeError("SII no entregó valores legibles")
    return {"series": serie, "source": "SII (tabla oficial de valores UF)", "source_url": "https://www.sii.cl/valores_y_fechas/uf/"}


def from_mindicador(cfg: dict) -> dict:
    serie = []
    year = santiago_now().year
    for url in (f"{cfg['uf']['mindicador_url']}/{year - 1}", f"{cfg['uf']['mindicador_url']}/{year}", cfg["uf"]["mindicador_url"]):
        try:
            res = http_json(url, timeout=40)
        except RuntimeError as e:
            log(f"  · {url}: {e}")
            continue
        for item in res.get("serie", []):
            # mindicador entrega "2026-10-12T03:00:00.000Z": medianoche de Santiago en UTC.
            dt = datetime.fromisoformat(item["fecha"].replace("Z", "+00:00")).astimezone(SANTIAGO)
            serie.append({"date": dt.date().isoformat(), "value": float(item["valor"])})
    if not serie:
        raise RuntimeError("mindicador.cl no entregó valores")
    return {"series": serie, "source": "mindicador.cl (valores del Banco Central de Chile)",
            "source_url": "https://mindicador.cl/"}


def pick_today(series: list[dict], today: str) -> dict:
    """Valor de hoy si existe; si no, el último publicado hasta hoy."""
    ok = [s for s in series if s["date"] <= today and s["value"] > 0]
    if not ok:
        raise RuntimeError("ningún valor de UF válido hasta hoy")
    return max(ok, key=lambda s: s["date"])


def main() -> int:
    cfg = load_json(CONFIG / "pipeline.json")
    prev = load_json(OUT, {}) or {}
    today = santiago_now().date().isoformat()
    attempts = []
    key = os.environ.get("CMF_API_KEY", "").strip()
    sources = ([("cmf", lambda: from_cmf(cfg, key))] if key else []) + [
        ("sii", lambda: from_sii(cfg)), ("mindicador", lambda: from_mindicador(cfg))]
    for name, fn in sources:
        try:
            got = fn()
            uniq = {s["date"]: s["value"] for s in got["series"]}
            series = [{"date": d, "value": round(v, 2)} for d, v in sorted(uniq.items())][-420:]
            cur = pick_today(series, today)
            out = {
                "value": cur["value"], "date": cur["date"], "status": "ok",
                "source": got["source"], "source_url": got["source_url"],
                "fetched_at": iso(), "last_attempt": iso(), "last_error": None,
                "series": series,
            }
            write_json(OUT, out)
            log(f"UF {cur['date']}: {cur['value']:,.2f} ({name})")
            return 0
        except Exception as e:                       # noqa: BLE001
            attempts.append(f"{name}: {e}")
            log(f"::warning::UF desde {name} falló: {e}")
    # Ninguna fuente: se conserva el último dato verificado y se marca desactualizado.
    if prev.get("value"):
        prev.update({"status": "desactualizado", "last_attempt": iso(), "last_error": " | ".join(attempts)[:500]})
        write_json(OUT, prev)
        log("::warning::UF sin actualizar; se conserva el último valor verificado")
        return 0
    log("::error::No hay valor de UF previo ni se pudo descargar uno nuevo")
    return 1


if __name__ == "__main__":
    sys.exit(main())
