"""Corteza: la parte del cerebro que piensa con Claude.

Cómo ahorra tokens (en orden de impacto):
  1. Solo revisa lo que vale la pena: neuronas nuevas o cuyo código cambió (la huella
     ignora comentarios y espacios). Las que ya se revisaron vuelven a la agenda tras
     N días, y si una revisión no aportó nada, ese plazo se duplica.
  2. Contexto mínimo: el código de UNA función + una línea por cada vecina (firma),
     nunca el archivo completo.
  3. Los reflejos estáticos (gratis) se le pasan como "ya detectado" para que Claude
     no gaste salida repitiéndolos, igual que los títulos de mejoras previas.
  4. Modo lote (Batches API): 50 % más barato. Se envía en un ciclo y se recoge en el
     siguiente, lo que calza con la revisión horaria.
  5. Salida estructurada, corta y con tope de mejoras por neurona.
  6. Presupuesto diario de tokens por cerebro: si se agota, el ciclo solo corre reflejos.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import timedelta

from .anatomia import Anatomia, Neurona
from .memoria import Memoria, ahora, de_iso, iso

# USD por millón de tokens (entrada, salida). Lote = 50 %.
PRECIOS = {
    "claude-fable-5-1": (10, 50), "claude-opus-5-5": (4, 20), "claude-opus-5": (5, 25),
    "claude-sonnet-5-5": (2, 10), "claude-sonnet-5": (2, 10), "claude-haiku-4-5": (1, 5),
}
CON_FALLBACK = {"claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}
CATEGORIAS = ["rendimiento", "correccion", "robustez", "diseno", "legibilidad", "reproducibilidad", "pruebas"]

ESQUEMA = {
    "type": "object",
    "properties": {
        "mejoras": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "titulo": {"type": "string"},
                    "categoria": {"type": "string", "enum": CATEGORIAS},
                    "severidad": {"type": "string", "enum": ["alta", "media", "baja"]},
                    "impacto": {"type": "integer"},
                    "esfuerzo": {"type": "integer"},
                    "porque": {"type": "string"},
                    "propuesta": {"type": "string"},
                    "confianza": {"type": "number"},
                },
                "required": ["titulo", "categoria", "severidad", "impacto", "esfuerzo", "porque", "propuesta", "confianza"],
                "additionalProperties": False,
            },
        },
        "resueltas": {"type": "array", "items": {"type": "string"}},
        "resumen": {"type": "string"},
    },
    "required": ["mejoras", "resueltas", "resumen"],
    "additionalProperties": False,
}


def sistema(cfg: dict) -> str:
    """Prompt de sistema fijo por cerebro (estable byte a byte => cacheable)."""
    return (
        "Eres un revisor senior de código Python y trabajas como la corteza de un 'cerebro' que revisa un "
        "proyecto neurona por neurona (cada neurona es una función). Recibes UNA neurona con contexto mínimo.\n"
        f"Objetivo del proyecto: {cfg.get('objetivo') or 'código mantenible, correcto y eficiente'}\n\n"
        "Tu trabajo:\n"
        f"- Propón como máximo {cfg['max_mejoras_por_neurona']} mejoras de implementación concretas, las de mayor "
        "valor (impacto alto, esfuerzo bajo). Menos y mejores: si no hay nada que valga la pena, devuelve la lista vacía.\n"
        "- No repitas lo que aparece en 'Ya detectado' ni en 'Mejoras previas'.\n"
        "- Prioriza errores de lógica o de cálculo, resultados incorrectos, rendimiento real y reproducibilidad "
        "por sobre estilo.\n"
        "- Respeta las 'Lecciones del usuario': son sus preferencias aprendidas de decisiones anteriores.\n"
        "- En 'resueltas' devuelve los ids de mejoras previas que el código actual ya resolvió.\n\n"
        "Formato de cada mejora, en español y sin relleno:\n"
        "- titulo: máx 80 caracteres, qué cambiar.\n"
        "- porque: máx 280 caracteres, el problema concreto y su efecto.\n"
        "- propuesta: el cambio listo para pegar, solo las líneas que cambian (máx 20 líneas de código).\n"
        "- impacto y esfuerzo: enteros de 1 a 5. confianza: 0 a 1.\n"
        "- resumen: una frase sobre la salud de la neurona (máx 140 caracteres)."
    )


def codigo_compacto(n: Neurona, anat: Anatomia, min_lineas: int = 4) -> str:
    """Código de la neurona con el cuerpo de sus funciones hijas colapsado: cada hija es su
    propia neurona y se revisa aparte, así que mandarla dos veces sería pagar doble.
    Las hijas demasiado cortas para revisarse solas se dejan completas."""
    if n.tipo == "script":
        return n.codigo
    lineas = n.codigo.split("\n")
    for h in anat.neuronas.values():
        if h.padre != n.id or h.lineas < max(3, min_lineas):
            continue
        a, b = h.linea - n.linea, h.fin - n.linea          # índices dentro de n.codigo
        cab = next((i for i in range(a, b + 1) if lineas[i].rstrip().endswith(":")), a)
        sangria = " " * (len(lineas[cab + 1]) - len(lineas[cab + 1].lstrip())) if cab + 1 <= b else "    "
        lineas[cab + 1:b + 1] = [f"{sangria}...  # neurona aparte: {h.qual}"] + [None] * (b - cab - 1)
    return "\n".join(x for x in lineas if x is not None)


def contexto(n: Neurona, anat: Anatomia, mem: Memoria) -> str:
    """Mensaje de usuario compacto para una neurona."""
    inv = anat.llamadores().get(n.id, [])
    vecina = lambda i: anat.neuronas[i].firma if i in anat.neuronas else i.split("::")[-1]
    reflejos = [m for m in mem.mejoras_de(n.id) if m["origen"] == "reflejo" and m["estado"] != "obsoleta"]
    previas = [m for m in mem.mejoras_de(n.id) if m["origen"] != "reflejo" and m["estado"] in ("pendiente", "aceptada", "rechazada")]
    partes = [
        f"Neurona: {n.qual}  ({n.archivo}:{n.linea}-{n.fin}, {n.lineas} líneas, complejidad {n.complejidad})",
        f"Usa librerías: {', '.join(n.libs) or '—'}",
        "Llama a: " + ("; ".join(vecina(i) for i in n.llama) or "—"),
        "La llaman: " + ("; ".join(vecina(i) for i in inv) or "—"),
    ]
    if reflejos:
        partes.append("Ya detectado (no repetir): " + "; ".join(m["titulo"] for m in reflejos))
    if previas:
        partes.append("Mejoras previas (id · estado · título):\n" + "\n".join(
            f"  {m['id']} · {m['estado']} · {m['titulo']}" for m in previas[-8:]))
    lecc = mem.lecciones_texto()
    if lecc:
        partes.append("Lecciones del usuario:\n" + lecc)
    partes.append("Código:\n```python\n" + codigo_compacto(n, anat, mem.cfg["min_lineas"]) + "\n```")
    return "\n".join(partes)


def _params(cfg: dict, n: Neurona, anat: Anatomia, mem: Memoria) -> dict:
    return {
        "model": cfg["modelo"],
        "max_tokens": 8000,
        "system": [{"type": "text", "text": sistema(cfg), "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": contexto(n, anat, mem)}],
        "output_config": {"format": {"type": "json_schema", "schema": ESQUEMA}, "effort": cfg["esfuerzo"]},
    }


def estimar_tokens(p: dict) -> int:
    chars = len(p["system"][0]["text"]) + len(p["messages"][0]["content"])
    return int(chars / 3.2) + 1500   # entrada aprox. + salida típica


def costo(modelo: str, entrada: int, salida: int, cache: int, lote: bool) -> float:
    pin, pout = PRECIOS.get(modelo, (5, 25))
    f = 0.5 if lote else 1.0
    return f * (entrada * pin + cache * pin * 0.1 + salida * pout) / 1e6


def _procesar(mem: Memoria, anat: Anatomia, nid: str, msg, lote: bool) -> int:
    """Guarda el resultado de Claude para una neurona. Devuelve cuántas mejoras nuevas agregó."""
    u = msg.usage
    entrada = (u.input_tokens or 0) + (getattr(u, "cache_creation_input_tokens", 0) or 0)
    cache = getattr(u, "cache_read_input_tokens", 0) or 0
    mem.sumar_uso(entrada, u.output_tokens or 0, cache,
                  costo(mem.cfg["modelo"], entrada, u.output_tokens or 0, cache, lote))
    if msg.stop_reason == "refusal":
        mem.anotar("rehusó", nid)
        return 0
    texto = next((b.text for b in msg.content if b.type == "text"), "")
    try:
        data = json.loads(texto)
    except json.JSONDecodeError:
        mem.anotar("respuesta ilegible", f"{nid} ({msg.stop_reason})")
        return 0
    return incorporar(mem, anat, nid, data, msg.model)


def incorporar(mem: Memoria, anat: Anatomia, nid: str, data: dict, modelo: str) -> int:
    """Guarda una revisión (venga de la API o de una sesión de Claude Code) en la memoria."""
    n = anat.neuronas.get(nid)
    if n is None:
        return 0
    nuevas = 0
    for m in data.get("mejoras", [])[: mem.cfg["max_mejoras_por_neurona"]]:
        m["impacto"] = max(1, min(5, int(m.get("impacto", 3))))
        m["esfuerzo"] = max(1, min(5, int(m.get("esfuerzo", 3))))
        if mem.agregar(nid, m, "claude", n.hash, {"modelo": modelo}):
            nuevas += 1
    for mid in data.get("resueltas", []):
        previa = next((x for x in mem.mejoras_de(nid) if x["id"] == mid), None)
        if previa and previa["estado"] in ("pendiente", "aceptada"):
            mem.cambiar_estado(mid, "aplicada", "Claude verificó que el código ya lo resuelve", por="claude")
    for m in mem.mejoras_de(nid):
        m.pop("codigo_cambio", None)
    e = mem.d["neuronas"].setdefault(nid, {})
    if data.get("resumen"):
        e["resumen"] = data["resumen"][:200]
    mem.marcar_revisada(nid, n.hash, nuevas)
    mem.anotar("revisión", f"{n.qual}: {nuevas} mejoras nuevas")
    return nuevas


def _cliente():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
    except ImportError:
        print("  ! falta el paquete anthropic (pip install anthropic)", file=sys.stderr)
        return None
    return anthropic.Anthropic()


def pensar(mem: Memoria, anat: Anatomia, modo: str | None = None) -> dict:
    """Un ciclo de la corteza: recoge el lote anterior (si hay) y manda a revisar las siguientes neuronas."""
    cfg = mem.cfg
    modo = modo or cfg["modo"]
    res = {"recogidas": 0, "enviadas": 0, "mejoras": 0, "motivo": ""}
    cli = _cliente()
    if cli is None:
        res["motivo"] = "sin ANTHROPIC_API_KEY: solo reflejos"
        return res

    # 1. recoger el lote pendiente
    lote = mem.d.get("lote")
    if lote:
        try:
            b = cli.messages.batches.retrieve(lote["id"])
        except Exception as e:  # red o id vencido
            print(f"  ! no se pudo consultar el lote {lote['id']}: {e}", file=sys.stderr)
            b = None
        if b is not None and b.processing_status == "ended":
            for r in cli.messages.batches.results(lote["id"]):
                nid = lote["neuronas"].get(r.custom_id)
                if nid and r.result.type == "succeeded":
                    res["mejoras"] += _procesar(mem, anat, nid, r.result.message, lote=True)
                    res["recogidas"] += 1
                elif nid:
                    mem.anotar("lote sin resultado", f"{nid}: {r.result.type}")
            mem.sumar_uso(0, 0, 0, 0.0, reservado=-lote.get("reservado", 0))
            mem.d["lote"] = None
        elif b is None or ahora() - de_iso(lote["enviado"]) > timedelta(hours=26):
            mem.anotar("lote descartado", lote["id"])
            mem.sumar_uso(0, 0, 0, 0.0, reservado=-lote.get("reservado", 0))
            mem.d["lote"] = None
        else:
            res["motivo"] = "esperando el lote anterior"
            return res

    # 2. elegir neuronas dentro del presupuesto
    elegidas, reservado = [], 0
    for nid in mem.agenda(anat):
        if len(elegidas) >= cfg["neuronas_por_ciclo"]:
            break
        p = _params(cfg, anat.neuronas[nid], anat, mem)
        est = estimar_tokens(p)
        if mem.uso_hoy() + reservado + est > cfg["tokens_por_dia"]:
            res["motivo"] = "presupuesto diario de tokens agotado"
            break
        elegidas.append((nid, p))
        reservado += est
    if not elegidas:
        res["motivo"] = res["motivo"] or "nada que revisar: todas las neuronas están al día"
        return res

    # 3a. lote: se envía ahora y se recoge en el próximo ciclo
    if modo == "lote":
        from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
        from anthropic.types.messages.batch_create_params import Request
        mapa = {f"n{i}": nid for i, (nid, _) in enumerate(elegidas)}
        b = cli.messages.batches.create(requests=[
            Request(custom_id=f"n{i}", params=MessageCreateParamsNonStreaming(**p)) for i, (_, p) in enumerate(elegidas)])
        mem.d["lote"] = {"id": b.id, "enviado": iso(), "neuronas": mapa, "reservado": reservado}
        mem.sumar_uso(0, 0, 0, 0.0, reservado=reservado)
        mem.anotar("lote enviado", f"{b.id}: " + ", ".join(anat.neuronas[n].qual for n in mapa.values()))
        res["enviadas"] = len(elegidas)
        return res

    # 3b. directo: respuesta inmediata (precio normal)
    for nid, p in elegidas:
        try:
            if cfg["modelo"] in CON_FALLBACK:
                msg = cli.beta.messages.create(**p, betas=["server-side-fallback-2026-07-01"], fallbacks="default")
            else:
                msg = cli.messages.create(**p)
        except Exception as e:
            mem.anotar("error", f"{nid}: {str(e)[:200]}")
            print(f"  ! {nid}: {e}", file=sys.stderr)
            continue
        res["mejoras"] += _procesar(mem, anat, nid, msg, lote=False)
        res["enviadas"] += 1
    return res
