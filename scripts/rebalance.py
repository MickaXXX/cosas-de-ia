#!/usr/bin/env python3
"""
Reorganización de la cartera: qué cambiaría y cuánto risk se saca de encima.

No intenta adivinar qué acción va a subir; eso no se puede y el propio historial
de esta app lo demuestra (r² de 0,3% prediciendo el día siguiente). Lo que sí se
puede calcular es lo otro: cuánto de la suerte de la cartera depende de una sola
posición, cuántas apuestas distintas hay de verdad detrás de 27 nombres, y qué
posiciones son tan chicas que no cambian nada aunque acierten.

Las cuatro reglas, todas explícitas:

  1. Ninguna posición sobre el 10%. Una sola no puede decidir el resultado.
  2. Ninguna bajo el 3%. Más chica que eso no mueve la aguja y sí ocupa atención
     y comisiones; es mejor juntarla con otra.
  3. Ningún grupo correlacionado sobre el 30%. Ocho mineras de bitcoin distintas
     son una sola apuesta con ocho nombres: se agrupan por correlación real de
     los últimos meses, no por sector declarado.
  4. Dentro de esos límites, más peso a lo que el modelo puntúa más alto. Lo que
     tiene señal de venta o puntaje bajo sale.

Se publican dos planes, porque tienen costos muy distintos:
  · aporte   → dónde poner el próximo dinero fresco, sin vender nada.
  · completo → la reorganización entera, con lo que hay que vender.

Salida: docs/data/rebalance.json
"""
from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")

MAX_POS = 12.0          # techo por posición, en % de la cartera
MIN_POS = 5.0           # piso: bajo esto una posición no cambia el resultado
MAX_GRUPO = 30.0        # techo por grupo de activos que se mueven juntos
CORR_GRUPO = 0.65       # a partir de aquí dos activos son "lo mismo"
SCORE_FUERA = 50        # puntaje del modelo bajo el cual la posición sale
DIAS_MIN = 40           # días en común mínimos para creerle a una correlación


def coma(v, dec=1):
    """Número en formato chileno: la app entera usa coma decimal."""
    return f"{v:.{dec}f}".replace(".", ",")


def num(x, default=None):
    if isinstance(x, bool) or x is None:
        return default
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return default if v != v else v


# ------------------------------------------------------------------ estadística
def retornos(hist: list) -> dict:
    """Retorno diario por fecha, saltándose los días sin precio."""
    filas = [r for r in hist or [] if num(r.get("p", 0), 0) > 0]
    return {filas[i]["d"]: filas[i]["p"] / filas[i - 1]["p"] - 1 for i in range(1, len(filas))}


def desvio(xs: list) -> float:
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def correlacion(ra: dict, rb: dict) -> float | None:
    """Correlación de los días que las dos series tienen en común.

    Se descartan los días en que las dos quedaron planas: son feriados y fines de
    semana arrastrando el precio del viernes, y si se cuentan inflan la
    correlación de cualquier par hacia 1.
    """
    dias = [d for d in (set(ra) & set(rb)) if ra[d] or rb[d]]
    if len(dias) < DIAS_MIN:
        return None
    xs, ys = [ra[d] for d in dias], [rb[d] for d in dias]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))
    return cov / den if den else None


def vol_cartera(pesos: dict, sig: dict, cor: dict) -> float | None:
    """Volatilidad diaria de la cartera, en %. Con correlaciones: dos posiciones
    que se mueven juntas suman riesgo, dos que no, se compensan."""
    syms = [s for s in pesos if sig.get(s) is not None and pesos[s] > 0]
    if not syms:
        return None
    var = 0.0
    for a in syms:
        for b in syms:
            c = 1.0 if a == b else (cor.get((a, b)) if cor.get((a, b)) is not None else 0.35)
            var += pesos[a] * pesos[b] * sig[a] * sig[b] * c
    return math.sqrt(max(var, 0)) * 100


