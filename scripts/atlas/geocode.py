#!/usr/bin/env python3
"""
Geocodificación de direcciones con Nominatim (OpenStreetMap).

Recorre projects.json, developments.json y rentals.json y completa las coordenadas
de los registros que tienen `geocode_query` (o dirección + comuna) pero no tienen
lat/lon. Nunca sobrescribe coordenadas puestas a mano (geo_source = "manual").

Precisión que se guarda en `geo_precision`:
  exacta      Nominatim encontró el número de la calle o el edificio (place_rank ≥ 30)
  calle       encontró la calle pero no el número (26–29): se muestra como aproximada
  aproximada  barrio, comuna o lugar (≤ 25): se muestra con un círculo de incertidumbre
Si el resultado cae fuera de la comuna indicada queda `geo_review = true` para
revisión humana y la app no lo muestra como ubicación confirmada.

Política de uso de Nominatim: máximo 1 petición por segundo, User-Agent propio y
caché local (data/geocode_cache.json) para no repetir consultas.
"""
from __future__ import annotations

import sys
import time
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CONFIG, DATA, http_json, iso, load_json, log, write_json  # noqa: E402

CACHE = DATA / "geocode_cache.json"
TARGETS = (("projects.json", "projects"), ("developments.json", "developments"), ("rentals.json", "listings"))


def norm(s: str) -> str:
    return unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()


def precision(rank: int) -> str:
    if rank >= 30:
        return "exacta"
    if rank >= 26:
        return "calle"
    return "aproximada"


def query_for(rec: dict) -> str | None:
    if rec.get("geocode_query"):
        return rec["geocode_query"]
    if rec.get("address") and rec.get("commune"):
        return f"{rec['address']}, {rec['commune']}, Región Metropolitana, Chile"
    return None


def needs_geocode(rec: dict) -> bool:
    if rec.get("geo_source") == "manual":
        return False
    if rec.get("geometry"):                          # desarrollos con geometría dibujada
        return False
    has = rec.get("lat") not in (None, "") and rec.get("lon") not in (None, "")
    return (not has) or rec.get("geo_precision") == "pendiente"


def geocode(q: str, cfg: dict, cache: dict, state: dict) -> dict | None:
    if q in cache:
        return cache[q]
    if state["calls"] >= cfg["geocode"]["max_per_run"]:
        return None
    wait = cfg["geocode"]["min_interval_s"] - (time.time() - state["last"])
    if wait > 0:
        time.sleep(wait)
    b = cfg["bbox"]
    try:
        res = http_json(cfg["geocode"]["endpoint"], params={
            "q": q, "format": "jsonv2", "limit": 1, "countrycodes": "cl", "addressdetails": 1,
            "viewbox": f"{b['west']},{b['north']},{b['east']},{b['south']}", "bounded": 1,
        }, timeout=30, headers={"Accept-Language": "es"})
    except RuntimeError as e:
        log(f"  · geocodificación falló para «{q}»: {e}")
        return None
    finally:
        state["last"] = time.time()
        state["calls"] += 1
    hit = res[0] if res else None
    out = {"found": False, "at": iso()}
    if hit:
        addr = hit.get("address", {})
        out = {
            "found": True, "lat": round(float(hit["lat"]), 6), "lon": round(float(hit["lon"]), 6),
            "rank": int(hit.get("place_rank", 0)), "display_name": hit.get("display_name"),
            "commune": addr.get("city") or addr.get("town") or addr.get("municipality") or addr.get("suburb"),
            "at": iso(),
        }
    cache[q] = out
    return out


def main() -> int:
    cfg = load_json(CONFIG / "pipeline.json")
    cache = load_json(CACHE, {}) or {}
    state = {"calls": 0, "last": 0.0}
    changed_total = 0
    for fname, key in TARGETS:
        path = DATA / fname
        doc = load_json(path)
        if not doc or key not in doc:
            continue
        changed = 0
        for rec in doc[key]:
            if not needs_geocode(rec):
                continue
            q = query_for(rec)
            if not q:
                continue
            g = geocode(q, cfg, cache, state)
            if not g:
                continue
            if not g.get("found"):
                rec["geo_precision"] = "pendiente"
                rec["geo_review"] = True
                rec["geo_note"] = f"Nominatim no encontró «{q}» ({g['at'][:10]}). Ingresar coordenadas a mano."
                changed += 1
                continue
            rec["lat"], rec["lon"] = g["lat"], g["lon"]
            rec["geo_precision"] = precision(g["rank"])
            rec["geo_source"] = "nominatim"
            rec["geocoded_at"] = g["at"]
            rec["geo_display_name"] = g["display_name"]
            expected = rec.get("commune")
            rec["geo_review"] = bool(expected and g.get("commune") and norm(expected) not in norm(g["display_name"]))
            if rec["geo_review"]:
                rec["geo_note"] = f"El resultado ({g.get('commune')}) no coincide con la comuna indicada ({expected})."
            changed += 1
        if changed:
            write_json(path, doc)
            log(f"{fname}: {changed} registros geocodificados")
            changed_total += changed
    write_json(CACHE, cache)
    log(f"Geocodificación: {changed_total} cambios, {state['calls']} consultas a Nominatim")
    return 0


if __name__ == "__main__":
    sys.exit(main())
