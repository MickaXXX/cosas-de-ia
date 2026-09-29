"""Cerebros que revisan y aprenden.

  python -m cerebro ciclo                  # escanea, reflejos, Claude (si hay API key) y exporta la web
  python -m cerebro ciclo --sin-ia         # solo lo gratis: escaneo + reflejos
  python -m cerebro estado                 # resumen en la terminal
  python -m cerebro decidir codigo-tesis m1a2b3c4 aceptada --nota "sí, vectorizar"
  python -m cerebro issue $GITHUB_EVENT_PATH   # aplica decisiones enviadas desde la web
  python -m cerebro contexto codigo-tesis  # prompt compacto de la próxima neurona (para usar sin API key)
  python -m cerebro registrar codigo-tesis "<id neurona>" resultado.json
  python -m cerebro nuevo mi-cerebro --rutas src --objetivo "..."
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from . import anatomia, corteza, reflejos, web
from .memoria import ESTADOS, Memoria, cargar_config, guardar_config

ADAPTADORES = {
    # tipo de cerebro -> función que devuelve su anatomía (neuronas + sinapsis)
    "codigo": lambda c: anatomia.escanear(c["rutas"], c["excluir"]),
}


def _cerebros(filtro: str | None) -> list[dict]:
    cs = [c for c in cargar_config()["cerebros"] if c.get("activo", True)]
    if filtro:
        cs = [c for c in cs if c["id"] == filtro]
        if not cs:
            sys.exit(f"No existe el cerebro '{filtro}'. Revisa cerebro/cerebros.json")
    return cs


def _preparar(c: dict) -> tuple[Memoria, anatomia.Anatomia]:
    mem = Memoria(c)
    anat = ADAPTADORES[c["tipo"]](c)
    mem.sincronizar(anat)
    hallazgos = {nid: reflejos.revisar(n) for nid, n in anat.neuronas.items()} if c["tipo"] == "codigo" else {}
    mem.aplicar_reflejos(anat, hallazgos)
    return mem, anat


def cmd_ciclo(a) -> None:
    exportados = []
    for c in _cerebros(a.cerebro):
        print(f"🧠 {c['id']}")
        mem, anat = _preparar(c)
        print(f"   {len(anat.neuronas)} neuronas en {len(anat.archivos)} archivos")
        if not a.sin_ia:
            r = corteza.pensar(mem, anat, a.modo)
            print(f"   corteza: {r['recogidas']} recogidas, {r['enviadas']} enviadas, {r['mejoras']} mejoras nuevas"
                  + (f" · {r['motivo']}" if r["motivo"] else ""))
        mem.guardar()
        exportados.append(web.exportar_cerebro(mem, anat))
    for r in web.escribir(exportados):
        print("   →", r)


def cmd_estado(a) -> None:
    for c in _cerebros(a.cerebro):
        mem, anat = _preparar(c)
        ms = mem.d["mejoras"]
        cuenta = {e: sum(1 for m in ms if m["estado"] == e) for e in ESTADOS}
        rev = sum(1 for n in anat.neuronas if mem.d["neuronas"].get(n, {}).get("revisada"))
        uso = mem.d["uso"]["total"]
        print(f"🧠 {c['id']} — {len(anat.neuronas)} neuronas, {rev} revisadas por Claude")
        print("   mejoras: " + ", ".join(f"{k} {v}" for k, v in cuenta.items() if v))
        print(f"   tokens: {uso.get('entrada', 0)} entrada, {uso.get('salida', 0)} salida, "
              f"{uso.get('cache', 0)} caché · US$ {uso.get('costo_usd', 0):.3f}")
        agenda = [anat.neuronas[x].qual for x in mem.agenda(anat)[:5]]
        print("   próximas: " + (", ".join(agenda) or "—"))
        top = sorted([m for m in ms if m["estado"] == "pendiente"],
                     key=lambda m: (-m["impacto"] / m["esfuerzo"], m["fecha"]))[:5]
        for m in top:
            print(f"   · [{m['id']}] {m['titulo']}  ({anat.neuronas[m['neurona']].qual if m['neurona'] in anat.neuronas else m['neurona']})")


def _exportar(c: dict, mem: Memoria, anat) -> None:
    todos = []
    for otro in _cerebros(None):
        if otro["id"] == c["id"]:
            todos.append(web.exportar_cerebro(mem, anat))
        else:
            m2, a2 = _preparar(otro)
            todos.append(web.exportar_cerebro(m2, a2))
    web.escribir(todos)


def cmd_decidir(a) -> None:
    c = _cerebros(a.cerebro)[0]
    mem, anat = _preparar(c)
    m = mem.cambiar_estado(a.mejora, a.estado, a.nota or "")
    mem.guardar()
    _exportar(c, mem, anat)
    print(f"✓ {m['id']} → {m['estado']}: {m['titulo']}")


def aplicar_decisiones(texto: str) -> list[str]:
    """Lee el bloque ```json que arma la web y aplica cada decisión. Devuelve un informe por línea."""
    bloque = re.search(r"```json\s*(\{.*?\})\s*```", texto or "", re.S)
    if not bloque:
        return ["No encontré el bloque ```json con decisiones."]
    data = json.loads(bloque.group(1))
    cid = str(data.get("cerebro", ""))
    c = next((x for x in cargar_config()["cerebros"] if x["id"] == cid), None)
    if c is None:
        return [f"Cerebro desconocido: {cid!r}"]
    mem, anat = _preparar({**c})
    informe = []
    for d in data.get("decisiones", [])[:200]:
        mid, estado, nota = str(d.get("id", "")), str(d.get("estado", "")), str(d.get("nota", ""))[:500]
        try:
            m = mem.cambiar_estado(mid, estado, nota)
            informe.append(f"✓ `{mid}` → **{estado}** · {m['titulo']}")
        except KeyError:
            informe.append(f"✗ `{mid}`: no existe en este cerebro")
        except ValueError as e:
            informe.append(f"✗ `{mid}`: {e}")
    mem.guardar()
    _exportar(c, mem, anat)
    return informe


