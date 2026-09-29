"""Exporta cada cerebro a JSON para la visualización (docs/cerebro/)."""
from __future__ import annotations

import json
import os
import re
import subprocess

from .anatomia import RAIZ, Anatomia, es_stdlib
from .memoria import Memoria, iso

SALIDA = RAIZ / "docs" / "cerebro" / "data"


def repo() -> str:
    if os.environ.get("GITHUB_REPOSITORY"):
        return os.environ["GITHUB_REPOSITORY"]
    try:
        url = subprocess.run(["git", "remote", "get-url", "origin"], cwd=RAIZ, capture_output=True,
                             text=True, check=True).stdout.strip()
        m = re.search(r"([^/:]+/[^/]+?)(?:\.git)?/?$", url)
        return m.group(1) if m else ""
    except Exception:
        return ""


def exportar_cerebro(mem: Memoria, anat: Anatomia) -> dict:
    reg = mem.d["neuronas"]
    inv = anat.llamadores()
    nodos, enlaces = [], []
    for ruta, meta in anat.archivos.items():
        nodos.append({"id": ruta, "tipo": "archivo", "nombre": ruta.rsplit("/", 1)[-1], "archivo": ruta,
                      "lineas": meta["lineas"]})
        for lib in meta["libs"]:
            lid = "lib:" + lib
            if not any(x["id"] == lid for x in nodos):
                nodos.append({"id": lid, "tipo": "libreria", "nombre": lib, "stdlib": es_stdlib(lib)})
            enlaces.append({"source": ruta, "target": lid, "tipo": "importa"})
    for n in anat.neuronas.values():
        e = reg.get(n.id, {})
        d = n.publica()
        d.pop("llama")
        d.update({
            "llamadores": inv.get(n.id, []), "llama": n.llama,
            "revisada": e.get("revisada"), "revisiones": e.get("revisiones", 0),
            "al_dia": e.get("revisada_hash") == n.hash, "intervalo": e.get("intervalo"),
            "resumen": e.get("resumen", ""), "nacio": e.get("nacio"), "cambio": e.get("cambio"),
        })
        nodos.append(d)
        enlaces.append({"source": n.padre or n.archivo, "target": n.id, "tipo": "define"})
        for dest in n.llama:
            enlaces.append({"source": n.id, "target": dest, "tipo": "llama"})
        for lib in n.libs:
            enlaces.append({"source": n.id, "target": "lib:" + lib, "tipo": "usa"})
    mejoras = mem.d["mejoras"]
    revisadas = sum(1 for n in anat.neuronas.values() if reg.get(n.id, {}).get("revisada"))
    return {
        "id": mem.cfg["id"], "nombre": mem.cfg.get("nombre", mem.cfg["id"]), "tipo": mem.cfg["tipo"],
        "objetivo": mem.cfg.get("objetivo", ""), "modelo": mem.cfg["modelo"], "modo": mem.cfg["modo"],
        "generado": iso(), "nodos": nodos, "enlaces": enlaces, "mejoras": mejoras,
        "uso": mem.d["uso"], "bitacora": mem.d["bitacora"][-60:], "lecciones": mem.lecciones(),
        "lote": mem.d.get("lote"), "tokens_por_dia": mem.cfg["tokens_por_dia"],
        "cobertura": {"neuronas": len(anat.neuronas), "revisadas": revisadas},
        "agenda": [anat.neuronas[x].qual for x in mem.agenda(anat)[:8]],
    }


def escribir(cerebros: list[dict]) -> list[str]:
    SALIDA.mkdir(parents=True, exist_ok=True)
    rutas = []
    resumen = []
    for c in cerebros:
        ruta = SALIDA / f"{c['id']}.json"
        ruta.write_text(json.dumps(c, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        rutas.append(str(ruta.relative_to(RAIZ)))
        ms = c["mejoras"]
        resumen.append({
            "id": c["id"], "nombre": c["nombre"], "tipo": c["tipo"], "objetivo": c["objetivo"],
            "neuronas": c["cobertura"]["neuronas"], "revisadas": c["cobertura"]["revisadas"],
            "pendientes": sum(1 for m in ms if m["estado"] == "pendiente"),
            "aceptadas": sum(1 for m in ms if m["estado"] in ("aceptada", "aplicada")),
            "costo_usd": c["uso"]["total"].get("costo_usd", 0), "generado": c["generado"],
        })
    idx = SALIDA / "index.json"
    idx.write_text(json.dumps({"repo": repo(), "generado": iso(), "cerebros": resumen}, ensure_ascii=False, indent=1),
                   encoding="utf-8")
    rutas.append(str(idx.relative_to(RAIZ)))
    return rutas
