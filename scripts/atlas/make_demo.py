#!/usr/bin/env python3
"""
Genera docs/atlas/data/demo.json: proyectos y avisos de arriendo FICTICIOS para probar
la app ("Modo DEMO"). Todo lleva demo=true, nombres con prefijo "DEMO ·" y enlaces a
example.com. La app nunca los mezcla con datos reales ni los pone en el ranking real.

Es determinista (semilla fija): correrlo dos veces da el mismo archivo.
Ubica los proyectos cerca de estaciones de Metro reales de las comunas activas
(data/osm/metro_stations.geojson + communes.geojson) para que el entorno sea realista.

  python scripts/atlas/make_demo.py
"""
from __future__ import annotations

import math
import random
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CONFIG, DATA, OSM, iso, load_json, write_json  # noqa: E402

SEED = 20261012
TODAY = date(2026, 10, 12)
UF_M2 = {"Providencia": 98, "Las Condes": 108, "Vitacura": 135, "Ñuñoa": 88, "Lo Barnechea": 100, "Santiago": 76}
RENT_M2 = {"Providencia": 14500, "Las Condes": 15500, "Vitacura": 15000, "Ñuñoa": 13000, "Lo Barnechea": 13500, "Santiago": 12000}
WEIGHT = {"Providencia": 6, "Las Condes": 5, "Vitacura": 2, "Ñuñoa": 7, "Lo Barnechea": 1, "Santiago": 7}
NAMES = ["Alerce", "Quillay", "Boldo", "Peumo", "Maitén", "Litre", "Canelo", "Arrayán", "Coigüe", "Raulí", "Lenga", "Ñirre",
         "Tepa", "Ulmo", "Avellano", "Patagua", "Pimiento", "Espino", "Molle", "Corontillo", "Luma", "Tineo", "Mañío", "Ciprés",
         "Roble", "Laurel", "Olivillo", "Maqui", "Chilco", "Copihue"]
AMENITIES = ["piscina", "gimnasio", "conserjería 24 h", "quincho", "cowork", "lavandería", "bicicletero", "sala multiuso", "sauna"]


def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def commune_of(lon, lat, communes):
    for f in communes:
        for poly in f["geometry"]["coordinates"]:
            if point_in_ring(lon, lat, poly[0]):
                return f["properties"]["name"]
    return None


def offset(lon, lat, dist_m, bearing):
    dlat = dist_m * math.cos(bearing) / 110540
    dlon = dist_m * math.sin(bearing) / (111320 * math.cos(math.radians(lat)))
    return lon + dlon, lat + dlat


