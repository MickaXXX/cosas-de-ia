#!/usr/bin/env python3
"""
Mesas de análisis institucional.

Convierte los datos que ya calcula update_data.py (docs/data/latest.json) en diez
informes diarios, uno por cada prompt institucional de la app: Goldman, Morgan
Stanley, Bridgewater, JPMorgan, BlackRock, Citadel, Harvard, Bain, Renaissance y
McKinsey. Cada mesa mira la cartera publicada y el radar del día.

Todo el cálculo es determinista y funciona sin ninguna clave: sale de precios,
fundamentales, analistas y técnico ya descargados. Si existe ANTHROPIC_API_KEY,
Claude reescribe encima el veredicto y el resumen de cada mesa con esos mismos
números (nunca inventa datos nuevos).

Salida: docs/data/desks.json
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")

SIG_ES = {"strong_buy": "Compra fuerte", "buy": "Compra", "hold": "Mantener",
          "sell": "Venta", "strong_sell": "Venta fuerte"}


# ---------------------------------------------------------------- utilidades
def num(x, default=None):
    """Devuelve x como float si es un número utilizable."""
    if isinstance(x, bool) or x is None:
        return default
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return default if v != v else v          # descarta NaN


def usd(v, dec=2):
    if v is None:
        return "—"
    return f"US${v:,.{dec}f}".replace(",", "@").replace(".", ",").replace("@", ".")


def pct(v, dec=1):
    if v is None:
        return "—"
    return f"{v:+.{dec}f}%".replace(".", ",")


def pct0(v, dec=1):
    if v is None:
        return "—"
    return f"{v:.{dec}f}%".replace(".", ",")


def big(v):
    if not v:
        return "—"
    for lim, suf in ((1e12, "B"), (1e9, "MM"), (1e6, "M")):
        if abs(v) >= lim:
            return f"{v / lim:.1f}{suf}".replace(".", ",")
    return f"{v:,.0f}".replace(",", ".")


def median(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


# ---------------------------------------------------------------- carga
def load_all():
    with open(os.path.join(DATA, "latest.json"), encoding="utf-8") as f:
        data = json.load(f)
    tickers = {t["sym"]: t for t in data.get("tickers", [])}

    positions, pf_name = [], "Mi cartera"
    path = os.path.join(DATA, "portfolios.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            book = json.load(f)
        pf = next((p for p in book.get("list", []) if p.get("tx")), None)
        if pf:
            pf_name = pf.get("name") or pf_name
            positions = positions_of(pf.get("tx", []), tickers)
    return data, tickers, positions, pf_name


def positions_of(tx, tickers):
    """Reconstruye posiciones abiertas: cantidad, costo y valor a precio de hoy."""
    acc = {}
    for t in tx:
        sym = (t.get("sym") or "").upper()
        if not sym:
            continue
        a = acc.setdefault(sym, {"qty": 0.0, "cost": 0.0})
        qty, price = num(t.get("qty"), 0.0), num(t.get("price"), 0.0)
        if t.get("type") == "sell":
            if a["qty"] > 0:                                   # baja el costo a prorrata
                a["cost"] -= a["cost"] * min(qty / a["qty"], 1.0)
            a["qty"] -= qty
        else:
            a["qty"] += qty
            a["cost"] += qty * price
    out = []
    for sym, a in acc.items():
        if a["qty"] <= 1e-9:
            continue
        t = tickers.get(sym)
        price = num((t or {}).get("price"))
        value = a["qty"] * price if price else a["cost"]
        out.append({
            "sym": sym, "qty": a["qty"], "cost": a["cost"], "value": value,
            "avg": a["cost"] / a["qty"] if a["qty"] else None,
            "pnl": value - a["cost"],
            "pnl_pct": (value / a["cost"] - 1) * 100 if a["cost"] else None,
            "t": t,
        })
    out.sort(key=lambda p: -(p["value"] or 0))
    return out


def weights(positions):
    total = sum(p["value"] or 0 for p in positions)
    return total, [(p, (p["value"] or 0) / total * 100 if total else 0) for p in positions]


def held_tickers(positions):
    return [p["t"] for p in positions if p.get("t")]


def sector_medians(tickers):
    """Mediana de P/E adelantado por sector: la referencia para 'caro vs. su sector'."""
    by = {}
    for t in tickers.values():
        if t.get("etf"):
            continue
        pe = num((t.get("fund") or {}).get("forward_pe"))
        if pe and 0 < pe < 200:
            by.setdefault(t.get("sector") or "—", []).append(pe)
    return {s: median(v) for s, v in by.items() if len(v) >= 5}


# ---------------------------------------------------------------- mesa 1
def desk_goldman(data, tickers, positions, med):
    """Screener: los mejores candidatos del radar con criterio fundamental."""
    cand = []
    for t in tickers.values():
        f = t.get("fund") or {}
        if t.get("etf") or t.get("conf") == "baja":
            continue
        if num(f.get("market_cap"), 0) < 2e9:
            continue
        growth, pe = num(f.get("revenue_growth")), num(f.get("forward_pe"))
        if growth is None or pe is None or pe <= 0:
            continue
        a = t.get("analysts") or {}
        cand.append((t["h"]["medium"]["s"] + t["h"]["long"]["s"], t, f, a))
    cand.sort(key=lambda x: -x[0])

    mine = {p["sym"] for p in positions}
    rows = []
    for _, t, f, a in cand[:10]:
        pe, sec = num(f.get("forward_pe")), t.get("sector") or "—"
        ref = med.get(sec)
        vs = f"{pe:.1f} vs {ref:.1f}".replace(".", ",") if ref else f"{pe:.1f}".replace(".", ",")
        atr = num((t.get("tech") or {}).get("atr_pct"), 0) or 0
        price = num(t.get("price"))
        stop = price * (1 - 2 * atr / 100) if price else None
        moat = moat_label(f)
        rows.append({
            "sym": t["sym"], "tag": SIG_ES.get(t["signal"], "—"),
            "mine": t["sym"] in mine,
            "cols": [t.get("name", "")[:28], vs, pct(num(f.get("revenue_growth"))),
                     f"{num(f.get('debt_to_equity'), 0):.0f}".replace(".", ","), moat,
                     usd(num((a.get("target") or {}).get("mean"))), usd(stop)],
        })

    tengo = [r["sym"] for r in rows if r["mine"]]
    faltan = [r["sym"] for r in rows if not r["mine"]][:4]
    puntos = [
        f"El filtro exige capitalización sobre US$2.000 millones, crecimiento de ingresos y P/E adelantado conocido: {len(cand)} de {len(tickers)} activos del radar lo pasan hoy.",
        f"De tu cartera entran al top 10: {', '.join(tengo) if tengo else 'ninguna posición'}.",
        f"Los que no tienes y mejor puntúan: {', '.join(faltan) if faltan else '—'}.",
        "El stop sugerido es el precio de hoy menos dos veces el rango diario medio (ATR): la caída que ya no es ruido normal del activo.",
    ]
    ver = f"{rows[0]['sym']} encabeza el screener" if rows else "Sin candidatos suficientes hoy"
    return {
        "cols": ["Activo", "Empresa", "P/E fwd vs sector", "Crec. ingresos", "D/E", "Ventaja", "Objetivo 12m", "Stop"],
        "rows": rows, "veredicto": ver, "puntos": puntos,
        "resumen": ("Ranking de las 10 mejores ideas del radar según fundamentales y consenso: valoración contra "
                    "la mediana de su propio sector, crecimiento, deuda, ventaja competitiva y objetivo de analistas."),
    }


def moat_label(f):
    """Proxy de ventaja competitiva: márgenes y retorno sobre patrimonio."""
    m, roe = num(f.get("operating_margin"), 0) or 0, num(f.get("roe"), 0) or 0
    if m >= 25 and roe >= 20:
        return "Fuerte"
    if m >= 12 or roe >= 12:
        return "Moderada"
    return "Débil"


# ---------------------------------------------------------------- mesa 2
def ev_over_cap(y, g, wacc, years=10, gt=0.025):
    """Valor del negocio dividido por su capitalización, para un FCF que crece g y
    converge a gt en `years`. Al ser un cociente, no depende de la moneda."""
    pv, cf = 0.0, 1.0
    for yr in range(1, years + 1):
        cf *= (1 + g + (gt - g) * (yr / years))
        pv += cf / (1 + wacc) ** yr
    tv = cf * (1 + gt) / (wacc - gt)
    return y * (pv + tv / (1 + wacc) ** years)


def implied_growth(y, wacc):
    """Crecimiento del flujo de caja que el precio de hoy ya está dando por hecho."""
    lo, hi = -0.20, 0.60
    if ev_over_cap(y, hi, wacc) < 1:
        return None                                   # ni con 60% anual se justifica
    if ev_over_cap(y, lo, wacc) > 1:
        return lo
    for _ in range(40):
        mid = (lo + hi) / 2
        if ev_over_cap(y, mid, wacc) < 1:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def dcf(t):
    """DCF de diez años con crecimiento decreciente y WACC por beta, más el
    crecimiento implícito en el precio actual. Descarta datos no comparables."""
    f = t.get("fund") or {}
    price, fcf_y = num(t.get("price")), num(f.get("fcf_yield"))
    if not price or fcf_y is None:
        return None
    # Un FCF yield fuera de esta banda casi siempre significa que la empresa reporta
    # en otra moneda que su capitalización (SK hynix, TSMC): el cociente no sirve.
    if not (0.2 <= fcf_y <= 15):
        return None
    beta = num(f.get("beta"), 1.0) or 1.0
    wacc = max(0.08, min(0.15, 0.045 + beta * 0.05))
    g0 = max(0.0, min(30.0, num(f.get("revenue_growth"), 8) or 8)) / 100
    ratio = ev_over_cap(fcf_y / 100, g0, wacc)
    if not (0.05 <= ratio <= 4):
        return None                                   # fuera del rango útil del modelo
    imp = implied_growth(fcf_y / 100, wacc)
    return {"fair": price * ratio, "upside": (ratio - 1) * 100, "wacc": wacc * 100,
            "g0": g0 * 100, "implied": imp * 100 if imp is not None else None, "price": price}


def desk_morgan(data, tickers, positions, med):
    """Dos jueces independientes: el crecimiento implícito en el precio y el
    múltiplo contra el propio sector. Coinciden o el veredicto queda en 'Justa'."""
    rows, infra, sobre, fuera = [], [], [], []
    for p in positions[:18]:
        t = p.get("t")
        if not t or t.get("etf"):
            continue
        d = dcf(t)
        if not d:
            fuera.append(p["sym"])
            continue
        f = t.get("fund") or {}
        pe, ref = num(f.get("forward_pe")), med.get(t.get("sector") or "—")
        pe_vs = (pe / ref) if (pe and ref and pe > 0) else None
        imp, esperado = d["implied"], d["g0"]

        caro = (1 if (imp is None or imp > esperado + 5) else 0) + (1 if (pe_vs and pe_vs > 1.3) else 0)
        barato = (1 if (imp is not None and imp < esperado - 5) else 0) + (1 if (pe_vs and pe_vs < 0.7) else 0)
        ver = "Sobrevalorada" if caro > barato else ("Infravalorada" if barato > caro else "Justa")
        (infra if ver == "Infravalorada" else sobre if ver == "Sobrevalorada" else []).append(t["sym"])

        a = t.get("analysts") or {}
        rows.append({
            "sym": t["sym"], "tag": ver, "mine": True,
            "cols": [usd(d["price"]),
                     usd(d["fair"]) if abs(d["upside"]) <= 70 else "fuera de rango",
                     pct0(imp) if imp is not None else "> 60%",
                     pct0(esperado),
                     (f"{pe:.0f} vs {ref:.0f}" if pe_vs else "—"),
                     usd(num((a.get("target") or {}).get("mean")))],
        })
    orden = {"Infravalorada": 0, "Justa": 1, "Sobrevalorada": 2}
    rows.sort(key=lambda r: orden.get(r["tag"], 3))
    puntos = [
        "La columna que manda es el crecimiento implícito: el que el precio de hoy ya da por hecho durante diez años. Si supera con holgura al crecimiento actual, estás pagando por una hazaña.",
        "El veredicto solo se emite cuando los dos jueces coinciden: el flujo de caja descontado y el múltiplo contra la mediana del propio sector. Si discrepan, queda en 'Justa'.",
        f"Bajo su valor: {', '.join(infra) if infra else 'ninguna'}. Por encima: {', '.join(sobre) if sobre else 'ninguna'}.",
        "Un 'fuera de rango' significa que la caja libre de hoy no alcanza a explicar el precio ni con supuestos generosos: la tesis de esa acción no está en su caja actual sino en lo que viene.",
        (f"Sin caja libre comparable, no se valoran: {', '.join(fuera)}. Pasa con las que aún queman caja y con las que reportan en otra moneda que su capitalización (SK hynix, TSMC)."
         if fuera else ""),
    ]
    ver = (f"{len(infra)} bajo su valor justo, {len(sobre)} por encima, {len(rows) - len(infra) - len(sobre)} en precio"
           if rows else "Ninguna posición tiene caja libre comparable para valorar")
    return {"cols": ["Activo", "Precio", "Valor DCF", "Crec. implícito", "Crec. actual", "P/E fwd vs sector", "Objetivo analistas"],
            "rows": rows, "veredicto": ver, "puntos": [x for x in puntos if x],
            "resumen": ("Qué crecimiento está pagando hoy el precio de cada posición y cómo se compara con lo que la "
                        "empresa realmente crece y con el múltiplo de su sector. No es un precio objetivo: es una prueba "
                        "de cuánta perfección viene incluida en el precio.")}


# ---------------------------------------------------------------- mesa 3
def desk_bridgewater(data, tickers, positions, med):
    total, ws = weights(positions)
    by_sector, beta_w, dd_w = {}, 0.0, 0.0
    for p, w in ws:
        t = p.get("t") or {}
        sec = "ETF" if t.get("etf") else (t.get("sector") or "Sin clasificar")
        by_sector[sec] = by_sector.get(sec, 0) + w
        beta_w += w / 100 * (num((t.get("fund") or {}).get("beta"), 1.0) or 1.0)
        dd_w += w / 100 * abs(num((t.get("tech") or {}).get("max_dd"), 0) or 0)

    rows = [{"sym": s, "tag": "Concentrado" if w >= 25 else ("Alto" if w >= 15 else "—"),
             "cols": [pct0(w), f"{sum(1 for p, x in ws if ('ETF' if (p.get('t') or {}).get('etf') else ((p.get('t') or {}).get('sector') or 'Sin clasificar')) == s)}"]}
            for s, w in sorted(by_sector.items(), key=lambda kv: -kv[1])]

    top = ws[0] if ws else None
    caida20 = beta_w * -20
    vix35 = beta_w * -12
    puntos = [
        f"Beta de la cartera: {beta_w:.2f}".replace(".", ",") + f". Si el S&P 500 cae 20%, el modelo estima {pct(caida20)} para ti; con el VIX saltando a 35, {pct(vix35)}.",
        f"Caída máxima ponderada del último año de tus propias posiciones: {pct(-dd_w)}. Ya viviste algo parecido con estos activos.",
        (f"Tu mayor posición es {top[0]['sym']} con {pct0(top[1])} del total." if top else "Sin posiciones."),
        (f"Sector más pesado: {max(by_sector, key=by_sector.get)} con {pct0(max(by_sector.values()))}. Sobre 30% en un solo sector, las posiciones dejan de diversificar entre ellas."
         if by_sector else ""),
    ]
    hedges = []
    if beta_w > 1.2:
        hedges.append("Beta sobre 1,2: una parte en efectivo o en un ETF de bonos cortos (SHY, BIL) baja el golpe sin vender tus ideas.")
    if by_sector.get("Technology", 0) > 35:
        hedges.append("Tecnología sobre 35%: oro (GLD) o defensivos (XLP, XLV) son los que menos se mueven con ella.")
    if sum(1 for p, w in ws if w > 12) >= 3:
        hedges.append("Varias posiciones sobre 12%: bajar las dos mayores a 10% libera capital sin cambiar tu tesis.")
    if not hedges:
        hedges.append("El riesgo de concentración está dentro de lo razonable para una cartera de convicción.")

    ver = f"Riesgo {'alto' if beta_w > 1.4 else 'medio' if beta_w > 1.0 else 'contenido'} · beta {beta_w:.2f}".replace(".", ",")
    return {"cols": ["Sector", "Peso", "Posiciones"], "rows": rows, "veredicto": ver,
            "puntos": [x for x in puntos if x] + hedges,
            "resumen": ("Mapa de concentración por sector, beta de la cartera y prueba de estrés. "
                        "El objetivo no es predecir la caída sino saber cuánto duele si llega.")}


# ---------------------------------------------------------------- mesa 4
def desk_jpmorgan(data, tickers, positions, med):
    hoy = datetime.now(timezone.utc).date()
    mine = {p["sym"] for p in positions}
    rows = []
    for t in tickers.values():
        ed = t.get("earnings_date")
        if not ed:
            continue
        try:
            days = (datetime.strptime(ed, "%Y-%m-%d").date() - hoy).days
        except ValueError:
            continue
        if not (0 <= days <= 60):
            continue
        if t["sym"] not in mine and t["h"]["medium"]["s"] < 70:
            continue
        atr = num((t.get("tech") or {}).get("atr_pct"), 0) or 0
        a = t.get("analysts") or {}
        rev = a.get("revisions") or {}
        up, down = rev.get("up", 0), rev.get("down", 0)
        tono = "Revisiones al alza" if up > down * 2 else ("Revisiones a la baja" if down > up else "Mixtas")
        rows.append({
            "sym": t["sym"], "tag": f"{days}d" if days else "hoy", "mine": t["sym"] in mine,
            "sort": (0 if t["sym"] in mine else 1, days),
            "cols": [ed, pct0(atr * 2.5), tono, f"{up}↑ / {down}↓",
                     f"{num((t.get('fund') or {}).get('forward_pe'), 0):.1f}".replace(".", ","),
                     SIG_ES.get(t["signal"], "—")],
        })
    rows.sort(key=lambda r: r["sort"])
    for r in rows:
        r.pop("sort", None)
    mias = [r for r in rows if r["mine"]]
    ver = (f"{len(mias)} de tus posiciones reportan en 60 días" if mias
           else "Ninguna posición tuya reporta en los próximos 60 días")
    puntos = [
        "El movimiento esperado es el rango diario medio del activo multiplicado por 2,5: es lo que suele moverse un día de resultados, no un pronóstico de dirección.",
        "Las revisiones de utilidades de los últimos 30 días son la mejor pista previa: cuando los analistas suben estimaciones en bloque, la empresa suele superar el consenso.",
        (f"El primero en reportar es {rows[0]['sym']} el {rows[0]['cols'][0]}." if rows else ""),
        "Regla de la mesa: si una posición pesa más de 15% y reporta esta semana, reducirla antes del reporte baja la varianza sin abandonar la tesis.",
    ]
    return {"cols": ["Activo", "Fecha", "Movimiento esperado", "Revisiones", "EPS 30d", "P/E fwd", "Señal"],
            "rows": rows[:14], "veredicto": ver, "puntos": [x for x in puntos if x],
            "resumen": "Calendario de resultados de tus posiciones y de las ideas fuertes del radar, con el movimiento típico de un día de reporte y hacia dónde apuntan las revisiones."}


# ---------------------------------------------------------------- mesa 5
def desk_blackrock(data, tickers, positions, med):
    total, ws = weights(positions)
    etf_w = sum(w for p, w in ws if (p.get("t") or {}).get("etf"))
    core = [(p, w) for p, w in ws if w >= 8]
    rows = []
    for p, w in ws[:14]:
        t = p.get("t") or {}
        objetivo = 10.0 if w > 10 else (w if w >= 4 else 4.0)
        accion = "Reducir" if w > objetivo + 2 else ("Aumentar" if w < objetivo - 1.5 else "Mantener")
        rows.append({"sym": p["sym"], "tag": accion, "mine": True,
                     "cols": [pct0(w), pct0(objetivo), usd(p["value"]),
                              usd(abs((objetivo - w) / 100 * total)) if accion != "Mantener" else "—",
                              SIG_ES.get(t.get("signal"), "—")]})
    puntos = [
        f"Cartera de {len(positions)} posiciones por {usd(total)}. Núcleo (sobre 8% cada una): {len(core)} posiciones que pesan {pct0(sum(w for _, w in core))}.",
        f"Exposición a ETFs: {pct0(etf_w)}. Todo lo demás son acciones individuales, donde el riesgo específico de cada empresa no se diluye.",
        "Regla usada: ninguna posición individual sobre 10% y ninguna bajo 4% (una posición muy chica no mueve la aguja y sí ocupa atención).",
        "Estás invertido en dólares desde Chile: el USD/CLP es una segunda apuesta encima de cada acción, y hoy no está cubierta.",
    ]
    reducir = [r["sym"] for r in rows if r["tag"] == "Reducir"]
    ver = (f"Rebalanceo sugerido en {len(reducir)} posiciones" if reducir else "Pesos dentro de la política")
    return {"cols": ["Activo", "Peso actual", "Peso objetivo", "Valor", "Ajuste", "Señal"],
            "rows": rows, "veredicto": ver, "puntos": puntos,
            "resumen": "Política de cartera: qué pesa cada posición hoy, qué debería pesar bajo una regla de núcleo y satélites, y cuánto hay que mover para llegar ahí."}


# ---------------------------------------------------------------- mesa 6
def desk_citadel(data, tickers, positions, med):
    rows = []
    for p in positions[:16]:
        t = p.get("t")
        if not t:
            continue
        tc = t.get("tech") or {}
        price = num(t.get("price"))
        sma20, sma50, sma200 = num(tc.get("sma20")), num(tc.get("sma50")), num(tc.get("sma200"))
        atr = num(tc.get("atr_pct"), 0) or 0
        if not price:
            continue
        if sma50 and sma200 and price > sma50 > sma200:
            tend = "Alcista"
        elif sma50 and sma200 and price < sma50 < sma200:
            tend = "Bajista"
        else:
            tend = "Lateral"
        soporte = max([x for x in (sma20, sma50, num(tc.get("lo52"))) if x and x < price] or [price * 0.9])
        resist = min([x for x in (sma20, sma50, num(tc.get("hi52"))) if x and x > price] or [price * 1.1])
        stop = price * (1 - 2 * atr / 100)
        objetivo = num(((t.get("analysts") or {}).get("target") or {}).get("mean")) or resist
        rr = (objetivo - price) / (price - stop) if price > stop and objetivo > price else None
        rows.append({"sym": t["sym"], "tag": tend, "mine": True,
                     "cols": [usd(price), f"{num(tc.get('rsi'), 0):.0f}", usd(soporte), usd(resist),
                              usd(stop), usd(objetivo),
                              f"{rr:.1f}".replace(".", ",") if rr else "—"]})
    sobrec = [r["sym"] for r in rows if float((r["cols"][1] or "0")) >= 70]
    sobrev = [r["sym"] for r in rows if float((r["cols"][1] or "0")) <= 30]
    alcistas = sum(1 for r in rows if r["tag"] == "Alcista")
    puntos = [
        f"{alcistas} de {len(rows)} posiciones tienen estructura alcista (precio sobre la media de 50 días y esta sobre la de 200).",
        f"RSI sobre 70 (estirado al alza): {', '.join(sobrec) if sobrec else 'ninguna'}. Bajo 30 (sobrevendido): {', '.join(sobrev) if sobrev else 'ninguna'}.",
        "El stop es dos ATR bajo el precio: por debajo de eso el movimiento dejó de ser ruido diario del activo.",
        "La relación riesgo/beneficio compara cuánto ganas hasta el objetivo de analistas contra cuánto pierdes hasta el stop. Bajo 1,5 la operación no compensa.",
    ]
    return {"cols": ["Activo", "Precio", "RSI", "Soporte", "Resistencia", "Stop", "Objetivo", "R/B"],
            "rows": rows, "veredicto": f"{alcistas} de {len(rows)} en tendencia alcista",
            "puntos": puntos,
            "resumen": "Ficha técnica de cada posición: tendencia, niveles donde el precio ha reaccionado, stop objetivo y cuánto pagas de riesgo por el potencial."}


# ---------------------------------------------------------------- mesa 7
def desk_harvard(data, tickers, positions, med):
    total, ws = weights(positions)
    ingreso = 0.0
    rows_mine = []
    for p, w in ws:
        t = p.get("t") or {}
        dy = num((t.get("fund") or {}).get("dividend_yield"), 0) or 0
        if dy > 0:
            anual = (p["value"] or 0) * dy / 100
            ingreso += anual
            rows_mine.append((t["sym"], dy, anual))

    cand = []
    for t in tickers.values():
        f = t.get("fund") or {}
        dy = num(f.get("dividend_yield"), 0) or 0
        if t.get("etf") or dy < 1.5 or num(f.get("market_cap"), 0) < 5e9:
            continue
        fcf, margin = num(f.get("fcf_yield"), 0) or 0, num(f.get("profit_margin"), 0) or 0
        seguridad = 5 + (2 if fcf > dy else -1) + (2 if margin > 12 else 0) + (1 if (num(f.get("debt_to_equity"), 0) or 0) < 100 else -1)
        seguridad = max(1, min(10, seguridad))
        cand.append((seguridad, dy, t, f))
    cand.sort(key=lambda x: (-x[0], -x[1]))

    rows = [{"sym": t["sym"], "tag": f"{seg}/10", "mine": t["sym"] in {p['sym'] for p in positions},
             "cols": [t.get("name", "")[:26], pct0(dy, 2), pct0(num(f.get("fcf_yield"), 0) or 0, 1),
                      pct0(num(f.get("profit_margin"), 0) or 0), t.get("sector") or "—"]}
            for seg, dy, t, f in cand[:12]]
    puntos = [
        f"Tu cartera genera hoy {usd(ingreso)} al año en dividendos, unos {usd(ingreso / 12)} al mes ({pct0(ingreso / total * 100 if total else 0, 2)} sobre el valor invertido).",
        f"Posiciones que reparten dividendo: {len(rows_mine)} de {len(positions)}. Tu cartera está construida para crecer, no para repartir.",
        "El puntaje de seguridad premia que el flujo de caja libre supere al dividendo (lo paga con caja, no con deuda), márgenes sanos y poca deuda.",
        "Para un residente en Chile, el dividendo de una acción estadounidense sufre 30% de retención en origen; la ganancia de capital no. Eso hace que la estrategia de dividendos rinda menos aquí que en EE.UU.",
    ]
    return {"cols": ["Activo", "Empresa", "Dividendo", "FCF yield", "Margen neto", "Sector"],
            "rows": rows, "veredicto": f"Ingreso actual {usd(ingreso / 12)} al mes",
            "puntos": puntos,
            "resumen": "Cuánta renta produce hoy tu cartera y cuáles son los pagadores más sólidos del radar, ordenados por la capacidad real de sostener el dividendo."}


# ---------------------------------------------------------------- mesa 8
def desk_bain(data, tickers, positions, med):
    rows = []
    vistos = set()
    for p in positions[:8]:
        t = p.get("t")
        if not t or t.get("etf") or not t.get("industry"):
            continue
        ind = t["industry"]
        if ind in vistos:
            continue
        vistos.add(ind)
        peers = [x for x in tickers.values()
                 if x.get("industry") == ind and not x.get("etf")
                 and num((x.get("fund") or {}).get("market_cap"), 0) > 1e9]
        peers.sort(key=lambda x: -(x["h"]["long"]["s"] + x["h"]["medium"]["s"]))
        mejor = peers[0] if peers else t
        for x in peers[:4]:
            f = x.get("fund") or {}
            rows.append({"sym": x["sym"], "tag": ind[:22],
                         "mine": x["sym"] == t["sym"],
                         "cols": [big(num(f.get("market_cap"))), pct0(num(f.get("operating_margin"), 0) or 0),
                                  pct(num(f.get("revenue_growth"))), moat_label(f),
                                  f"{x['h']['long']['s']}", "★" if x["sym"] == mejor["sym"] else ""]})
    ganadores = [r["sym"] for r in rows if r["cols"][-1] == "★"]
    tuyos = [r["sym"] for r in rows if r["mine"]]
    coinciden = [s for s in tuyos if s in ganadores]
    puntos = [
        f"Se comparan tus principales posiciones contra sus rivales directos de la misma industria dentro del radar ({len(rows)} empresas en {len(vistos)} industrias).",
        f"Tienes el mejor de su industria en: {', '.join(coinciden) if coinciden else 'ninguna industria'}.",
        f"Donde hay un rival mejor puntuado: {', '.join(s for s in ganadores if s not in tuyos) or 'ninguno'}.",
        "La ventaja competitiva se estima con margen operativo y retorno sobre patrimonio: márgenes altos y sostenidos son la huella de un negocio difícil de copiar.",
    ]
    return {"cols": ["Activo", "Capitalización", "Margen op.", "Crecimiento", "Ventaja", "Score largo", "Mejor"],
            "rows": rows, "veredicto": (f"Lideras en {len(coinciden)} de {len(vistos)} industrias" if vistos else "Sin industrias comparables"),
            "puntos": puntos,
            "resumen": "Panorama competitivo: cómo se ve cada posición tuya frente a los rivales de su propia industria en tamaño, márgenes, crecimiento y calidad."}


# ---------------------------------------------------------------- mesa 9
def desk_renaissance(data, tickers, positions, med):
    señales = []
    for t in tickers.values():
        tc, f, a = t.get("tech") or {}, t.get("fund") or {}, t.get("analysts") or {}
        ret = tc.get("ret") or {}
        sym, anomalias = t["sym"], []
        rsi, vr = num(tc.get("rsi")), num(tc.get("vol_ratio"), 1) or 1
        m1, m3 = num(ret.get("1m")), num(ret.get("3m"))
        hi52, price = num(tc.get("hi52")), num(t.get("price"))
        if vr >= 1.8:
            anomalias.append(f"volumen {vr:.1f}× lo normal".replace(".", ","))
        if rsi is not None and rsi >= 75:
            anomalias.append(f"RSI {rsi:.0f} (extremo)")
        if rsi is not None and rsi <= 25:
            anomalias.append(f"RSI {rsi:.0f} (sobrevendido)")
        if m1 is not None and m3 is not None and m1 > 8 and m3 < 0:
            anomalias.append("giro de tendencia: sube el mes tras tres meses malos")
        if hi52 and price and price >= hi52 * 0.98:
            anomalias.append("en máximos de 52 semanas")
        rev = a.get("revisions") or {}
        if rev.get("up", 0) >= 8 * max(rev.get("down", 0), 1):
            anomalias.append(f"revisiones de utilidades {rev.get('up')}↑ vs {rev.get('down')}↓")
        if anomalias:
            peso = len(anomalias) * 10 + (25 if any(p["sym"] == sym for p in positions) else 0)
            señales.append((peso, t, anomalias))
    señales.sort(key=lambda x: -x[0])

    mine = {p["sym"] for p in positions}
    rows = [{"sym": t["sym"], "tag": f"{len(an)} señal" + ("" if len(an) == 1 else "es"), "mine": t["sym"] in mine,
             "cols": [t.get("sector") or "—", "; ".join(an), SIG_ES.get(t["signal"], "—")]}
            for _, t, an in señales[:14]]
    puntos = [
        f"{len(señales)} activos del radar muestran al menos una anomalía estadística hoy; se listan los más cargados y las que tocan tu cartera.",
        "Volumen sobre 1,8 veces lo normal suele preceder a noticias: es dinero grande moviéndose antes que el titular.",
        "Un giro de tendencia (mes positivo tras trimestre negativo) es la señal con más recorrido histórico de esta lista, y también la que más falsos positivos da.",
        "Con solo dos días de historial propio guardado, los patrones estacionales todavía no se pueden calcular: se irán activando a medida que la app acumule días.",
    ]
    return {"cols": ["Activo", "Sector", "Anomalías detectadas", "Señal"],
            "rows": rows, "veredicto": f"{len(señales)} anomalías en el radar",
            "puntos": puntos,
            "resumen": "Rastreo de comportamientos que se salen de lo normal: volumen inusual, extremos de RSI, giros de tendencia, máximos anuales y revisiones de utilidades en bloque."}


# ---------------------------------------------------------------- mesa 10
def desk_mckinsey(data, tickers, positions, med):
    total, ws = weights(positions)
    regime = data.get("regime") or {}
    market = data.get("market") or {}
    growth_w = sum(w for p, w in ws
                   if (num(((p.get("t") or {}).get("fund") or {}).get("forward_pe"), 0) or 0) > 30
                   or (num(((p.get("t") or {}).get("fund") or {}).get("revenue_growth"), 0) or 0) > 25)
    beta_w = sum(w / 100 * (num(((p.get("t") or {}).get("fund") or {}).get("beta"), 1.0) or 1.0) for p, w in ws)

    rows = []
    for k, m in market.items():
        rows.append({"sym": m.get("name", k), "tag": "sobre 200d" if m.get("above_sma200") else "bajo 200d",
                     "cols": [f"{num(m.get('price'), 0):,.0f}".replace(",", "."), pct(num(m.get("chg1d"))),
                              pct(num(m.get("ret_1w"))), pct(num(m.get("ret_1m")))]})
    puntos = [
        f"Régimen actual: {regime.get('label', '—')}. {regime.get('desc', '')} {' '.join(regime.get('notes') or [])}".strip(),
        f"{pct0(growth_w)} de tu cartera está en perfil de crecimiento (P/E adelantado sobre 30 o crecimiento sobre 25%). Ese perfil es el que más sufre cuando las tasas largas suben y el que más gana cuando bajan.",
        f"Beta agregada {beta_w:.2f}".replace(".", ",") + ": tu cartera amplifica lo que haga el índice, en ambas direcciones.",
        "Inviertes en dólares desde Chile: si el dólar se debilita frente al peso, tu rentabilidad medida en pesos baja aunque las acciones suban.",
    ]
    acciones = []
    if (regime.get("label") or "").lower().startswith("risk-on"):
        acciones.append("Con el índice sobre su media de 200 días y volatilidad baja, el régimen respalda mantener la exposición; el error caro aquí es vender por miedo anticipado.")
    else:
        acciones.append("Régimen defensivo: conviene exigir más a cada compra nueva y priorizar las posiciones con caja libre positiva.")
    if growth_w > 60:
        acciones.append("Sobre 60% en perfil crecimiento: una posición en defensivos o efectivo reduce la dependencia de un solo escenario de tasas.")
    return {"cols": ["Índice", "Nivel", "Hoy", "1 semana", "1 mes"], "rows": rows,
            "veredicto": f"{regime.get('label', '—')} · beta {beta_w:.2f}".replace(".", ","),
            "puntos": puntos + acciones,
            "resumen": "Lectura macro: en qué régimen está el mercado, cómo se posiciona tu cartera frente a tasas y dólar, y qué ajustes pide el ciclo actual."}


# ---------------------------------------------------------------- catálogo
DESKS = [
    (1, "goldman", "🏦", "Screener de acciones", "Goldman Sachs", desk_goldman),
    (2, "morgan", "📐", "Valuación DCF", "Morgan Stanley", desk_morgan),
    (3, "bridgewater", "🛡️", "Análisis de riesgo", "Bridgewater", desk_bridgewater),
    (4, "jpmorgan", "📅", "Previa de resultados", "JPMorgan", desk_jpmorgan),
    (5, "blackrock", "🧩", "Construcción de portafolio", "BlackRock", desk_blackrock),
    (6, "citadel", "📊", "Análisis técnico", "Citadel", desk_citadel),
    (7, "harvard", "💵", "Estrategia de dividendos", "Harvard Endowment", desk_harvard),
    (8, "bain", "⚔️", "Ventaja competitiva", "Bain & Company", desk_bain),
    (9, "renaissance", "🔬", "Patrones y anomalías", "Renaissance", desk_renaissance),
    (10, "mckinsey", "🌍", "Impacto macro", "McKinsey", desk_mckinsey),
]


# ---------------------------------------------------------------- Claude
def narrate(desks, data, pf_name, total):
    """Reescribe veredicto, resumen y puntos con Claude a partir de los números ya calculados."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return 0
    try:
        import anthropic
    except ImportError:
        print("  ! anthropic no instalado; las mesas quedan con el texto calculado", file=sys.stderr)
        return 0

    model = (os.environ.get("DESKS_MODEL") or os.environ.get("NEWS_MODEL") or "").strip() or "claude-opus-5"
    client = anthropic.Anthropic(api_key=api_key)
    schema = {
        "type": "object",
        "properties": {
            "veredicto": {"type": "string"},
            "resumen": {"type": "string"},
            "puntos": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
            "acciones": {"type": "array", "maxItems": 6, "items": {
                "type": "object",
                "properties": {
                    "sym": {"type": "string"},
                    "accion": {"type": "string", "enum": ["Comprar", "Aumentar", "Mantener", "Reducir", "Vender", "Vigilar"]},
                    "por": {"type": "string"},
                },
                "required": ["sym", "accion", "por"], "additionalProperties": False}},
        },
        "required": ["veredicto", "resumen", "puntos", "acciones"],
        "additionalProperties": False,
    }
    regime = data.get("regime") or {}
    hechos_comunes = (f"Régimen de mercado: {regime.get('label')} — {regime.get('desc')}\n"
                      f"Cartera: {pf_name}, valor {usd(total)}, fecha de datos {data.get('date')}.")
    ok = 0
    for d in desks:
        tabla = "\n".join(" | ".join([r["sym"]] + [str(c) for c in r["cols"]]) for r in d["rows"][:14])
        prompt = (f"MESA: {d['firm']} — {d['title']}\n{hechos_comunes}\n\n"
                  f"COLUMNAS: {' | '.join(d['cols'])}\nDATOS CALCULADOS:\n{tabla or '(sin filas)'}\n\n"
                  f"HALLAZGOS DEL MODELO:\n- " + "\n- ".join(d["puntos"]))
        try:
            resp = client.messages.create(
                model=model, max_tokens=2000,
                system=("Eres el analista de esta mesa institucional escribiendo para un inversionista minorista chileno "
                        "que invierte en acciones de EE.UU. vía Racional. Escribe en español de Chile, directo y concreto. "
                        "USA EXCLUSIVAMENTE los números que te entrego: no inventes cifras, empresas ni fechas. "
                        "El veredicto es una línea de máximo 90 caracteres. El resumen, dos o tres frases. "
                        "Los puntos son hallazgos accionables, no definiciones. En acciones, usa solo símbolos que aparezcan "
                        "en los datos. Nunca prometas rentabilidades ni des asesoría financiera personalizada."),
                messages=[{"role": "user", "content": prompt}],
                output_config={"format": {"type": "json_schema", "schema": schema}, "effort": "low"},
            )
            if resp.stop_reason == "refusal":
                continue
            j = json.loads(next(b.text for b in resp.content if b.type == "text"))
            d["veredicto"] = j["veredicto"][:110]
            d["resumen"] = j["resumen"][:600]
            d["puntos"] = [p[:300] for p in j["puntos"]][:5]
            d["acciones"] = j.get("acciones", [])[:6]
            d["ai"] = True
            ok += 1
        except Exception as e:                                   # una mesa que falla no bota el run
            print(f"  ! mesa {d['id']}: {e}", file=sys.stderr)
    return ok


