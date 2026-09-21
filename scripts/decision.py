#!/usr/bin/env python3
"""
Portfolio Decision Engine — enfoque quantamental sobre la cartera publicada.

Responde una sola pregunta, todos los días:

    ¿Cómo debería reorganizarse esta cartera HOY, considerando información
    nueva, riesgo, oportunidades y lo que cambió desde el análisis anterior?

Ninguna acción se evalúa sola. Cada posición se puntúa en siete componentes y
el resultado se lee siempre contra la cartera completa y contra el análisis
anterior: lo que importa no es el puntaje, es el CAMBIO.

    fundamentales y valoración   25%
    calidad y factores           15%
    técnico y momentum           15%
    earnings y revisiones        10%
    macro y régimen              10%
    institucionales y sentimiento 10%
    riesgo y diversificación     15%

El puntaje ordena, no decide. Antes que el puntaje mandan los vetos (deterioro
de caja, deuda acelerada, márgenes, dilución, concentración) y los cambios
materiales de tesis.

Dos honestidades que el motor mantiene explícitas:

  · Lo que no tiene, lo dice. No hay CPI ni PCE ni actas de la Fed en estos
    datos; el régimen se deduce de precios de mercado (cobre/oro, tasa a diez
    años, petróleo, dólar, VIX) y se etiqueta como tal. Nunca se inventa un dato.
  · Confianza por componente: si faltan fundamentales o el historial es corto,
    la componente pesa menos y se informa.

Salida: docs/data/decision.json
"""
from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from desks import positions_of                                    # noqa: E402
from rebalance import (correlacion, agrupar, retornos, desvio,    # noqa: E402
                       vol_cartera, coma, conviccion, objetivo, plan_completo,
                       plan_esencial, plan_aporte, MAX_POS, MAX_GRUPO, SCORE_FUERA)

PESOS = {"valoracion": 25, "calidad": 15, "tecnico": 15, "earnings": 10,
         "macro": 10, "flujos": 10, "riesgo": 15}

# Un cambio de estado tiene que costar: si no, la app propone operar todos los
# días por ruido y las comisiones se comen cualquier ventaja.
HISTERESIS = 6          # puntos de score que hay que mover para cambiar de estado
DELTA_MINIMO = 5        # cambio de score que vale la pena contar como "cambió"


def num(x, default=None):
    if isinstance(x, bool) or x is None:
        return default
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return default if v != v else v


def clamp(v, a=0.0, b=100.0):
    return max(a, min(b, v))


def escala(v, malo, bueno):
    """Lleva un indicador a 0-100 interpolando entre 'malo' y 'bueno'."""
    if v is None:
        return None
    if bueno == malo:
        return 50.0
    return clamp((v - malo) / (bueno - malo) * 100)


def promedio(pares):
    """Promedio ponderado de (valor, peso), ignorando los que no existen.
    Devuelve (valor, cobertura) donde cobertura es cuánto del peso tenía dato."""
    usados = [(v, w) for v, w in pares if v is not None]
    if not usados:
        return None, 0.0
    total_w = sum(w for _, w in usados)
    todos = sum(w for _, w in pares)
    return sum(v * w for v, w in usados) / total_w, total_w / todos if todos else 0.0


