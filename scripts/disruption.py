#!/usr/bin/env python3
"""
Radar de disrupción: las 20 ideas con más potencial desproporcionado.

El radar normal responde "¿qué está bien hoy?". Este responde otra pregunta:
"¿dónde hay un cambio grande que el mercado todavía no ha puesto en precio?".
Son cosas distintas y a menudo opuestas: una acción que ya subió y gusta a todos
los analistas puntúa alto en el modelo y bajo aquí, porque ya no queda sorpresa.

Metodología — cuatro pilares, cada uno 0-100, sobre datos, no sobre opiniones:

  1. ASIMETRÍA (35%). Cuánto se puede ganar contra cuánto se puede perder.
     Usa el escenario alcista de los analistas, la distancia al máximo de 52
     semanas y la dispersión de objetivos (cuando los analistas no se ponen de
     acuerdo, hay algo sin resolver, y eso es opcionalidad).

  2. DESAPERCIBIDA (25%). Lo que nadie mira es donde queda precio por descubrir:
     pocos analistas cubriéndola, capitalización chica, ningún gurú dentro, poca
     prensa. Una empresa seguida por 40 analistas ya no tiene nada escondido.

  3. CATALIZADOR (25%). Que el cambio esté empezando, no que sea eterno:
     revisiones de utilidades al alza, crecimiento fuerte, volumen inusual,
     giro de tendencia, resultados a la vuelta de la esquina.

  4. TEMA (15%). En qué ola estructural está: IA, computación cuántica,
     biotecnología, defensa y espacio, nuclear, materiales críticos…

El RIESGO DE RUINA se calcula aparte y nunca se mezcla con el puntaje, porque
promediar riesgo con potencial es como esconder la mitad de la historia. Quema de
caja, deuda, volatilidad, caída desde máximos y tamaño mínimo. Una idea puede ser
"asimetría 12:1" y a la vez "riesgo extremo": ambas cosas son ciertas y el que
decide tiene que ver las dos.

Cada idea se clasifica en el horizonte donde su evidencia es más fuerte: corto
(un catalizador con fecha), mediano (una inflexión en marcha) o largo (una ola
estructural).

Salida: docs/data/disruption.json
"""
from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")

SIG_ES = {"strong_buy": "Compra fuerte", "buy": "Compra", "hold": "Mantener",
          "sell": "Venta", "strong_sell": "Venta fuerte"}