def agrupar(syms: list, cor: dict, pesos: dict) -> list:
    """Junta en un grupo los activos encadenados por correlación alta.

    Enlace simple: si A se mueve con B y B con C, los tres son la misma apuesta
    aunque A y C no se parezcan tanto. Es lo que pasa con las mineras de bitcoin
    y con la cadena de memoria y semiconductores.
    """
    padre = {s: s for s in syms}

    def raiz(x):
        while padre[x] != x:
            padre[x] = padre[padre[x]]
            x = padre[x]
        return x

    for i, a in enumerate(syms):
        for b in syms[i + 1:]:
            c = cor.get((a, b))
            if c is not None and c >= CORR_GRUPO:
                padre[raiz(a)] = raiz(b)
    grupos = {}
    for s in syms:
        grupos.setdefault(raiz(s), []).append(s)
    out = [sorted(g, key=lambda s: -pesos.get(s, 0)) for g in grupos.values()]
    out.sort(key=lambda g: -sum(pesos.get(s, 0) for s in g))
    return out


# ------------------------------------------------------------------ el plan
def conviccion(t: dict) -> float:
    """Cuánta confianza da el modelo a esta posición, de 0 a 1.

    Se resta la base de 45 puntos antes de repartir: entre un 91 y un 56 la
    diferencia real de convicción es enorme, y repartir proporcional al puntaje
    crudo la aplanaba a 1,6 a 1. Así el reparto refleja lo que el modelo dice.
    """
    score = num(t.get("score"), 50) or 50
    bono = {"strong_buy": 12, "buy": 6, "hold": 0, "sell": -25, "strong_sell": -40}.get(t.get("signal"), 0)
    return max(0.0, min(100.0, score + bono) - 45) / 55


