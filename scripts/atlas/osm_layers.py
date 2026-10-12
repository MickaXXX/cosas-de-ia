#!/usr/bin/env python3
"""
Capas cartográficas reales desde OpenStreetMap (Overpass API).

Genera, dentro de docs/atlas/data/osm/:
  metro_lines.geojson     líneas de Metro operativas (relaciones route=subway)
  metro_future.geojson    tramos de Metro en construcción o proyectados mapeados en OSM
  metro_stations.geojson  estaciones (operativas y en construcción) con las líneas cercanas
  pois.geojson            malls, supermercados, hospitales, clínicas, universidades,
                          parques, museos/atractivos y centros culturales
  communes.geojson        límites comunales (admin_level=8) simplificados
  meta.json               fecha, servidor usado, recuentos, errores y atribución

Licencia: © colaboradores de OpenStreetMap, ODbL 1.0. La app muestra la atribución.

Si un servidor Overpass falla se prueba el siguiente. Si todos fallan para una capa,
el archivo anterior se conserva intacto y meta.json registra el error: la app sigue
mostrando la última versión buena con su fecha.

Uso:
  python scripts/atlas/osm_layers.py                # todas las capas
  python scripts/atlas/osm_layers.py --only metro   # solo Metro
  python scripts/atlas/osm_layers.py --if-stale     # solo si faltan o tienen > osm_max_age_days
"""
from __future__ import annotations

import argparse
import math
import sys
import urllib.parse
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CONFIG, OSM, http_json, iso, load_json, log, utc_now, write_json  # noqa: E402

ATTRIBUTION = "© colaboradores de OpenStreetMap (ODbL 1.0)"


# --------------------------------------------------------------------------- Overpass
def overpass(query: str, cfg: dict) -> tuple[dict, str]:
    errors = []
    for ep in cfg["overpass_endpoints"]:
        try:
            data = urllib.parse.urlencode({"data": query}).encode()
            res = http_json(ep, data=data, timeout=240, retries=2,
                            headers={"Content-Type": "application/x-www-form-urlencoded"})
            if "elements" not in res:
                raise RuntimeError(f"respuesta sin 'elements': {str(res)[:200]}")
            return res, ep
        except Exception as e:                       # noqa: BLE001 — se prueba el siguiente servidor
            errors.append(f"{ep}: {e}")
            log(f"  · Overpass {ep} falló: {e}")
    raise RuntimeError(" | ".join(errors))


def bbox_str(cfg: dict) -> str:
    b = cfg["bbox"]
    return f"{b['south']},{b['west']},{b['north']},{b['east']}"


# --------------------------------------------------------------------------- geometría
def r5(x: float) -> float:
    return round(x, 5)


def way_coords(member_or_el: dict) -> list[list[float]]:
    return [[r5(p["lon"]), r5(p["lat"])] for p in member_or_el.get("geometry") or [] if p]