# ---------------------------------------------------------------------------
# Temas estructurales. El peso es cuánta disrupción cabe en esa industria: una
# empresa de tabaco puede ser un gran negocio, pero no va a cambiar el mundo.
TEMAS = {
    "Semiconductors": ("Semiconductores e IA", 95),
    "Semiconductor Equipment & Materials": ("Equipos para chips", 90),
    "Software - Infrastructure": ("Infraestructura de software e IA", 85),
    "Software - Application": ("Software de aplicación", 70),
    "Information Technology Services": ("Servicios de TI", 55),
    "Computer Hardware": ("Hardware y centros de datos", 80),
    "Communication Equipment": ("Redes y óptica", 70),
    "Electronic Components": ("Componentes electrónicos", 65),
    "Scientific & Technical Instruments": ("Instrumentos científicos", 70),
    "Biotechnology": ("Biotecnología y terapias nuevas", 95),
    "Diagnostics & Research": ("Diagnóstico y genómica", 85),
    "Medical Devices": ("Dispositivos médicos", 80),
    "Medical Instruments & Supplies": ("Instrumental médico", 70),
    "Health Information Services": ("Salud digital", 80),
    "Drug Manufacturers - Specialty & Generic": ("Farmacéutica especializada", 75),
    "Drug Manufacturers - General": ("Farmacéutica", 65),
    "Medical Care Facilities": ("Servicios de salud", 45),
    "Aerospace & Defense": ("Defensa y espacio", 90),
    "Airports & Air Services": ("Servicios aéreos", 40),
    "Uranium": ("Nuclear y uranio", 90),
    "Utilities - Independent Power Producers": ("Generación para centros de datos", 80),
    "Utilities - Renewable": ("Renovables", 75),
    "Solar": ("Solar", 75),
    "Electrical Equipment & Parts": ("Red eléctrica y almacenamiento", 75),
    "Specialty Industrial Machinery": ("Automatización y robótica", 70),
    "Farm & Heavy Construction Machinery": ("Maquinaria pesada", 45),
    "Engineering & Construction": ("Infraestructura y centros de datos", 60),
    "Pollution & Treatment Controls": ("Tratamiento y agua", 55),
    "Waste Management": ("Residuos y economía circular", 45),
    "Auto Manufacturers": ("Vehículos eléctricos y autonomía", 80),
    "Auto Parts": ("Componentes para movilidad", 55),
    "Copper": ("Cobre: electrificación", 70),
    "Other Industrial Metals & Mining": ("Materiales críticos", 70),
    "Specialty Chemicals": ("Química especializada", 60),
    "Chemicals": ("Química", 45),
    "Agricultural Inputs": ("Insumos agrícolas: litio y fertilizantes", 65),
    "Steel": ("Acero", 35),
    "Gold": ("Oro", 30),
    "Silver": ("Plata", 35),
    "Other Precious Metals & Mining": ("Metales preciosos", 35),
    "Capital Markets": ("Mercados de capitales y cripto", 60),
    "Credit Services": ("Pagos y fintech", 65),
    "Financial Data & Stock Exchanges": ("Datos financieros", 55),
    "Internet Content & Information": ("Plataformas de internet", 70),
    "Internet Retail": ("Comercio electrónico", 60),
    "Electronic Gaming & Multimedia": ("Videojuegos y mundos virtuales", 60),
    "Entertainment": ("Entretenimiento", 45),
    "Telecom Services": ("Telecomunicaciones", 40),
    "Oil & Gas E&P": ("Petróleo y gas", 25),
    "Oil & Gas Equipment & Services": ("Servicios petroleros", 30),
    "Oil & Gas Drilling": ("Perforación", 25),
    "Oil & Gas Integrated": ("Energía integrada", 25),
    "Oil & Gas Midstream": ("Transporte de energía", 25),
    "Oil & Gas Refining & Marketing": ("Refinación", 20),
    "Coking Coal": ("Carbón metalúrgico", 20),
    "Marine Shipping": ("Transporte marítimo", 30),
    "Integrated Freight & Logistics": ("Logística", 40),
    "Railroads": ("Ferrocarriles", 30),
    "Trucking": ("Transporte terrestre", 30),
    "Education & Training Services": ("Educación", 45),
    "Specialty Business Services": ("Servicios especializados", 40),
    "Consulting Services": ("Consultoría", 40),
}
TEMA_DEFECTO = ("Negocio tradicional", 25)

# La clasificación de Yahoo mete la computación cuántica en "hardware" y a los
# reactores modulares en "maquinaria". El nombre de la empresa afina eso.
TEMAS_NOMBRE = [
    (("quantum", "qubit"), ("Computación cuántica", 98)),
    (("nuclear", "oklo", "nano nuclear", "uranium", "fission"), ("Nuclear de nueva generación", 92)),
    (("space", "lunar", "orbit", "rocket", "astro", "satell", "intuitive machines"), ("Espacio", 92)),
    (("aviation", "aero", "evtol", "archer", "joby"), ("Movilidad aérea autónoma", 88)),
    (("lithium", "litio"), ("Litio y baterías", 82)),
    (("bitcoin", "blockchain", "crypto", "digital asset"), ("Cripto-infraestructura", 75)),
    (("therapeutic", "biosc", "genom", "oncolog", "immun", "cell", "gene"), ("Biotecnología y terapias nuevas", 95)),
    (("robot", "autonom"), ("Robótica y autonomía", 88)),
    (("hydrogen", "fuel cell"), ("Hidrógeno", 78)),
    (("drone", "unmanned"), ("Drones y sistemas no tripulados", 88)),
]


# ---------------------------------------------------------------- utilidades
def num(x, d=None):
    if isinstance(x, bool) or x is None:
        return d
    try:
        v = float(x)
    except (TypeError, ValueError):
        return d
    return d if v != v else v