# ------------------------------------------------------------------ 1. macro
def regimen(market: dict, prev_macro: dict | None) -> dict:
    """Régimen implícito en los precios, con su dirección.

    No hay CPI ni PCE en estos datos y no se inventan. Lo que sí hay son los
    precios que reaccionan a esos datos antes que nadie: la tasa a diez años, el
    cobre contra el oro (crecimiento), el petróleo (inflación), el dólar y el
    VIX (condiciones financieras). El mercado no siempre acierta, pero es la
    lectura honesta con lo que tenemos.
    """
    def dato(sym):
        m = market.get(sym) or {}
        return num(m.get("price")), num(m.get("ret_1m")), num(m.get("ret_1w"))

    tasa, tasa_1m, _ = dato("^TNX")
    vix, vix_1m, _ = dato("^VIX")
    petroleo, petroleo_1m, _ = dato("CL=F")
    oro, oro_1m, _ = dato("GC=F")
    cobre, cobre_1m, _ = dato("HG=F")
    dolar, dolar_1m, _ = dato("DX-Y.NYB")
    small, small_1m, _ = dato("^RUT")
    sp, sp_1m, _ = dato("^GSPC")

    # Crecimiento: cobre contra oro, y las chicas contra el índice grande.
    crec = []
    if cobre_1m is not None and oro_1m is not None:
        crec.append(cobre_1m - oro_1m)
    if small_1m is not None and sp_1m is not None:
        crec.append((small_1m - sp_1m) * 1.5)
    g = sum(crec) / len(crec) if crec else None

    # Inflación: petróleo y la tasa larga tirando en la misma dirección.
    inf = [x for x in (petroleo_1m, (tasa_1m or 0) * 2 if tasa_1m is not None else None) if x is not None]
    i = sum(inf) / len(inf) if inf else None

    if g is None or i is None:
        etiqueta, detalle = "Indeterminado", "Faltan precios de referencia para clasificar el régimen."
    elif g >= 0 and i < 0:
        etiqueta = "Goldilocks"
        detalle = "Crecimiento sostenido con presión de precios cediendo: el mejor entorno para acciones de crecimiento."
    elif g >= 0 and i >= 0:
        etiqueta = "Reflación"
        detalle = "Crecimiento y precios subiendo juntos: favorece cíclicas y materias primas, castiga duración larga."
    elif g < 0 and i < 0:
        etiqueta = "Desaceleración / desinflación"
        detalle = "Actividad y precios cediendo: favorece calidad y balances sólidos, castiga lo especulativo."
    else:
        etiqueta = "Estanflación"
        detalle = "Actividad floja con precios firmes: el peor entorno para múltiplos altos."

    antes = (prev_macro or {}).get("label")
    senales = []
    if tasa is not None:
        senales.append(f"Tasa a 10 años en {coma(tasa, 2)}%" + (f", {coma(tasa_1m, 1)}% en el mes" if tasa_1m is not None else ""))
    if vix is not None:
        senales.append(f"VIX en {coma(vix, 1)}" + (" y subiendo" if (vix_1m or 0) > 10 else " y tranquilo" if vix < 20 else ""))
    if cobre_1m is not None and oro_1m is not None:
        senales.append(f"Cobre {coma(cobre_1m, 1)}% contra oro {coma(oro_1m, 1)}% en el mes")
    if dolar_1m is not None:
        senales.append(f"Dólar {coma(dolar_1m, 1)}% en el mes")

    return {"label": etiqueta, "detalle": detalle, "cambio": (antes and antes != etiqueta and antes) or None,
            "crecimiento": round(g, 2) if g is not None else None,
            "inflacion": round(i, 2) if i is not None else None,
            "senales": senales,
            "fuente": "Régimen deducido de precios de mercado (cobre/oro, tasa a 10 años, petróleo, dólar, VIX). "
                      "No son datos oficiales de CPI, PCE ni Fed: esos no están en esta fuente."}


def sensibilidad_macro(t: dict, reg: dict) -> float | None:
    """Cuánto le conviene a esta acción el régimen de hoy, de 0 a 100."""
    if reg["label"] == "Indeterminado":
        return None
    f = t.get("fund") or {}
    beta = num(f.get("beta"))
    pe = num(f.get("forward_pe"))
    sector = t.get("sector") or ""
    largo_plazo = pe is not None and pe > 30          # valoración que depende de tasas bajas
    ciclica = sector in ("Basic Materials", "Energy", "Industrials", "Financial Services")
    base = 50.0
    if reg["label"] == "Goldilocks":
        base = 70 if largo_plazo else 60
    elif reg["label"] == "Reflación":
        base = 70 if ciclica else (35 if largo_plazo else 50)
    elif reg["label"] == "Desaceleración / desinflación":
        base = 60 if (beta or 1) < 1 else 40
        if sector in ("Healthcare", "Consumer Defensive", "Utilities"):
            base = 70
    else:                                              # estanflación
        base = 25 if largo_plazo else (60 if sector == "Energy" else 40)
    if beta is not None:                               # la beta amplifica en ambos sentidos
        base += (base - 50) * min(beta, 3) * 0.15
    return clamp(base)


# ------------------------------------------------------- 2. las siete componentes
def c_valoracion(t):
    f = t.get("fund") or {}
    a = t.get("analysts") or {}
    pe, peg, fcf_y = num(f.get("forward_pe")), num(f.get("peg")), num(f.get("fcf_yield"))
    ev = num(f.get("ev_ebitda"))
    crec_v, crec_e = num(f.get("revenue_growth")), num(f.get("earnings_growth"))
    partes = [
        (escala(pe, 60, 12) if pe and pe > 0 else None, 6),
        (escala(peg, 3.5, 0.6) if peg and peg > 0 else None, 5),
        (escala(fcf_y, -2, 8) if fcf_y is not None else None, 5),
        (escala(ev, 40, 8) if ev and ev > 0 else None, 3),
        (escala(crec_v, -10, 40) if crec_v is not None else None, 3),
        (escala(crec_e, -20, 60) if crec_e is not None else None, 3),
        (escala(num(a.get("upside")), -20, 50), 3),
    ]
    return promedio(partes)


def c_calidad(t):
    f = t.get("fund") or {}
    roe, om, gm = num(f.get("roe")), num(f.get("operating_margin")), num(f.get("gross_margin"))
    de, cr = num(f.get("debt_to_equity")), num(f.get("current_ratio"))
    pm = num(f.get("profit_margin"))
    partes = [
        (escala(roe, -10, 35), 5),
        (escala(om, -15, 30), 4),
        (escala(gm, 10, 70), 3),
        (escala(pm, -15, 25), 3),
        (escala(de, 250, 20) if de is not None else None, 4),
        (escala(cr, 0.6, 2.5) if cr is not None else None, 2),
    ]
    return promedio(partes)