def main() -> int:
    rnd = random.Random(SEED)
    cfg = load_json(CONFIG / "defaults.json")
    stations = (load_json(OSM / "metro_stations.geojson", {}) or {}).get("features", [])
    communes = (load_json(OSM / "communes.geojson", {}) or {}).get("features", [])
    if not stations or not communes:
        sys.exit("Faltan capas OSM (metro_stations / communes): correr osm_layers.py primero")
    active = cfg["communes"]["active"]
    by_commune: dict[str, list] = {}
    for s in stations:
        lon, lat = s["geometry"]["coordinates"]
        c = commune_of(lon, lat, communes)
        if c in active:
            by_commune.setdefault(c, []).append(s)
    pool = [c for c in active if by_commune.get(c)]
    weights = [WEIGHT.get(c, 1) for c in pool]
    projects, listings = [], []
    bands = cfg["commonExpenses"]["bandsByCommune"]
    for i in range(30):
        commune = rnd.choices(pool, weights)[0]
        st = rnd.choice(by_commune[commune])
        lon0, lat0 = st["geometry"]["coordinates"]
        for _ in range(20):
            lon, lat = offset(lon0, lat0, rnd.uniform(120, 850), rnd.uniform(0, 2 * math.pi))
            if commune_of(lon, lat, communes) == commune:
                break
        else:
            lon, lat = lon0, lat0
        pid = f"demo-{i + 1:02d}"
        name = f"DEMO · Edificio {NAMES[i]}"
        r = rnd.random()
        if r < 0.35:
            age = rnd.randint(0, 40)
            delivery = {"status": "inmediata", "date": None, "date_status": "confirmada", "immediate_verified": True,
                        "stock_verified": True, "verified_at": (TODAY - timedelta(days=age)).isoformat()}
        elif r < 0.45:
            delivery = {"status": "inmediata", "date": None, "date_status": "desconocida", "immediate_declared": True,
                        "immediate_verified": False, "stock_verified": False, "verified_at": None}
        elif r < 0.70:
            d = TODAY + timedelta(days=rnd.randint(60, 365))
            delivery = {"status": "futura", "date": d.isoformat(), "date_status": "estimada", "immediate_verified": False,
                        "stock_verified": True, "verified_at": (TODAY - timedelta(days=rnd.randint(0, 30))).isoformat()}
        elif r < 0.90:
            d = TODAY + timedelta(days=rnd.randint(380, 1000))
            delivery = {"status": "futura", "date": d.strftime("%Y-%m"), "date_status": "estimada", "immediate_verified": False,
                        "stock_verified": True, "verified_at": (TODAY - timedelta(days=rnd.randint(0, 30))).isoformat()}
        else:
            delivery = {"status": "desconocida", "date": None, "date_status": "desconocida", "immediate_verified": False,
                        "stock_verified": False, "verified_at": None}
        strs = rnd.choices(["permitido_verificado", "no_permitido_verificado", "condicionado", "por_verificar"], [3, 1, 1, 5])[0]
        uf_m2 = UF_M2[commune] * rnd.uniform(0.9, 1.1)
        units = []
        typs = rnd.sample([(0, 24, 30), (1, 33, 42), (2, 52, 68), (3, 75, 95)], rnd.randint(2, 4))
        bono = rnd.choice([0, 0, 5, 10])
        for b, lo, hi in sorted(typs):
            m2 = round(rnd.uniform(lo, hi), 1)
            prem = 1.08 if b == 0 else 1.0
            price = round(m2 * uf_m2 * prem / 10) * 10
            units.append({"id": f"{['E', '1D', '2D', '3D'][b]}-{rnd.randint(2, 18)}0{rnd.randint(1, 8)}", "type": ["Estudio", "1D1B", "2D2B", "3D2B"][b],
                          "bedrooms": b, "bathrooms": 1 if b < 2 else 2, "useful_m2": m2, "total_m2": round(m2 * 1.12, 1),
                          "list_price_uf": round(price * 1.04), "offer_price_uf": price, "bono_pie_pct": bono,
                          "parking": b >= 2, "storage": b >= 1, "floor": rnd.randint(2, 18), "orientation": rnd.choice(["Norte", "Oriente", "Poniente", "Sur"]),
                          "available": delivery["stock_verified"] or None})
        gc_pub = rnd.random() < 0.5
        band = bands.get(commune, cfg["commonExpenses"]["defaultBand"])
        proj = {
            "id": pid, "name": name, "developer": {"name": f"Inmobiliaria Ficticia {chr(65 + i % 8)}", "url": "https://example.com/demo"},
            "address": f"Calle Ficticia {rnd.randint(100, 3999)}", "commune": commune, "neighborhood": f"cerca de Metro {st['properties']['name']}",
            "lat": round(lat, 6), "lon": round(lon, 6), "geo_precision": "exacta", "geo_source": "demo",
            "delivery": delivery, "price_from_uf": min(u["offer_price_uf"] for u in units),
            "publication_url": f"https://example.com/demo/{pid}", "brochure_url": f"https://example.com/demo/{pid}/brochure.pdf",
            "documents": [{"label": "Brochure (DEMO)", "url": f"https://example.com/demo/{pid}/brochure.pdf"}],
            "amenities": rnd.sample(AMENITIES, rnd.randint(1, 5)),
            "benefits": [{"type": "bono_pie", "label": f"Bono pie {bono}%"}] if bono else [],
            "common_expenses_clp_m2": round(rnd.uniform(band["low"], band["high"])) if gc_pub else None,
            "short_term_rental": {"status": strs},
            "units": units,
            "observed_at": (TODAY - timedelta(days=rnd.randint(0, 25))).isoformat(),
            "first_seen_at": iso() if i < 3 else "2026-08-01T12:00:00Z",
            "price_history": ([{"date": "2026-08-01", "min_price_uf": round(min(u["offer_price_uf"] for u in units) * 1.06)},
                               {"date": "2026-10-01", "min_price_uf": min(u["offer_price_uf"] for u in units)}] if i % 7 == 0 else []),
            "evidence": [{"field": "units", "source_name": "DEMO (datos simulados)", "source_url": f"https://example.com/demo/{pid}",
                          "observed_at": TODAY.isoformat(), "access_method": "demo", "confidence": "demo", "verification_status": "verificado",
                          "notes": "Ficticio: solo para probar la app."}],
            "demo": True,
        }
        projects.append(proj)
        # Avisos de arriendo alrededor
        for k in range(rnd.randint(12, 34)):
            b = rnd.choices([0, 1, 2, 3], [2, 5, 4, 1])[0]
            m2 = round(rnd.uniform(*{0: (22, 32), 1: (32, 45), 2: (50, 72), 3: (72, 100)}[b]), 1)
            llon, llat = offset(lon, lat, rnd.uniform(50, 2300), rnd.uniform(0, 2 * math.pi))
            lc = commune_of(llon, llat, communes) or commune
            base = RENT_M2.get(lc, 12500) * (m2 / 40) ** (-0.3)
            price = round(base * m2 * math.exp(rnd.gauss(0, 0.09)) / 5000) * 5000
            furnished = rnd.random() < 0.15
            if furnished:
                price = round(price * 1.18 / 5000) * 5000
            gc = round(rnd.uniform(band["low"], band["high"]) * m2 / 1000) * 1000 if rnd.random() < 0.7 else None
            listings.append({
                "id": f"{pid}-a{k:02d}", "source": "DEMO (simulado)", "url": None, "address": None, "commune": lc,
                "lat": round(llat, 6), "lon": round(llon, 6), "geo_precision": "exacta", "price_clp": price,
                "common_expenses_clp": gc, "common_expenses_included": False, "bedrooms": b, "bathrooms": 1 if b < 2 else 2,
                "useful_m2": m2, "furnished": furnished, "parking": b >= 2 and rnd.random() < 0.6,
                "building_year": rnd.randint(2008, 2025), "published_at": (TODAY - timedelta(days=rnd.randint(1, 90))).isoformat(),
                "observed_at": (TODAY - timedelta(days=rnd.randint(0, 10))).isoformat(), "demo": True, "price_kind": "pedido",
            })
        # un duplicado entre "portales" y un valor extremo, para ver la depuración en acción
        if i % 5 == 0 and listings:
            dup = dict(listings[-1]); dup["id"] += "-dup"; dup["source"] = "DEMO (otro portal)"
            listings.append(dup)
            out = dict(listings[-2]); out["id"] += "-x"; out["price_clp"] = out["price_clp"] * 3
            listings.append(out)
    write_json(DATA / "demo.json", {"generated_at": iso(), "seed": SEED, "label": "DEMO / DATOS SIMULADOS",
                                    "note": "Proyectos y avisos ficticios para probar la app. No usar para decidir.",
                                    "projects": projects, "listings": listings}, compact=True)
    print(f"demo.json: {len(projects)} proyectos, {len(listings)} avisos")
    return 0


if __name__ == "__main__":
    sys.exit(main())