def esc(v, lo, hi):
    """Lleva v al rango 0-100 entre lo y hi, recortando fuera de los extremos."""
    v = num(v)
    if v is None:
        return None
    if hi == lo:
        return 50.0
    return max(0.0, min(100.0, (v - lo) / (hi - lo) * 100))


def mezcla(pares):
    """Promedio ponderado que ignora lo que no se pudo calcular."""
    tot = peso = 0.0
    for v, w in pares:
        if v is None:
            continue
        tot += v * w
        peso += w
    return tot / peso if peso else None


def usd(v, dec=2):
    if v is None:
        return "—"
    return f"US${v:,.{dec}f}".replace(",", "@").replace(".", ",").replace("@", ".")


def pct(v, dec=0):
    if v is None:
        return "—"
    return f"{v:+.{dec}f}%".replace(".", ",")


def big(v):
    if not v:
        return "—"
    for lim, suf in ((1e12, " billones"), (1e9, "MM"), (1e6, "M")):
        if abs(v) >= lim:
            return f"US${v / lim:,.1f}{suf}".replace(",", "@").replace(".", ",").replace("@", ".")
    return usd(v, 0)


# ---------------------------------------------------------------- pilares
def p_asimetria(t):
    """Cuánto se puede ganar frente a lo que ya está descontado en el precio."""
    price = num(t.get("price"))
    a = t.get("analysts") or {}
    tg = a.get("target") or {}
    tech = t.get("tech") or {}
    if not price:
        return None, {}

    alto, medio, bajo = num(tg.get("high")), num(tg.get("mean")), num(tg.get("low"))
    hi52 = num(tech.get("hi52"))
    det = {}

    # Objetivos disparatados (los típicos de una acción que se desplomó y nadie
    # actualizó) se recortan: sirven de señal, no de promesa.
    up_alto = min((alto / price - 1) * 100, 400) if alto and alto > price else None
    up_medio = min((medio / price - 1) * 100, 300) if medio and medio > price else None
    recupera = min((hi52 / price - 1) * 100, 400) if hi52 and hi52 > price else None
    dispersion = ((alto / bajo) if (alto and bajo and bajo > 0) else None)

    det["upside_alto"] = up_alto
    det["upside_medio"] = up_medio
    det["recuperacion_52s"] = recupera
    det["dispersion"] = dispersion
    det["stale"] = bool(up_medio and up_medio >= 250)      # objetivo probablemente viejo

    bruto = mezcla([
        (esc(up_alto, 20, 250), 3),
        (esc(up_medio, 5, 120), 2),
        (esc(recupera, 15, 200), 2),
        (esc(dispersion, 1.3, 4.0), 1),
    ])
    # Un objetivo que nadie actualizó desde antes del desplome no puede valer lo
    # mismo que uno vigente: cuenta, pero con descuento.
    if bruto is not None and det["stale"]:
        bruto *= 0.75
    return bruto, det


def p_olvido(t, vol_dolar):
    """Lo que nadie cubre es donde queda precio por descubrir."""
    f = t.get("fund") or {}
    a = t.get("analysts") or {}
    cap = num(f.get("market_cap"))
    n_an = num(a.get("count"), 0) or 0
    noticias = len(t.get("news") or [])
    gurus = len(t.get("gurus") or [])
    det = {"analistas": int(n_an), "cap": cap, "noticias": noticias, "gurus": gurus}

    cobertura = esc(-n_an, -30, -2)                          # 2 analistas → 100
    tamano = esc(-math.log10(cap), -11.0, -8.3) if cap and cap > 0 else None  # 200M → alto
    prensa = esc(-noticias, -4, 0)
    sin_gurus = 100.0 if gurus == 0 else max(0.0, 60 - gurus * 15)
    liquidez = esc(-math.log10(vol_dolar), -9.5, -6.5) if vol_dolar and vol_dolar > 0 else None

    return mezcla([(cobertura, 3), (tamano, 3), (prensa, 1), (sin_gurus, 1), (liquidez, 1)]), det