def c_tecnico(t):
    tc = t.get("tech") or {}
    p = num(t.get("price"))
    s20, s50, s200 = num(tc.get("sma20")), num(tc.get("sma50")), num(tc.get("sma200"))
    rsi, macd = num(tc.get("rsi")), num(tc.get("macd_hist"))
    ret = tc.get("ret") or {}
    tendencia = None
    if p and s50 and s200:
        pasos = sum([p > s20 if s20 else False, p > s50, p > s200, (s50 > s200)])
        tendencia = pasos / 4 * 100
    # RSI: ni "sobre 70 vender" ni "bajo 30 comprar". En tendencia sana un RSI
    # alto confirma; el castigo solo aparece en el extremo, donde el riesgo de
    # que el movimiento ya esté hecho es real.
    rsi_s = None
    if rsi is not None:
        rsi_s = 85 if 55 <= rsi <= 72 else (60 if 40 <= rsi < 55 else
                                            (45 if rsi > 80 else (35 if rsi > 72 else 30)))
    partes = [
        (tendencia, 6),
        (rsi_s, 3),
        (70 if (macd or 0) > 0 else 35 if macd is not None else None, 2),
        (escala(num(ret.get("3m")), -25, 35), 3),
        (escala(num(tc.get("vol_ratio")), 0.5, 1.6) if num(tc.get("vol_ratio")) else None, 1),
    ]
    return promedio(partes)


def rev_sana(v):
    """Una revisión de utilidades utilizable.

    Los datos publicados antes de la corrección traen porcentajes calculados
    sobre estimaciones que cruzaban el cero (-580% en un caso). Se acotan aquí
    también, para que un archivo viejo no desequilibre la componente.
    """
    x = num(v)
    return None if x is None else max(-100.0, min(100.0, x))


def c_earnings(t):
    a = t.get("analysts") or {}
    rev = a.get("revisions") or {}
    up, down = num(rev.get("up"), 0) or 0, num(rev.get("down"), 0) or 0
    balance = escala((up - down) / (up + down) * 100, -100, 100) if (up + down) else None
    sor = a.get("surprises") or []
    partes = [
        (escala(rev_sana(a.get("eps_rev90")), -8, 8), 5),
        (escala(rev_sana(a.get("eps_rev30")), -4, 4), 4),
        (balance, 4),
        (escala(num(a.get("eps_growth_next")), -15, 35), 3),
        (escala(num(a.get("rev_growth_next")), -5, 25), 2),
        (escala(sum(sor) / len(sor), -8, 12) if sor else None, 2),
    ]
    return promedio(partes)


def c_flujos(t):
    """Institucionales, insiders y posiciones cortas. Nunca se copia una
    operación institucional: se busca confluencia, y los 13F llegan tarde."""
    f = t.get("fund") or {}
    inst, ins = num(f.get("held_inst")), num(f.get("held_insiders"))
    short_pct, short_chg = num(f.get("short_pct")), num(f.get("short_chg"))
    gurus = len(t.get("gurus") or [])
    partes = [
        (escala(inst, 20, 85) if inst is not None else None, 3),
        (escala(ins, 0, 12) if ins is not None else None, 2),
        (escala(short_pct, 18, 1) if short_pct is not None else None, 3),
        (escala(short_chg, 25, -25) if short_chg is not None else None, 2),
        (clamp(45 + gurus * 9) if gurus else None, 2),
    ]
    return promedio(partes)