def perp_dist(p, a, b) -> float:
    (x, y), (x1, y1), (x2, y2) = p, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def simplify(points: list, tol: float) -> list:
    """Douglas-Peucker iterativo (en grados; 0,0003° ≈ 30 m en Santiago)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        best, idx = 0.0, -1
        for k in range(i + 1, j):
            d = perp_dist(points[k], points[i], points[j])
            if d > best:
                best, idx = d, k
        if idx >= 0 and best > tol:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(points, keep) if k]


def assemble_rings(ways: list[list[list[float]]]) -> list[list[list[float]]]:
    """Une tramos de borde (ways) en anillos cerrados emparejando extremos."""
    pending = [w[:] for w in ways if len(w) >= 2]
    rings = []
    while pending:
        ring = pending.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, w in enumerate(pending):
                if w[0] == ring[-1]:
                    ring += w[1:]
                elif w[-1] == ring[-1]:
                    ring += w[::-1][1:]
                elif w[-1] == ring[0]:
                    ring = w[:-1] + ring
                elif w[0] == ring[0]:
                    ring = w[::-1][:-1] + ring
                else:
                    continue
                pending.pop(i)
                changed = True
                break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def ring_area_m2(ring: list[list[float]]) -> float:
    if len(ring) < 4:
        return 0.0
    lat0 = math.radians(sum(p[1] for p in ring) / len(ring))
    kx, ky = 111320 * math.cos(lat0), 110540
    s = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        s += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky)
    return abs(s) / 2


def haversine_m(lon1, lat1, lon2, lat2) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def dist_point_line_m(pt, line) -> float:
    """Distancia aproximada (m) de un punto a una polilínea, proyectando localmente."""
    lat0 = math.radians(pt[1])
    kx, ky = 111320 * math.cos(lat0), 110540
    p = (pt[0] * kx, pt[1] * ky)
    best = float("inf")
    for a, b in zip(line, line[1:]):
        best = min(best, perp_dist(p, (a[0] * kx, a[1] * ky), (b[0] * kx, b[1] * ky)))
    return best


def fc(features: list, **meta) -> dict:
    out = {"type": "FeatureCollection", "features": features}
    out.update(meta)
    return out


# --------------------------------------------------------------------------- Metro
LINE_COLOURS = {  # respaldo si OSM no trae el color oficial de la línea
    "1": "#E1251B", "2": "#F6A800", "3": "#7B4A12", "4": "#0055A4", "4A": "#00A3E0",
    "5": "#00A650", "6": "#8E44AD", "7": "#6D6E71", "8": "#A3A3A3", "9": "#A3A3A3",
}


def line_ref(tags: dict) -> str:
    ref = (tags.get("ref") or "").upper().replace("L", "").strip()
    if not ref:
        import re
        m = re.search(r"L[íi]nea\s*(\d+A?)", tags.get("name", ""), re.I)
        ref = m.group(1).upper() if m else "?"
    return ref


def build_metro(cfg: dict) -> dict:
    bb = bbox_str(cfg)
    q = f"""[out:json][timeout:200];
(
  relation["route"="subway"]({bb});
);
out geom;"""
    res, ep = overpass(q, cfg)
    lines: dict[str, dict] = {}
    for el in res["elements"]:
        tags = el.get("tags", {})
        net = (tags.get("network", "") + " " + tags.get("operator", "")).lower()
        if net.strip() and "metro" not in net:
            continue
        ref = line_ref(tags)
        entry = lines.setdefault(ref, {"segments": set(), "coords": [], "tags": tags})
        for m in el.get("members", []):
            if m.get("type") != "way" or m.get("role") not in ("", None):
                continue
            key = m.get("ref")
            if key in entry["segments"]:
                continue
            entry["segments"].add(key)
            cs = way_coords(m)
            if len(cs) >= 2:
                entry["coords"].append(simplify(cs, 0.00005))
    feats = []
    for ref, e in sorted(lines.items()):
        if not e["coords"]:
            continue
        tags = e["tags"]
        colour = tags.get("colour") or LINE_COLOURS.get(ref, "#555555")
        feats.append({
            "type": "Feature",
            "properties": {"ref": ref, "name": f"Línea {ref}", "colour": colour,
                           "network": tags.get("network"), "status": "operativa",
                           "source": "OpenStreetMap", "osm_relation": tags.get("name")},
            "geometry": {"type": "MultiLineString", "coordinates": e["coords"]},
        })
    write_json(OSM / "metro_lines.geojson", fc(feats, attribution=ATTRIBUTION, generated_at=iso()), compact=True)

    # Tramos en construcción / proyectados que la comunidad OSM ya mapeó.
    q2 = f"""[out:json][timeout:200];