def p_catalizador(t, hoy, cambios):
    """Que el cambio esté empezando, no que sea una promesa eterna."""
    f, tech, a = t.get("fund") or {}, t.get("tech") or {}, t.get("analysts") or {}
    rev = a.get("revisions") or {}
    ret = tech.get("ret") or {}
    det = {}

    up, down = num(rev.get("up"), 0) or 0, num(rev.get("down"), 0) or 0
    revisiones = esc((up - down) / max(up + down, 1) * 100, -20, 80) if (up + down) else None
    det["revisiones"] = f"{int(up)}↑ / {int(down)}↓" if (up + down) else None
    det["revisiones_al_alza"] = bool(up > down)
    det["revisiones_a_la_baja"] = bool(down > up)

    crec = max(num(f.get("revenue_growth"), -100) or -100, num(f.get("earnings_growth"), -100) or -100)
    crecimiento = esc(crec, 5, 80) if crec > -100 else None
    det["crecimiento"] = crec if crec > -100 else None

    vr = num(tech.get("vol_ratio"))
    volumen = esc(vr, 1.0, 2.5)
    det["vol_ratio"] = vr

    m1, m3 = num(ret.get("1m")), num(ret.get("3m"))
    giro = 100.0 if (m1 is not None and m3 is not None and m1 > 5 and m3 < 0) else (
        60.0 if (m1 is not None and m1 > 10) else None)
    det["giro"] = bool(giro == 100.0)

    dias = None
    ed = t.get("earnings_date")
    if ed:
        try:
            dias = (datetime.strptime(ed, "%Y-%m-%d").date() - hoy).days
        except ValueError:
            dias = None
    evento = esc(-dias, -60, -3) if (dias is not None and 0 <= dias <= 60) else None
    det["dias_resultados"] = dias if (dias is not None and 0 <= dias <= 60) else None

    hot = next((n for n in (t.get("news") or []) if n.get("nivel") == "alta"), None)
    noticia = 80.0 if hot else None
    det["titular"] = (hot.get("t_es") or hot.get("t"))[:120] if hot else None

    ch = cambios.get(t["sym"])
    mejora = 90.0 if (ch and ch.get("dir") == "up") else None
    det["cambio_senal"] = f"{SIG_ES.get(ch['from'], '')} → {SIG_ES.get(ch['to'], '')}" if ch else None

    return mezcla([(revisiones, 3), (crecimiento, 3), (volumen, 2), (giro, 2),
                   (evento, 1.5), (noticia, 1.5), (mejora, 1)]), det


def p_tema(t):
    nombre, peso = TEMAS.get(t.get("industry") or "", TEMA_DEFECTO)
    low = (t.get("name") or "").lower()
    for claves, (n2, p2) in TEMAS_NOMBRE:
        if any(k in low for k in claves):
            nombre, peso = n2, max(peso, p2)          # el nombre precisa el tema
            break
    return float(peso), {"tema": nombre}


def riesgo_ruina(t, vol_dolar):
    """Lo que puede hacer que la idea valga cero. Se informa aparte del puntaje."""
    f, tech = t.get("fund") or {}, t.get("tech") or {}
    price, cap = num(t.get("price")), num(f.get("market_cap"))
    fcf = num(f.get("fcf_yield"))
    motivos, s = [], 0.0

    margen = num(f.get("profit_margin"))
    if margen is not None and margen <= 0:
        s += 22
        motivos.append("No gana dinero todavía: su precio es una apuesta a que el futuro llegue, y mientras tanto se financia emitiendo acciones")
    if fcf is not None and fcf < 0:
        # fcf_yield es la caja libre sobre la capitalización: -50% significa que
        # en un año quema la mitad de lo que vale. Eso termina en dilución.
        quema = min(abs(fcf), 200)
        s += esc(quema, 3, 100) * 0.3
        if fcf <= -20:
            motivos.append(f"Quema caja al {abs(fcf):.0f}% de su valor de mercado al año: la dilución no es un riesgo, es el plan".replace(".", ","))
    de = num(f.get("debt_to_equity"))
    if de is not None and de > 120:
        s += esc(de, 120, 400) * 0.15
        motivos.append(f"Deuda sobre patrimonio de {de:.0f}%".replace(".", ","))
    v30 = num(tech.get("vol30"))
    if v30:
        s += esc(v30, 35, 110) * 0.28
        if v30 >= 70:
            motivos.append(f"Volatilidad anual de {v30:.0f}%: movimientos diarios de dos dígitos son normales".replace(".", ","))
    dd = num(tech.get("max_dd"))
    if dd is not None and dd < -45:
        s += esc(-dd, 45, 90) * 0.22
        motivos.append(f"Cayó {abs(dd):.0f}% desde su máximo del último año".replace(".", ","))
    if cap and cap < 3e8:
        s += 15
        motivos.append(f"Capitalización de {big(cap)}: cualquier noticia la mueve entero")
    if price and price < 1:
        s += 15
        motivos.append(f"Precio bajo US$1: riesgo de deslistado y de contrasplit")
    if vol_dolar and vol_dolar < 1e6:
        s += 10
        motivos.append("Se negocia poco: entrar y salir mueve el precio en contra")

    s = max(0.0, min(100.0, s))
    label = "Extremo" if s >= 70 else "Alto" if s >= 45 else "Medio" if s >= 25 else "Contenido"
    return s, label, motivos[:4]


