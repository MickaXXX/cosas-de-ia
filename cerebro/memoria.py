"""Memoria de un cerebro: qué neuronas conoce, qué revisó, qué mejoras propuso y
qué decidió el usuario sobre ellas. Vive en `cerebro/cerebros/<id>/memoria.json`
y se versiona en git, así que el historial completo queda en el repositorio.
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .anatomia import RAIZ, Anatomia

DIR = RAIZ / "cerebro"
CONFIG = DIR / "cerebros.json"
ESTADOS = ("pendiente", "aceptada", "rechazada", "aplicada", "obsoleta")
DEFAULTS = {
    "tipo": "codigo",
    "rutas": [],
    "excluir": [],
    "objetivo": "",
    "modelo": "claude-opus-5-5",
    "esfuerzo": "medium",
    "modo": "lote",               # lote (Batches API, -50 %) | directo
    "neuronas_por_ciclo": 2,
    "max_mejoras_por_neurona": 3,
    "tokens_por_dia": 120000,
    "revisar_cada_dias": 7,       # re-visitar una neurona sin cambios tras N días (se duplica si no aporta)
    "max_dias": 60,
    "min_lineas": 4,
}


def ahora() -> datetime:
    return datetime.now(timezone.utc)


def iso(d: datetime | None = None) -> str:
    return (d or ahora()).strftime("%Y-%m-%dT%H:%M:%SZ")


def de_iso(s: str | None) -> datetime | None:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) if s else None


def cargar_config() -> dict:
    data = json.loads(CONFIG.read_text(encoding="utf-8"))
    for c in data["cerebros"]:
        for k, v in DEFAULTS.items():
            c.setdefault(k, v)
    return data


def guardar_config(data: dict) -> None:
    CONFIG.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalizar(t: str) -> str:
    t = unicodedata.normalize("NFKD", t.lower()).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


class Memoria:
    def __init__(self, cerebro: dict):
        self.cfg = cerebro
        self.ruta = DIR / "cerebros" / cerebro["id"] / "memoria.json"
        if self.ruta.exists():
            self.d = json.loads(self.ruta.read_text(encoding="utf-8"))
        else:
            self.d = {"version": 1, "id": cerebro["id"], "creado": iso(), "neuronas": {}, "mejoras": [],
                      "lote": None, "uso": {"total": {}, "dias": {}}, "bitacora": []}

    # ------------------------------------------------------------------ persistencia
    def guardar(self) -> None:
        self.d["actualizado"] = iso()
        self.d["bitacora"] = self.d["bitacora"][-300:]
        dias = self.d["uso"]["dias"]
        for k in sorted(dias)[:-90]:
            del dias[k]
        self.ruta.parent.mkdir(parents=True, exist_ok=True)
        self.ruta.write_text(json.dumps(self.d, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    def anotar(self, evento: str, detalle: str = "") -> None:
        self.d["bitacora"].append({"fecha": iso(), "evento": evento, "detalle": detalle[:300]})

    # ------------------------------------------------------------------ neuronas
    def sincronizar(self, anat: Anatomia) -> dict:
        """Actualiza el registro de neuronas con la anatomía recién escaneada."""
        reg = self.d["neuronas"]
        nuevas, cambiadas, perdidas = [], [], []
        for n in anat.neuronas.values():
            e = reg.get(n.id)
            if e is None:
                reg[n.id] = {"hash": n.hash, "nacio": iso(), "revisiones": 0, "intervalo": self.cfg["revisar_cada_dias"]}
                nuevas.append(n.id)
            elif e["hash"] != n.hash:
                e["hash"], e["cambio"] = n.hash, iso()
                e.pop("perdida", None)
                cambiadas.append(n.id)
            elif e.pop("perdida", None):
                cambiadas.append(n.id)
        for nid, e in reg.items():
            if nid not in anat.neuronas and not e.get("perdida"):
                e["perdida"] = iso()
                perdidas.append(nid)
        for m in self.d["mejoras"]:
            if m["neurona"] in perdidas and m["estado"] == "pendiente":
                m["estado"], m["nota_sistema"] = "obsoleta", "la función ya no existe (¿renombrada o borrada?)"
            elif m["neurona"] in cambiadas and m["estado"] in ("pendiente", "aceptada") and m.get("origen") != "reflejo":
                m["codigo_cambio"] = True
        if nuevas or cambiadas or perdidas:
            self.anotar("escaneo", f"{len(nuevas)} nuevas, {len(cambiadas)} cambiadas, {len(perdidas)} desaparecidas")
        return {"nuevas": nuevas, "cambiadas": cambiadas, "perdidas": perdidas}

    # ------------------------------------------------------------------ mejoras
    def mejoras_de(self, nid: str) -> list[dict]:
        return [m for m in self.d["mejoras"] if m["neurona"] == nid]

    def _id_mejora(self, nid: str, clave: str) -> str:
        return "m" + hashlib.sha1(f"{nid}|{clave}".encode()).hexdigest()[:8]

    def agregar(self, nid: str, m: dict, origen: str, hash_codigo: str, extra: dict | None = None) -> dict | None:
        clave = m.get("regla") or normalizar(m["titulo"])
        mid = self._id_mejora(nid, clave)
        existentes = {x["id"]: x for x in self.d["mejoras"]}
        if mid in existentes:
            return None
        # evitar duplicados casi idénticos de Claude sobre la misma neurona
        tnorm = set(normalizar(m["titulo"]).split())
        for x in self.mejoras_de(nid):
            otros = set(normalizar(x["titulo"]).split())
            if tnorm and otros and len(tnorm & otros) / len(tnorm | otros) > 0.8:
                return None
        nueva = {
            "id": mid, "neurona": nid, "fecha": iso(), "origen": origen, "estado": "pendiente",
            "titulo": m["titulo"][:120], "categoria": m.get("categoria", "diseno"),
            "severidad": m.get("severidad", "media"), "impacto": int(m.get("impacto", 3)),
            "esfuerzo": int(m.get("esfuerzo", 3)), "porque": m.get("porque", "")[:900],
            "propuesta": m.get("propuesta", "")[:3000], "confianza": round(float(m.get("confianza", 0.7)), 2),
            "hash_codigo": hash_codigo,
        }
        if m.get("regla"):
            nueva["regla"] = m["regla"]
        nueva.update(extra or {})
        nueva["historial"] = [{"fecha": nueva["fecha"], "estado": "pendiente", "por": origen}]
        self.d["mejoras"].append(nueva)
        return nueva

    def cambiar_estado(self, mid: str, estado: str, nota: str = "", por: str = "usuario") -> dict:
        if estado not in ESTADOS:
            raise ValueError(f"estado inválido: {estado}")
        m = next((x for x in self.d["mejoras"] if x["id"] == mid), None)
        if m is None:
            raise KeyError(mid)
        if m["estado"] == estado and not nota:
            return m
        m["estado"] = estado
        if nota:
            m["nota"] = nota[:500]
        if por == "usuario":
            m["decidida"] = iso()
        m.setdefault("historial", []).append({"fecha": iso(), "estado": estado, "por": por, **({"nota": nota[:200]} if nota else {})})
        self.anotar(f"mejora {estado}", f"{m['titulo']} ({por})")
        return m

    def aplicar_reflejos(self, anat: Anatomia, hallazgos: dict[str, list[dict]]) -> int:
        nuevos = 0
        for nid, lista in hallazgos.items():
            h = anat.neuronas[nid].hash
            activas = set()
            for m in lista:
                activas.add(m["regla"])
                if self.agregar(nid, m, "reflejo", h):
                    nuevos += 1
            # Reflejos que dejaron de dispararse: el código ya se corrigió.
            for m in self.mejoras_de(nid):
                if m.get("regla") and m["regla"] not in activas and m["estado"] in ("pendiente", "aceptada"):
                    self.cambiar_estado(m["id"], "aplicada", "el patrón ya no aparece en el código", por="reflejo")
        if nuevos:
            self.anotar("reflejos", f"{nuevos} hallazgos estáticos nuevos")
        return nuevos

    # ------------------------------------------------------------------ aprendizaje
    def lecciones(self) -> dict:
        """Lo que el cerebro aprendió de las decisiones del usuario (se envía compacto a Claude)."""
        decididas = [m for m in self.d["mejoras"] if m.get("decidida")]
        por_cat: dict[str, list[int]] = {}
        for m in decididas:
            ok = m["estado"] in ("aceptada", "aplicada")
            por_cat.setdefault(m["categoria"], [0, 0])[0 if ok else 1] += 1
        valora = sorted([c for c, (a, r) in por_cat.items() if a >= 2 and a > r], key=lambda c: -por_cat[c][0])
        evita = sorted([c for c, (a, r) in por_cat.items() if r >= 2 and r > a], key=lambda c: -por_cat[c][1])
        rechazos = [f"«{m['titulo']}»" + (f" — {m['nota']}" if m.get("nota") else "")
                    for m in sorted(decididas, key=lambda m: m["decidida"]) if m["estado"] == "rechazada"][-5:]
        aceptadas = [m["titulo"] for m in sorted(decididas, key=lambda m: m["decidida"])
                     if m["estado"] in ("aceptada", "aplicada")][-3:]
        return {"por_categoria": por_cat, "valora": valora, "evita": evita, "rechazos": rechazos,
                "aceptadas": aceptadas, "decididas": len(decididas)}

    def lecciones_texto(self) -> str:
        l = self.lecciones()
        partes = []
        if l["valora"]:
            partes.append("Valora: " + ", ".join(f"{c} ({l['por_categoria'][c][0]}✓)" for c in l["valora"]))
        if l["evita"]:
            partes.append("Suele rechazar: " + ", ".join(f"{c} ({l['por_categoria'][c][1]}✗)" for c in l["evita"]))
        if l["rechazos"]:
            partes.append("Rechazó: " + "; ".join(l["rechazos"]))
        if l["aceptadas"]:
            partes.append("Aceptó: " + "; ".join(l["aceptadas"]))
        return "\n".join(partes)[:900]

    # ------------------------------------------------------------------ agenda
    def agenda(self, anat: Anatomia) -> list[str]:
        """Neuronas que conviene revisar ahora, de la más a la menos valiosa."""
        reg, hoy = self.d["neuronas"], ahora()
        inv = anat.llamadores()
        en_lote = set((self.d.get("lote") or {}).get("neuronas", {}).values())
        cand = []
        for nid, n in anat.neuronas.items():
            e = reg.get(nid, {})
            if nid in en_lote or n.lineas < self.cfg["min_lineas"]:
                continue
            nunca = not e.get("revisada")
            cambio = e.get("revisada_hash") not in (None, n.hash)
            vencida = e.get("revisada") and de_iso(e["revisada"]) + timedelta(days=e.get("intervalo", 7)) <= hoy
            if not (nunca or cambio or vencida):
                continue
            conexiones = len(n.llama) + len(inv.get(nid, []))
            pendientes = sum(1 for m in self.mejoras_de(nid) if m["estado"] == "pendiente")
            valor = conexiones * 2 + n.complejidad * 1.5 + n.lineas / 8 - pendientes
            prioridad = 0 if cambio else (1 if nunca else 2)
            cand.append((prioridad, -valor, nid))
        return [nid for *_, nid in sorted(cand)]

    def marcar_revisada(self, nid: str, hash_: str, aporto: int) -> None:
        e = self.d["neuronas"].setdefault(nid, {"revisiones": 0})
        e["revisada"], e["revisada_hash"] = iso(), hash_
        e["revisiones"] = e.get("revisiones", 0) + 1
        base, tope = self.cfg["revisar_cada_dias"], self.cfg["max_dias"]
        # Si la revisión no aportó nada, se espacia la próxima: la neurona está "madura".
        e["intervalo"] = base if aporto else min(tope, max(base, e.get("intervalo", base)) * 2)
        e["sin_novedad"] = 0 if aporto else e.get("sin_novedad", 0) + 1

    # ------------------------------------------------------------------ uso de tokens
    def uso_hoy(self) -> int:
        d = self.d["uso"]["dias"].get(ahora().strftime("%Y-%m-%d"), {})
        return d.get("entrada", 0) + d.get("salida", 0) + d.get("reservado", 0)

    def sumar_uso(self, entrada: int, salida: int, cache: int, costo: float, reservado: int = 0) -> None:
        dia = ahora().strftime("%Y-%m-%d")
        for bolsa in (self.d["uso"]["total"], self.d["uso"]["dias"].setdefault(dia, {})):
            bolsa["entrada"] = bolsa.get("entrada", 0) + entrada
            bolsa["salida"] = bolsa.get("salida", 0) + salida
            bolsa["cache"] = bolsa.get("cache", 0) + cache
            bolsa["costo_usd"] = round(bolsa.get("costo_usd", 0) + costo, 4)
            bolsa["llamadas"] = bolsa.get("llamadas", 0) + (1 if entrada else 0)
        if reservado:
            d = self.d["uso"]["dias"][dia]
            d["reservado"] = max(0, d.get("reservado", 0) + reservado)
