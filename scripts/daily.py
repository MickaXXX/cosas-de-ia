#!/usr/bin/env python3
"""
Parte diario: qué hacer hoy con cada posición, y por qué cambió desde ayer.

El motor de decisión (decision.py) mira la tesis: fundamentales, valoración,
calidad, revisiones. Eso se mueve lento a propósito —tiene histéresis para no
proponer operaciones por ruido— y por eso de un día a otro parece que no pasa
nada. Pero una cartera sí cambia todos los días, y una semana mala de 9,85% se
siente aunque ninguna tesis se haya roto.

Este archivo es la capa rápida que faltaba. No reemplaza al motor de decisión:
lo complementa con lo que sí se mueve a diario.

  1. De dónde viene el resultado. Un chileno que invierte en dólares tiene dos
     apuestas encima: la acción y el tipo de cambio. Cuando la cartera baja en
     pesos, lo primero es saber cuánto fue cada una. Se descompone exacto:
         Δ(pesos) = efecto acciones + efecto dólar + el cruce de los dos.

  2. Un veredicto por posición que de verdad cambia. Se construye con señales
     rápidas —distancia al máximo de 20 días, posición contra sus medias, RSI,
     distancia al stop por ATR, resultado abierto, peso contra el objetivo— y
     cada veredicto nombra el gatillo que se activó. Si ningún gatillo se
     activó, el veredicto es "mantener" y lo dice con esas palabras.

  3. Venta parcial con recompra. Una posición estirada y sobreponderada no se
     vende entera: se recorta la parte que sobra y queda anotado a qué precio
     vuelve a tener sentido recomprarla. Es la única forma de "vender para
     comprar después" sin que sea una corazonada.

Nada de esto predice. Lo que hace es poner delante, todos los días, los datos
que uno miraría si tuviera tiempo de mirarlos.

Salida: docs/data/daily.json
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from desks import positions_of                                      # noqa: E402
from rebalance import coma, MAX_POS                                 # noqa: E402

# Gatillos. Cada uno es una regla explícita, no un puntaje escondido.
# Los umbrales son altos a propósito. Un parte diario con veinte acciones no es
# un parte: es ruido con fecha. Si todo el mercado cae 8%, que una posición caiga
# 8% no dice nada de ella, así que la rotura se mide CONTRA EL MERCADO.
CAIDA_FUERTE = -8.0        # % bajo el máximo de 20 días
PEOR_QUE_MERCADO = -5.0    # y además esto peor que el S&P en el mismo tramo
RSI_ESTIRADO = 72          # sobre esto, el movimiento ya está hecho
RSI_HUNDIDO = 32           # bajo esto, la caída ya fue
SOBRE_META = 4.0           # puntos porcentuales por encima del peso objetivo
BAJO_META = 4.0            # puntos por debajo
GANANCIA_RECORTE = 25.0    # % de ganancia abierta para considerar recortar
RECORTE_MAX = 0.40         # nunca se recorta más del 40% de una posición
MONTO_MINIMO = 40.0        # bajo esto la comisión se come el movimiento
MAX_ACCIONES = 5           # cuántas se muestran como "hoy"; el resto, a vigilar


def num(x, d=None):
    if isinstance(x, bool) or x is None:
        return d
    try:
        v = float(x)
    except (TypeError, ValueError):
        return d
    return d if v != v else v


def carga(nombre, default):
    try:
        with open(os.path.join(DATA, nombre), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def usd(v, dec=2):
    if v is None:
        return "—"
    return f"US${v:,.{dec}f}".replace(",", "@").replace(".", ",").replace("@", ".")


def clp(v):
    if v is None:
        return "—"
    return f"${v:,.0f}".replace(",", ".")


# ------------------------------------------------------- 1. de dónde viene todo
def descomponer(valor_hoy_usd, valor_antes_usd, fx_hoy, fx_antes):
    """Separa el cambio en pesos entre lo que hicieron las acciones y lo que
    hizo el dólar.

    V(pesos) = V(dólares) × tipo de cambio, así que el cambio total se abre en
    tres partes exactas: cuánto movieron las acciones al tipo de cambio viejo,
    cuánto movió el dólar sobre la cartera vieja, y el cruce de ambos. Las tres
    suman el total, sin residuo.
    """
    if None in (valor_hoy_usd, valor_antes_usd, fx_hoy, fx_antes):
        return None
    d_usd = valor_hoy_usd - valor_antes_usd
    d_fx = fx_hoy - fx_antes
    efecto_acciones = d_usd * fx_antes
    efecto_dolar = valor_antes_usd * d_fx
    cruce = d_usd * d_fx
    total = valor_hoy_usd * fx_hoy - valor_antes_usd * fx_antes
    return {
        "clp_hoy": round(valor_hoy_usd * fx_hoy),
        "clp_antes": round(valor_antes_usd * fx_antes),
        "total": round(total),
        "acciones": round(efecto_acciones),
        "dolar": round(efecto_dolar),
        "cruce": round(cruce),
        "usd_hoy": round(valor_hoy_usd, 2),
        "usd_antes": round(valor_antes_usd, 2),
        "usd_pct": round((valor_hoy_usd / valor_antes_usd - 1) * 100, 2) if valor_antes_usd else None,
        "fx_hoy": round(fx_hoy, 1),
        "fx_antes": round(fx_antes, 1),
        "fx_pct": round((fx_hoy / fx_antes - 1) * 100, 2) if fx_antes else None,
        "pct": round((total / (valor_antes_usd * fx_antes)) * 100, 2) if valor_antes_usd and fx_antes else None,
    }


def valor_en(history, qty, fecha):
    """Valor de la cartera de hoy a los precios de una fecha pasada.

    Se usan las cantidades actuales a propósito: la pregunta es cuánto se movió
    lo que uno tiene, no cuánto valía una cartera distinta. Si falta el precio
    de algún día se arrastra el último conocido, que es lo que hace el mercado
    un fin de semana."""
    total, faltan = 0.0, []
    for sym, q in qty.items():
        filas = [r for r in history.get(sym, []) if r.get("d") <= fecha and num(r.get("p"))]
        if not filas:
            faltan.append(sym)
            continue
        total += q * filas[-1]["p"]
    return (total if total > 0 else None), faltan


# ------------------------------------------------ 2. el veredicto de cada día
def maximo_recientes(history, sym, dias=20):
    filas = [r for r in history.get(sym, []) if num(r.get("p"))][-dias:]
    return max((r["p"] for r in filas), default=None)


def veredicto(p, t, meta, history, mercado_desde_max=0.0):
    """Qué hacer hoy con esta posición, y por qué.

    Los gatillos se evalúan en orden de gravedad: primero lo que obliga a
    reaccionar (rotura de precio), después lo que conviene aprovechar (recorte
    de una posición estirada), y al final los ajustes de tamaño. El primero que
    se activa manda, y queda nombrado.
    """
    sym = p["sym"]
    tc = (t or {}).get("tech") or {}
    precio = num((t or {}).get("price"))
    rsi = num(tc.get("rsi"))
    s20, s50 = num(tc.get("sma20")), num(tc.get("sma50"))
    atr = num(tc.get("atr_pct"))
    mx = maximo_recientes(history, sym)
    desde_max = ((precio / mx - 1) * 100) if (precio and mx) else None
    pnl = num(p.get("pnl_pct"))
    peso = p["peso"]
    gatillos = []

    # --- lo que obliga a reaccionar ----------------------------------------
    relativo = (desde_max - mercado_desde_max) if desde_max is not None else None
    if (desde_max is not None and desde_max <= CAIDA_FUERTE and relativo <= PEOR_QUE_MERCADO
            and s20 and precio < s20):
        gatillos.append(("VENDER PARCIAL", "rotura",
                         f"Cayó {coma(abs(desde_max))}% desde su máximo de 20 días —{coma(abs(relativo))} puntos "
                         f"peor que el mercado— y perdió su media de 20. No es el mercado: es ella.",
                         0.30))
    if (pnl is not None and pnl <= -25 and s50 and precio and precio < s50
            and (desde_max or 0) < -15 and (relativo or 0) <= PEOR_QUE_MERCADO):
        gatillos.append(("VENDER", "tesis",
                         f"Pierde {coma(abs(pnl))}%, está bajo su media de 50 días y {coma(abs(desde_max))}% "
                         f"bajo su máximo reciente. No es un mal día: es una tendencia.", 1.0))

    # --- lo que conviene aprovechar ----------------------------------------
    if pnl is not None and pnl >= GANANCIA_RECORTE and rsi is not None and rsi >= RSI_ESTIRADO:
        gatillos.append(("VENDER PARCIAL", "toma de ganancia",
                         f"Ganas {coma(pnl)}% y el RSI está en {int(rsi)}: el movimiento ya está hecho. "
                         f"Recortar parte asegura la ganancia y deja con qué volver a entrar.", 0.30))
    if peso - meta >= SOBRE_META and p["value"] * min(RECORTE_MAX, (peso - meta) / peso) >= MONTO_MINIMO:
        gatillos.append(("VENDER PARCIAL", "tamaño",
                         f"Pesa {coma(peso)}% y su lugar es {coma(meta)}%. Recortar la diferencia no cambia "
                         f"la tesis, cambia cuánto dependes de ella.", min(RECORTE_MAX, (peso - meta) / peso)))

    # --- lo que conviene sumar ---------------------------------------------
    if meta - peso >= BAJO_META and rsi is not None and rsi <= RSI_HUNDIDO:
        gatillos.append(("COMPRAR", "oportunidad",
                         f"Le corresponde {coma(meta)}% y pesa {coma(peso)}%, y con el RSI en {int(rsi)} "
                         f"está comprando barato dentro de su propio rango.", 0.0))
    elif meta - peso >= BAJO_META:
        gatillos.append(("AÑADIR", "tamaño",
                         f"Pesa {coma(peso)}% y le corresponde {coma(meta)}%.", 0.0))

    if not gatillos:
        razon = "Ningún gatillo activo hoy."
        if desde_max is not None:
            razon += f" Está {coma(abs(desde_max))}% bajo su máximo de 20 días"
            razon += f" y {'sobre' if (s20 and precio and precio >= s20) else 'bajo'} su media de 20."
        return {"accion": "MANTENER", "gatillo": None, "por_que": razon, "recorte": 0.0,
                "desde_max": round(desde_max, 1) if desde_max is not None else None,
                "rsi": int(rsi) if rsi is not None else None}

    orden = {"VENDER": 0, "VENDER PARCIAL": 1, "COMPRAR": 2, "AÑADIR": 3}
    accion, gat, txt, recorte = sorted(gatillos, key=lambda g: orden[g[0]])[0]
    out = {"accion": accion, "gatillo": gat, "por_que": txt, "recorte": round(recorte, 3),
           "desde_max": round(desde_max, 1) if desde_max is not None else None,
           "rsi": int(rsi) if rsi is not None else None}
    # Vender para comprar después solo es una decisión si queda dicho cuándo volver.
    if accion == "VENDER PARCIAL" and precio:
        # El nivel de recompra es el MÁS CERCANO de los dos candidatos, no el más
        # lejano: una recompra 20% abajo no es un plan, es no volver a entrar.
        candidatos = [precio * (1 - (atr or 3) * 1.5 / 100)]
        if s20 and s20 < precio:
            candidatos.append(s20)
        vuelta = max(candidatos)
        out["monto"] = round(p["value"] * recorte, 2)
        if vuelta / precio - 1 >= -0.15:
            out["recompra"] = round(vuelta, 2)
            out["recompra_pct"] = round((vuelta / precio - 1) * 100, 1)
        else:
            out["recompra"] = None
            out["recompra_nota"] = "Su media de 20 está muy abajo: espera a que se acerque antes de volver."
    return out


def main():
    latest = carga("latest.json", None)
    if not latest:
        print("Sin latest.json.")
        return
    tks = {t["sym"]: t for t in latest.get("tickers", [])}
    history = carga("history.json", {})
    book = carga("portfolios.json", {"list": []})
    dec = carga("decision.json", {})
    prev = carga("daily.json", {})

    pf = next((p for p in book.get("list", []) if p.get("tx")), None)
    if not pf:
        print("Sin cartera publicada.")
        return
    pos = [p for p in positions_of(pf.get("tx", []), tks) if (p.get("value") or 0) > 0]
    total = sum(p["value"] for p in pos)
    if total <= 0:
        print("La cartera no tiene valor de mercado.")
        return
    for p in pos:
        p["peso"] = p["value"] / total * 100
    pos.sort(key=lambda p: -p["value"])
    qty = {p["sym"]: p["qty"] for p in pos}

    # --- de dónde viene el resultado ---------------------------------------
    fx = (latest.get("market") or {}).get("CLP=X") or {}
    fx_hoy = num(fx.get("price"))
    spark = [x for x in (fx.get("spark") or []) if num(x)]
    fechas = sorted({r["d"] for s in qty for r in history.get(s, []) if num(r.get("p"))})
    hoy = fechas[-1] if fechas else None
    ventanas = {}
    # Fin de semana y feriados repiten el precio del viernes. Si se compara contra
    # una de esas fechas, "el día" da cero y no dice nada: se busca hacia atrás la
    # última en que la cartera realmente valía otra cosa.
    v_hoy_ref, _ = valor_en(history, qty, fechas[-1]) if fechas else (None, [])
    def fecha_util(atras):
        i = len(fechas) - 1 - atras
        while i > 0:
            v, _ = valor_en(history, qty, fechas[i])
            if v and v_hoy_ref and abs(v / v_hoy_ref - 1) > 1e-6:
                return fechas[i]
            i -= 1
        return fechas[max(0, len(fechas) - 1 - atras)]

    for etiqueta, atras in (("dia", 1), ("semana", 5), ("mes", 21)):
        if not hoy or len(fechas) <= atras:
            continue
        antes = fecha_util(atras)
        v_hoy, _ = valor_en(history, qty, hoy)
        v_antes, faltan = valor_en(history, qty, antes)
        # El tipo de cambio de esa fecha sale de la serie que publica el radar.
        idx = fechas.index(antes)
        pasos = len(fechas) - 1 - idx
        fx_antes = num(spark[-1 - pasos]) if len(spark) > pasos else fx_hoy
        d = descomponer(v_hoy, v_antes, fx_hoy, fx_antes)
        if d:
            d["desde"] = antes
            d["sin_precio"] = faltan[:4]
            ventanas[etiqueta] = d

    # --- el veredicto de cada posición -------------------------------------
    metas = {f["sym"]: f.get("meta") for f in (dec.get("posiciones") or []) if f.get("meta") is not None}
    estados = {f["sym"]: f.get("estado") for f in (dec.get("posiciones") or [])}
    antes_v = {f["sym"]: f.get("accion") for f in (prev.get("posiciones") or [])}

    # Cuánto cayó el propio mercado desde su máximo de 20 días: la vara contra la
    # que se mide si una posición se rompió o si simplemente la arrastró la marea.
    sp = (latest.get("market") or {}).get("^GSPC") or {}
    serie = [x for x in (sp.get("spark") or []) if num(x)][-20:]
    mercado_desde_max = ((serie[-1] / max(serie) - 1) * 100) if len(serie) >= 5 else 0.0

    filas = []
    for p in pos:
        t = tks.get(p["sym"])
        meta = metas.get(p["sym"], p["peso"])
        v = veredicto(p, t, meta, history, mercado_desde_max)
        v.update({"sym": p["sym"], "peso": round(p["peso"], 1), "meta": round(meta, 1),
                  "valor": round(p["value"], 2), "pnl_pct": round(p["pnl_pct"], 1) if p.get("pnl_pct") is not None else None,
                  "precio": num((t or {}).get("price")), "tesis": estados.get(p["sym"]),
                  "cambio": (antes_v.get(p["sym"]) != v["accion"] and antes_v.get(p["sym"])) or None})
        filas.append(v)

    peso_accion = {"VENDER": 0, "VENDER PARCIAL": 1, "COMPRAR": 2, "AÑADIR": 3, "VIGILAR": 4, "MANTENER": 5}
    filas.sort(key=lambda f: (peso_accion[f["accion"]], -(f.get("monto") or f["valor"])))
    # Solo las primeras son "para hoy". Las demás quedan anotadas, pero pedirle a
    # alguien veinte operaciones en un día es garantizar que no haga ninguna.
    # Un movimiento que no llega al mínimo no es una acción, es algo que vigilar:
    # la comisión se comería el ajuste y el consejo solo gastaría atención.
    for f in filas:
        if f["accion"] in ("VENDER PARCIAL", "VENDER") and (f.get("monto") or f["valor"]) < MONTO_MINIMO:
            f["accion"], f["gatillo"] = "VIGILAR", f.get("gatillo")
            f["por_que"] = f["por_que"] + f" Son {usd(f.get('monto') or f['valor'])}: muy poco para que valga la comisión."
    con_gatillo = [f for f in filas if f["accion"] not in ("MANTENER", "VIGILAR")]
    for i, f in enumerate(con_gatillo):
        f["hoy"] = i < MAX_ACCIONES
    cuenta = {}
    for f in filas:
        cuenta[f["accion"]] = cuenta.get(f["accion"], 0) + 1

    # --- el titular: qué pasó y qué hacer ----------------------------------
    titulares = []
    sem = ventanas.get("semana")
    if sem:
        if abs(sem["dolar"]) > abs(sem["acciones"]) * 0.5 and abs(sem["dolar"]) > 20000:
            quien = "el dólar" if abs(sem["dolar"]) > abs(sem["acciones"]) else "las acciones"
            titulares.append(
                f"En la semana la cartera {'bajó' if sem['total'] < 0 else 'subió'} {clp(abs(sem['total']))}: "
                f"{clp(abs(sem['acciones']))} por las acciones y {clp(abs(sem['dolar']))} por el dólar. "
                f"Mandó {quien}.")
        else:
            titulares.append(
                f"En la semana la cartera {'bajó' if sem['total'] < 0 else 'subió'} {clp(abs(sem['total']))}, "
                f"casi todo por las acciones ({clp(abs(sem['acciones']))}); el dólar aportó {clp(abs(sem['dolar']))}.")
    urgentes = [f for f in con_gatillo if f.get("hoy")]
    if urgentes:
        titulares.append(f"Para hoy: {', '.join(f['sym'] + ' (' + f['accion'].lower() + ')' for f in urgentes)}."
                         + (f" Quedan {len(con_gatillo) - len(urgentes)} con gatillo para después."
                            if len(con_gatillo) > len(urgentes) else ""))
    else:
        titulares.append("Ninguna posición tiene un gatillo activo hoy.")
    cambiaron = [f for f in filas if f["cambio"]]
    titulares.append(f"{len(cambiaron)} veredictos cambiaron desde ayer." if cambiaron
                     else "Ningún veredicto cambió desde ayer.")

    salida = {
        "date": latest.get("date"),
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "prev_date": prev.get("date"),
        "valor": round(total, 2),
        "fx": fx_hoy,
        "ventanas": ventanas,
        "titular": titulares,
        "posiciones": filas,
        "conteo": cuenta,
        "mercado_desde_max": round(mercado_desde_max, 1),
        "reglas": [
            f"Rotura: cae {coma(abs(CAIDA_FUERTE))}% o más desde su máximo de 20 días Y pierde la media de 20.",
            f"Toma de ganancia: gana {coma(GANANCIA_RECORTE)}% o más con el RSI sobre {RSI_ESTIRADO}.",
            f"Tamaño: pesa {coma(SOBRE_META)} puntos más (o menos) que el lugar que le da el motor de decisión.",
            f"Oportunidad: está bajo su peso objetivo Y el RSI bajo {RSI_HUNDIDO}.",
            f"Nunca se recorta más del {coma(RECORTE_MAX * 100, 0)}% de una posición de una vez.",
        ],
        "nota": ("Esto no predice nada: ordena los datos que uno miraría si tuviera tiempo. Un gatillo es una "
                 "regla que se cumplió, no un pronóstico. Las ventas parciales traen su nivel de recompra para "
                 "que vender no sea quedarse fuera, y cada movimiento paga comisión."),
    }
    with open(os.path.join(DATA, "daily.json"), "w", encoding="utf-8") as f:
        json.dump(salida, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Parte diario · {len(filas)} posiciones · {usd(total)} · dólar {fx_hoy}")
    for l in titulares:
        print("  ·", l)
    for et, d in ventanas.items():
        print(f"  {et:7}: {clp(d['total'])} = acciones {clp(d['acciones'])} + dólar {clp(d['dolar'])} "
              f"+ cruce {clp(d['cruce'])}  (USD {d['usd_pct']:+.2f}%, dólar {d['fx_pct']:+.2f}%)")
    print("  veredictos:", ", ".join(f"{k}={v}" for k, v in cuenta.items()))
    for f in filas:
        if f["accion"] != "MANTENER":
            extra = f" · recompra bajo {usd(f.get('recompra'))}" if f.get("recompra") else ""
            print(f"    {f['accion']:15} {f['sym']:5} {f.get('monto') and usd(f['monto']) or '':>10}{extra}")
    print(f"→ {os.path.join(DATA, 'daily.json')}")


if __name__ == "__main__":
    main()