# ---------------------------------------------------------------- horizonte
def horizonte_de(t, cat_det, tema_peso, asim_det):
    """Dónde está la evidencia más fuerte: una fecha, una inflexión o una ola.
    Cada horizonte se normaliza sobre su propio máximo para que compitan de igual
    a igual; si no, el mediano se lleva casi todo por tener más casillas."""
    tech, f = t.get("tech") or {}, t.get("fund") or {}

    corto = 0.0
    dias = cat_det.get("dias_resultados")
    if dias is not None and dias <= 21:
        corto += 50                                   # una fecha concreta manda
    elif dias is not None and dias <= 45:
        corto += 25
    if cat_det.get("titular"):
        corto += 20
    if cat_det.get("cambio_senal"):
        corto += 20
    if (num(tech.get("vol_ratio"), 1) or 1) >= 1.5:
        corto += 20
    if cat_det.get("giro"):
        corto += 15
    corto = min(100.0, corto / 125 * 100)

    medio = 0.0
    if cat_det.get("revisiones"):
        medio += 25
    if (cat_det.get("crecimiento") or 0) > 20:
        medio += 25
    if (asim_det.get("upside_medio") or 0) > 25:
        medio += 25
    if t["h"]["medium"]["s"] >= 60:
        medio += 25
    medio = min(100.0, medio)

    largo = 0.0
    largo += min(45.0, tema_peso * 0.45)              # la ola estructural pesa
    if (num(f.get("revenue_growth"), 0) or 0) > 25:
        largo += 20
    if t["h"]["long"]["s"] >= 60:
        largo += 20
    if (asim_det.get("upside_alto") or 0) > 120:
        largo += 15
    largo = min(100.0, largo)

    # Empate técnico: manda el corto solo si hay una fecha, y el largo solo si el
    # tema es de verdad estructural.
    orden = sorted(((corto, "corto"), (medio, "mediano"), (largo, "largo")), reverse=True)
    mejor = orden[0][1]
    if mejor == "corto" and dias is None and not cat_det.get("cambio_senal"):
        mejor = orden[1][1]
    if mejor == "largo" and tema_peso < 60:
        mejor = "mediano"
    return mejor, {"corto": round(corto), "mediano": round(medio), "largo": round(largo)}


