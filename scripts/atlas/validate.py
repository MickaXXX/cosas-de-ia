#!/usr/bin/env python3
"""
Control de calidad, salud de datos y detección de cambios.

1. Valida projects.json, developments.json, rentals.json y rent_reference.json
   (tipos, rangos, fechas, URLs, coordenadas dentro de Santiago).
2. Escribe data/health.json: estado de cada fuente (ok / desactualizado / error /
   no configurado), última actualización, registros, errores y cobertura. Es lo que
   muestra la pantalla "Fuentes y datos".
3. Compara contra la foto anterior (data/snapshots/) y agrega a data/changes.json
   solo diferencias verdaderas: proyecto nuevo, baja de precio sobre el umbral,
   cambio de fecha de entrega o de stock, gasto común, brochure, obra nueva o cambio
   de etapa. Diferencias de redondeo (< 0,5 UF) no generan aviso.

Con --strict sale con código 1 si hay errores (lo usa la CI). Sin --strict siempre
publica health.json, para que la app muestre los errores en vez de esconderlos.
"""
from __future__ import annotations

import hashlib
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CONFIG, DATA, OSM, iso, load_json, log, parse_date, santiago_now, utc_now, write_json  # noqa: E402

SNAP = DATA / "snapshots"
URL_RE = re.compile(r"^https?://[^\s]+$")
STAGES = {"idea", "anuncio", "diseno", "evaluacion", "aprobado", "en_construccion", "operativo"}
DEV_TYPES = {"metro_futuro", "metro_extension", "transporte", "vial", "mall", "comercio", "clinica", "hospital",
             "universidad", "educacion", "parque", "cultura", "polo_empleo", "residencial", "normativa", "otro"}
DELIVERY_STATES = {"inmediata", "futura", "desconocida"}


class Report:
    def __init__(self):
        self.errors: list[dict] = []
        self.warnings: list[dict] = []

    def err(self, entity, field, msg):
        self.errors.append({"entity": entity, "field": field, "level": "error", "message": msg})

    def warn(self, entity, field, msg):
        self.warnings.append({"entity": entity, "field": field, "level": "warning", "message": msg})


def in_bbox(lat, lon, cfg) -> bool:
    b = cfg["bbox"]
    try:
        return b["south"] <= float(lat) <= b["north"] and b["west"] <= float(lon) <= b["east"]
    except (TypeError, ValueError):
        return False


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def age_days(ts: str | None) -> float | None:
    d = parse_date(ts)
    if not d:
        return None
    return (santiago_now().date() - d).days