# -------------------------------------------------------------- 3. los vetos
def vetos(t, peso, grupo, peso_grupo, prev_t):
    """Problemas que mandan por encima del puntaje. Se muestran antes que él."""
    out = []
    f = t.get("fund") or {}
    a = t.get("analysts") or {}
    fcf_y, de = num(f.get("fcf_yield")), num(f.get("debt_to_equity"))
    om, pm = num(f.get("operating_margin")), num(f.get("profit_margin"))
    cr = num(f.get("current_ratio"))
    # Quemar caja no es un veto por sí solo: una empresa en fase de inversión lo
    # hace a propósito. Lo es cuando además el balance no aguanta el ritmo.
    frágil = (de is not None and de > 120) or (cr is not None and cr < 1.2) or (om is not None and om < 0)
    if fcf_y is not None and fcf_y < -2 and frágil:
        razon = ("con deuda alta" if de and de > 120 else
                 "sin caja para cubrir el corto plazo" if cr and cr < 1.2 else
                 "y encima pierde en la operación")
        out.append(("caja", f"Quema caja ({coma(fcf_y)}% de flujo libre sobre su valor) {razon}. "
                            f"Cada trimestre así acerca una ampliación de capital que te diluye."))
    if de is not None and de > 200:
        out.append(("deuda", f"Deuda sobre patrimonio en {coma(de, 0)}%: el balance manda más que la tesis."))
    if om is not None and om < 0 and pm is not None and pm < 0:
        out.append(("margenes", f"Pierde plata en la operación (margen operativo {coma(om)}%): no es un problema de precio, "
                                f"es de negocio."))
    prev_shares = num(((prev_t or {}).get("fund") or {}).get("shares"))
    shares = num(f.get("shares"))
    if prev_shares and shares and shares / prev_shares - 1 > 0.05:
        out.append(("dilucion", f"Emitió {coma((shares / prev_shares - 1) * 100)}% más acciones desde el análisis anterior: "
                                f"tu parte de la empresa se achicó."))
    rev90 = rev_sana(a.get("eps_rev90"))
    if a.get("eps_cruce90") == "a pérdidas":
        out.append(("guidance", "La estimación de utilidades del próximo año cruzó a pérdidas en 90 días: "
                                "Wall Street ya no espera que gane plata."))
    elif rev90 is not None and rev90 < -10:
        out.append(("guidance", f"Las estimaciones de utilidades del próximo año bajaron {coma(abs(rev90))}% "
                                f"en 90 días. Eso es un recorte, no ruido."))
    if peso > MAX_POS + 4:
        out.append(("concentracion", f"Pesa {coma(peso)}% de la cartera: pase lo que pase con la empresa, "
                                     f"esta posición sola decide tu resultado."))
    elif grupo and peso_grupo > MAX_GRUPO + 10:
        out.append(("concentracion", f"Forma parte de un grupo que se mueve junto y pesa {coma(peso_grupo, 0)}% "
                                     f"({', '.join(grupo[:4])}…)."))
    return out


# ------------------------------------------------------------- 4. el veredicto
ESTADOS = ["SALIR", "REDUCIR", "OBSERVAR", "MANTENER", "AUMENTAR"]


def estado_de(score, peso, meta, vets, t, cambio_fuerte):
    """Cinco estados. El puntaje ordena; los vetos y el peso deciden."""
    graves = [v for v in vets if v[0] in ("caja", "margenes", "guidance", "deuda")]
    if graves and score < 55:
        return "SALIR", graves[0][1]
    if t.get("signal") in ("sell", "strong_sell") and score < 50:
        return "SALIR", "El modelo de señales la tiene en venta y ninguna componente la sostiene."
    if vets:
        return "REDUCIR", vets[0][1]
    if meta is not None and peso - meta > 3:
        return "REDUCIR", f"Pesa {coma(peso)}% y su lugar en la cartera es {coma(meta)}%."
    if cambio_fuerte:
        return "OBSERVAR", cambio_fuerte
    if meta is not None and meta - peso > 3 and score >= 60:
        return "AUMENTAR", f"Puntaje {int(score)}/100 y pesa solo {coma(peso)}%: si la tesis vale, tiene que notarse."
    if score < 45:
        return "OBSERVAR", f"Puntaje {int(score)}/100: sin deterioro claro todavía, pero es la más floja de la cartera."
    return "MANTENER", "Tesis en pie y peso razonable."


def con_histeresis(nuevo, anterior, score, score_prev):
    """No se cambia de estado por un movimiento menor: se necesita que el puntaje
    se haya movido de verdad. Así la app no propone operar todos los días."""
    if not anterior or anterior == nuevo:
        return nuevo
    if score_prev is None:
        return nuevo
    if abs(score - score_prev) < HISTERESIS and {anterior, nuevo} <= {"MANTENER", "OBSERVAR", "AUMENTAR"}:
        return anterior          # movimientos chicos entre estados vecinos: se ignoran
    return nuevo