def cuantas_caben(valor_total: float) -> int:
    """Cuántas posiciones tiene sentido tener con este capital.

    Con US$4.000 repartidos en 27 nombres cada uno es US$150: ninguno cambia el
    resultado y todos cobran comisión. El piso de MIN_POS por posición ya fija el
    máximo aritmético (100/5 = 20); además se pide que cada una valga al menos
    US$200, que es donde una comisión fija deja de pesar.
    """
    por_piso = int(100 // MIN_POS)
    por_plata = max(5, int(valor_total // 200))
    return max(5, min(por_piso, por_plata, 15))


def elegidas(conv: dict, grupos: list, n: int) -> list:
    """Las n posiciones que se quedan: las de más convicción, pero sin que un solo
    grupo correlacionado cope la lista (si copara, el techo de grupo sería
    imposible de cumplir con el piso por posición)."""
    tope_grupo = max(1, int(MAX_GRUPO // MIN_POS))
    grupo_de = {s: i for i, g in enumerate(grupos) for s in g}
    cupo, out = {}, []
    for s in sorted((x for x, c in conv.items() if c > 0), key=lambda x: -conv[x]):
        g = grupo_de.get(s, -1)
        if g >= 0 and len(grupos[g]) > 1:
            if cupo.get(g, 0) >= tope_grupo:
                continue
            cupo[g] = cupo.get(g, 0) + 1
        out.append(s)
        if len(out) >= n:
            break
    return out


def objetivo(pesos: dict, conv: dict, grupos: list, valor_total: float) -> dict:
    """Pesos objetivo: proporcionales a la convicción, dentro de los cuatro topes.

    Se fija primero quiénes se quedan y después se reparte entre ellos. Al revés
    —repartir entre todos y después ir botando a los que quedan bajo el piso— la
    lista se desmorona: cada renormalización deja a otros bajo el piso y la
    cartera termina en cuatro nombres.
    """
    elegidos = elegidas(conv, grupos, cuantas_caben(valor_total))
    if not elegidos:
        return {}
    suma = sum(conv[s] for s in elegidos)
    obj = {s: conv[s] / suma * 100 for s in elegidos}
    piso = min(MIN_POS, 100 / len(elegidos))          # con pocas posiciones el piso cede

    for _ in range(200):
        obj = {s: max(piso, min(MAX_POS, w)) for s, w in obj.items()}
        for g in grupos:
            dentro = [s for s in g if s in obj]
            peso = sum(obj[s] for s in dentro)
            if len(dentro) > 1 and peso > MAX_GRUPO:
                sobra = peso - MAX_GRUPO
                for s in dentro:                       # baja el grupo a prorrata
                    obj[s] -= sobra * obj[s] / peso
                fuera = [s for s in obj if s not in dentro]
                base = sum(conv[s] for s in fuera)
                for s in fuera:                        # y ese peso va a los demás
                    obj[s] += sobra * (conv[s] / base if base else 1 / max(len(fuera), 1))
        total = sum(obj.values())
        obj = {s: w / total * 100 for s, w in obj.items()}
        if (all(piso - 0.05 <= w <= MAX_POS + 0.05 for w in obj.values())
                and all(sum(obj[s] for s in g if s in obj) <= MAX_GRUPO + 0.05
                        for g in grupos if len([s for s in g if s in obj]) > 1)):
            break
    return {s: round(w, 2) for s, w in obj.items()}


def razon(sym, actual, meta, t, grupo_de, conv, cupos=0):
    """Una línea que explica por qué se mueve esta posición, sin jerga."""
    sig = t.get("signal")
    if meta == 0:
        if sig in ("sell", "strong_sell"):
            return f"El modelo la tiene en venta ({num(t.get('score'), 0):.0f}/100). Sale."
        if (num(t.get("score"), 50) or 50) < SCORE_FUERA:
            return f"Puntaje {num(t.get('score'), 0):.0f}/100, bajo el mínimo para ocupar un lugar."
        g = grupo_de.get(sym)
        if g and len(g) > 1:
            return (f"Se mueve casi igual que {', '.join(x for x in g if x != sym)[:44]}, y de ese grupo "
                    f"ya quedan las de mejor puntaje. Esta repite apuesta.")
        return (f"Con {int(round(num(t.get('score'), 0) or 0))}/100 no entra entre las {cupos} que caben, "
                f"y con {coma(actual)}% tampoco alcanza a mover tu resultado.")
    if meta < actual - 0.5:
        g = grupo_de.get(sym)
        if actual > MAX_POS:
            return (f"Pesa {coma(actual)}%: un mal día suyo es un mal día de toda la cartera. "
                    f"Bajarla a {coma(meta)}% no cambia la tesis, cambia el tamaño de la apuesta.")
        if g and len(g) > 1:
            return f"Se mueve casi igual que {', '.join(x for x in g if x != sym)[:40]}: juntas ya son demasiada apuesta a lo mismo."
        return f"Ajuste de peso a {coma(meta)}%."
    if meta > actual + 0.5:
        return (f"El modelo la puntúa {num(t.get('score'), 0):.0f}/100 y hoy pesa solo {coma(actual)}%: "
                f"si le crees, tiene que pesar lo suficiente para notarse.")
    return "Queda como está."


def plan_completo(pesos, obj, valor_total, tks, grupo_de, conv, cupos):
    """El plan se paga solo: lo que entra de las ventas es lo que se reparte en
    compras. Antes se cortaba la lista a los diez movimientos más grandes y
    quedaban US$800 de compras sin financiar."""
    minimo = max(30.0, valor_total * 0.008)        # bajo esto la comisión se come el ajuste
    ventas, compras = [], []
    for s in set(pesos) | set(obj):
        a, m = pesos.get(s, 0), obj.get(s, 0)
        delta = (m - a) / 100 * valor_total
        if abs(delta) < minimo:
            continue
        t = tks.get(s) or {}
        fila = {"sym": s, "accion": "comprar" if delta > 0 else "vender",
                "peso": round(a, 1), "meta": round(m, 1), "usd": round(abs(delta), 2),
                "score": num(t.get("score")), "senal": t.get("signal"),
                "nombre": t.get("name") or "",
                "por_que": razon(s, a, m, t, grupo_de, conv, cupos)}
        (compras if delta > 0 else ventas).append(fila)

    ventas.sort(key=lambda f: -f["usd"])
    compras.sort(key=lambda f: -f["usd"])
    caja = sum(f["usd"] for f in ventas)
    elegidas_c, resto = [], caja
    for f in compras[:7]:                          # una lista más larga no la hace nadie
        if resto < minimo:
            break
        f = dict(f, usd=round(min(f["usd"], resto), 2))
        # Si la compra se recorta, la meta mostrada tiene que ser la alcanzable.
        f["meta"] = round(f["peso"] + f["usd"] / valor_total * 100, 1)
        elegidas_c.append(f)
        resto -= f["usd"]
    # El vuelto se reparte respetando el techo por posición: antes iba entero a la
    # primera compra y la dejaba en 14,8%, por encima del propio límite del plan.
    for f in elegidas_c:
        if resto < 1:
            break
        techo = MAX_POS / 100 * valor_total - f["peso"] / 100 * valor_total
        pone = max(0.0, min(resto, techo - f["usd"]))
        if pone <= 0:
            continue
        f["usd"] = round(f["usd"] + pone, 2)
        f["meta"] = round(f["peso"] + f["usd"] / valor_total * 100, 1)
        resto -= pone
    return ventas + elegidas_c


def pesos_tras(pesos, movidas, valor_total):
    """Pesos de la cartera si solo se hicieran estos movimientos."""
    w = {s: v / 100 * valor_total for s, v in pesos.items()}
    for m in movidas:
        w[m["sym"]] = w.get(m["sym"], 0) + (m["usd"] if m["accion"] == "comprar" else -m["usd"])
    tot = sum(x for x in w.values() if x > 0) or 1
    return {s: x / tot for s, x in w.items() if x > 1e-6}


def plan_esencial(plan, pesos, valor_total, sig, cor, vol_antes, vol_despues):
    """Si solo vas a hacer unos pocos movimientos, cuáles.

    Se agregan de a uno —cada venta con las compras que financia— hasta capturar
    el 60% de la baja de riesgo del plan completo. Veintitrés operaciones no las
    hace nadie, y las primeras tres ya son casi todo el beneficio.
    """
    if not plan or vol_antes is None or vol_despues is None or vol_antes <= vol_despues:
        return {"filas": [], "vol": vol_antes}
    ventas = [f for f in plan if f["accion"] == "vender"]
    compras = [f for f in plan if f["accion"] == "comprar"]
    meta = vol_antes - (vol_antes - vol_despues) * 0.6
    elegidas_v, elegidas_c, caja = [], [], 0.0
    for v in ventas[:6]:
        elegidas_v.append(v)
        caja += v["usd"]
        while compras and caja >= 30 and len(elegidas_c) < len(elegidas_v) + 2:
            c = compras.pop(0)
            # El techo por posición manda: si la compra no absorbe toda la caja,
            # el resto va a la siguiente en vez de quedar sin destino.
            tope = max(0.0, MAX_POS / 100 * valor_total - c["peso"] / 100 * valor_total)
            monto = min(c["usd"], caja, tope) if tope > 0 else 0
            if monto < 30:
                continue
            c = dict(c, usd=round(monto, 2))
            c["meta"] = round(c["peso"] + c["usd"] / valor_total * 100, 1)
            elegidas_c.append(c)
            caja -= c["usd"]
        vol = vol_cartera(pesos_tras(pesos, elegidas_v + elegidas_c, valor_total), sig, cor)
        if vol is not None and vol <= meta and elegidas_c:
            break
    filas = elegidas_v + elegidas_c
    return {"filas": filas, "vol": round(vol_cartera(pesos_tras(pesos, filas, valor_total), sig, cor) or 0, 2)}


def plan_aporte(pesos, obj, valor_total, monto, tks):
    """Dónde poner dinero fresco sin vender nada: se reparte entre las posiciones
    que están por debajo de su objetivo, empezando por la más atrasada."""
    faltan = []
    for s, m in obj.items():
        hoy = pesos.get(s, 0) / 100 * valor_total
        meta = m / 100 * (valor_total + monto)
        if meta > hoy:
            faltan.append((meta - hoy, s))
    faltan.sort(reverse=True)
    resto, filas = monto, []
    for falta, s in faltan:
        if resto <= 0:
            break
        pone = min(falta, resto)
        if pone < max(20.0, monto * 0.12):        # no fraccionar el aporte en migajas
            continue
        t = tks.get(s) or {}
        filas.append({"sym": s, "usd": round(pone, 2), "score": num(t.get("score")),
                      "senal": t.get("signal"), "nombre": t.get("name") or "",
                      "peso": round(pesos.get(s, 0), 1), "meta": round(obj.get(s, 0), 1)})
        resto -= pone
    if filas and resto > 0.5:                      # el sobrante va al primero
        filas[0]["usd"] = round(filas[0]["usd"] + resto, 2)
    return filas


# ------------------------------------------------------------------ principal
def main():
    with open(os.path.join(DATA, "latest.json"), encoding="utf-8") as f:
        latest = json.load(f)
    tks = {t["sym"]: t for t in latest.get("tickers", [])}
    try:
        with open(os.path.join(DATA, "history.json"), encoding="utf-8") as f:
            hist = json.load(f)
    except (OSError, json.JSONDecodeError):
        hist = {}
    try:
        with open(os.path.join(DATA, "portfolios.json"), encoding="utf-8") as f:
            book = json.load(f)
    except (OSError, json.JSONDecodeError):
        book = {"list": []}

    pf = next((p for p in book.get("list", []) if p.get("tx")), None)
    if not pf:
        print("Sin cartera publicada: nada que reorganizar.")
        return

    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from desks import positions_of

    posiciones = [p for p in positions_of(pf.get("tx", []), tks) if (p.get("value") or 0) > 0]
    valor_total = sum(p["value"] for p in posiciones)
    if valor_total <= 0:
        print("La cartera no tiene valor de mercado: nada que reorganizar.")
        return
    pesos = {p["sym"]: p["value"] / valor_total * 100 for p in posiciones}
    syms = sorted(pesos, key=lambda s: -pesos[s])

    # --- riesgo y parentesco -------------------------------------------------
    rets = {s: retornos(hist.get(s)) for s in syms}
    sig = {s: (desvio(list(r.values())) if len(r) >= DIAS_MIN else None) for s, r in rets.items()}
    cor = {}
    for i, a in enumerate(syms):
        for b in syms[i + 1:]:
            c = correlacion(rets[a], rets[b])
            cor[(a, b)] = cor[(b, a)] = c
    grupos = agrupar(syms, cor, pesos)
    grupo_de = {s: g for g in grupos for s in g if len(g) > 1}

    conv = {s: conviccion(tks.get(s) or {}) for s in syms}
    for s in syms:                                   # lo que el modelo descarta, fuera
        t = tks.get(s) or {}
        if t.get("signal") in ("sell", "strong_sell") or (num(t.get("score"), 0) or 0) < SCORE_FUERA:
            conv[s] = 0.0
    obj = objetivo(pesos, conv, grupos, valor_total)

    w_ahora = {s: w / 100 for s, w in pesos.items()}
    w_luego = {s: w / 100 for s, w in obj.items()}
    vol_antes = vol_cartera(w_ahora, sig, cor)
    vol_despues = vol_cartera(w_luego, sig, cor)

    def efectivas(w):
        hh = sum(x * x for x in w.values())
        return 1 / hh if hh else 0

    def grupo_top(w):
        return max((sum(w.get(s, 0) for s in g) * 100 for g in grupos), default=0)

    def score_medio(w):
        tot = sum(w.values()) or 1
        return sum(w[s] * (num((tks.get(s) or {}).get("score"), 50) or 50) for s in w) / tot

    completo = plan_completo(pesos, obj, valor_total, tks, grupo_de, conv, len(obj))
    esencial = plan_esencial(completo, pesos, valor_total, sig, cor, vol_antes, vol_despues)
    aporte = plan_aporte(pesos, obj, valor_total, 200.0, tks)

    # --- el titular: una frase con el problema más grande --------------------
    mayor = syms[0]
    grupo_mayor = max(grupos, key=lambda g: sum(pesos.get(s, 0) for s in g))
    peso_gm = sum(pesos.get(s, 0) for s in grupo_mayor)
    chicas = [s for s in syms if pesos[s] < MIN_POS]
    titulares = []
    if pesos[mayor] > MAX_POS + 2:
        titulares.append((pesos[mayor], f"**{mayor}** pesa {pesos[mayor]:.0f}% de todo. Es la posición que "
                                        f"decide tu resultado, te guste o no."))
    if len(grupo_mayor) > 1 and peso_gm > MAX_GRUPO:
        titulares.append((peso_gm, f"**{', '.join(grupo_mayor[:4])}** se mueven casi igual y juntas son "
                                   f"{peso_gm:.0f}%: parecen {len(grupo_mayor)} apuestas y son una sola."))
    if len(chicas) >= 6:
        plata = sum(pesos[s] for s in chicas)
        titulares.append((plata, f"{len(chicas)} posiciones bajo {MIN_POS:.0f}% se reparten {plata:.0f}% de "
                                 f"la cartera: ninguna cambia tu resultado aunque acierte."))
    titulares.sort(reverse=True)
    titular = titulares[0][1] if titulares else "Los pesos de tu cartera están dentro de la política."

    salida = {
        "date": latest.get("date"),
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "valor": round(valor_total, 2),
        "titular": titular,
        "hallazgos": [t for _, t in titulares],
        "antes": {
            "posiciones": len(pesos), "efectivas": round(efectivas(w_ahora), 1),
            "mayor": {"sym": mayor, "peso": round(pesos[mayor], 1)},
            "grupo_top": round(grupo_top(w_ahora), 1),
            "vol": round(vol_antes, 2) if vol_antes else None,
            "score": round(score_medio(w_ahora)),
        },
        "despues": {
            "posiciones": len(obj), "efectivas": round(efectivas(w_luego), 1),
            "mayor": {"sym": max(obj, key=obj.get) if obj else None,
                      "peso": round(max(obj.values()), 1) if obj else None},
            "grupo_top": round(grupo_top(w_luego), 1),
            "vol": round(vol_despues, 2) if vol_despues else None,
            "score": round(score_medio(w_luego)) if w_luego else None,
        },
        "grupos": [{"syms": g, "peso": round(sum(pesos.get(s, 0) for s in g), 1),
                    "corr": round(max((cor.get((a, b)) or 0) for i, a in enumerate(g) for b in g[i + 1:]), 2)}
                   for g in grupos if len(g) > 1],
        "plan": completo,
        "esencial": esencial,
        "aporte": {"monto": 200.0, "filas": aporte},
        "reglas": [
            f"Ninguna posición sobre {MAX_POS:.0f}%: una sola no puede decidir el resultado.",
            f"Ninguna bajo {MIN_POS:.0f}%: más chica que eso no mueve la aguja y sí cuesta comisiones y atención.",
            f"Ningún grupo de activos que se muevan juntos (correlación sobre {CORR_GRUPO:.2f}) sobre {MAX_GRUPO:.0f}%.",
            f"Dentro de esos límites, más peso a lo que el modelo puntúa más alto; señal de venta o puntaje bajo {SCORE_FUERA} sale.",
        ],
        "limites": ("Esto reparte riesgo, no adivina ganancias: nadie sabe qué va a subir mañana y el propio "
                    "historial de esta app lo confirma. Lo que sí cambia es cuánto dependes de una sola carta. "
                    "Cada movimiento paga comisión y puede gatillar impuestos, así que conviene hacerlos de a poco, "
                    "empezando por los de arriba."),
    }

    with open(os.path.join(DATA, "rebalance.json"), "w", encoding="utf-8") as f:
        json.dump(salida, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Reorganización · {len(pesos)} posiciones por US${valor_total:,.2f}")
    print(f"  {titular}")
    a, d = salida["antes"], salida["despues"]
    print(f"  antes:   {a['posiciones']} posiciones ({a['efectivas']} efectivas) · mayor {a['mayor']['sym']} "
          f"{a['mayor']['peso']}% · grupo top {a['grupo_top']}% · vol {a['vol']}% · score {a['score']}")
    print(f"  después: {d['posiciones']} posiciones ({d['efectivas']} efectivas) · mayor {d['mayor']['sym']} "
          f"{d['mayor']['peso']}% · grupo top {d['grupo_top']}% · vol {d['vol']}% · score {d['score']}")
    for g in salida["grupos"][:4]:
        print(f"  grupo {g['peso']:.1f}% (corr {g['corr']}): {', '.join(g['syms'])}")
    print(f"  plan: {sum(1 for f in completo if f['accion'] == 'vender')} ventas, "
          f"{sum(1 for f in completo if f['accion'] == 'comprar')} compras")
    print(f"  esencial: {len(esencial['filas'])} movimientos → vol {esencial['vol']}% "
          f"({', '.join(f['sym'] for f in esencial['filas'])})")
    print(f"→ {os.path.join(DATA, 'rebalance.json')}")


if __name__ == "__main__":
    main()