# --------------------------------------------------------------------------- validadores
def validate_projects(doc, cfg, rep: Report) -> dict:
    stats = {"total": 0, "real": 0, "demo": 0, "units": 0, "stale": 0, "geo_review": 0}
    ids = set()
    for p in doc.get("projects", []):
        pid = p.get("id") or "(sin id)"
        stats["total"] += 1
        stats["demo" if p.get("demo") else "real"] += 1
        if not p.get("id"):
            rep.err(pid, "id", "Proyecto sin id")
        elif pid in ids:
            rep.err(pid, "id", "id duplicado")
        ids.add(pid)
        if not p.get("name"):
            rep.err(pid, "name", "Proyecto sin nombre")
        if not p.get("commune"):
            rep.err(pid, "commune", "Proyecto sin comuna")
        lat, lon = p.get("lat"), p.get("lon")
        if lat in (None, "") or lon in (None, ""):
            rep.warn(pid, "lat/lon", "Sin coordenadas: no aparece en el mapa hasta geocodificar")
        elif not in_bbox(lat, lon, cfg):
            rep.err(pid, "lat/lon", f"Coordenadas fuera de Santiago ({lat}, {lon})")
        if p.get("geo_review"):
            stats["geo_review"] += 1
            rep.warn(pid, "geo", p.get("geo_note") or "Ubicación pendiente de revisión")
        d = p.get("delivery") or {}
        if d.get("status") and d["status"] not in DELIVERY_STATES:
            rep.err(pid, "delivery.status", f"Estado de entrega desconocido: {d['status']}")
        if d.get("date") and not parse_date(d["date"]):
            rep.err(pid, "delivery.date", f"Fecha inválida: {d['date']}")
        for k in ("publication_url", "brochure_url"):
            if p.get(k) and not URL_RE.match(str(p[k])):
                rep.err(pid, k, "URL inválida")
        a = age_days(p.get("observed_at"))
        if not p.get("demo") and (a is None or a > cfg["staleness_days"]["projects"]):
            stats["stale"] += 1
            rep.warn(pid, "observed_at", f"Precio/stock observado hace {a if a is not None else '?'} días: verificar")
        for u in p.get("units", []):
            stats["units"] += 1
            uid = f"{pid}/{u.get('id', '?')}"
            price = num(u.get("offer_price_uf")) or num(u.get("list_price_uf"))
            if price is None:
                rep.warn(uid, "price", "Unidad sin precio")
            elif not 300 <= price <= 100000:
                rep.err(uid, "price", f"Precio fuera de rango: {price} UF")
            m2 = num(u.get("useful_m2"))
            if m2 is not None and not 12 <= m2 <= 400:
                rep.err(uid, "useful_m2", f"Superficie fuera de rango: {m2}")
            b = u.get("bedrooms")
            if b is not None and (not isinstance(b, int) or not 0 <= b <= 6):
                rep.err(uid, "bedrooms", f"Dormitorios inválidos: {b}")
    return stats


def validate_developments(doc, cfg, rep: Report) -> dict:
    stats = {"total": 0, "publicado": 0, "pendiente_revision": 0}
    for d in doc.get("developments", []):
        did = d.get("id") or "(sin id)"
        stats["total"] += 1
        st = d.get("status", "pendiente_revision")
        stats[st] = stats.get(st, 0) + 1
        if d.get("type") not in DEV_TYPES:
            rep.err(did, "type", f"Tipo desconocido: {d.get('type')}")
        if d.get("stage") not in STAGES:
            rep.err(did, "stage", f"Etapa desconocida: {d.get('stage')}")
        srcs = d.get("sources") or []
        if not srcs or not all(URL_RE.match(str(s.get("url", ""))) for s in srcs):
            rep.err(did, "sources", "Toda obra necesita al menos una fuente con URL")
        if st == "publicado" and not d.get("radius_justification"):
            rep.err(did, "radius_justification", "Falta justificar el radio de influencia")
        if not d.get("geometry") and (d.get("lat") in (None, "") or d.get("lon") in (None, "")):
            rep.warn(did, "geo", "Sin ubicación: pendiente de geocodificar o de resolver su ancla OSM")
        elif d.get("lat") not in (None, "") and not in_bbox(d.get("lat"), d.get("lon"), cfg):
            rep.err(did, "lat/lon", "Coordenadas fuera de Santiago")
        if st == "publicado" and len(srcs) < 2 and not any(s.get("official") for s in srcs):
            rep.warn(did, "sources", "Una sola fuente y no oficial: buscar confirmación")
    return stats


def validate_rentals(doc, cfg, rep: Report) -> dict:
    stats = {"total": 0, "real": 0, "demo": 0, "stale": 0}
    for r in doc.get("listings", []):
        rid = r.get("id") or "(sin id)"
        stats["total"] += 1
        stats["demo" if r.get("demo") else "real"] += 1
        price = num(r.get("price_clp"))
        if price is None or not 50_000 <= price <= 10_000_000:
            rep.err(rid, "price_clp", f"Arriendo fuera de rango: {r.get('price_clp')}")
        if not in_bbox(r.get("lat"), r.get("lon"), cfg):
            rep.warn(rid, "lat/lon", "Aviso sin coordenadas válidas: no entra al radio de 2 km")
        a = age_days(r.get("observed_at"))
        if not r.get("demo") and (a is None or a > cfg["staleness_days"]["rentals"]):
            stats["stale"] += 1
    return stats