def cmd_issue(a) -> None:
    evento = json.loads(Path(a.evento).read_text(encoding="utf-8"))
    informe = aplicar_decisiones(evento.get("issue", {}).get("body", ""))
    texto = "\n".join(informe)
    print(texto)
    if a.salida:
        Path(a.salida).write_text(texto + "\n", encoding="utf-8")


def cmd_contexto(a) -> None:
    c = _cerebros(a.cerebro)[0]
    mem, anat = _preparar(c)
    nid = a.neurona or next(iter(mem.agenda(anat)), None)
    if not nid:
        sys.exit("Nada que revisar: todas las neuronas están al día.")
    print(f"<!-- neurona: {nid} -->")
    print("### Instrucciones\n" + corteza.sistema(c))
    print("\nResponde SOLO con JSON con este esquema:\n" + json.dumps(corteza.ESQUEMA, ensure_ascii=False))
    print("\n### Neurona\n" + corteza.contexto(anat.neuronas[nid], anat, mem))
    mem.guardar()


def cmd_registrar(a) -> None:
    c = _cerebros(a.cerebro)[0]
    mem, anat = _preparar(c)
    data = json.loads(Path(a.archivo).read_text(encoding="utf-8"))
    n = corteza.incorporar(mem, anat, a.neurona, data, a.modelo)
    mem.guardar()
    _exportar(c, mem, anat)
    print(f"✓ {n} mejoras nuevas en {a.neurona}")


def cmd_nuevo(a) -> None:
    cfg = cargar_config()
    if any(c["id"] == a.id for c in cfg["cerebros"]):
        sys.exit(f"Ya existe '{a.id}'")
    cfg["cerebros"].append({"id": a.id, "nombre": a.nombre or a.id, "tipo": "codigo",
                            "rutas": a.rutas, "objetivo": a.objetivo or ""})
    guardar_config(cfg)
    print(f"✓ cerebro '{a.id}' creado. Corre: python -m cerebro ciclo --cerebro {a.id} --sin-ia")


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="cerebro", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("ciclo"); s.add_argument("--cerebro"); s.add_argument("--sin-ia", action="store_true")
    s.add_argument("--modo", choices=["lote", "directo"]); s.set_defaults(f=cmd_ciclo)
    s = sub.add_parser("estado"); s.add_argument("--cerebro"); s.set_defaults(f=cmd_estado)
    s = sub.add_parser("decidir"); s.add_argument("cerebro"); s.add_argument("mejora")
    s.add_argument("estado", choices=ESTADOS); s.add_argument("--nota"); s.set_defaults(f=cmd_decidir)
    s = sub.add_parser("issue"); s.add_argument("evento"); s.add_argument("--salida"); s.set_defaults(f=cmd_issue)
    s = sub.add_parser("contexto"); s.add_argument("cerebro"); s.add_argument("--neurona"); s.set_defaults(f=cmd_contexto)
    s = sub.add_parser("registrar"); s.add_argument("cerebro"); s.add_argument("neurona"); s.add_argument("archivo")
    s.add_argument("--modelo", default="claude-code"); s.set_defaults(f=cmd_registrar)
    s = sub.add_parser("nuevo"); s.add_argument("id"); s.add_argument("--rutas", nargs="+", required=True)
    s.add_argument("--nombre"); s.add_argument("--objetivo"); s.set_defaults(f=cmd_nuevo)
    a = p.parse_args(argv)
    a.f(a)


if __name__ == "__main__":
    main()