# --------------------------------------------------------------- 5. principal
def main():
    def carga(nombre, default):
        try:
            with open(os.path.join(DATA, nombre), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return default

    latest = carga("latest.json", None)
    if not latest:
        print("Sin latest.json: nada que decidir.")
        return
    tks = {t["sym"]: t for t in latest.get("tickers", [])}
    hist = carga("history.json", {})
    book = carga("portfolios.json", {"list": []})
    prev = carga("decision.json", {})
    prev_pos = {p["sym"]: p for p in (prev.get("posiciones") or [])}

    pf = next((p for p in book.get("list", []) if p.get("tx")), None)
    if not pf:
        print("Sin cartera publicada.")
        return
    posiciones = [p for p in positions_of(pf.get("tx", []), tks) if (p.get("value") or 0) > 0]
    total = sum(p["value"] for p in posiciones)
    if total <= 0:
        print("La cartera no tiene valor de mercado.")
        return
    pesos = {p["sym"]: p["value"] / total * 100 for p in posiciones}
    syms = sorted(pesos, key=lambda s: -pesos[s])

    # --- parentesco y riesgo -------------------------------------------------
    rets = {s: retornos(hist.get(s)) for s in syms}
    sigma = {s: (desvio(list(r.values())) if len(r) >= 40 else None) for s, r in rets.items()}
    cor = {}
    for i, a in enumerate(syms):
        for b in syms[i + 1:]:
            cor[(a, b)] = cor[(b, a)] = correlacion(rets[a], rets[b])
    grupos = agrupar(syms, cor, pesos)
    grupo_de = {s: g for g in grupos for s in g if len(g) > 1}
    peso_grupo = {s: sum(pesos.get(x, 0) for x in g) for g in grupos for s in g}
    vol_total = vol_cartera({s: w / 100 for s, w in pesos.items()}, sigma, cor)

    reg = regimen(latest.get("market") or {}, prev.get("macro"))
    # Meta preliminar solo con los puntajes del modelo, para poder clasificar
    # "pesa más/menos de lo que le corresponde". El plan definitivo se recalcula
    # después con la convicción ya corregida por los vetos; usar aquí esa meta
    # sería circular, porque depende de los estados que estamos calculando.
    metas = objetivo(pesos, {s: conviccion(tks.get(s) or {}) for s in syms}, grupos, total)

    # --- componente de riesgo de cartera, por posición -----------------------
    def c_riesgo(s):
        """Qué le aporta —o le quita— esta posición a la cartera completa."""
        w = pesos[s]
        partes = [
            (escala(w, MAX_POS * 1.8, 6), 5),                       # demasiado grande pesa en contra
            (escala(peso_grupo.get(s, w), MAX_GRUPO * 1.7, 12), 4),  # y repetir apuesta también
            (escala(sigma.get(s) * 100 if sigma.get(s) else None, 9, 2), 3),
            (escala(num((tks.get(s) or {}).get("fund", {}).get("beta")), 3.5, 0.7), 2),
        ]
        # Lo que no se mueve con el resto vale más de lo que su ficha dice sola.
        otras = [cor.get((s, x)) for x in syms if x != s and cor.get((s, x)) is not None]
        if otras:
            partes.append((escala(sum(otras) / len(otras), 0.75, 0.05), 4))
        return promedio(partes)

    filas, alertas_pos = [], []
    for s in syms:
        t = tks.get(s) or {}
        comps, cobertura = {}, {}
        for clave, fn in (("valoracion", c_valoracion), ("calidad", c_calidad), ("tecnico", c_tecnico),
                          ("earnings", c_earnings), ("flujos", c_flujos)):
            v, cob = fn(t)
            comps[clave], cobertura[clave] = v, cob
        comps["macro"] = sensibilidad_macro(t, reg)
        cobertura["macro"] = 1.0 if comps["macro"] is not None else 0.0
        comps["riesgo"], cobertura["riesgo"] = c_riesgo(s)

        score, cob_total = promedio([(comps[k], PESOS[k]) for k in PESOS])
        if score is None:
            continue
        p_ant = prev_pos.get(s) or {}
        score_prev = num(p_ant.get("score"))
        vets = vetos(t, pesos[s], grupo_de.get(s), peso_grupo.get(s, pesos[s]), p_ant)

        # --- qué cambió desde el análisis anterior ---------------------------
        cambios = []
        if score_prev is not None and abs(score - score_prev) >= DELTA_MINIMO:
            cambios.append(f"Puntaje {int(score_prev)} → {int(score)}")
        for clave, etiqueta in (("earnings", "Revisiones de utilidades"), ("tecnico", "Técnico"),
                                ("valoracion", "Valoración"), ("flujos", "Institucionales")):
            antes = num((p_ant.get("comp") or {}).get(clave))
            ahora = comps.get(clave)
            if antes is not None and ahora is not None and abs(ahora - antes) >= 12:
                cambios.append(f"{etiqueta} {int(antes)} → {int(ahora)}")
        peso_prev = num(p_ant.get("peso"))
        if peso_prev is not None and abs(pesos[s] - peso_prev) >= 2:
            cambios.append(f"Peso {coma(peso_prev)}% → {coma(pesos[s])}%")
        if t.get("signal") != p_ant.get("senal") and p_ant.get("senal"):
            cambios.append(f"Señal del modelo: {p_ant.get('senal')} → {t.get('signal')}")

        # "Observar" es para señales que se contradicen, no para cualquier cambio:
        # si todo mejora a la vez, eso no es una contradicción, es una tesis que
        # se confirma. Y un reporte de resultados encima también manda a observar.
        sube_score = score_prev is not None and score - score_prev >= DELTA_MINIMO
        baja_score = score_prev is not None and score_prev - score >= DELTA_MINIMO
        rev_ant = num((p_ant.get("comp") or {}).get("earnings"))
        rev_baja = rev_ant is not None and comps.get("earnings") is not None and rev_ant - comps["earnings"] >= 12
        rev_sube = rev_ant is not None and comps.get("earnings") is not None and comps["earnings"] - rev_ant >= 12
        contradiccion = (sube_score and rev_baja) or (baja_score and rev_sube)
        fuerte = None
        if contradiccion:
            fuerte = ("El puntaje mejora pero las expectativas de utilidades se están recortando: "
                      "el precio va para un lado y los analistas para el otro."
                      if sube_score else
                      "El puntaje cae mientras las expectativas de utilidades suben: puede ser una caída "
                      "de precio sobre un negocio que va bien.")
        dias_ev = None
        if t.get("earnings_date"):
            try:
                _d = datetime.strptime(t["earnings_date"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
                dias_ev = (_d - datetime.now(timezone.utc)).days
            except ValueError:
                dias_ev = None
        if not fuerte and dias_ev is not None and 0 <= dias_ev <= 10 and pesos[s] >= 5:
            fuerte = f"Reporta resultados en {dias_ev} días pesando {coma(pesos[s])}%: el dato manda sobre cualquier ajuste de hoy."
        bruto, motivo = estado_de(score, pesos[s], metas.get(s), vets, t, fuerte)
        estado = con_histeresis(bruto, p_ant.get("estado"), score, score_prev)
        if estado != bruto:
            motivo = p_ant.get("motivo") or motivo

        dias_earnings = None
        if t.get("earnings_date"):
            try:
                d = datetime.strptime(t["earnings_date"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
                dias_earnings = (d - datetime.now(timezone.utc)).days
            except ValueError:
                dias_earnings = None

        filas.append({
            "sym": s, "nombre": (t.get("name") or "")[:38], "peso": round(pesos[s], 1),
            "meta": metas.get(s), "score": round(score), "score_prev": round(score_prev) if score_prev is not None else None,
            "comp": {k: (round(v) if v is not None else None) for k, v in comps.items()},
            "confianza": round(cob_total * 100),
            "estado": estado, "motivo": motivo, "vetos": [{"tipo": a, "texto": b} for a, b in vets],
            "cambios": cambios[:4], "senal": t.get("signal"), "sector": t.get("sector"),
            "earnings_en": dias_earnings,
            "grupo": grupo_de.get(s, [])[:5] if grupo_de.get(s) else None,
        })

    filas.sort(key=lambda f: (ESTADOS.index(f["estado"]), -f["peso"]))

    # --- el plan concreto, ya alineado con los estados -----------------------
    # Antes el plan lo armaba rebalance.py sin saber de los vetos, y podía decir
    # "comprar APLD" mientras este motor decía "salir de APLD". Ahora la
    # convicción que alimenta al asignador sale de aquí: una posición vetada
    # vale cero por mucho puntaje que tenga.
    estado_de_sym = {f["sym"]: f["estado"] for f in filas}
    conv = {}
    for s in syms:
        t = tks.get(s) or {}
        c = conviccion(t)
        est = estado_de_sym.get(s)
        if est == "SALIR" or (num(t.get("score"), 0) or 0) < SCORE_FUERA:
            c = 0.0
        elif est == "REDUCIR":
            c *= 0.75
        elif est == "AUMENTAR":
            c *= 1.2
        elif est == "OBSERVAR":
            c *= 0.9
        conv[s] = c
    obj = objetivo(pesos, conv, grupos, total)
    plan = plan_completo(pesos, obj, total, tks, grupo_de, conv, len(obj))
    w_luego = {s: w / 100 for s, w in obj.items()}
    vol_luego = vol_cartera(w_luego, sigma, cor)
    esencial = plan_esencial(plan, pesos, total, sigma, cor, vol_total, vol_luego)
    aporte = plan_aporte(pesos, obj, total, 200.0, tks)
    metas = {s: round(w, 1) for s, w in obj.items()}
    for f in filas:                                   # la meta definitiva es la de este plan
        f["meta"] = metas.get(f["sym"], 0)

    # --- movimientos prioritarios: como máximo tres --------------------------
    ya_dicho = {p["sym"] for p in (prev.get("prioritarios") or [])}

    usd_de = {x["sym"]: x["usd"] for x in (plan or [])}

    def urgencia(f):
        """Qué tan importante es este movimiento, no solo qué tan malo es el activo.

        Salir de una posición de US$64 es menos importante que recortar una de
        US$930, por grave que sea el motivo: lo que mueve la cartera es la plata.
        """
        u = {"SALIR": 45, "REDUCIR": 35, "AUMENTAR": 25, "OBSERVAR": 12, "MANTENER": 0}[f["estado"]]
        u += len(f["vetos"]) * 10
        u += (usd_de.get(f["sym"], 0) / total * 100) * 2.5     # cuánto capital mueve
        if f["score_prev"] is not None:
            u += max(0, f["score_prev"] - f["score"])          # lo que se deterioró pesa más
        if f["cambios"]:
            u += 20                                            # lo nuevo va primero
        elif f["sym"] in ya_dicho:
            u -= 25      # ya se dijo ayer y nada cambió: repetirlo no aporta
        return u

    prioritarios, motivos_usados = [], []
    for f in sorted(filas, key=urgencia, reverse=True):
        if f["estado"] in ("MANTENER",) or len(prioritarios) >= 3:
            continue
        if f["estado"] == "OBSERVAR" and prioritarios:
            continue
        # Tres veces el mismo motivo no son tres movimientos prioritarios, son uno.
        firma = f["vetos"][0]["tipo"] if f["vetos"] else f["estado"]
        if motivos_usados.count(firma) >= 1 and len(filas) > 6:
            continue
        motivos_usados.append(firma)
        t = tks.get(f["sym"]) or {}
        mov = next((x for x in (plan or []) if x["sym"] == f["sym"]), None)
        accion = {"SALIR": "Salir", "REDUCIR": "Reducir", "AUMENTAR": "Aumentar", "OBSERVAR": "Vigilar"}[f["estado"]]
        if mov:
            accion += f" · {'vender' if mov['accion'] == 'vender' else 'comprar'} US${mov['usd']:,.0f}".replace(",", ".")
        tipos = {v["tipo"] for v in f["vetos"]}
        if f["estado"] == "SALIR":
            riesgo = ("Una acción que quema caja puede rebotar fuerte con una noticia buena: "
                      "vender es aceptar quedarse fuera de ese rebote."
                      if "caja" in tipos else
                      "El modelo puede equivocarse, y salir cierra la pérdida en vez de dejarla abierta.")
            invalida = ("Que vuelva a generar caja dos trimestres seguidos, o que levante capital "
                        "sin diluirte." if "caja" in tipos else
                        "Que las estimaciones de utilidades vuelvan a subir dos meses seguidos."
                        if "guidance" in tipos else
                        "Que el puntaje suba sobre 60 y el veto desaparezca.")
        elif f["estado"] == "REDUCIR":
            riesgo = ("Si el grupo entero sube, estarás menos expuesto justo cuando más rendía."
                      if f["grupo"] else
                      "Puede seguir subiendo sin ti: reducir es pagar ese costo a cambio de que una sola "
                      "posición deje de decidir tu resultado.")
            invalida = (f"Que su peso vuelva bajo {coma(MAX_POS)}% solo, por precio, sin vender nada."
                        if "concentracion" in tipos else
                        "Que el problema que la bajó de categoría se corrija en el próximo reporte.")
        elif f["estado"] == "AUMENTAR":
            riesgo = (f"Reporta resultados en {f['earnings_en']} días: comprar antes es comprar el dato a ciegas."
                      if f["earnings_en"] is not None and f["earnings_en"] < 21 else
                      "El puntaje mide lo conocido; el precio ya puede tenerlo incorporado.")
            invalida = "Que el puntaje caiga bajo 55 o aparezca cualquier veto."
        else:
            riesgo = ("Esperar también cuesta: si la señal se confirma, la entrada será más cara.")
            invalida = "Que el cambio que la puso en observación se revierta."
        prioritarios.append({
            "sym": f["sym"], "accion": accion, "estado": f["estado"],
            "por_que": f["motivo"],
            "que_cambio": " · ".join(f["cambios"]) or "Sin cambios desde el análisis anterior: la razón es estructural, no nueva.",
            "riesgo": riesgo, "invalida": invalida,
            "usd": mov["usd"] if mov else None,
        })

    # --- alertas de cartera: como máximo tres --------------------------------
    alertas = []
    mayor = filas[0] if filas else None
    top = max(filas, key=lambda f: f["peso"]) if filas else None
    if top and top["peso"] > MAX_POS:
        alertas.append({"tipo": "concentración",
                        "texto": f"{top['sym']} pesa {coma(top['peso'])}% de la cartera."})
    g0 = grupos[0] if grupos else []
    if len(g0) > 1 and peso_grupo.get(g0[0], 0) > MAX_GRUPO:
        c_max = max((cor.get((a, b)) or 0) for i, a in enumerate(g0) for b in g0[i + 1:])
        alertas.append({"tipo": "correlación",
                        "texto": f"{', '.join(g0[:4])}{'…' if len(g0) > 4 else ''} se mueven juntos "
                                 f"(correlación {coma(c_max, 2)}) y pesan {coma(peso_grupo[g0[0]], 0)}%."})
    pronto = [f for f in filas if f["earnings_en"] is not None and 0 <= f["earnings_en"] <= 14 and f["peso"] >= 5]
    if pronto:
        alertas.append({"tipo": "earnings",
                        "texto": f"{', '.join(x['sym'] for x in pronto[:3])} reporta"
                                 f"{'n' if len(pronto) > 1 else ''} en menos de dos semanas pesando "
                                 f"{coma(sum(x['peso'] for x in pronto), 0)}% juntas."})
    deterioro = [f for f in filas if f["score_prev"] is not None and f["score_prev"] - f["score"] >= 8]
    if deterioro and len(alertas) < 3:
        alertas.append({"tipo": "deterioro",
                        "texto": f"{', '.join(x['sym'] for x in deterioro[:3])} perdió puntaje desde el análisis anterior."})
    if reg.get("cambio") and len(alertas) < 3:
        alertas.append({"tipo": "macro",
                        "texto": f"El régimen de mercado pasó de {reg['cambio']} a {reg['label']}."})
    alertas = alertas[:3]

    # --- qué vigilar: como máximo cinco --------------------------------------
    vigilar = []
    for f in sorted(filas, key=lambda x: (x["earnings_en"] if x["earnings_en"] is not None else 999)):
        if f["earnings_en"] is not None and 0 <= f["earnings_en"] <= 45 and f["peso"] >= 4:
            vigilar.append(f"Resultados de {f['sym']} en {f['earnings_en']} días ({coma(f['peso'])}% de la cartera).")
        if len(vigilar) >= 2:
            break
    if reg["label"] != "Indeterminado":
        vigilar.append(f"Que el régimen deje de ser {reg['label']}: hoy se lee en la tasa a 10 años y el cobre contra el oro.")
    obs = [f for f in filas if f["estado"] == "OBSERVAR"][:2]
    for f in obs:
        vigilar.append(f"{f['sym']}: {f['motivo'][:90]}")
    if top and top["peso"] > MAX_POS:
        vigilar.append(f"Que {top['sym']} siga creciendo por precio: sobre {coma(MAX_POS + 5)}% deja de ser una posición y pasa a ser la cartera.")
    vigilar = vigilar[:5]

    # --- diagnóstico: cuatro a seis líneas -----------------------------------
    cuenta = {e: sum(1 for f in filas if f["estado"] == e) for e in ESTADOS}
    plata = f"US${total:,.2f}".replace(",", "@").replace(".", ",").replace("@", ".")
    diag = [f"{len(filas)} posiciones por {plata}"
            + (f", con una volatilidad diaria de {coma(vol_total, 2)}%." if vol_total else
               " (sin historial suficiente para medir su riesgo todavía)."),
            f"Régimen {reg['label'].lower()}: {reg['detalle']}"]
    if alertas:
        diag.append(alertas[0]["texto"])
    movidos = [f for f in filas if f["cambios"]]
    diag.append(f"Desde el análisis anterior cambió algo en {len(movidos)} de {len(filas)} posiciones."
                if movidos else "Nada material cambió desde el análisis anterior.")
    diag.append(", ".join(f"{cuenta[e]} {e.lower()}" for e in ESTADOS if cuenta[e]) + ".")

    salida = {
        "date": latest.get("date"),
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "prev_date": prev.get("date"),
        "valor": round(total, 2),
        "vol": round(vol_total, 2) if vol_total else None,
        "macro": reg,
        "diagnostico": diag,
        "posiciones": filas,
        "plan": plan,
        "esencial": esencial,
        "aporte": {"monto": 200.0, "filas": aporte},
        "despues": {"posiciones": len(obj), "vol": round(vol_luego, 2) if vol_luego else None,
                    "mayor": {"sym": max(obj, key=obj.get) if obj else None,
                              "peso": round(max(obj.values()), 1) if obj else None},
                    "grupo_top": round(max((sum(w_luego.get(x, 0) for x in g) * 100 for g in grupos), default=0), 1)},
        "antes": {"posiciones": len(pesos), "vol": round(vol_total, 2) if vol_total else None,
                  "mayor": {"sym": syms[0], "peso": round(pesos[syms[0]], 1)},
                  "grupo_top": round(max((sum(pesos.get(x, 0) for x in g) for g in grupos), default=0), 1)},
        "grupos": [{"syms": g, "peso": round(sum(pesos.get(x, 0) for x in g), 1),
                    "corr": round(max((cor.get((a, b)) or 0) for i, a in enumerate(g) for b in g[i + 1:]), 2)}
                   for g in grupos if len(g) > 1],
        "prioritarios": prioritarios,
        "alertas": alertas,
        "vigilar": vigilar,
        "conteo": cuenta,
        "pesos_modelo": PESOS,
        "nota": ("El puntaje ordena información; no decide solo. Mandan los vetos y los cambios de tesis. "
                 "Las componentes con poca cobertura de datos bajan la confianza de la posición, y lo que "
                 "no está en la fuente no se inventa."),
    }
    with open(os.path.join(DATA, "decision.json"), "w", encoding="utf-8") as f:
        json.dump(salida, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Decision engine · {len(filas)} posiciones · US${total:,.2f} · vol {salida['vol']}%")
    print(f"  régimen: {reg['label']} ({reg['detalle'][:60]}…)")
    for l in diag:
        print(f"  · {l}")
    print("  estados:", ", ".join(f"{e}={cuenta[e]}" for e in ESTADOS if cuenta[e]))
    for p in prioritarios:
        print(f"  → {p['sym']}: {p['accion']} — {p['por_que'][:70]}")
    for a in alertas:
        print(f"  ⚠ {a['tipo']}: {a['texto'][:80]}")
    print(f"→ {os.path.join(DATA, 'decision.json')}")


if __name__ == "__main__":
    main()