(
  way["railway"="construction"]["construction"="subway"]({bb});
  way["railway"="proposed"]["proposed"="subway"]({bb});
  way["construction:railway"="subway"]({bb});
);
out geom;"""
    future = []
    try:
        res2, _ = overpass(q2, cfg)
        for el in res2["elements"]:
            tags = el.get("tags", {})
            cs = way_coords(el)
            if len(cs) < 2:
                continue
            status = "en_construccion" if tags.get("railway") == "construction" or "construction:railway" in tags else "proyectada"
            future.append({
                "type": "Feature",
                "properties": {"name": tags.get("name") or tags.get("description") or "Tramo de Metro",
                               "ref": line_ref(tags) if (tags.get("ref") or tags.get("name")) else None,
                               "status": status, "source": "OpenStreetMap", "osm_id": f"way/{el['id']}"},
                "geometry": {"type": "LineString", "coordinates": simplify(cs, 0.00005)},
            })
        write_json(OSM / "metro_future.geojson", fc(future, attribution=ATTRIBUTION, generated_at=iso()), compact=True)
    except RuntimeError as e:
        log(f"::warning::Metro futuro sin actualizar: {e}")

    q3 = f"""[out:json][timeout:120];
(
  node["railway"="station"]["station"="subway"]({bb});
  node["railway"="station"]["subway"="yes"]({bb});
  node["public_transport"="station"]["subway"="yes"]({bb});
  node["railway"="construction"]["station"="subway"]({bb});
  node["construction:railway"="station"]["station"="subway"]({bb});
  node["railway"="proposed"]["station"="subway"]({bb});
);
out tags;"""
    res3, _ = overpass(q3, cfg)
    stations, seen = [], {}
    line_feats = [(f["properties"]["ref"], f["geometry"]["coordinates"]) for f in feats]
    for el in res3["elements"]:
        tags = el.get("tags", {})
        name = tags.get("name")
        if not name:
            continue
        pt = [r5(el["lon"]), r5(el["lat"])]
        # Una estación puede venir duplicada (railway=station + public_transport=station).
        dup = next((s for s in seen.get(name.lower(), []) if haversine_m(*s, *pt) < 250), None)
        if dup:
            continue
        seen.setdefault(name.lower(), []).append(pt)
        status = "operativa"
        if tags.get("railway") in ("construction",) or "construction:railway" in tags:
            status = "en_construccion"
        elif tags.get("railway") == "proposed":
            status = "proyectada"
        near = sorted({ref for ref, mls in line_feats
                       if any(dist_point_line_m(pt, ln) < 140 for ln in mls)})
        stations.append({
            "type": "Feature",
            "properties": {"name": name, "lines": near, "status": status, "osm_id": f"node/{el['id']}"},
            "geometry": {"type": "Point", "coordinates": pt},
        })
    write_json(OSM / "metro_stations.geojson", fc(stations, attribution=ATTRIBUTION, generated_at=iso()), compact=True)
    return {"endpoint": ep, "lines": len(feats), "future_segments": len(future), "stations": len(stations)}


# --------------------------------------------------------------------------- POIs
def build_pois(cfg: dict) -> dict:
    bb = bbox_str(cfg)
    feats, counts, errors = [], {}, {}
    previous = load_json(OSM / "pois.geojson", {"features": []})
    for cat, spec in cfg["poi_categories"].items():
        need_geom = "min_area_m2" in spec
        out = "out geom;" if need_geom else "out center tags;"
        q = f"[out:json][timeout:180];\n({spec['query']}({bb}););\n{out}"
        try:
            res, _ = overpass(q, cfg)
        except RuntimeError as e:
            errors[cat] = str(e)[:300]
            kept = [f for f in previous.get("features", []) if f["properties"].get("category") == cat]
            feats += kept
            counts[cat] = len(kept)
            log(f"::warning::POI {cat}: se conserva la versión anterior ({len(kept)})")
            continue
        n = 0
        for el in res["elements"]:
            tags = el.get("tags", {})
            name = tags.get("name")
            if not name:
                continue
            area = None
            if el["type"] == "node":
                lon, lat = el["lon"], el["lat"]
            elif need_geom:
                rings = []
                if el["type"] == "way":
                    rings = assemble_rings([way_coords(el)])
                else:
                    rings = assemble_rings([way_coords(m) for m in el.get("members", [])
                                            if m.get("type") == "way" and m.get("role") in ("outer", "")])
                if not rings:
                    continue
                area = sum(ring_area_m2(r) for r in rings)
                if area < spec["min_area_m2"]:
                    continue
                big = max(rings, key=ring_area_m2)
                lon = sum(p[0] for p in big[:-1]) / (len(big) - 1)
                lat = sum(p[1] for p in big[:-1]) / (len(big) - 1)
            else:
                c = el.get("center")
                if not c:
                    continue
                lon, lat = c["lon"], c["lat"]
            props = {"category": cat, "name": name, "osm_id": f"{el['type']}/{el['id']}"}
            for k in ("operator", "brand", "healthcare", "website", "tourism", "amenity", "addr:street", "addr:housenumber"):
                if tags.get(k):
                    props[k.replace("addr:", "addr_")] = tags[k]
            if area:
                props["area_m2"] = round(area)
            feats.append({"type": "Feature", "properties": props,
                          "geometry": {"type": "Point", "coordinates": [r5(lon), r5(lat)]}})
            n += 1
        counts[cat] = n
        log(f"  POI {cat}: {n}")
    write_json(OSM / "pois.geojson", fc(feats, attribution=ATTRIBUTION, generated_at=iso()), compact=True)
    return {"counts": counts, "errors": errors}


# --------------------------------------------------------------------------- comunas
def build_communes(cfg: dict) -> dict:
    bb = bbox_str(cfg)
    q = f"""[out:json][timeout:240];