# ---------------------------------------------------------------- narrativa
def por_que(t, partes, det_a, det_o, det_c, det_t, asim_ratio):
    """Las tres o cuatro frases que justifican la idea, con sus números."""
    out = []
    if det_o["analistas"] and det_o["analistas"] <= 8:
        out.append(f"La siguen solo {det_o['analistas']} analistas y no aparece en ninguna cartera de los gurús que rastrea la app: hay poca gente mirándola."
                   if not det_o["gurus"] else
                   f"La siguen solo {det_o['analistas']} analistas, muy poca cobertura para su tamaño.")
    if det_o["cap"]:
        out.append(f"Capitalización de {big(det_o['cap'])}: chica como para que un contrato o una aprobación la muevan de verdad.")
    if det_a.get("stale"):
        out.append("El objetivo de los analistas quedó tan lejos del precio que casi con seguridad no se actualizó tras la caída: "
                   "sirve para saber que alguna vez hubo una tesis ambiciosa, no como pronóstico.")
    elif det_a.get("upside_alto"):
        out.append(f"En el escenario alcista de los analistas vale {pct(det_a['upside_alto'])} más que hoy"
                   + (f", y aun en el promedio {pct(det_a['upside_medio'])}." if det_a.get("upside_medio") else "."))
    elif det_a.get("recuperacion_52s"):
        out.append(f"Está {pct(-det_a['recuperacion_52s'] / (1 + det_a['recuperacion_52s'] / 100))} bajo su máximo de 52 semanas: volver ahí ya sería {pct(det_a['recuperacion_52s'])}.")
    if det_c.get("revisiones") and det_c.get("revisiones_al_alza"):
        out.append(f"Los analistas subieron estimaciones {det_c['revisiones']} en 30 días: alguien ya está viendo algo distinto.")
    elif det_c.get("revisiones") and det_c.get("revisiones_a_la_baja"):
        out.append(f"Cuidado: las revisiones de los últimos 30 días van {det_c['revisiones']}, en contra de la tesis.")
    if det_c.get("crecimiento") and det_c["crecimiento"] > 20:
        out.append(f"Crece {pct(det_c['crecimiento'])} y eso todavía no se refleja en cómo la trata el mercado.")
    if det_c.get("giro"):
        out.append("Giró al alza el último mes después de un trimestre malo: el patrón con más recorrido histórico de esta lista, y también el que más falsos positivos da.")
    if det_c.get("vol_ratio") and det_c["vol_ratio"] >= 1.5:
        veces = f"{det_c['vol_ratio']:.1f}".replace(".", ",")
        out.append(f"Se negocia {veces} veces su volumen normal: dinero grande moviéndose antes del titular.")
    if det_c.get("dias_resultados") is not None:
        out.append(f"Reporta resultados en {det_c['dias_resultados']} días: fecha concreta donde la tesis se confirma o se cae.")
    if det_c.get("titular"):
        out.append(f"Titular reciente de alta prioridad: {det_c['titular']}")
    if asim_ratio:
        out.append(f"Relación entre lo que puedes ganar y lo que arriesgas hasta el stop: {asim_ratio}.")
    return out[:6]


def discrepancia(t, score, riesgo_s):
    """El caso interesante: el modelo dice una cosa y la asimetría dice otra."""
    sig = t["signal"]
    if sig in ("sell", "strong_sell") and score >= 55:
        return (f"El modelo cuantitativo la marca **{SIG_ES[sig]} ({t['score']}/100)** porque puntúa lo que ya pasó: "
                f"tendencia, momentum y números actuales. Esta lista mira lo contrario, lo que todavía no pasó. "
                f"Las dos lecturas pueden ser ciertas a la vez: hoy está mal y el premio está en que cambie. "
                f"Es una apuesta a un cambio, no una inversión por fundamentos, y se dimensiona como tal.")
    if sig in ("strong_buy", "buy") and score >= 55:
        return (f"Aquí el modelo y esta lista coinciden: **{SIG_ES[sig]} ({t['score']}/100)** por los números de hoy "
                f"y potencial desproporcionado por lo que puede venir. Es el caso más cómodo de los dos mundos.")
    return None