# --------------------------------------------------------------------------- cambios
def event(kind, entity, title, before=None, after=None, source=None, evidence="media") -> dict:
    raw = f"{kind}|{entity}|{before}|{after}"
    return {"id": hashlib.sha1(raw.encode()).hexdigest()[:16], "type": kind, "entity_id": entity,
            "title": title, "before": before, "after": after, "detected_at": iso(),
            "source_url": source, "evidence": evidence}


def min_price(p) -> float | None:
    ps = [num(u.get("offer_price_uf")) or num(u.get("list_price_uf")) for u in p.get("units", [])]
    ps = [x for x in ps if x]
    return min(ps) if ps else None


def detect_changes(projects, developments, cfg) -> list[dict]:
    prev_p = load_json(SNAP / "projects.prev.json")
    prev_d = load_json(SNAP / "developments.prev.json")
    events = []
    thr_pct, thr_uf = cfg["alerts"]["price_drop_pct"], cfg["alerts"]["price_drop_uf"]
    if prev_p is not None:
        before = {p["id"]: p for p in prev_p.get("projects", []) if not p.get("demo")}
        for p in projects.get("projects", []):
            if p.get("demo"):
                continue
            o = before.get(p["id"])
            src = p.get("publication_url")
            if not o:
                events.append(event("proyecto_nuevo", p["id"], f"Proyecto nuevo: {p['name']} ({p.get('commune')})",
                                    after=min_price(p), source=src))
                continue
            a, b = min_price(o), min_price(p)
            if a and b and abs(a - b) >= 0.5:
                drop = a - b
                if drop > 0 and (drop / a * 100 >= thr_pct or drop >= thr_uf):
                    events.append(event("baja_precio", p["id"], f"Baja de precio en {p['name']}: {a:,.0f} → {b:,.0f} UF",
                                        before=a, after=b, source=src, evidence="alta" if src else "media"))
                elif drop < 0:
                    events.append(event("alza_precio", p["id"], f"Sube el precio en {p['name']}: {a:,.0f} → {b:,.0f} UF",
                                        before=a, after=b, source=src))
            od, nd = (o.get("delivery") or {}), (p.get("delivery") or {})
            if (od.get("date"), od.get("status")) != (nd.get("date"), nd.get("status")):
                events.append(event("cambio_entrega", p["id"], f"Cambia la entrega de {p['name']}",
                                    before=f"{od.get('status')} {od.get('date') or ''}".strip(),
                                    after=f"{nd.get('status')} {nd.get('date') or ''}".strip(), source=src))
            if bool(od.get("stock_verified")) != bool(nd.get("stock_verified")):
                events.append(event("cambio_stock", p["id"], f"Cambia el stock verificado de {p['name']}",
                                    before=od.get("stock_verified"), after=nd.get("stock_verified"), source=src))
            for field, label in (("common_expenses_clp", "gasto común"), ("brochure_url", "brochure")):
                if o.get(field) != p.get(field) and p.get(field):
                    events.append(event(f"cambio_{field}", p["id"], f"Cambia el {label} de {p['name']}",
                                        before=o.get(field), after=p.get(field), source=src))
    if prev_d is not None:
        before = {d["id"]: d for d in prev_d.get("developments", [])}
        for d in developments.get("developments", []):
            if d.get("status") != "publicado":
                continue
            o = before.get(d["id"])
            src = (d.get("sources") or [{}])[0].get("url")
            if not o or o.get("status") != "publicado":
                events.append(event("obra_nueva", d["id"], f"Nueva obra en el radar: {d['name']}", after=d.get("stage"),
                                    source=src, evidence="alta" if any(s.get("official") for s in d.get("sources", [])) else "media"))
            elif o.get("stage") != d.get("stage") or o.get("estimated_date") != d.get("estimated_date"):
                events.append(event("cambio_obra", d["id"], f"{d['name']}: cambia etapa o fecha",
                                    before=f"{o.get('stage')} {o.get('estimated_date') or ''}".strip(),
                                    after=f"{d.get('stage')} {d.get('estimated_date') or ''}".strip(), source=src))
    write_json(SNAP / "projects.prev.json", projects, compact=True)
    write_json(SNAP / "developments.prev.json", developments, compact=True)
    return events