# ---------------------------------------------------------------- main
def main():
    data, tickers, positions, pf_name = load_all()
    med = sector_medians(tickers)
    total = sum(p["value"] or 0 for p in positions)
    print(f"Mesas de análisis · {len(tickers)} activos · cartera '{pf_name}' con {len(positions)} posiciones")

    desks = []
    for n, did, icon, title, firm, fn in DESKS:
        try:
            body = fn(data, tickers, positions, med)
        except Exception as e:
            print(f"  ! {did}: {e}", file=sys.stderr)
            continue
        body.update({"n": n, "id": did, "icon": icon, "title": title, "firm": firm,
                     "acciones": body.get("acciones", []), "ai": False})
        desks.append(body)
        print(f"  {icon} {firm}: {body['veredicto']}")

    ai = narrate(desks, data, pf_name, total) if os.environ.get("ANTHROPIC_API_KEY") else 0
    out = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M+00:00"),
        "date": data.get("date"),
        "ai": ai, "model": (os.environ.get("DESKS_MODEL") or "claude-opus-5") if ai else None,
        "portfolio": {"name": pf_name, "value": round(total, 2), "n": len(positions),
                      "syms": [p["sym"] for p in positions]},
        "desks": desks,
    }
    path = os.path.join(DATA, "desks.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"→ {path} ({os.path.getsize(path) / 1024:.0f} KB, IA en {ai} de {len(desks)} mesas)")


if __name__ == "__main__":
    main()
