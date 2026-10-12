#!/usr/bin/env python3
"""
Importación de proyectos y avisos de arriendo desde CSV (o XLSX si está openpyxl).

Las columnas y reglas salen de docs/atlas/config/import_schema.json, el mismo
archivo que usa el validador del navegador: lo que la app marca como error, aquí
también lo es.

  python scripts/atlas/import_data.py projects archivo.csv [--dry-run]
  python scripts/atlas/import_data.py rentals  archivo.csv [--dry-run]

Reglas:
  * Si una fila tiene errores, NO se importa nada: se listan los errores por fila y
    columna y se sale con código 1. Mejor corregir el archivo que publicar a medias.
  * Proyectos: las filas con el mismo project_id son unidades del mismo proyecto.
    Si el proyecto ya existe, sus unidades se reemplazan por las del archivo (es la
    observación más reciente), se conserva first_seen_at y se agrega una entrada a
    price_history si cambió el precio mínimo. Campos que el CSV no trae (documentos,
    amenities, notas manuales) no se tocan.
  * Arriendos: se deduplican por listing_id y, entre portales, por ubicación
    redondeada + precio + dormitorios + superficie.
  * Cada importación queda en data/import_log.json (quién, cuándo, archivo, filas).
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CONFIG, DATA, iso, load_json, log, parse_date, write_json  # noqa: E402

TRUE = {"si", "sí", "s", "yes", "y", "true", "1", "x", "verdadero"}
FALSE = {"no", "n", "false", "0", "falso", ""}
URL_RE = re.compile(r"^https?://\S+$")


def parse_number(v: str) -> float:
    """Acepta '2.921', '2921', '2921,5', '2.921,5' y '2,921.5'."""
    s = str(v).strip().replace(" ", "").replace("$", "").replace("UF", "")
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".")
    elif s.count(".") > 1 or re.fullmatch(r"\d{1,3}(\.\d{3})+", s):
        s = s.replace(".", "")
    return float(s)


def validate_row(row: dict, columns: list[dict], line: int) -> tuple[dict, list[str]]:
    out, errs = {}, []
    for col in columns:
        name = col["name"]
        raw = (row.get(name) or "").strip()
        if raw == "":
            if col.get("required"):
                errs.append(f"fila {line}, {name}: obligatorio")
            out[name] = None
            continue
        t = col["type"]
        try:
            if t == "string":
                val = raw
            elif t in ("number", "integer"):
                val = parse_number(raw)
                if t == "integer":
                    if val != int(val):
                        raise ValueError("debe ser entero")
                    val = int(val)
                if "min" in col and val < col["min"] or "max" in col and val > col["max"]:
                    raise ValueError(f"fuera de rango [{col.get('min')}, {col.get('max')}]")
            elif t == "date":
                d = parse_date(raw)
                if not d:
                    raise ValueError("fecha inválida (usar AAAA-MM-DD)")
                val = d.isoformat() if len(raw) > 7 else d.isoformat()[:7]
            elif t == "url":
                if not URL_RE.match(raw):
                    raise ValueError("URL inválida")
                val = raw
            elif t == "bool":
                low = raw.lower()
                if low in TRUE:
                    val = True
                elif low in FALSE:
                    val = False
                else:
                    raise ValueError("usar si/no")
            elif t == "enum":
                if raw not in col["enum"]:
                    raise ValueError(f"debe ser uno de {', '.join(col['enum'])}")
                val = raw
            else:
                val = raw
            out[name] = val
        except ValueError as e:
            errs.append(f"fila {line}, {name}: «{raw}» {e}")
    return out, errs


def read_rows(path_or_text: str, is_text: bool = False) -> list[dict]:
    if not is_text and str(path_or_text).lower().endswith(".xlsx"):
        try:
            import openpyxl
        except ImportError:
            sys.exit("Para XLSX instala openpyxl (pip install openpyxl) o exporta a CSV.")
        wb = openpyxl.load_workbook(path_or_text, read_only=True, data_only=True)
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
        head = [str(h).strip() for h in rows[0]]
        return [{h: ("" if v is None else str(v)) for h, v in zip(head, r)} for r in rows[1:] if any(r)]
    text = path_or_text if is_text else Path(path_or_text).read_text(encoding="utf-8-sig")
    sample = text[:2000]
    delim = ";" if sample.count(";") > sample.count(",") else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)
    reader.fieldnames = [f.strip() for f in reader.fieldnames or []]
    return [r for r in reader if any((v or "").strip() for v in r.values())]


def build_projects(rows: list[dict], now: str) -> dict[str, dict]:
    projects: dict[str, dict] = {}
    for r in rows:
        pid = r["project_id"]
        p = projects.get(pid)
        if not p:
            immediate = bool(r.get("immediate_delivery_verified"))
            status = "inmediata" if immediate else ("futura" if r.get("delivery_date") else "desconocida")
            has_geo = r.get("latitude") is not None and r.get("longitude") is not None
            p = projects[pid] = {
                "id": pid, "name": r["project_name"],
                "developer": {"name": r.get("developer_name"), "url": r.get("developer_url")},
                "address": r.get("address"), "commune": r["commune"], "neighborhood": r.get("neighborhood"),
                "lat": r.get("latitude"), "lon": r.get("longitude"),
                "geo_precision": r.get("geolocation_precision") or ("exacta" if has_geo else "pendiente"),
                "geo_source": "manual" if has_geo else None,
                "delivery": {"status": status, "date": r.get("delivery_date"),
                             "date_status": r.get("delivery_date_status") or ("confirmada" if immediate else "desconocida"),
                             "immediate_verified": immediate,
                             "stock_verified": bool(r.get("available_stock_verified")),
                             "verified_at": r.get("data_observed_at")},
                "publication_url": r.get("publication_url"), "brochure_url": r.get("brochure_url"),
                "short_term_rental": {"status": r.get("short_term_rental_status") or "por_verificar"},
                "observed_at": r["data_observed_at"], "demo": bool(r.get("is_demo")),
                "units": [],
                **({"payment_terms": {
                    "pie_installments_max": int(round(r["pie_installments_max"])),
                    "pie_post_delivery": bool(r.get("pie_post_delivery")),
                    "pie_min_upfront_pct": r.get("pie_min_upfront_pct"),
                    "source_name": "Importación CSV", "source_url": r.get("publication_url"),
                    "observed_at": r["data_observed_at"], "verification_status": "importado_sin_verificar",
                }} if r.get("pie_installments_max") is not None else {}),
                "evidence": [{
                    "field": "units", "source_name": "Importación CSV", "source_url": r.get("publication_url"),
                    "observed_at": r["data_observed_at"], "ingested_at": now, "access_method": "importacion_csv",
                    "license_status": "declarado_por_quien_importa", "confidence": "media",
                    "verification_status": "importado_sin_verificar", "notes": r.get("evidence_notes"),
                }],
            }
        p["units"].append({
            "id": r["unit_id"], "type": r.get("unit_type"), "bedrooms": r["bedrooms"], "bathrooms": r.get("bathrooms"),
            "useful_m2": r["useful_area_m2"], "total_m2": r.get("total_area_m2"),
            "list_price_uf": r.get("list_price_uf"), "offer_price_uf": r.get("offer_price_uf"),
            "bono_pie_pct": r.get("bono_pie_pct"), "parking": r.get("parking"), "storage": r.get("storage"),
            "floor": r.get("floor"), "orientation": r.get("orientation"),
            "common_expenses_clp": r.get("common_expenses_clp"),
            "available": bool(r.get("available_stock_verified")) if r.get("available_stock_verified") is not None else None,
        })
    return projects


def min_price(p) -> float | None:
    ps = [u.get("offer_price_uf") or u.get("list_price_uf") for u in p.get("units", [])]
    ps = [x for x in ps if x]
    return min(ps) if ps else None


def merge_projects(new: dict[str, dict], now: str) -> tuple[int, int]:
    path = DATA / "projects.json"
    doc = load_json(path, {"projects": []}) or {"projects": []}
    index = {p["id"]: p for p in doc["projects"]}
    added = updated = 0
    for pid, p in new.items():
        old = index.get(pid)
        mp = min_price(p)
        if old:
            keep = {k: v for k, v in old.items() if k not in p or p[k] in (None, "", [])}
            merged = {**keep, **{k: v for k, v in p.items() if v not in (None, "", [])}}
            merged["first_seen_at"] = old.get("first_seen_at") or now
            hist = old.get("price_history", [])
            if mp and (not hist or abs((hist[-1].get("min_price_uf") or 0) - mp) >= 0.5):
                hist = hist + [{"date": p["observed_at"], "min_price_uf": mp}]
            merged["price_history"] = hist
            merged["evidence"] = (p["evidence"] + old.get("evidence", []))[:30]
            if old.get("geo_source") == "manual" and p.get("geo_source") != "manual":
                for k in ("lat", "lon", "geo_precision", "geo_source"):
                    merged[k] = old.get(k)
            index[pid] = merged
            updated += 1
        else:
            p["first_seen_at"] = now
            p["price_history"] = [{"date": p["observed_at"], "min_price_uf": mp}] if mp else []
            index[pid] = p
            added += 1
    doc["projects"] = list(index.values())
    doc["updated_at"] = now
    write_json(path, doc)
    return added, updated


def merge_rentals(rows: list[dict], now: str) -> tuple[int, int]:
    path = DATA / "rentals.json"
    doc = load_json(path, {"listings": []}) or {"listings": []}
    by_id = {r["id"]: r for r in doc["listings"]}

    def fp(r):
        lat, lon = r.get("lat"), r.get("lon")
        if lat is None or lon is None:
            return None
        return (round(lat, 4), round(lon, 4), round(r["price_clp"], -3), r.get("bedrooms"), round(r.get("useful_m2") or 0))

    fps = {fp(r): r["id"] for r in doc["listings"] if fp(r)}
    added = dup = 0
    for r in rows:
        rec = {
            "id": r["listing_id"], "source": r["source"], "url": r.get("url"), "address": r.get("address"),
            "commune": r["commune"], "lat": r.get("latitude"), "lon": r.get("longitude"),
            "geo_precision": r.get("geolocation_precision") or ("exacta" if r.get("latitude") is not None else "pendiente"),
            "geo_source": "manual" if r.get("latitude") is not None else None,
            "price_clp": r["price_clp"], "common_expenses_clp": r.get("common_expenses_clp"),
            "common_expenses_included": r.get("common_expenses_included"),
            "bedrooms": r["bedrooms"], "bathrooms": r.get("bathrooms"), "useful_m2": r.get("useful_area_m2"),
            "furnished": r.get("furnished"), "parking": r.get("parking"), "building_year": r.get("building_year"),
            "published_at": r.get("published_at"), "observed_at": r["observed_at"], "notes": r.get("notes"),
            "demo": bool(r.get("is_demo")), "ingested_at": now, "price_kind": "pedido",
        }
        key = fp(rec)
        if rec["id"] in by_id or (key and key in fps and fps[key] != rec["id"]):
            dup += 1
            if rec["id"] in by_id:
                by_id[rec["id"]].update({k: v for k, v in rec.items() if v is not None})
            continue
        by_id[rec["id"]] = rec
        if key:
            fps[key] = rec["id"]
        added += 1
    doc["listings"] = list(by_id.values())
    doc["updated_at"] = now
    write_json(path, doc)
    return added, dup


def run_import(kind: str, rows: list[dict], label: str, actor: str = "local", dry: bool = False) -> dict:
    schema = load_json(CONFIG / "import_schema.json")[kind]
    clean, errors = [], []
    names = {c["name"] for c in schema["columns"]}
    if rows:
        unknown = sorted(set(rows[0]) - names)
        if unknown:
            log(f"Columnas ignoradas (no están en el esquema): {', '.join(unknown)}")
        missing = sorted(c["name"] for c in schema["columns"] if c.get("required") and c["name"] not in rows[0])
        if missing:
            errors.append(f"faltan columnas obligatorias: {', '.join(missing)}")
    for i, row in enumerate(rows, start=2):
        rec, errs = validate_row(row, schema["columns"], i)
        errors += errs
        clean.append(rec)
    result = {"kind": kind, "file": label, "actor": actor, "at": iso(), "rows": len(rows), "errors": errors[:200]}
    if errors or not rows:
        result["status"] = "rechazado" if errors else "vacio"
        return result
    now = iso()
    if dry:
        result["status"] = "validado_sin_importar"
        return result
    if kind == "projects":
        added, updated = merge_projects(build_projects(clean, now), now)
        result.update({"status": "importado", "added": added, "updated": updated})
    else:
        added, dup = merge_rentals(clean, now)
        result.update({"status": "importado", "added": added, "duplicates": dup})
    logdoc = load_json(DATA / "import_log.json", {"imports": []}) or {"imports": []}
    logdoc["imports"] = ([result] + logdoc["imports"])[:200]
    write_json(DATA / "import_log.json", logdoc)
    return result


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["projects", "rentals"])
    ap.add_argument("file")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--actor", default="local")
    args = ap.parse_args(argv)
    res = run_import(args.kind, read_rows(args.file), Path(args.file).name, args.actor, args.dry_run)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0 if res["status"] in ("importado", "validado_sin_importar") else 1


if __name__ == "__main__":
    sys.exit(main())
