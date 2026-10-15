#!/usr/bin/env python3
"""
Parte diario: qué hacer hoy con cada posición, y por qué.

POR QUÉ SE REESCRIBIÓ ESTO
La primera versión decidía con el precio y nada más: si una acción caía 8% bajo
su máximo de 20 días y perdía su media, decía "vender parcial". Eso está mal, y
se puede demostrar con los datos de esta misma cartera:

  · Ese gatillo se activaba en el 50% de los días. Un aviso que suena la mitad
    del tiempo no es un aviso.
  · Después de que se activaba, la acción rendía +0,01% a 5 días. Cualquier día
    al azar rendía −0,69%. O sea: no anticipaba nada. Vender ahí era botar una
    moneda al aire, y encima pagando comisión.

Lo que SÍ separa a las que suben de las que bajan, medido sobre los 899 activos
del radar (11.664 observaciones, horizonte 5 días hábiles):

  cae ≥8% del máximo Y la empresa es de calidad alta  →  +0,65%, sube el 56%
  cae ≥8% del máximo Y la empresa es de calidad baja  →  −1,79%, sube el 33%

Misma caída. Dos destinos distintos. Lo que los separa no es el precio: es la
empresa. Por eso ahora cada posición se lee en DOS EJES:

  1. LA EMPRESA (tesis). Márgenes, rentabilidad sobre patrimonio, deuda,
     liquidez, revisiones de utilidades. Se eligió esto y no la valoración
     porque la valoración se midió y casi no discrimina (+0,17% vs −0,47%):
     el múltiplo "barato" de hoy es casi siempre el reflejo de la caída de ayer.
  2. EL MOMENTO (precio). Dónde está dentro de su propio rango: sobrevendida,
     corrigiendo, neutral, fuerte o estirada.

El cruce de los dos ejes manda. Una buena empresa que cayó no se vende: esa es
justamente la que rebota. Una mala empresa se vende, haya caído o no —y si no
ha caído, mejor, se vende más arriba.

QUÉ SIGNIFICA "PROYECCIÓN" ACÁ
No es un pronóstico y no se inventa ningún número. Para cada posición se busca
en qué casilla cae (empresa × momento) y se informa qué pasó históricamente con
las posiciones que estuvieron en esa misma casilla: cuántos casos, qué rindieron
en promedio, cuántas veces subieron y cuánto subieron contra cuánto bajaron.
Es una tasa base, con su tamaño de muestra a la vista. Si la muestra es chica,
lo dice y baja la confianza.

LÍMITES, DICHOS DE FRENTE
  · Los fundamentales son los de hoy aplicados a fechas pasadas. Se revisó el
    sesgo que eso introduce: el efecto es MÁS fuerte en la ventana reciente
    (donde el sesgo es mínimo) que en la antigua, que es lo contrario de lo que
    pasaría si el sesgo lo estuviera creando. Aun así, está ahí.
  · 130 días de historial y un solo régimen de mercado. No es una ley.
  · El marcador de abajo lleva la cuenta real de cómo le fue a cada veredicto
    pasado. Esa es la única prueba que no se puede discutir, y se va llenando
    sola con los días.

También separa de dónde vino el resultado en pesos: un chileno que invierte en
dólares tiene dos apuestas encima, y
    Δ(pesos) = efecto acciones + efecto dólar + el cruce de los dos.

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

from desks import positions_of                                          # noqa: E402
from rebalance import coma, conviccion, objetivo, agrupar, correlacion, retornos  # noqa: E402
from decision import c_calidad, c_earnings, c_flujos, c_valoracion, vetos, promedio  # noqa: E402

# --- los dos ejes -----------------------------------------------------------
# La tesis pesa la calidad por encima de todo porque es lo que se midió y
# discrimina. La valoración entra con poco peso justamente porque se midió y
# casi no discrimina: dejarla fuera sería esconder un dato, dejarla mandar
# sería ignorar la medición.
PESO_TESIS = {"calidad": 55, "earnings": 20, "flujos": 15, "valoracion": 10}
TESIS_ALTA = 65
TESIS_BAJA = 45

RSI_HUNDIDO = 32           # bajo esto el eje momento dice "sobrevendida"
RSI_ESTIRADO = 72          # sobre esto, "estirada"
CAIDA_20D = -8.0           # % bajo el máximo de 20 días para "corrigiendo"
CERCA_MAX = -4.0           # sobre esto y con las medias a favor, "fuerte"
REVERSION_20D = -12.0      # % en 20 días que también cuenta como sobrevendida

SOBRE_META = 4.0           # puntos porcentuales sobre el peso objetivo
BAJO_META = 4.0
RECORTE_MAX = 0.40         # nunca se recorta más del 40% de una vez
MONTO_MINIMO = 40.0        # bajo esto la comisión se come el movimiento
MAX_ACCIONES = 5           # cuántas se muestran como "hoy"
HORIZONTE = 5              # días hábiles del que se miden las tasas base
MUESTRA_MINIMA = 80        # bajo esto una casilla no se usa para proyectar
SEGUIMIENTO_MAX = 600      # veredictos que se guardan para el marcador


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


def pct(v, dec=2):
    """Un retorno siempre con su signo: "+0,28%" se lee distinto a "0,28%"."""
    if v is None:
        return "—"
    return ("+" if v > 0 else "") + coma(v, dec) + "%"


def clp(v):
    if v is None:
        return "—"
    return f"${v:,.0f}".replace(",", ".")


# ------------------------------------------------------- 1. de dónde viene todo
def descomponer(valor_hoy_usd, valor_antes_usd, fx_hoy, fx_antes):
    """Separa el cambio en pesos entre lo que hicieron las acciones y lo que
    hizo el dólar. Las tres partes suman el total, sin residuo."""
    if None in (valor_hoy_usd, valor_antes_usd, fx_hoy, fx_antes):
        return None
    d_usd = valor_hoy_usd - valor_antes_usd
    d_fx = fx_hoy - fx_antes
    total = valor_hoy_usd * fx_hoy - valor_antes_usd * fx_antes
    return {
        "clp_hoy": round(valor_hoy_usd * fx_hoy), "clp_antes": round(valor_antes_usd * fx_antes),
        "total": round(total), "acciones": round(d_usd * fx_antes),
        "dolar": round(valor_antes_usd * d_fx), "cruce": round(d_usd * d_fx),
        "usd_hoy": round(valor_hoy_usd, 2), "usd_antes": round(valor_antes_usd, 2),
        "usd_pct": round((valor_hoy_usd / valor_antes_usd - 1) * 100, 2) if valor_antes_usd else None,
        "fx_hoy": round(fx_hoy, 1), "fx_antes": round(fx_antes, 1),
        "fx_pct": round((fx_hoy / fx_antes - 1) * 100, 2) if fx_antes else None,
        "pct": round((total / (valor_antes_usd * fx_antes)) * 100, 2) if valor_antes_usd and fx_antes else None,
    }


def valor_en(history, qty, fecha):
    """Valor de la cartera de hoy a los precios de una fecha pasada."""
    total, faltan = 0.0, []
    for sym, q in qty.items():
        filas = [r for r in history.get(sym, []) if r.get("d") <= fecha and num(r.get("p"))]
        if not filas:
            faltan.append(sym)
            continue
        total += q * filas[-1]["p"]
    return (total if total > 0 else None), faltan


# --------------------------------------------------- 2. el eje de la empresa
def tesis_de(t):
    """Qué tan sólida es la empresa, de 0 a 100, sin mirar el precio.

    Devuelve (puntaje, cobertura, detalle). La cobertura dice con cuánto de la
    información se calculó: si falta la mitad, se informa y se baja la confianza
    en vez de rellenar con un supuesto.
    """
    partes, detalle = [], {}
    for clave, fn in (("calidad", c_calidad), ("earnings", c_earnings),
                      ("flujos", c_flujos), ("valoracion", c_valoracion)):
        v, _cob = fn(t)
        detalle[clave] = round(v) if v is not None else None
        partes.append((v, PESO_TESIS[clave]))
    score, cob = promedio(partes)
    return (round(score, 1) if score is not None else None), round(cob, 2), detalle


def banda(tesis):
    if tesis is None:
        return "sin dato"
    return "alta" if tesis >= TESIS_ALTA else ("baja" if tesis <= TESIS_BAJA else "media")


# ---------------------------------------------------- 3. el eje del momento
def sma(v, n):
    return sum(v[-n:]) / n if len(v) >= n else None


def rsi_de(px, n=14):
    if len(px) < n + 1:
        return None
    g = l = 0.0
    for i in range(len(px) - n, len(px)):
        ch = px[i] - px[i - 1]
        g += max(ch, 0.0)
        l += max(-ch, 0.0)
    if l == 0:
        return 100.0
    return 100 - 100 / (1 + (g / n) / (l / n))


def senales_precio(px, i):
    """Las señales de precio en el día i de una serie, usando solo el pasado."""
    p = px[i]
    if not p:
        return None
    mx = max(px[max(0, i - 19):i + 1])
    s20, s50 = sma(px[:i + 1], 20), sma(px[:i + 1], 50)
    return {
        "precio": p,
        "desde_max": (p / mx - 1) * 100 if mx else None,
        "sobre_s20": bool(s20 and p > s20),
        "sobre_s50": bool(s50 and p > s50),
        "s20": s20, "s50": s50,
        "rsi": rsi_de(px[:i + 1]),
        "ret20": (p / px[i - 20] - 1) * 100 if i >= 20 and px[i - 20] else None,
    }


def momento_de(sg):
    """Dónde está la acción dentro de su propio rango. El orden importa: se
    pregunta primero por los extremos, que son los que de verdad informan."""
    if not sg:
        return "sin dato"
    rsi, dm, r20 = sg.get("rsi"), sg.get("desde_max"), sg.get("ret20")
    if (rsi is not None and rsi < RSI_HUNDIDO) or (r20 is not None and r20 <= REVERSION_20D):
        return "sobrevendida"
    if rsi is not None and rsi > RSI_ESTIRADO:
        return "estirada"
    if dm is not None and dm <= CAIDA_20D:
        return "corrigiendo"
    if dm is not None and dm > CERCA_MAX and sg.get("sobre_s20") and sg.get("sobre_s50"):
        return "fuerte"
    return "neutral"


# ------------------------------------- 4. las tasas base: la "proyección"
def tasas_base(history, tks):
    """Qué pasó históricamente con cada casilla (empresa × momento).

    Esta es la pieza que convierte el parte en una proyección en vez de una
    reacción. Se recorre todo el radar, se clasifica cada día de cada activo en
    su casilla usando SOLO el pasado de precios, y se mira qué rindió los
    siguientes HORIZONTE días hábiles. No hay modelo ni ajuste de parámetros:
    es un conteo.
    """
    cajas, todos = {}, []
    for sym, filas in history.items():
        if sym.startswith("^") or "=" in sym:
            continue
        px = [r["p"] for r in filas if num(r.get("p"))]
        if len(px) < 30:
            continue
        t = tks.get(sym) or {}
        tesis, _cob, _d = tesis_de(t)
        b = banda(tesis)
        if b == "sin dato":
            continue
        for i in range(22, len(px) - HORIZONTE):
            sg = senales_precio(px, i)
            if not sg or not px[i]:
                continue
            fut = (px[i + HORIZONTE] / px[i] - 1) * 100
            todos.append(fut)
            cajas.setdefault((momento_de(sg), b), []).append(fut)

    def resumen(xs):
        if not xs:
            return None
        sube = [x for x in xs if x > 0]
        baja = [x for x in xs if x <= 0]
        return {
            "n": len(xs),
            "media": round(sum(xs) / len(xs), 2),
            "acierto": round(100 * len(sube) / len(xs)),
            "sube": round(sum(sube) / len(sube), 2) if sube else 0.0,
            "baja": round(sum(baja) / len(baja), 2) if baja else 0.0,
        }

    tabla = {f"{m}|{b}": resumen(xs) for (m, b), xs in cajas.items() if resumen(xs)}
    return tabla, resumen(todos)


# ------------------------------------------------------ 5. el veredicto
# La matriz es explícita a propósito: cualquiera puede leerla y discutirla.
# Cada casilla sale de lo que se midió, no de una intuición.
MATRIZ = {
    ("sobrevendida", "alta"): ("COMPRAR",
        "Buena empresa castigada por precio. Esto es comprar barato algo que funciona, "
        "no atrapar un cuchillo que cae: lo que sostiene la decisión es la empresa, no el descuento."),
    ("sobrevendida", "media"): ("MANTENER",
        "Está sobrevendida y la empresa es correcta sin ser excepcional. El rebote suele llegar, "
        "pero no da para poner más plata encima."),
    ("sobrevendida", "baja"): ("VENDER PARCIAL",
        "Está sobrevendida, pero la empresa es floja y acá el promedio engaña: sube fuerte pocas veces "
        "y baja seguido. Eso no es una apuesta con ventaja, es una rifa."),
    ("corrigiendo", "alta"): ("MANTENER",
        "Cayó, pero la empresa está intacta. Vender acá es exactamente el error que cometía la versión "
        "anterior de este parte: la caída sola no distingue una oportunidad de un problema."),
    ("corrigiendo", "media"): ("MANTENER",
        "Corrigiendo sin señales de deterioro en la empresa. La corrección sola no es motivo."),
    ("corrigiendo", "baja"): ("VENDER",
        "Acá sí se vende, y no por la caída: por lo que la acompaña. Empresa débil que además cae es la "
        "peor casilla del tablero. La caída es el síntoma, no la causa."),
    ("neutral", "alta"): ("MANTENER", "Empresa sólida y precio sin extremos. No hay nada que corregir."),
    ("neutral", "media"): ("MANTENER", "Nada llamativo en ninguno de los dos ejes."),
    ("neutral", "baja"): ("VENDER PARCIAL",
        "La empresa es la parte floja de la cartera y el precio no está ni regalado ni estirado. "
        "Soltar parte acá es barato: no hay que esperar a que caiga para decidirlo."),
    ("fuerte", "alta"): ("MANTENER",
        "Empresa sólida en tendencia. Lo más probable es que lo más rentable sea no tocarla."),
    ("fuerte", "media"): ("MANTENER", "En tendencia y sin problemas en la empresa. Se deja correr."),
    ("fuerte", "baja"): ("VENDER PARCIAL",
        "Sube, pero la empresa no la respalda. Esta es la venta cómoda: se suelta con el precio a favor, "
        "que es lo contrario de vender en pánico."),
    ("estirada", "alta"): ("MANTENER",
        "Está estirada pero la empresa la sostiene. Un RSI alto en una buena empresa confirma tendencia; "
        "no es motivo para salir."),
    ("estirada", "media"): ("VENDER PARCIAL",
        "El movimiento ya está hecho y la empresa no da para pedir más. Recortar asegura parte de lo ganado."),
    ("estirada", "baja"): ("VENDER",
        "Precio estirado y empresa débil: la combinación que más se devuelve. Vender con el precio arriba "
        "es el mejor momento que vas a tener."),
}

# Qué acciones son "de compra" y cuáles "de venta", para poder contrastar el
# veredicto con lo que la tasa base medida dice de su casilla.
COMPRADORAS = ("COMPRAR", "AÑADIR", "MANTENER")

ORDEN = {"VENDER": 0, "VENDER PARCIAL": 1, "COMPRAR": 2, "AÑADIR": 3, "VIGILAR": 4, "MANTENER": 5}


def veredicto(p, t, meta, sg, tabla, base):
    """Qué hacer hoy con esta posición, y por qué. Dos ejes y una tasa base."""
    tesis, cob, comp = tesis_de(t)
    b = banda(tesis)
    mom = momento_de(sg)
    pnl = num(p.get("pnl_pct"))
    peso, precio = p["peso"], sg.get("precio") if sg else None

    accion, por_que = MATRIZ.get((mom, b), ("MANTENER", "Sin datos suficientes para separar los dos ejes."))
    gatillo = f"{mom} + empresa {b}"
    recorte = {"VENDER": 1.0, "VENDER PARCIAL": 0.30}.get(accion, 0.0)

    # --- lo que manda por encima de la matriz -------------------------------
    vets = vetos(t, peso, None, peso, None)
    graves = [v for v in vets if v[0] in ("caja", "margenes", "guidance", "deuda")]
    if graves:
        # Un veto grave no significa lo mismo en una empresa floja que en una
        # sólida. En una floja confirma la salida; en una sólida es un riesgo de
        # balance que se gestiona bajando exposición, no liquidando la posición.
        # Sin esta distinción el motor vendía Oracle completa (calidad 73) por su
        # deuda, que es la clase de reacción exagerada que se quiere evitar.
        if b == "baja":
            accion, gatillo, recorte = "VENDER", "veto: " + graves[0][0], 1.0
            por_que = graves[0][1] + " Con la empresa ya floja, esto confirma la salida."
        else:
            accion, gatillo, recorte = "VENDER PARCIAL", "veto: " + graves[0][0], 0.30
            por_que = (graves[0][1] + f" El resto de la empresa aguanta (tesis {int(tesis or 0)}/100), así que "
                       f"esto no es para liquidarla: es para depender menos de ella mientras el balance esté así.")

    # El tamaño no es una predicción, es control de riesgo: va después de la
    # tesis pero antes de "mantener".
    if accion == "MANTENER" and peso - meta >= SOBRE_META:
        frac = min(RECORTE_MAX, (peso - meta) / peso)
        if p["value"] * frac >= MONTO_MINIMO:
            accion, gatillo, recorte = "VENDER PARCIAL", "tamaño", frac
            por_que = (f"La empresa está bien y el precio no pide nada: esto no es por ella, es por ti. "
                       f"Pesa {coma(peso)}% y su lugar es {coma(meta)}%. Recortar la diferencia no cambia la "
                       f"tesis, cambia cuánto dependes de una sola carta.")
    elif accion in ("MANTENER", "COMPRAR") and meta - peso >= BAJO_META and b == "alta":
        if accion != "COMPRAR":
            accion, gatillo = "AÑADIR", "tamaño"
            por_que = (f"Empresa sólida con menos peso del que le corresponde: pesa {coma(peso)}% y le toca "
                       f"{coma(meta)}%. Si la tesis vale, tiene que notarse en la cartera.")

    # --- la proyección: qué pasó históricamente en esta casilla -------------
    casilla = tabla.get(f"{mom}|{b}")
    # El texto de la matriz es cualitativo a propósito: los números los pone la
    # tabla que se acaba de medir, no una cifra escrita a mano que mañana ya no
    # cuadre con lo que el propio motor calculó.
    if casilla and casilla["n"] >= MUESTRA_MINIMA:
        med = (base or {}).get("media")
        veces = f"{casilla['n']:,}".replace(",", ".")
        por_que += (f" Medido: de {veces} veces que una posición estuvo en esta casilla, subió el "
                    f"{casilla['acierto']}% y rindió {pct(casilla['media'])} a {HORIZONTE} días"
                    + (f" (el universo completo rindió {pct(med)})." if med is not None else "."))
    proy = None
    if casilla and casilla["n"] >= MUESTRA_MINIMA:
        asim = abs(casilla["sube"] / casilla["baja"]) if casilla["baja"] else None
        proy = {"n": casilla["n"], "media": casilla["media"], "acierto": casilla["acierto"],
                "sube": casilla["sube"], "baja": casilla["baja"],
                "asimetria": round(asim, 2) if asim else None,
                "vs_base": round(casilla["media"] - (base or {}).get("media", 0), 2),
                "horizonte": HORIZONTE}
    elif casilla:
        proy = {"n": casilla["n"], "media": casilla["media"], "acierto": casilla["acierto"],
                "sube": casilla["sube"], "baja": casilla["baja"], "asimetria": None,
                "vs_base": None, "horizonte": HORIZONTE,
                "nota": "Muestra chica: tómalo como referencia, no como base."}

    # Si la tasa base medida contradice al veredicto, se dice. Un motor que
    # esconde cuándo sus propios datos no lo respaldan no sirve para decidir.
    discrepancia = None
    if proy and proy.get("vs_base") is not None and gatillo not in ("tamaño",) and not gatillo.startswith("veto"):
        if accion in COMPRADORAS and proy["media"] < -0.5:
            discrepancia = (f"Ojo: la matriz dice {accion.lower()}, pero esta casilla midió "
                            f"{pct(proy['media'])} a {HORIZONTE} días. La muestra es de {proy['n']} casos "
                            f"y no la respalda del todo.")
        elif accion not in COMPRADORAS and proy["media"] > 0.5:
            discrepancia = (f"Ojo: la matriz dice {accion.lower()}, pero esta casilla midió "
                            f"{pct(proy['media'])} a {HORIZONTE} días. El motivo acá es la empresa, "
                            f"no lo que hizo el precio.")

    out = {"accion": accion, "gatillo": gatillo, "por_que": por_que, "discrepancia": discrepancia,
           "recorte": round(recorte, 3),
           "tesis": round(tesis) if tesis is not None else None, "banda": b, "momento": mom,
           "comp": comp, "confianza": round(cob * 100), "proyeccion": proy,
           "vetos": [v[1] for v in vets][:2],
           "desde_max": round(sg["desde_max"], 1) if sg and sg.get("desde_max") is not None else None,
           "rsi": int(sg["rsi"]) if sg and sg.get("rsi") is not None else None}

    if accion in ("VENDER PARCIAL", "VENDER") and precio:
        out["monto"] = round(p["value"] * recorte, 2)
        if accion == "VENDER PARCIAL":
            # Vender para volver solo es una decisión si queda dicho a qué precio.
            atr = num(((t or {}).get("tech") or {}).get("atr_pct")) or 3.0
            candidatos = [precio * (1 - atr * 1.5 / 100)]
            if sg.get("s20") and sg["s20"] < precio:
                candidatos.append(sg["s20"])
            vuelta = max(candidatos)
            if vuelta / precio - 1 >= -0.15:
                out["recompra"] = round(vuelta, 2)
                out["recompra_pct"] = round((vuelta / precio - 1) * 100, 1)
            else:
                out["recompra"] = None
                out["recompra_nota"] = "Su referencia de vuelta está muy abajo: espera a que se acerque."
    if pnl is not None:
        out["pnl_pct"] = round(pnl, 1)
    return out


# --------------------------- 5b. la simulación: ¿esta regla habría servido?
def simulacion(history, tks, syms, tabla, base):
    """Qué habría dicho esta regla cada día sobre TUS acciones, y qué pasó después.

    Recorre el historial de las posiciones actuales, clasifica cada día con el
    mismo código que usa el parte de hoy y mide el retorno de los HORIZONTE días
    siguientes. Después agrupa por el veredicto que habría dado.

    Lo que esto sí prueba: que los dos ejes separan resultados. Si "vender"
    rindiera igual que "comprar", la regla no serviría para nada.
    Lo que esto NO prueba: no es la rentabilidad de una cartera. No descuenta
    comisiones ni considera en qué habrías puesto la plata vendida. Y los
    fundamentales son los de hoy aplicados al pasado, así que el eje de la
    empresa tiene ventaja de información que en vivo no vas a tener.
    """
    por_accion, n_total = {}, 0
    for sym in syms:
        px = [r["p"] for r in history.get(sym, []) if num(r.get("p"))]
        if len(px) < 30:
            continue
        t = tks.get(sym) or {}
        for i in range(22, len(px) - HORIZONTE):
            sg = senales_precio(px, i)
            if not sg or not px[i]:
                continue
            tesis, _c, _d = tesis_de(t)
            b = banda(tesis)
            if b == "sin dato":
                continue
            accion = MATRIZ.get((momento_de(sg), b), ("MANTENER", ""))[0]
            ret = (px[i + HORIZONTE] / px[i] - 1) * 100
            g = por_accion.setdefault(accion, {"n": 0, "suma": 0.0, "ok": 0})
            g["n"] += 1
            g["suma"] += ret
            bien = ret < 0 if accion in ("VENDER", "VENDER PARCIAL") else ret > 0
            g["ok"] += 1 if bien else 0
            n_total += 1
    res = {a: {"n": g["n"], "media": round(g["suma"] / g["n"], 2),
               "acierto": round(100 * g["ok"] / g["n"])}
           for a, g in por_accion.items() if g["n"] >= 30}
    # La prueba que importa: la brecha entre lo que la regla quería comprar y lo
    # que quería vender. Si es cero o negativa, la regla no separa nada.
    compras = [a for a in res if a in ("COMPRAR", "AÑADIR", "MANTENER")]
    ventas = [a for a in res if a in ("VENDER", "VENDER PARCIAL")]
    def pond(claves):
        tot = sum(res[a]["n"] for a in claves)
        return (sum(res[a]["media"] * res[a]["n"] for a in claves) / tot) if tot else None
    m_c, m_v = pond(compras), pond(ventas)
    return {"n": n_total, "horizonte": HORIZONTE, "por_accion": res,
            "lado_compra": round(m_c, 2) if m_c is not None else None,
            "lado_venta": round(m_v, 2) if m_v is not None else None,
            "brecha": round(m_c - m_v, 2) if (m_c is not None and m_v is not None) else None,
            "base": (base or {}).get("media")}


# ------------------------------------------- 6. el marcador: ¿esto funciona?
def marcador(prev, history, filas, hoy):
    """Lleva la cuenta real de cómo le fue a cada veredicto pasado.

    Es la única prueba que no se puede discutir. Se guarda cada veredicto con su
    precio y su fecha; cuando pasan HORIZONTE días hábiles se mide qué hizo la
    acción y si el veredicto acertó. Un "vender" acierta si la acción bajó; un
    "comprar" o un "mantener", si subió.
    """
    seg = [s for s in (prev.get("seguimiento") or []) if s.get("d") and s.get("sym")]
    vistos = {(s["d"], s["sym"]) for s in seg}
    for f in filas:
        if f.get("precio") and (hoy, f["sym"]) not in vistos:
            seg.append({"d": hoy, "sym": f["sym"], "a": f["accion"], "p": f["precio"]})

    fechas = sorted({r["d"] for v in history.values() for r in v if num(r.get("p"))})
    idx = {d: i for i, d in enumerate(fechas)}
    acum, pendientes = [], 0
    for s in seg:
        i0 = idx.get(s["d"])
        if i0 is None or i0 + HORIZONTE >= len(fechas):
            pendientes += 1
            continue
        objetivo_d = fechas[i0 + HORIZONTE]
        filas_s = [r for r in history.get(s["sym"], []) if r.get("d") <= objetivo_d and num(r.get("p"))]
        if not filas_s or not s.get("p"):
            pendientes += 1
            continue
        ret = (filas_s[-1]["p"] / s["p"] - 1) * 100
        s["r"] = round(ret, 2)
        acum.append((s["a"], ret))

    por_accion = {}
    for a, ret in acum:
        g = por_accion.setdefault(a, {"n": 0, "suma": 0.0, "ok": 0})
        g["n"] += 1
        g["suma"] += ret
        bien = ret < 0 if a in ("VENDER", "VENDER PARCIAL") else ret > 0
        g["ok"] += 1 if bien else 0
    resumen = {a: {"n": g["n"], "media": round(g["suma"] / g["n"], 2),
                   "acierto": round(100 * g["ok"] / g["n"])} for a, g in por_accion.items() if g["n"]}
    total_ok = sum(g["ok"] for g in por_accion.values())
    total_n = sum(g["n"] for g in por_accion.values())

    seg = seg[-SEGUIMIENTO_MAX:]
    return seg, {"evaluados": total_n, "pendientes": pendientes,
                 "acierto": round(100 * total_ok / total_n) if total_n else None,
                 "por_accion": resumen, "horizonte": HORIZONTE}


# --------------------------------------------------------------- 7. principal
def main():
    latest = carga("latest.json", None)
    if not latest:
        print("Sin latest.json.")
        return
    tks = {t["sym"]: t for t in latest.get("tickers", [])}
    history = carga("history.json", {})
    book = carga("portfolios.json", {"list": []})
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
    syms = [p["sym"] for p in pos]

    # --- de dónde viene el resultado ---------------------------------------
    fx = (latest.get("market") or {}).get("CLP=X") or {}
    fx_hoy = num(fx.get("price"))
    spark = [x for x in (fx.get("spark") or []) if num(x)]
    fechas = sorted({r["d"] for s in qty for r in history.get(s, []) if num(r.get("p"))})
    hoy = fechas[-1] if fechas else None
    ventanas = {}
    v_hoy_ref, _ = valor_en(history, qty, fechas[-1]) if fechas else (None, [])

    def fecha_util(atras):
        """Fin de semana y feriados repiten el precio del viernes: si se compara
        contra uno de esos días "el día" da cero y no dice nada."""
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
        pasos = len(fechas) - 1 - fechas.index(antes)
        fx_antes = num(spark[-1 - pasos]) if len(spark) > pasos else fx_hoy
        d = descomponer(v_hoy, v_antes, fx_hoy, fx_antes)
        if d:
            d["desde"] = antes
            d["sin_precio"] = faltan[:4]
            ventanas[etiqueta] = d

    # --- el peso objetivo se calcula acá, no se hereda ----------------------
    # Antes se leía de decision.json, que se publica en otro momento: si ese
    # archivo quedaba viejo (pasó, con la cartera a US$5.797 cuando ya valía
    # US$4.730) el parte del día repartía contra pesos que no existían.
    rets = {s: retornos(history.get(s)) for s in syms}
    cor = {}
    for i, a in enumerate(syms):
        for b2 in syms[i + 1:]:
            cor[(a, b2)] = cor[(b2, a)] = correlacion(rets[a], rets[b2])
    pesos = {p["sym"]: p["peso"] for p in pos}
    grupos = agrupar(syms, cor, pesos)
    metas = objetivo(pesos, {s: conviccion(tks.get(s) or {}) for s in syms}, grupos, total)

    # --- las tasas base (la proyección) ------------------------------------
    tabla, base = tasas_base(history, tks)

    # --- el veredicto de cada posición -------------------------------------
    antes_v = {f["sym"]: f.get("accion") for f in (prev.get("posiciones") or [])}
    filas = []
    for p in pos:
        t = tks.get(p["sym"]) or {}
        px = [r["p"] for r in history.get(p["sym"], []) if num(r.get("p"))]
        sg = senales_precio(px, len(px) - 1) if len(px) >= 22 else None
        if sg is None:
            precio_hoy = num(t.get("price"))
            sg = {"precio": precio_hoy, "desde_max": None, "sobre_s20": False, "sobre_s50": False,
                  "s20": None, "s50": None, "rsi": num((t.get("tech") or {}).get("rsi")), "ret20": None}
        # objetivo() solo devuelve las que caben en la cartera objetivo. Antes, las
        # que no estaban heredaban su propio peso y la ficha mostraba "2,6% → 2,6%"
        # al lado de un VENDER: el asignador las quiere en cero, no igual.
        fuera = p["sym"] not in metas
        meta = 0.0 if fuera else num(metas.get(p["sym"]), p["peso"])
        v = veredicto(p, t, meta, sg, tabla, base)
        if fuera and v["accion"] in ("COMPRAR", "AÑADIR"):
            # Los dos ejes dicen una cosa y el asignador otra. No se esconde
            # ninguna de las dos: con poco capital, "buena y barata" no alcanza
            # para justificar una posición más.
            v["nota_cartera"] = (
                f"Los dos ejes la aprueban, pero con {usd(total, 0)} repartidos el motor de cartera "
                f"prefiere concentrar en {len(metas)} nombres y esta queda fuera. Súmale solo si sacas "
                f"el espacio de otra, no encima de las {len(pos)} que ya tienes.")
        v.update({"sym": p["sym"], "nombre": t.get("name") or p["sym"],
                  "peso": round(p["peso"], 1), "meta": round(meta, 1),
                  "valor": round(p["value"], 2), "precio": sg.get("precio"),
                  "cambio": (antes_v.get(p["sym"]) != v["accion"] and antes_v.get(p["sym"])) or None})
        filas.append(v)

    filas.sort(key=lambda f: (ORDEN[f["accion"]], -(f.get("monto") or f["valor"])))
    for f in filas:
        if f["accion"] in ("VENDER PARCIAL", "VENDER") and (f.get("monto") or f["valor"]) < MONTO_MINIMO:
            f["accion"] = "VIGILAR"
            f["por_que"] += f" Son {usd(f.get('monto') or f['valor'])}: muy poco para que valga la comisión."
    con_gatillo = [f for f in filas if f["accion"] not in ("MANTENER", "VIGILAR")]
    # Las de venta van primero en la lista, y con un tope de cinco se comían
    # todos los cupos: las oportunidades de compra quedaban escondidas abajo.
    # Se reservan cupos para cada lado y se rellena con lo que haya.
    lado_v = [f for f in con_gatillo if f["accion"] in ("VENDER", "VENDER PARCIAL")]
    lado_c = [f for f in con_gatillo if f["accion"] in ("COMPRAR", "AÑADIR")]
    elegidas_hoy = lado_v[:3] + lado_c[:2]
    if len(elegidas_hoy) < MAX_ACCIONES:
        resto = [f for f in con_gatillo if f not in elegidas_hoy]
        elegidas_hoy += resto[:MAX_ACCIONES - len(elegidas_hoy)]
    ids_hoy = {id(f) for f in elegidas_hoy}
    for f in con_gatillo:
        f["hoy"] = id(f) in ids_hoy
    cuenta = {}
    for f in filas:
        cuenta[f["accion"]] = cuenta.get(f["accion"], 0) + 1

    seg, marca = marcador(prev, history, filas, hoy or latest.get("date"))
    sim = simulacion(history, tks, syms, tabla, base)

    # --- el titular --------------------------------------------------------
    titulares = []
    sem = ventanas.get("semana")
    if sem:
        if abs(sem["dolar"]) > abs(sem["acciones"]) * 0.5 and abs(sem["dolar"]) > 20000:
            quien = "el dólar" if abs(sem["dolar"]) > abs(sem["acciones"]) else "las acciones"
            titulares.append(f"En la semana la cartera {'bajó' if sem['total'] < 0 else 'subió'} "
                             f"{clp(abs(sem['total']))}: {clp(abs(sem['acciones']))} por las acciones y "
                             f"{clp(abs(sem['dolar']))} por el dólar. Mandó {quien}.")
        else:
            titulares.append(f"En la semana la cartera {'bajó' if sem['total'] < 0 else 'subió'} "
                             f"{clp(abs(sem['total']))}, casi todo por las acciones "
                             f"({clp(abs(sem['acciones']))}); el dólar aportó {clp(abs(sem['dolar']))}.")
    urgentes = [f for f in con_gatillo if f.get("hoy")]
    if urgentes:
        titulares.append(f"Para hoy: {', '.join(f['sym'] + ' (' + f['accion'].lower() + ')' for f in urgentes)}."
                         + (f" Quedan {len(con_gatillo) - len(urgentes)} para después."
                            if len(con_gatillo) > len(urgentes) else ""))
    else:
        titulares.append("Ninguna posición pide un movimiento hoy.")
    caen_bien = [f for f in filas if f["momento"] in ("corrigiendo", "sobrevendida") and f["banda"] == "alta"]
    if caen_bien:
        titulares.append(f"{len(caen_bien)} {'posición cayó' if len(caen_bien) == 1 else 'posiciones cayeron'} "
                         f"con la empresa intacta ({', '.join(f['sym'] for f in caen_bien[:4])}): "
                         f"eso no se vende, es la casilla que históricamente rebota.")
    cambiaron = [f for f in filas if f["cambio"]]
    titulares.append(f"{len(cambiaron)} veredictos cambiaron desde el parte anterior." if cambiaron
                     else "Ningún veredicto cambió desde el parte anterior.")

    # Las reglas se escriben con los números que se acaban de medir, no con cifras
    # a mano: si la tabla cambia, el texto cambia con ella.
    def cel(k):
        c = tabla.get(k)
        return (f"{pct(c['media'])} y sube el {c['acierto']}%" + f" (n={c['n']})") if c else "sin muestra"

    reglas = [
        "Cada posición se lee en dos ejes: la EMPRESA (márgenes, rentabilidad sobre patrimonio, deuda, "
        "liquidez, revisiones de utilidades) y el MOMENTO del precio (sobrevendida, corrigiendo, neutral, "
        "fuerte, estirada). El cruce de los dos manda; el precio solo, nunca.",
        f"Una buena empresa que cayó NO se vende. Medido hoy en este universo: cayendo con la empresa "
        f"intacta rinde {cel('corrigiendo|alta')}; cayendo con la empresa débil, {cel('corrigiendo|baja')}. "
        f"Misma caída, destinos distintos: lo que las separa es la empresa.",
        f"Una empresa débil se vende caiga o no caiga. Sin caer todavía rinde {cel('neutral|baja')}, "
        f"así que esperar a que caiga para decidirlo solo empeora el precio de salida.",
        f"La mejor casilla del tablero es una buena empresa sobrevendida: {cel('sobrevendida|alta')}. "
        f"La peor, una empresa débil que ya viene cayendo: {cel('corrigiendo|baja')}.",
        "La valoración entra con poco peso (10 de 100) porque se midió y casi no separa: el múltiplo "
        "barato de hoy suele ser solo el reflejo de la caída de ayer. La calidad pesa 55.",
        f"Cada veredicto trae la tasa base de su casilla: cuántos casos, qué rindieron a {HORIZONTE} días "
        f"y cuántas veces subieron. Si la muestra no llega a {MUESTRA_MINIMA} casos, lo dice y no proyecta.",
        f"Nunca se recorta más del {coma(RECORTE_MAX * 100, 0)}% de una posición de una vez, y un movimiento "
        f"bajo {usd(MONTO_MINIMO, 0)} pasa a vigilar: la comisión se lo comería.",
    ]

    salida = {
        "date": latest.get("date"),
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "prev_date": prev.get("date"),
        "valor": round(total, 2), "fx": fx_hoy,
        "ventanas": ventanas, "titular": titulares, "posiciones": filas, "conteo": cuenta,
        "tasas": tabla, "base": base, "marcador": marca, "seguimiento": seg, "simulacion": sim,
        "ejes": {"tesis": PESO_TESIS, "alta": TESIS_ALTA, "baja": TESIS_BAJA, "horizonte": HORIZONTE},
        "reglas": reglas,
        "nota": ("Esto no es un pronóstico. Cada posición cae en una casilla (empresa × momento) y se informa "
                 "qué pasó históricamente con las que estuvieron ahí, con el tamaño de muestra a la vista. "
                 "Los fundamentales son los de hoy aplicados al pasado: se revisó ese sesgo y el efecto es más "
                 "fuerte en la ventana reciente, donde el sesgo es mínimo, pero existe. Son 130 días y un solo "
                 "régimen de mercado. El marcador lleva la cuenta real de cómo le fue a cada veredicto."),
    }
    with open(os.path.join(DATA, "daily.json"), "w", encoding="utf-8") as f:
        json.dump(salida, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Parte diario · {len(filas)} posiciones · {usd(total)} · dólar {fx_hoy}")
    for l in titulares:
        print("  ·", l)
    for et, d in ventanas.items():
        print(f"  {et:7}: {clp(d['total'])} = acciones {clp(d['acciones'])} + dólar {clp(d['dolar'])} "
              f"+ cruce {clp(d['cruce'])}  (USD {d['usd_pct']:+.2f}%, dólar {d['fx_pct']:+.2f}%)")
    print(f"  base del universo: {base['media']:+.2f}% a {HORIZONTE}d (n={base['n']:,})")
    print("  casillas medidas:")
    for k in sorted(tabla, key=lambda k: -(tabla[k]["media"])):
        c = tabla[k]
        print(f"    {k:26} n={c['n']:<6} {c['media']:+.2f}%  sube {c['acierto']}%")
    print("  veredictos:", ", ".join(f"{k}={v}" for k, v in cuenta.items()))
    for f in filas:
        if f["accion"] != "MANTENER":
            pr = f.get("proyeccion") or {}
            extra = f" · base {pr.get('media', 0):+.2f}% sube {pr.get('acierto', '?')}%" if pr else ""
            print(f"    {f['accion']:15} {f['sym']:5} tesis={f['tesis']} {f['momento']:13}{extra}")
    print(f"  simulacion sobre tus {len(syms)} acciones ({sim['n']:,} dias-accion):")
    for a, g in sorted(sim["por_accion"].items(), key=lambda kv: -kv[1]["media"]):
        print(f"    {a:15} n={g['n']:<6} {g['media']:+.2f}%  acierto {g['acierto']}%")
    print(f"    lado compra {sim['lado_compra']:+.2f}%  ·  lado venta {sim['lado_venta']:+.2f}%  "
          f"·  brecha {sim['brecha']:+.2f} pts")
    print(f"  marcador: {marca['evaluados']} veredictos evaluados, "
          f"{marca['pendientes']} pendientes, acierto {marca['acierto']}%")
    print(f"→ {os.path.join(DATA, 'daily.json')}")


if __name__ == "__main__":
    main()