# ---------------------------------------------------------------- main
def evaluar(t, hoy, cambios):
    tech = t.get("tech") or {}
    price = num(t.get("price"))
    vol_dolar = None
    cap = num((t.get("fund") or {}).get("market_cap"))
    vr = num(tech.get("vol_ratio"))
    if cap and vr:
        vol_dolar = cap * 0.004 * vr            # aproximación: ~0,4% de la cap al día

    a, det_a = p_asimetria(t)
    o, det_o = p_olvido(t, vol_dolar)
    c, det_c = p_catalizador(t, hoy, cambios)
    te, det_t = p_tema(t)
    if a is None or o is None:
        return None

    score = mezcla([(a, 35), (o, 25), (c, 25), (te, 15)])
    r_s, r_label, r_motivos = riesgo_ruina(t, vol_dolar)


    # Techo y suelo de la tesis, no del día. El suelo sale del mínimo de 52
    # semanas y de lo que la propia volatilidad del activo hace creíble: para una
    # acción que se mueve 80% al año, un escenario malo es perder la mitad.
    tg = (t.get("analysts") or {}).get("target") or {}
    alto, bajo = num(tg.get("high")), num(tg.get("low"))
    lo52, hi52 = num(tech.get("lo52")), num(tech.get("hi52"))
    v30 = num(tech.get("vol30"), 50) or 50
    ratio = techo = piso = None
    if price:
        techo = min(alto, price * 4) if (alto and alto > price) else (hi52 if (hi52 and hi52 > price) else None)
        caida = price * (1 - min(0.80, max(0.25, v30 / 150)))
        piso = min([x for x in (lo52 if (lo52 and lo52 < price) else None, caida) if x] or [caida])
        if r_s >= 70:
            piso = min(piso, price * 0.15)            # riesgo de ruina: puede irse a casi nada
        if techo and piso and piso < price:
            r = (techo - price) / (price - piso)
            ratio = f"{min(r, 20):.1f}:1".replace(".", ",") + (" o más" if r > 20 else "")
    atr = num(tech.get("atr_pct"), 0) or 0
    stop = price * (1 - 2.5 * atr / 100) if price and atr else None

    hz, hz_det = horizonte_de(t, det_c, te, det_a)
    return {
        "sym": t["sym"], "name": t.get("name"), "sector": t.get("sector"),
        "industry": t.get("industry"), "tema": det_t["tema"],
        "horizonte": hz, "horizontes": hz_det,
        "score": round(score),
        "partes": {"asimetria": round(a), "olvido": round(o), "catalizador": round(c), "tema": round(te)},
        "precio": price, "stop": stop, "asimetria": ratio,
        "escenarios": {"techo": techo, "piso": piso},
        "objetivo": {k: num((t.get("analysts") or {}).get("target", {}).get(k)) for k in ("mean", "high", "low")},
        "analistas": det_o["analistas"], "cap": det_o["cap"],
        "upside_medio": det_a.get("upside_medio"), "upside_alto": det_a.get("upside_alto"),
        "objetivo_viejo": det_a.get("stale", False),
        "riesgo": {"score": round(r_s), "label": r_label, "motivos": r_motivos},
        "senal": {"sig": t["signal"], "label": SIG_ES.get(t["signal"], "—"), "score": t.get("score")},
        "por_que": por_que(t, None, det_a, det_o, det_c, det_t, ratio),
        "discrepancia": discrepancia(t, score, r_s),
        "catalizador": det_c.get("titular") or det_c.get("cambio_senal")
        or (f"Resultados en {det_c['dias_resultados']} días" if det_c.get("dias_resultados") is not None else None),
    }