(
  relation["boundary"="administrative"]["admin_level"="8"]({bb});
);
out geom;"""
    res, _ = overpass(q, cfg)
    feats = []
    for el in res["elements"]:
        tags = el.get("tags", {})
        outers = [way_coords(m) for m in el.get("members", [])
                  if m.get("type") == "way" and m.get("role") in ("outer", "")]
        rings = assemble_rings(outers)
        if not rings:
            continue
        polys = []
        for r in rings:
            s = simplify(r, 0.0003)
            if len(s) >= 4 and s[0] == s[-1]:
                polys.append([s])
        if not polys:
            continue
        feats.append({
            "type": "Feature",
            "properties": {"name": tags.get("name"), "osm_id": f"relation/{el['id']}"},
            "geometry": {"type": "MultiPolygon", "coordinates": polys},
        })
    write_json(OSM / "communes.geojson", fc(feats, attribution=ATTRIBUTION, generated_at=iso()), compact=True)
    return {"communes": len(feats)}


# --------------------------------------------------------------------------- main
def is_stale(cfg: dict) -> bool:
    meta = load_json(OSM / "meta.json", {})
    files = ["metro_lines.geojson", "metro_stations.geojson", "pois.geojson", "communes.geojson"]
    if any(not (OSM / f).exists() for f in files):
        return True
    last = meta.get("generated_at")
    if not last:
        return True
    from datetime import datetime
    age = utc_now() - datetime.fromisoformat(last.replace("Z", "+00:00"))
    return age > timedelta(days=cfg.get("osm_max_age_days", 30))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["metro", "pois", "communes"])
    ap.add_argument("--if-stale", action="store_true")
    args = ap.parse_args(argv)
    cfg = load_json(CONFIG / "pipeline.json")
    if args.if_stale and not is_stale(cfg):
        log("Capas OSM al día; no se descargan.")
        return 0
    meta = load_json(OSM / "meta.json", {}) or {}
    meta.setdefault("layers", {})
    ok = True
    for name, fn in (("metro", build_metro), ("pois", build_pois), ("communes", build_communes)):
        if args.only and args.only != name:
            continue
        log(f"Capa {name}…")
        try:
            info = fn(cfg)
            meta["layers"][name] = {"status": "ok", "updated_at": iso(), **info}
        except Exception as e:                       # noqa: BLE001
            ok = False
            prev = meta["layers"].get(name, {})
            meta["layers"][name] = {**prev, "status": "desactualizado", "last_error": str(e)[:400],
                                    "last_attempt": iso()}
            log(f"::warning::Capa {name} no se pudo actualizar; se conserva la anterior. {e}")
    meta.update({"last_attempt": iso(), "attribution": ATTRIBUTION, "source": "OpenStreetMap vía Overpass API"})
    if ok:                                           # una corrida parcial no "refresca" la fecha
        meta["generated_at"] = iso()
    write_json(OSM / "meta.json", meta)
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
