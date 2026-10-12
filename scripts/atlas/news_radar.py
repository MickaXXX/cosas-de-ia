#!/usr/bin/env python3
"""
Radar de noticias urbanas — data/radar_candidates.json

Flujo obligatorio: descubierto → extraído → georreferenciado → deduplicado →
clasificado → validado → publicado.

Este script cubre las primeras etapas y se detiene antes de "validado":
  descubierto  titulares de Google News (RSS público) para las búsquedas de
               config/pipeline.json → radar.queries
  extraído     titular, medio, fecha, enlace (no se copia el artículo)
  clasificado  categoría (metro, salud, comercio, educación, vial, residencial,
               normativa), comunas mencionadas y etapa sugerida por palabras clave
  deduplicado  por titular normalizado y enlace

Todo candidato queda `pendiente_revision`. Un humano lo promueve a
data/developments.json (con ubicación, radio y su justificación) desde la pantalla
"Radar urbano" o editando el archivo. Una nota de prensa es una pista, no una
confirmación de que la obra se ejecutará.
"""
from __future__ import annotations

import hashlib
import html
import re
import sys
import unicodedata
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CONFIG, DATA, http_get, iso, load_json, log, utc_now, write_json  # noqa: E402

OUT = DATA / "radar_candidates.json"

COMMUNES = ["Santiago", "Providencia", "Las Condes", "Vitacura", "Ñuñoa", "Lo Barnechea", "La Reina",
            "San Miguel", "Macul", "La Florida", "Estación Central", "Independencia", "Recoleta",
            "Quinta Normal", "San Joaquín", "Huechuraba", "Renca", "Peñalolén", "Maipú", "Puente Alto",
            "La Cisterna", "Conchalí", "Cerrillos", "Pudahuel", "Quilicura", "La Pintana", "El Bosque"]

CATEGORIES = [
    ("metro_futuro", r"\b(metro|l[ií]nea \d|estaci[oó]n(es)?|tren|teleférico|telef[eé]rico|corredor)\b"),
    ("hospital", r"\b(hospital|cl[ií]nica|centro m[eé]dico|cesfam|salud)\b"),
    ("mall", r"\b(mall|centro comercial|strip center|outlet|retail|supermercado)\b"),
    ("universidad", r"\b(universidad|campus|instituto|colegio)\b"),
    ("vial", r"\b(autopista|t[uú]nel|vial|avenida|ciclov[ií]a|puente|costanera)\b"),
    ("parque", r"\b(parque|plaza|[aá]rea verde|paseo)\b"),
    ("normativa", r"\b(plan regulador|normativa|altura|congelamiento|zonificaci[oó]n|densificaci[oó]n)\b"),
    ("residencial", r"\b(edificio|departamentos|inmobiliari[ao]|viviendas|proyecto habitacional|torre)\b"),
]
STAGES = [
    ("operativo", r"\b(inaugur|abre sus puertas|ya opera|entra en operaci[oó]n|abri[oó])"),
    ("en_construccion", r"\b(construcci[oó]n|obras|excavaci[oó]n|avance de \d+ ?%|primera piedra|tuneladora)"),
    ("aprobado", r"\b(aprob|rca favorable|permiso de edificaci[oó]n|adjudic)"),
    ("evaluacion", r"\b(seia|evaluaci[oó]n ambiental|declaraci[oó]n de impacto|estudio de impacto|ingres[oó])"),
    ("diseno", r"\b(dise[ñn]o|ingenier[ií]a|licitaci[oó]n)"),
    ("anuncio", r"\b(anunci|proyecta|planea|plan|propuesta|evaluar[aá])"),
]


def norm(s: str) -> str:
    return unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()


def classify(title: str) -> dict:
    t = norm(title)
    cat = next((c for c, pat in CATEGORIES if re.search(norm(pat), t)), "otro")
    stage = next((s for s, pat in STAGES if re.search(norm(pat), t)), None)
    communes = [c for c in COMMUNES if re.search(rf"\b{re.escape(norm(c))}\b", t)]
    return {"category": cat, "stage_hint": stage, "communes": communes}


def fetch_query(cfg: dict, q: str) -> list[dict]:
    r = cfg["radar"]
    url = f"{r['endpoint']}?q={urllib.parse.quote(q)}&{r['lang']}"
    xml = http_get(url, timeout=30, retries=2, headers={"Accept": "application/rss+xml, text/xml"})
    root = ET.fromstring(xml)
    out = []
    for it in root.iter("item"):
        title = html.unescape((it.findtext("title") or "").strip())
        link = (it.findtext("link") or "").strip()
        src_el = it.find("source")
        source = src_el.text.strip() if src_el is not None and src_el.text else ""
        if source and title.endswith(f" - {source}"):
            title = title[: -len(source) - 3].strip()
        try:
            pub = parsedate_to_datetime(it.findtext("pubDate") or "").astimezone().isoformat()
        except (TypeError, ValueError):
            pub = None
        out.append({"title": title, "url": link, "publisher": source, "published_at": pub, "query": q})
    return out


def main() -> int:
    cfg = load_json(CONFIG / "pipeline.json")
    prev = load_json(OUT, {"candidates": []}) or {"candidates": []}
    by_key = {c["key"]: c for c in prev.get("candidates", [])}
    cutoff = (utc_now() - timedelta(days=cfg["radar"]["max_age_days"])).isoformat()
    ok_queries, errors = 0, []
    for q in cfg["radar"]["queries"]:
        try:
            items = fetch_query(cfg, q)
            ok_queries += 1
        except Exception as e:                       # noqa: BLE001
            errors.append(f"{q}: {e}")
            log(f"::warning::radar «{q}» falló: {e}")
            continue
        for it in items:
            if it["published_at"] and it["published_at"] < cutoff:
                continue
            key = hashlib.sha1(re.sub(r"\W+", "", norm(it["title"]))[:120].encode()).hexdigest()[:14]
            if key in by_key:
                c = by_key[key]
                c["queries"] = sorted(set(c.get("queries", [])) | {q})
                continue
            cls = classify(it["title"])
            by_key[key] = {
                "key": key, "title": it["title"], "url": it["url"], "publisher": it["publisher"],
                "published_at": it["published_at"], "discovered_at": iso(), "queries": [q],
                "pipeline_stage": "clasificado", "status": "pendiente_revision", **cls,
            }
    cands = [c for c in by_key.values() if (c.get("published_at") or c["discovered_at"]) >= cutoff
             or c.get("status") != "pendiente_revision"]
    cands.sort(key=lambda c: c.get("published_at") or c["discovered_at"], reverse=True)
    status = "ok" if ok_queries == len(cfg["radar"]["queries"]) else ("desactualizado" if ok_queries == 0 else "parcial")
    if ok_queries == 0 and prev.get("candidates"):
        prev.update({"status": "desactualizado", "last_attempt": iso(), "detail": " | ".join(errors)[:500]})
        write_json(OUT, prev)
        return 0
    write_json(OUT, {
        "generated_at": iso(), "status": status, "source": "Google News RSS (titulares y enlaces; sin copiar artículos)",
        "detail": f"{ok_queries}/{len(cfg['radar']['queries'])} búsquedas OK" + (f" · errores: {' | '.join(errors)[:300]}" if errors else ""),
        "candidates": cands[:400],
    })
    log(f"Radar: {len(cands)} candidatos ({ok_queries} búsquedas OK)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