def main():
    with open(os.path.join(DATA, "latest.json"), encoding="utf-8") as f:
        data = json.load(f)
    hoy = datetime.now(timezone.utc).date()
    cambios = {c["sym"]: c for c in data.get("changes", [])}

    mias = set()
    pf_path = os.path.join(DATA, "portfolios.json")
    if os.path.exists(pf_path):
        try:
            book = json.load(open(pf_path, encoding="utf-8"))
            saldo = {}
            for p in book.get("list", []):
                for t in p.get("tx", []):
                    q = num(t.get("qty"), 0) or 0
                    saldo[t["sym"]] = saldo.get(t["sym"], 0) + (-q if t.get("type") == "sell" else q)
            mias = {s for s, q in saldo.items() if q > 1e-9}
        except Exception as e:
            print(f"  ! cartera: {e}", file=sys.stderr)

    evaluadas = []
    for t in data.get("tickers", []):
        if t.get("etf"):
            continue                                   # un ETF no es una idea disruptiva
        try:
            ev = evaluar(t, hoy, cambios)
        except Exception as e:
            print(f"  ! {t.get('sym')}: {e}", file=sys.stderr)
            continue
        if ev:
            ev["mia"] = ev["sym"] in mias
            evaluadas.append(ev)

    evaluadas.sort(key=lambda x: -x["score"])

    # Máximo tres por tema: si no, la lista entera se llena de biotecnológicas.
    top, por_tema = [], {}
    for e in evaluadas:
        n = por_tema.get(e["tema"], 0)
        if n >= 3:
            continue
        por_tema[e["tema"]] = n + 1
        top.append(e)
        if len(top) >= 20:
            break

    # Las listas por horizonte mezclan las dos preguntas: cuánta disrupción tiene
    # la idea y cuánto encaja con ese plazo. Ordenar solo por encaje devolvería
    # NVDA en "largo", que de desapercibida no tiene nada.
    horizontes = {}
    for h in ("corto", "mediano", "largo"):
        cand = [e for e in evaluadas if e["score"] >= 50 and e["horizontes"][h] >= 40]
        cand.sort(key=lambda e: -(e["score"] * 0.65 + e["horizontes"][h] * 0.35))
        vistos, lista = set(), []
        for e in cand:                                 # dos por tema en cada plazo
            if sum(1 for x in lista if x["tema"] == e["tema"]) >= 2:
                continue
            lista.append(e)
            if len(lista) >= 8:
                break
        horizontes[h] = lista

    # Todo lo que la app necesita, sin repetir fichas: una bolsa de ideas y
    # listas de símbolos que apuntan a ella.
    bolsa = {}
    for e in top + [x for v in horizontes.values() for x in v]:
        bolsa.setdefault(e["sym"], e)

    cartera = [e for e in evaluadas if e["mia"]]
    cartera.sort(key=lambda x: -x["score"])
    for e in cartera:
        bolsa.setdefault(e["sym"], e)

    out = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M+00:00"),
        "date": data.get("date"),
        "universo": len(evaluadas),
        "ideas": list(bolsa.values()),
        "top": [e["sym"] for e in top],
        "horizontes": {h: [e["sym"] for e in v] for h, v in horizontes.items()},
        "cartera": [e["sym"] for e in cartera],
        "temas": sorted({e["tema"] for e in top}),
        "metodologia": {
            "pilares": [
                {"n": "Asimetría", "peso": 35, "d": "Cuánto se puede ganar frente a lo que ya está en el precio: escenario alcista de los analistas, distancia al máximo de 52 semanas y desacuerdo entre analistas."},
                {"n": "Desapercibida", "peso": 25, "d": "Pocos analistas cubriéndola, capitalización chica, ningún gurú dentro y poca prensa. Lo que todos miran ya no esconde nada."},
                {"n": "Catalizador", "peso": 25, "d": "Que el cambio esté empezando: revisiones al alza, crecimiento fuerte, volumen inusual, giro de tendencia, resultados cerca."},
                {"n": "Tema", "peso": 15, "d": "En qué ola estructural está: IA, biotecnología, defensa y espacio, nuclear, materiales críticos, salud digital."},
            ],
            "nota_riesgo": "El riesgo de ruina se calcula aparte y nunca se promedia con el puntaje: una idea puede ser muy asimétrica y muy peligrosa al mismo tiempo, y las dos cosas hay que verlas.",
        },
    }
    path = os.path.join(DATA, "disruption.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Radar de disrupción · {len(evaluadas)} acciones evaluadas · {len(bolsa)} fichas")
    for e in top:
        print(f"  {e['score']:3} {e['sym']:6} {e['horizonte']:8} riesgo {e['riesgo']['label']:9} "
              f"{(e['tema'] or '')[:28]:28} {e['asimetria'] or '—'}")
    for h, v in horizontes.items():
        print(f"  {h:8}: " + ", ".join(f"{e['sym']}({e['score']})" for e in v))
    if cartera:
        print(f"  — tu cartera: " + ", ".join(f"{e['sym']} {e['score']}" for e in cartera[:8]))
    print(f"→ {path} ({os.path.getsize(path) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