def merge_changes(new_events: list[dict]) -> int:
    doc = load_json(DATA / "changes.json", {"events": []}) or {"events": []}
    known = {e["id"] for e in doc["events"]}
    fresh = [e for e in new_events if e["id"] not in known]
    cutoff = (utc_now() - timedelta(days=365)).strftime("%Y-%m-%d")
    doc["events"] = (fresh + doc["events"])
    doc["events"] = [e for e in doc["events"] if e["detected_at"][:10] >= cutoff][:500]
    doc["generated_at"] = iso()
    write_json(DATA / "changes.json", doc)
    return len(fresh)


# --------------------------------------------------------------------------- salud
def source_entry(sid, name, status, last_update=None, records=None, detail=None, url=None, kind="dato"):
    return {"id": sid, "name": name, "status": status, "last_update": last_update, "records": records,
            "detail": detail, "url": url, "kind": kind}


def build_health(cfg, rep: Report, pstats, dstats, rstats) -> dict:
    s = []
    uf = load_json(DATA / "uf.json", {}) or {}
    if uf.get("value"):
        stale = (age_days(uf.get("date")) or 0) > cfg["uf"]["stale_after_days"]
        s.append(source_entry("uf", "UF diaria", "desactualizado" if stale or uf.get("status") != "ok" else "ok",
                              uf.get("fetched_at"), len(uf.get("series", [])),
                              f"UF {uf.get('date')}: {uf['value']:,.2f} · {uf.get('source')}" + (f" · último error: {uf['last_error']}" if uf.get("last_error") else ""),
                              uf.get("source_url")))
    else:
        s.append(source_entry("uf", "UF diaria", "error", detail="Sin valor de UF: correr update_uf.py"))
    meta = load_json(OSM / "meta.json", {}) or {}
    for layer, label in (("metro", "Metro operativo y estaciones (OSM)"), ("pois", "Servicios: malls, salud, educación, parques (OSM)"),
                         ("communes", "Límites comunales (OSM)")):
        m = (meta.get("layers") or {}).get(layer)
        if not m:
            s.append(source_entry(f"osm_{layer}", label, "no_configurado", detail="Aún no se descarga: correr osm_layers.py"))
        else:
            rec = m.get("stations") or m.get("communes") or sum((m.get("counts") or {}).values()) or None
            s.append(source_entry(f"osm_{layer}", label, m.get("status", "ok"), m.get("updated_at"), rec,
                                  m.get("last_error") or "© colaboradores de OpenStreetMap (ODbL)", "https://www.openstreetmap.org/copyright"))
    s.append(source_entry("projects", "Proyectos inmobiliarios", "ok" if pstats["real"] else "sin_datos",
                          (load_json(DATA / "projects.json", {}) or {}).get("updated_at"), pstats["real"],
                          f"{pstats['real']} reales · {pstats['demo']} demo · {pstats['units']} unidades · {pstats['stale']} con precio por re-verificar · {pstats['geo_review']} ubicaciones por revisar"))
    s.append(source_entry("rentals", "Avisos de arriendo (comparables 2 km)", "ok" if rstats["real"] else "sin_datos",
                          (load_json(DATA / "rentals.json", {}) or {}).get("updated_at"), rstats["real"],
                          f"{rstats['real']} reales · {rstats['demo']} demo. Sin proveedor autorizado conectado: importar CSV propio o contratar un feed."))
    s.append(source_entry("developments", "Radar urbano: obras y anuncios validados", "ok" if dstats.get("publicado") else "sin_datos",
                          (load_json(DATA / "developments.json", {}) or {}).get("updated_at"), dstats.get("publicado"),
                          f"{dstats.get('publicado', 0)} publicados · {dstats.get('pendiente_revision', 0)} pendientes de revisión"))
    radar = load_json(DATA / "radar_candidates.json", {}) or {}
    s.append(source_entry("radar", "Radar de noticias (candidatos sin validar)", radar.get("status", "no_configurado"),
                          radar.get("generated_at"), len(radar.get("candidates", [])), radar.get("detail")))
    ref = load_json(DATA / "rent_reference.json", {}) or {}
    s.append(source_entry("rent_reference", "Arriendo de referencia por comuna (informes publicados)",
                          "ok" if ref.get("references") else "sin_datos", ref.get("updated_at"), len(ref.get("references", [])),
                          "Promedios comunales publicados por terceros: NO son comparables de 2 km"))
    rates = load_json(DATA / "market.json", {}) or {}
    s.append(source_entry("mortgage_rate", "Tasa hipotecaria de referencia", "ok" if rates.get("mortgage_rate") else "sin_datos",
                          (rates.get("mortgage_rate") or {}).get("observed_at"), None,
                          (rates.get("mortgage_rate") or {}).get("source_name")))
    for sid, name, detail, url in (
        ("cead", "Seguridad: CEAD / SIED", "No configurado. Los indicadores comunales se cargan desde data/communes.json con su fuente; no hay descarga automática.", "https://cead.spd.gov.cl/sala-cead/"),
        ("sernatur", "Turismo: Sernatur / SIET", "No configurado. El índice turístico usa un score propio con POIs de OSM (ver fórmula).", "https://datosturismo.sernatur.cl/siet/"),
        ("airdna", "Renta corta: AirDNA u otro proveedor licenciado", "No configurado (requiere licencia pagada). El módulo Airbnb funciona solo en modo supuestos.", "https://www.airdna.co/"),
        ("listings_feed", "Feed autorizado de proyectos y arriendos (Portal Inmobiliario, TOCTOC, etc.)", "No configurado: requiere acuerdo de datos. Mientras tanto: importación CSV/XLSX.", None),
        ("bcch_siete", "Banco Central (SIETE): tasas de colocación vivienda", "No configurado: requiere usuario y clave SIETE (BCCH_USER / BCCH_PASS).", "https://si3.bcentral.cl/Siete/"),
    ):
        s.append(source_entry(sid, name, "no_configurado", detail=detail, url=url, kind="integracion"))
    jobs = load_json(DATA / "jobs.json", {}) or {}
    return {"generated_at": iso(), "sources": s, "jobs": jobs,
            "quality_flags": (rep.errors + rep.warnings)[:400],
            "summary": {"errors": len(rep.errors), "warnings": len(rep.warnings)}}


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--strict", action="store_true", help="salir con código 1 si hay errores")
    args = ap.parse_args(argv)
    cfg = load_json(CONFIG / "pipeline.json")
    rep = Report()
    projects = load_json(DATA / "projects.json", {"projects": []}) or {"projects": []}
    developments = load_json(DATA / "developments.json", {"developments": []}) or {"developments": []}
    rentals = load_json(DATA / "rentals.json", {"listings": []}) or {"listings": []}
    pstats = validate_projects(projects, cfg, rep)
    dstats = validate_developments(developments, cfg, rep)
    rstats = validate_rentals(rentals, cfg, rep)
    fresh = merge_changes(detect_changes(projects, developments, cfg))
    health = build_health(cfg, rep, pstats, dstats, rstats)
    write_json(DATA / "health.json", health)
    log(f"Validación: {len(rep.errors)} errores, {len(rep.warnings)} advertencias, {fresh} cambios nuevos")
    for e in rep.errors[:50]:
        log(f"::error::{e['entity']} · {e['field']}: {e['message']}")
    return 1 if (rep.errors and args.strict) else 0


if __name__ == "__main__":
    sys.exit(main())
