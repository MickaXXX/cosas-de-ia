#!/usr/bin/env python3
"""
Market Intelligence AI - generador diario de datos.

Descarga precios, fundamentales, consenso de analistas y noticias desde Yahoo
Finance (vía yfinance), calcula señales por horizonte (corto / mediano / largo)
y escribe JSON compactos en docs/data/ que la app móvil consume.

Uso:
    python scripts/update_data.py            # datos reales (requiere internet)
    python scripts/update_data.py --demo     # datos sintéticos para probar la app
    python scripts/update_data.py --only NVDA,AAPL

El almacenamiento se auto-gestiona: solo se conserva el último snapshot,
N días de historial de scores y pocas noticias recientes por ticker.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "docs" / "data"

SIGNAL_LABELS = {
    "strong_buy": "Compra fuerte",
    "buy": "Compra",
    "hold": "Mantener",
    "sell": "Venta",
    "strong_sell": "Venta fuerte",
}


# --------------------------------------------------------------------------- #
# Utilidades
# --------------------------------------------------------------------------- #
def load_json(path: Path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def clamp(x, lo=0.0, hi=100.0):
    return max(lo, min(hi, x))


def num(x):
    """Convierte a float o None (maneja NaN, strings, etc.)."""
    try:
        if x is None:
            return None
        v = float(x)
        if math.isnan(v) or math.isinf(v):
            return None
        return v
    except Exception:
        return None


def r(x, nd=2):
    v = num(x)
    if v is None:
        return None
    return int(round(v)) if nd == 0 else round(v, nd)


def scale(value, lo, hi, lo_score=0.0, hi_score=100.0):
    """Mapea value en [lo, hi] linealmente a [lo_score, hi_score], recortando."""
    if value is None:
        return None
    if hi == lo:
        return (lo_score + hi_score) / 2
    t = (value - lo) / (hi - lo)
    t = max(0.0, min(1.0, t))
    return lo_score + t * (hi_score - lo_score)


def weighted(parts: dict, weights: dict):
    """Promedio ponderado ignorando None. Devuelve (score, cobertura)."""
    total_w = 0.0
    acc = 0.0
    used_w = 0.0
    for k, w in weights.items():
        if k.startswith("_"):
            continue
        total_w += w
        v = parts.get(k)
        if v is None:
            continue
        acc += v * w
        used_w += w
    if used_w == 0:
        return None, 0.0
    return acc / used_w, used_w / total_w if total_w else 0.0


# --------------------------------------------------------------------------- #
# Indicadores técnicos
# --------------------------------------------------------------------------- #
def rsi(series: pd.Series, period=14):
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    out = 100 - (100 / (1 + rs))
    return out.fillna(50)


def technicals(hist: pd.DataFrame) -> dict:
    """Calcula indicadores a partir de OHLCV diario (>= 60 filas idealmente)."""
    if hist is None or len(hist) < 30:
        return {}
    c = hist["Close"].astype(float)
    h = hist["High"].astype(float)
    l = hist["Low"].astype(float)
    v = hist["Volume"].astype(float)
    n = len(c)
    price = float(c.iloc[-1])

    def sma(p):
        return float(c.rolling(p).mean().iloc[-1]) if n >= p else None

    ema12 = c.ewm(span=12, adjust=False).mean()
    ema26 = c.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    signal = macd.ewm(span=9, adjust=False).mean()
    hist_macd = macd - signal

    sma20 = sma(20)
    std20 = float(c.rolling(20).std().iloc[-1]) if n >= 20 else None
    bb_pct = None
    if sma20 and std20:
        upper = sma20 + 2 * std20
        lower = sma20 - 2 * std20
        bb_pct = (price - lower) / (upper - lower) if upper != lower else 0.5

    tr = pd.concat([(h - l), (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    atr14 = float(tr.rolling(14).mean().iloc[-1]) if n >= 15 else None

    def ret(days):
        if n > days:
            base = float(c.iloc[-1 - days])
            return (price / base - 1) * 100 if base else None
        return None

    rets = c.pct_change().dropna()
    vol30 = float(rets.tail(30).std() * math.sqrt(252) * 100) if len(rets) >= 20 else None
    roll_max = c.cummax()
    dd = (c / roll_max - 1) * 100
    max_dd = float(dd.min()) if n else None

    vol_ratio = None
    if n >= 50 and float(v.tail(50).mean()) > 0:
        vol_ratio = float(v.tail(5).mean() / v.tail(50).mean())

    hi52 = float(h.tail(252).max())
    lo52 = float(l.tail(252).min())

    rsi14 = float(rsi(c).iloc[-1])
    rsi_prev = float(rsi(c).iloc[-4]) if n > 20 else rsi14

    return {
        "price": price,
        "sma20": sma20,
        "sma50": sma(50),
        "sma200": sma(200),
        "rsi": rsi14,
        "rsi_rising": rsi14 > rsi_prev,
        "macd": float(macd.iloc[-1]),
        "macd_signal": float(signal.iloc[-1]),
        "macd_hist": float(hist_macd.iloc[-1]),
        "macd_hist_prev": float(hist_macd.iloc[-2]) if n > 2 else None,
        "bb_pct": bb_pct,
        "atr_pct": (atr14 / price * 100) if atr14 and price else None,
        "ret_1w": ret(5),
        "ret_1m": ret(21),
        "ret_3m": ret(63),
        "ret_6m": ret(126),
        "ret_1y": ret(252) if n > 252 else ret(n - 1),
        "vol30": vol30,
        "max_dd": max_dd,
        "vol_ratio": vol_ratio,
        "hi52": hi52,
        "lo52": lo52,
        "dist_hi52": (price / hi52 - 1) * 100 if hi52 else None,
        "dist_lo52": (price / lo52 - 1) * 100 if lo52 else None,
        "avg_dollar_vol": float((c * v).tail(30).mean()),
        "spark": [round(float(x), 2) for x in c.tail(129).iloc[::3]],  # ~6 meses, 1 de cada 3 días
    }


def technical_rating(t: dict) -> dict:
    """Votación estilo TradingView: cada indicador vota compra/venta/neutral."""
    votes = []
    p = t.get("price")
    if not p:
        return {"label": "neutral", "buy": 0, "sell": 0, "neutral": 0}

    def vote(cond_buy, cond_sell):
        votes.append(1 if cond_buy else (-1 if cond_sell else 0))

    for k in ("sma20", "sma50", "sma200"):
        s = t.get(k)
        if s:
            vote(p > s, p < s)
    if t.get("sma50") and t.get("sma200"):
        vote(t["sma50"] > t["sma200"], t["sma50"] < t["sma200"])
    vote(t["macd"] > t["macd_signal"], t["macd"] < t["macd_signal"])
    rsi_v = t.get("rsi", 50)
    vote(rsi_v < 30 and t.get("rsi_rising"), rsi_v > 70 and not t.get("rsi_rising"))
    if t.get("ret_1m") is not None:
        vote(t["ret_1m"] > 0, t["ret_1m"] < 0)
    if t.get("bb_pct") is not None:
        vote(t["bb_pct"] < 0, t["bb_pct"] > 1)
    if t.get("macd_hist") is not None and t.get("macd_hist_prev") is not None:
        vote(t["macd_hist"] > t["macd_hist_prev"] and t["macd_hist"] > 0,
             t["macd_hist"] < t["macd_hist_prev"] and t["macd_hist"] < 0)

    buy = sum(1 for x in votes if x > 0)
    sell = sum(1 for x in votes if x < 0)
    neutral = len(votes) - buy - sell
    score = (buy - sell) / len(votes) if votes else 0
    if score >= 0.5:
        label = "strong_buy"
    elif score >= 0.1:
        label = "buy"
    elif score <= -0.5:
        label = "strong_sell"
    elif score <= -0.1:
        label = "sell"
    else:
        label = "neutral"
    return {"label": label, "buy": buy, "sell": sell, "neutral": neutral}


# --------------------------------------------------------------------------- #
# Scoring por horizonte
# --------------------------------------------------------------------------- #
def score_short(t: dict, W: dict) -> tuple:
    if not t:
        return None, 0.0, {}
    p = t["price"]
    parts = {}
    # Tendencia corta: precio vs SMA20/50
    trend = []
    if t.get("sma20"):
        trend.append(scale((p / t["sma20"] - 1) * 100, -6, 6))
    if t.get("sma50"):
        trend.append(scale((p / t["sma50"] - 1) * 100, -10, 10))
    parts["trend"] = sum(trend) / len(trend) if trend else None

    # Momentum: RSI en zona sana + retorno 1M
    rsi_v = t.get("rsi")
    if rsi_v is not None:
        if rsi_v < 30:
            rsi_s = 55 if t.get("rsi_rising") else 35   # sobreventa: posible rebote
        elif rsi_v < 45:
            rsi_s = scale(rsi_v, 30, 45, 40, 55)
        elif rsi_v <= 65:
            rsi_s = scale(rsi_v, 45, 65, 60, 85)
        elif rsi_v <= 75:
            rsi_s = scale(rsi_v, 65, 75, 75, 50)
        else:
            rsi_s = 30                                   # sobrecompra
        mom = [rsi_s]
        if t.get("ret_1m") is not None:
            mom.append(scale(t["ret_1m"], -12, 12))
        parts["momentum"] = sum(mom) / len(mom)

    # MACD
    if t.get("macd_hist") is not None and p:
        mh = t["macd_hist"] / p * 100
        base = scale(mh, -2, 2)
        if t.get("macd_hist_prev") is not None:
            base += 8 if t["macd_hist"] > t["macd_hist_prev"] else -8
        parts["macd"] = clamp(base)

    # Volumen confirmando el movimiento
    if t.get("vol_ratio") is not None and t.get("ret_1w") is not None:
        vr = t["vol_ratio"]
        up = t["ret_1w"] >= 0
        if vr > 1.3:
            parts["volume"] = 80 if up else 20
        elif vr < 0.7:
            parts["volume"] = 45
        else:
            parts["volume"] = 60 if up else 40

    # Bollinger: zona baja = oportunidad, extremo alto = extendido
    if t.get("bb_pct") is not None:
        b = t["bb_pct"]
        if b < 0.1:
            parts["bollinger"] = 65
        elif b < 0.5:
            parts["bollinger"] = 55 + (b - 0.1) * 50
        elif b < 0.85:
            parts["bollinger"] = 75 - (b - 0.5) * 30
        else:
            parts["bollinger"] = 35

    s, cov = weighted(parts, W["short"])
    return s, cov, parts


def score_medium(t: dict, f: dict, a: dict, W: dict) -> tuple:
    parts = {}
    # Consenso de analistas (1 = strong buy, 5 = strong sell)
    rm = a.get("mean_rating")
    if rm is not None and (a.get("count") or 0) >= 3:
        parts["analysts"] = scale(rm, 4.2, 1.4)
    # Upside al precio objetivo promedio
    up = a.get("upside")
    if up is not None:
        parts["upside"] = scale(up, -25, 45)
    # Revisiones de EPS últimos 30 días
    rev = a.get("revisions")
    if rev and (rev.get("up") or rev.get("down")):
        tot = rev["up"] + rev["down"]
        parts["revisions"] = scale((rev["up"] - rev["down"]) / tot, -1, 1)
    # Crecimiento esperado / reciente
    g = []
    if f.get("revenue_growth") is not None:
        g.append(scale(f["revenue_growth"], -10, 35))
    if f.get("earnings_growth") is not None:
        g.append(scale(f["earnings_growth"], -25, 60))
    parts["growth"] = sum(g) / len(g) if g else None
    # Momentum 3-6M y posición vs SMA200
    if t:
        m = []
        if t.get("ret_3m") is not None:
            m.append(scale(t["ret_3m"], -20, 25))
        if t.get("ret_6m") is not None:
            m.append(scale(t["ret_6m"], -30, 40))
        if t.get("sma200"):
            m.append(scale((t["price"] / t["sma200"] - 1) * 100, -15, 20))
        parts["momentum"] = sum(m) / len(m) if m else None
    # Valoración forward
    fpe = f.get("forward_pe")
    if fpe is not None and fpe > 0:
        parts["valuation"] = scale(fpe, 60, 10)
    s, cov = weighted(parts, W["medium"])
    return s, cov, parts


def score_long(t: dict, f: dict, a: dict, W: dict) -> tuple:
    parts = {}
    if f.get("revenue_growth") is not None:
        parts["growth"] = scale(f["revenue_growth"], -5, 30)
    prof = []
    if f.get("profit_margin") is not None:
        prof.append(scale(f["profit_margin"], -5, 30))
    if f.get("roe") is not None:
        prof.append(scale(f["roe"], 0, 35))
    parts["profitability"] = sum(prof) / len(prof) if prof else None
    de = f.get("debt_to_equity")
    if de is not None:
        parts["balance"] = scale(de, 250, 20)
    if f.get("fcf_yield") is not None:
        parts["cashflow"] = scale(f["fcf_yield"], -2, 6)
    val = []
    if f.get("peg") is not None and f["peg"] > 0:
        val.append(scale(f["peg"], 4, 0.8))
    if f.get("forward_pe") is not None and f["forward_pe"] > 0:
        val.append(scale(f["forward_pe"], 60, 12))
    parts["valuation"] = sum(val) / len(val) if val else None
    an = []
    if a.get("mean_rating") is not None and (a.get("count") or 0) >= 3:
        an.append(scale(a["mean_rating"], 4.2, 1.4))
    if a.get("upside") is not None:
        an.append(scale(a["upside"], -25, 45))
    parts["analysts"] = sum(an) / len(an) if an else None
    if t:
        tr = []
        if t.get("sma200"):
            tr.append(scale((t["price"] / t["sma200"] - 1) * 100, -20, 25))
        if t.get("ret_1y") is not None:
            tr.append(scale(t["ret_1y"], -30, 60))
        parts["trend"] = sum(tr) / len(tr) if tr else None
    s, cov = weighted(parts, W["long"])
    return s, cov, parts


def score_risk(t: dict, f: dict) -> tuple:
    """0 = muy seguro, 100 = muy riesgoso."""
    parts = []
    if f.get("beta") is not None:
        parts.append(scale(abs(f["beta"]), 0.5, 2.2))
    if t.get("vol30") is not None:
        parts.append(scale(t["vol30"], 12, 70))
    if t.get("max_dd") is not None:
        parts.append(scale(-t["max_dd"], 8, 55))
    mc = f.get("market_cap")
    if mc is not None:
        parts.append(scale(math.log10(max(mc, 1)), 11.5, 8.7))  # >300B seguro, <500M riesgoso
    if t.get("avg_dollar_vol") is not None:
        parts.append(scale(math.log10(max(t["avg_dollar_vol"], 1)), 9, 6.5))
    if t.get("price") is not None and t["price"] < 5:
        parts.append(90)
    if not parts:
        return None, "desconocido"
    s = sum(parts) / len(parts)
    label = "Bajo" if s < 35 else ("Medio" if s < 60 else "Alto")
    return s, label


def signal_from_score(score, sh, md, lg, risk, S: dict) -> str:
    if score is None:
        return "hold"
    if score >= S["strong_buy"] and (md or 0) >= S["strong_buy_min_horizon"] and (lg or 0) >= S["strong_buy_min_horizon"]:
        return "strong_buy"
    if score >= S["buy"]:
        return "buy"
    if score >= S["hold"]:
        return "hold"
    if score >= S["sell"]:
        return "sell"
    return "strong_sell"


def horizon_label(s):
    if s is None:
        return "hold"
    if s >= 78:
        return "strong_buy"
    if s >= 62:
        return "buy"
    if s >= 42:
        return "hold"
    if s >= 28:
        return "sell"
    return "strong_sell"


def build_reasons(t, f, a, parts_s, parts_m, parts_l, risk_label) -> list:
    """Explicaciones cortas, en español, ordenadas por importancia."""
    pos, neg = [], []
    if t:
        p = t["price"]
        if t.get("sma200") and t.get("sma50"):
            if p > t["sma50"] > t["sma200"]:
                pos.append("Tendencia alcista: precio sobre SMA50 y SMA200")
            elif p < t["sma50"] < t["sma200"]:
                neg.append("Tendencia bajista: precio bajo SMA50 y SMA200")
        rsi_v = t.get("rsi")
        if rsi_v is not None:
            if rsi_v > 75:
                neg.append(f"RSI {rsi_v:.0f}: sobrecomprado, riesgo de pausa")
            elif rsi_v < 30:
                pos.append(f"RSI {rsi_v:.0f}: sobrevendido, posible rebote")
        if t.get("macd_hist") is not None and t.get("macd_hist_prev") is not None:
            if t["macd_hist"] > 0 and t["macd_hist"] > t["macd_hist_prev"]:
                pos.append("MACD positivo y acelerando")
            elif t["macd_hist"] < 0 and t["macd_hist"] < t["macd_hist_prev"]:
                neg.append("MACD negativo y deteriorándose")
        if t.get("vol_ratio") and t["vol_ratio"] > 1.4:
            (pos if (t.get("ret_1w") or 0) >= 0 else neg).append(
                f"Volumen {t['vol_ratio']:.1f}x el promedio" + (" confirmando alza" if (t.get("ret_1w") or 0) >= 0 else " en caída"))
        if t.get("dist_hi52") is not None and t["dist_hi52"] > -3:
            pos.append("Cerca de máximos de 52 semanas")
        if t.get("dist_hi52") is not None and t["dist_hi52"] < -35:
            neg.append(f"{abs(t['dist_hi52']):.0f}% bajo su máximo de 52 semanas")
    if a.get("count"):
        key = a.get("key")
        if key in ("strong_buy", "buy"):
            pos.append(f"Analistas: {SIGNAL_LABELS.get(key, key)} ({a['count']} opiniones)")
        elif key in ("sell", "strong_sell", "underperform"):
            neg.append(f"Analistas: {SIGNAL_LABELS.get(key, 'Venta')} ({a['count']} opiniones)")
    if a.get("upside") is not None:
        if a["upside"] >= 20:
            pos.append(f"Potencial +{a['upside']:.0f}% al precio objetivo promedio")
        elif a["upside"] <= -5:
            neg.append(f"Precio sobre el objetivo de analistas ({a['upside']:.0f}%)")
    rev = a.get("revisions")
    if rev and (rev.get("up") or rev.get("down")):
        if rev["up"] > rev["down"] * 1.5:
            pos.append(f"Revisiones de EPS positivas ({rev['up']}↑ / {rev['down']}↓ en 30 días)")
        elif rev["down"] > rev["up"] * 1.5:
            neg.append(f"Revisiones de EPS negativas ({rev['up']}↑ / {rev['down']}↓ en 30 días)")
    if f.get("revenue_growth") is not None:
        if f["revenue_growth"] >= 20:
            pos.append(f"Ingresos creciendo {f['revenue_growth']:.0f}% anual")
        elif f["revenue_growth"] < 0:
            neg.append(f"Ingresos cayendo {f['revenue_growth']:.0f}% anual")
    if f.get("profit_margin") is not None and f["profit_margin"] < 0:
        neg.append("Empresa con pérdidas (margen neto negativo)")
    if f.get("debt_to_equity") is not None and f["debt_to_equity"] > 200:
        neg.append(f"Deuda elevada (D/E {f['debt_to_equity']:.0f}%)")
    if f.get("fcf_yield") is not None and f["fcf_yield"] >= 4:
        pos.append(f"Genera caja: FCF yield {f['fcf_yield']:.1f}%")
    if f.get("peg") is not None and 0 < f["peg"] < 1.2:
        pos.append(f"Valoración atractiva vs crecimiento (PEG {f['peg']:.2f})")
    if f.get("forward_pe") is not None and f["forward_pe"] > 50:
        neg.append(f"Valoración exigente (P/E forward {f['forward_pe']:.0f})")
    if risk_label == "Alto":
        neg.append("Riesgo alto: volatilidad / beta / drawdown elevados")
    return pos, neg


# --------------------------------------------------------------------------- #
# Descarga (Yahoo Finance)
# --------------------------------------------------------------------------- #
def fetch_ticker(sym: str, is_etf: bool) -> dict:
    import yfinance as yf

    tk = yf.Ticker(sym)
    out = {"symbol": sym, "etf": is_etf, "errors": []}

    try:
        hist = tk.history(period="1y", auto_adjust=True)
        hist = hist.dropna(subset=["Close"])
    except Exception as e:
        hist = None
        out["errors"].append(f"history: {e}")
    out["hist"] = hist

    info = {}
    try:
        info = tk.info or {}
    except Exception as e:
        out["errors"].append(f"info: {e}")
    out["info"] = info

    apt, recs, revs, earn = {}, None, None, None
    if not is_etf:
        try:
            apt = tk.analyst_price_targets or {}
        except Exception as e:
            out["errors"].append(f"targets: {e}")
        try:
            recs = tk.recommendations_summary
        except Exception as e:
            out["errors"].append(f"recs: {e}")
        try:
            revs = tk.eps_revisions
        except Exception as e:
            out["errors"].append(f"revisions: {e}")
        try:
            cal = tk.calendar or {}
            ed = cal.get("Earnings Date") or []
            if ed:
                earn = str(ed[0])[:10]
        except Exception as e:
            out["errors"].append(f"calendar: {e}")
    out["apt"], out["recs"], out["revs"], out["earnings_date"] = apt, recs, revs, earn

    try:
        out["news"] = tk.get_news(count=8) or []
    except Exception as e:
        out["news"] = []
        out["errors"].append(f"news: {e}")
    return out


def parse_news(items: list, max_age_days: int, limit: int) -> list:
    res = []
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
    for it in items or []:
        c = it.get("content") if isinstance(it, dict) and "content" in it else it
        if not isinstance(c, dict):
            continue
        title = c.get("title")
        if not title:
            continue
        pub = c.get("pubDate") or c.get("providerPublishTime")
        ts = None
        if isinstance(pub, (int, float)):
            ts = datetime.fromtimestamp(pub, tz=timezone.utc)
        elif isinstance(pub, str):
            try:
                ts = datetime.fromisoformat(pub.replace("Z", "+00:00"))
            except Exception:
                ts = None
        if ts and ts < cutoff:
            continue
        prov = c.get("provider") or {}
        publisher = prov.get("displayName") if isinstance(prov, dict) else c.get("publisher")
        link = None
        for k in ("canonicalUrl", "clickThroughUrl"):
            u = c.get(k)
            if isinstance(u, dict) and u.get("url"):
                link = u["url"]
                break
        link = link or c.get("link")
        res.append({
            "t": title[:180],
            "p": (publisher or "")[:40],
            "u": link,
            "d": ts.isoformat(timespec="minutes") if ts else None,
            "s": (c.get("summary") or "")[:150],
        })
    res.sort(key=lambda x: x["d"] or "", reverse=True)
    return res[:limit]


def parse_analysts(info: dict, apt: dict, recs, revs, price) -> dict:
    a = {}
    a["key"] = (info.get("recommendationKey") or "").replace("-", "_") or None
    a["mean_rating"] = num(info.get("recommendationMean"))
    a["count"] = int(info.get("numberOfAnalystOpinions") or 0)
    mean_t = num((apt or {}).get("mean")) or num(info.get("targetMeanPrice"))
    a["target_mean"] = mean_t
    a["target_high"] = num((apt or {}).get("high")) or num(info.get("targetHighPrice"))
    a["target_low"] = num((apt or {}).get("low")) or num(info.get("targetLowPrice"))
    a["upside"] = (mean_t / price - 1) * 100 if mean_t and price else None
    dist = None
    try:
        if recs is not None and len(recs):
            row = recs.iloc[0]
            dist = {k: int(row.get(col) or 0) for k, col in
                    (("sb", "strongBuy"), ("b", "buy"), ("h", "hold"), ("s", "sell"), ("ss", "strongSell"))}
            if a["count"] == 0:
                a["count"] = sum(dist.values())
    except Exception:
        dist = None
    a["dist"] = dist
    rev = None
    try:
        if revs is not None and len(revs):
            up = int(num(revs["upLast30days"].sum()) or 0) if "upLast30days" in revs else 0
            down = int(num(revs["downLast30days"].sum()) or 0) if "downLast30days" in revs else 0
            rev = {"up": up, "down": down}
    except Exception:
        rev = None
    a["revisions"] = rev
    return a


def parse_fundamentals(info: dict) -> dict:
    mc = num(info.get("marketCap"))
    fcf = num(info.get("freeCashflow"))
    pct = lambda k: (num(info.get(k)) * 100) if num(info.get(k)) is not None else None
    return {
        "name": (info.get("shortName") or info.get("longName") or "")[:40],
        "sector": info.get("sector") or ("ETF" if info.get("quoteType") == "ETF" else None),
        "industry": (info.get("industry") or "")[:40] or None,
        "market_cap": mc,
        "trailing_pe": num(info.get("trailingPE")),
        "forward_pe": num(info.get("forwardPE")),
        "peg": num(info.get("trailingPegRatio")) or num(info.get("pegRatio")),
        "revenue_growth": pct("revenueGrowth"),
        "earnings_growth": pct("earningsGrowth") if num(info.get("earningsGrowth")) is not None else pct("earningsQuarterlyGrowth"),
        "profit_margin": pct("profitMargins"),
        "operating_margin": pct("operatingMargins"),
        "roe": pct("returnOnEquity"),
        "debt_to_equity": num(info.get("debtToEquity")),
        "fcf_yield": (fcf / mc * 100) if fcf and mc else None,
        "dividend_yield": num(info.get("dividendYield")),  # Yahoo ya lo entrega en % (ej. 2.41)
        "beta": num(info.get("beta")) or num(info.get("beta3Year")),
        "currency": info.get("currency") or "USD",
        "expense_ratio": pct("annualReportExpenseRatio") if info.get("annualReportExpenseRatio") is not None else None,
    }


# --------------------------------------------------------------------------- #
# Modo demo (datos sintéticos, para probar la app sin internet)
# --------------------------------------------------------------------------- #
def demo_ticker(sym: str, is_etf: bool, seed: int) -> dict:
    rng = random.Random(seed)
    n = 260
    drift = rng.uniform(-0.0008, 0.0025)
    vol = rng.uniform(0.008, 0.035)
    p0 = rng.uniform(15, 600)
    closes, price = [], p0
    for _ in range(n):
        price *= math.exp(rng.gauss(drift, vol))
        closes.append(price)
    idx = pd.bdate_range(end=datetime.now(), periods=n)
    c = pd.Series(closes, index=idx)
    hist = pd.DataFrame({
        "Open": c.shift(1).fillna(c),
        "High": c * (1 + rng.uniform(0.002, 0.02)),
        "Low": c * (1 - rng.uniform(0.002, 0.02)),
        "Close": c,
        "Volume": [rng.uniform(5e5, 5e7) for _ in range(n)],
    })
    info = {
        "shortName": f"{sym} (demo)",
        "sector": "ETF" if is_etf else rng.choice(["Technology", "Healthcare", "Energy", "Financial Services", "Consumer Cyclical", "Industrials"]),
        "industry": None if is_etf else "Demo industry",
        "marketCap": None if is_etf else rng.uniform(5e9, 3e12),
        "currency": "USD",
        "quoteType": "ETF" if is_etf else "EQUITY",
    }
    apt, recs, revs = {}, None, None
    if not is_etf:
        info.update({
            "trailingPE": rng.uniform(8, 80), "forwardPE": rng.uniform(8, 60),
            "trailingPegRatio": rng.uniform(0.5, 4), "revenueGrowth": rng.uniform(-0.1, 0.6),
            "earningsGrowth": rng.uniform(-0.3, 0.9), "profitMargins": rng.uniform(-0.1, 0.45),
            "operatingMargins": rng.uniform(-0.1, 0.5), "returnOnEquity": rng.uniform(-0.1, 0.6),
            "debtToEquity": rng.uniform(0, 300), "freeCashflow": rng.uniform(-1e9, 5e10),
            "beta": rng.uniform(0.4, 2.5), "dividendYield": rng.choice([0, rng.uniform(0.5, 4.0)]),
            "recommendationMean": rng.uniform(1.3, 3.8), "numberOfAnalystOpinions": rng.randint(4, 50),
        })
        rm = info["recommendationMean"]
        info["recommendationKey"] = "strong_buy" if rm < 1.6 else ("buy" if rm < 2.5 else ("hold" if rm < 3.2 else "sell"))
        cur = float(c.iloc[-1])
        apt = {"current": cur, "mean": cur * rng.uniform(0.8, 1.6), "low": cur * rng.uniform(0.5, 0.95), "high": cur * rng.uniform(1.2, 2.2)}
        recs = pd.DataFrame([{"period": "0m", "strongBuy": rng.randint(0, 20), "buy": rng.randint(0, 20),
                              "hold": rng.randint(0, 15), "sell": rng.randint(0, 5), "strongSell": rng.randint(0, 3)}])
        revs = pd.DataFrame({"upLast30days": [rng.randint(0, 12)] * 4, "downLast30days": [rng.randint(0, 12)] * 4})
    news = [{"content": {"title": f"{sym}: noticia de demostración #{i+1}", "pubDate": (datetime.now(timezone.utc) - timedelta(hours=6 * i)).isoformat(),
                         "provider": {"displayName": "Demo News"}, "canonicalUrl": {"url": "https://finance.yahoo.com/quote/" + sym},
                         "summary": "Texto sintético. Ejecuta el workflow de GitHub Actions para obtener noticias reales."}} for i in range(3)]
    return {"symbol": sym, "etf": is_etf, "errors": [], "hist": hist, "info": info, "apt": apt, "recs": recs,
            "revs": revs, "earnings_date": (datetime.now() + timedelta(days=rng.randint(3, 80))).strftime("%Y-%m-%d") if not is_etf else None,
            "news": news}


# --------------------------------------------------------------------------- #
# Ensamblado
# --------------------------------------------------------------------------- #
def analyze(raw: dict, W: dict) -> dict:
    sym = raw["symbol"]
    t = technicals(raw.get("hist"))
    info = raw.get("info") or {}
    f = parse_fundamentals(info)
    price = t.get("price") or num(info.get("currentPrice")) or num(info.get("regularMarketPrice"))
    if t and not t.get("price"):
        t["price"] = price
    a = parse_analysts(info, raw.get("apt"), raw.get("recs"), raw.get("revs"), price) if not raw["etf"] else {}

    sh, cov_s, ps = score_short(t, W)
    md, cov_m, pm = score_medium(t, f, a, W)
    lg, cov_l, pl = score_long(t, f, a, W)
    risk, risk_label = score_risk(t, f)

    # Para ETFs no hay fundamentales: el mediano/largo se apoya en momentum/tendencia.
    hw = dict(W["horizons"])
    parts_total = {"short": sh, "medium": md, "long": lg}
    total, cov_total = weighted(parts_total, hw)
    coverage = (cov_s * hw["short"] + cov_m * hw["medium"] + cov_l * hw["long"])
    confidence = "alta" if coverage >= 0.8 else ("media" if coverage >= 0.5 else "baja")
    sig = signal_from_score(total, sh, md, lg, risk, W["signal"])
    # Sin datos suficientes (p.ej. ETFs sin fundamentales) no se emiten señales "fuertes".
    if confidence == "baja":
        sig = {"strong_buy": "buy", "strong_sell": "sell"}.get(sig, sig)

    pos_r, neg_r = build_reasons(t, f, a, ps, pm, pl, risk_label)
    # En señales de venta, primero los motivos negativos; en compra, los positivos.
    reasons = (neg_r[:5] + pos_r[:5]) if sig in ("sell", "strong_sell") else (pos_r[:5] + neg_r[:5])

    prev_close = None
    hist = raw.get("hist")
    if hist is not None and len(hist) >= 2:
        prev_close = float(hist["Close"].iloc[-2])
    change_1d = (price / prev_close - 1) * 100 if price and prev_close else None

    return {
        "sym": sym,
        "name": f["name"] or sym,
        "etf": raw["etf"],
        "sector": f["sector"],
        "industry": f["industry"],
        "price": r(price),
        "chg1d": r(change_1d),
        "currency": f["currency"],
        "score": r(total, 0),
        "signal": sig,
        "conf": confidence,
        "h": {  # horizontes
            "short": {"s": r(sh, 0), "sig": horizon_label(sh), "parts": {k: r(v, 0) for k, v in ps.items()}},
            "medium": {"s": r(md, 0), "sig": horizon_label(md), "parts": {k: r(v, 0) for k, v in pm.items()}},
            "long": {"s": r(lg, 0), "sig": horizon_label(lg), "parts": {k: r(v, 0) for k, v in pl.items()}},
        },
        "risk": {"s": r(risk, 0), "label": risk_label},
        "tech": {
            "rating": technical_rating(t) if t else None,
            "rsi": r(t.get("rsi"), 0) if t else None,
            "macd_hist": r(t.get("macd_hist"), 3) if t else None,
            "sma20": r(t.get("sma20")), "sma50": r(t.get("sma50")), "sma200": r(t.get("sma200")),
            "bb_pct": r(t.get("bb_pct")), "atr_pct": r(t.get("atr_pct"), 1),
            "ret": {k: r(t.get(f"ret_{k}"), 1) for k in ("1w", "1m", "3m", "6m", "1y")} if t else {},
            "vol30": r(t.get("vol30"), 0) if t else None, "max_dd": r(t.get("max_dd"), 0) if t else None,
            "vol_ratio": r(t.get("vol_ratio")) if t else None,
            "hi52": r(t.get("hi52")), "lo52": r(t.get("lo52")),
            "spark": t.get("spark") if t else [],
        },
        "fund": {k: r(v, 2) if isinstance(v, (int, float)) else v for k, v in f.items() if k not in ("name", "sector", "industry", "currency")},
        "analysts": {
            "key": a.get("key"), "mean": r(a.get("mean_rating")), "count": a.get("count"),
            "target": {"mean": r(a.get("target_mean")), "high": r(a.get("target_high")), "low": r(a.get("target_low"))},
            "upside": r(a.get("upside"), 1), "dist": a.get("dist"), "revisions": a.get("revisions"),
        } if a else None,
        "earnings_date": raw.get("earnings_date"),
        "reasons": reasons,
        "news": parse_news(raw.get("news"), W["retention"]["news_max_age_days"], W["retention"]["news_per_ticker"]),
        "errors": raw.get("errors") or [],
    }


def market_regime(market: dict) -> dict:
    spx = market.get("^GSPC") or {}
    vix = market.get("^VIX") or {}
    points = 0
    notes = []
    if spx.get("above_sma200") is True:
        points += 1
        notes.append("S&P 500 sobre su media de 200 días")
    elif spx.get("above_sma200") is False:
        points -= 1
        notes.append("S&P 500 bajo su media de 200 días")
    v = vix.get("price")
    if v is not None:
        if v < 18:
            points += 1
            notes.append(f"VIX bajo ({v:.0f}): mercado tranquilo")
        elif v > 28:
            points -= 1
            notes.append(f"VIX alto ({v:.0f}): miedo elevado")
        else:
            notes.append(f"VIX moderado ({v:.0f})")
    m1 = spx.get("ret_1m")
    if m1 is not None:
        if m1 > 2:
            points += 1
        elif m1 < -4:
            points -= 1
    label = "Risk-on" if points >= 2 else ("Risk-off" if points <= -1 else "Neutral")
    desc = {
        "Risk-on": "Entorno favorable: las señales de compra tienen más respaldo.",
        "Neutral": "Entorno mixto: exige más confluencia antes de comprar fuerte.",
        "Risk-off": "Entorno defensivo: prioriza proteger capital y reduce tamaño de posiciones.",
    }[label]
    return {"label": label, "desc": desc, "notes": notes}


def build_market(symbols: dict, demo: bool) -> dict:
    out = {}
    for sym, name in symbols.items():
        try:
            if demo:
                raw = demo_ticker(sym, True, seed=hash(sym) % 10000)
                hist = raw["hist"]
            else:
                import yfinance as yf
                hist = yf.Ticker(sym).history(period="1y", auto_adjust=True).dropna(subset=["Close"])
            if hist is None or len(hist) < 5:
                continue
            c = hist["Close"].astype(float)
            price = float(c.iloc[-1])
            sma200 = float(c.rolling(200).mean().iloc[-1]) if len(c) >= 200 else None

            def ret(d):
                return (price / float(c.iloc[-1 - d]) - 1) * 100 if len(c) > d else None

            out[sym] = {
                "name": name, "price": r(price, 2 if price < 1000 else 0),
                "chg1d": r(ret(1)), "ret_1w": r(ret(5), 1), "ret_1m": r(ret(21), 1), "ret_ytd": None,
                "above_sma200": (price > sma200) if sma200 else None,
                "spark": [round(float(x), 2) for x in c.tail(60).iloc[::2]],
            }
        except Exception as e:
            print(f"  ! mercado {sym}: {e}", file=sys.stderr)
        if not demo:
            time.sleep(0.4)
    return out


def update_history(history: dict, tickers: list, today: str, keep_days: int, universe: set) -> dict:
    """history = {sym: [{d, p, s, sig, sh, md, lg}, ...]} — solo N días, solo universo."""
    new_hist = {}
    for tk in tickers:
        rows = [row for row in history.get(tk["sym"], []) if row.get("d") != today]
        rows.append({"d": today, "p": tk["price"], "s": tk["score"], "sig": tk["signal"],
                     "sh": tk["h"]["short"]["s"], "md": tk["h"]["medium"]["s"], "lg": tk["h"]["long"]["s"]})
        rows.sort(key=lambda x: x["d"])
        new_hist[tk["sym"]] = rows[-keep_days:]
    # Tickers que ya no están en el universo se eliminan (auto-limpieza).
    for sym in list(history.keys()):
        if sym in universe and sym not in new_hist:
            new_hist[sym] = history[sym][-keep_days:]
    return new_hist


def signal_changes(tickers: list, history: dict) -> list:
    """Detecta cambios de señal vs. ayer y vs. hace ~7 días."""
    changes = []
    order = ["strong_sell", "sell", "hold", "buy", "strong_buy"]
    for tk in tickers:
        rows = history.get(tk["sym"], [])
        if len(rows) < 2:
            continue
        prev = rows[-2]
        week = rows[-8] if len(rows) >= 8 else rows[0]
        for ref, label in ((prev, "1d"), (week, "7d")):
            if ref.get("sig") and ref["sig"] != tk["signal"]:
                direction = "up" if order.index(tk["signal"]) > order.index(ref["sig"]) else "down"
                changes.append({"sym": tk["sym"], "from": ref["sig"], "to": tk["signal"], "since": label,
                                "dir": direction, "score_from": ref.get("s"), "score_to": tk["score"]})
                break
    changes.sort(key=lambda c: abs((c["score_to"] or 0) - (c["score_from"] or 0)), reverse=True)
    return changes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true", help="datos sintéticos, sin internet")
    ap.add_argument("--only", help="lista de tickers separada por comas")
    ap.add_argument("--sleep", type=float, default=0.4, help="pausa entre tickers (rate limit)")
    args = ap.parse_args()

    universe = load_json(CONFIG_DIR / "universe.json", {})
    W = load_json(CONFIG_DIR / "weights.json", {})
    if not universe or not W:
        print("Faltan config/universe.json o config/weights.json", file=sys.stderr)
        sys.exit(1)

    stocks = list(dict.fromkeys(universe.get("stocks", [])))
    etfs = [e for e in dict.fromkeys(universe.get("etfs", [])) if e not in stocks]
    if args.only:
        wanted = {s.strip().upper() for s in args.only.split(",")}
        stocks = [s for s in stocks if s in wanted]
        etfs = [s for s in etfs if s in wanted]
        # permitir tickers fuera del universo
        for s in wanted - set(stocks) - set(etfs):
            stocks.append(s)

    now = datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")
    print(f"== Market Intelligence AI :: {today} :: {'DEMO' if args.demo else 'REAL'} :: {len(stocks)} acciones, {len(etfs)} ETFs")

    tickers, failed = [], []
    for i, (sym, is_etf) in enumerate([(s, False) for s in stocks] + [(e, True) for e in etfs]):
        try:
            raw = demo_ticker(sym, is_etf, seed=i * 7919) if args.demo else fetch_ticker(sym, is_etf)
            if raw.get("hist") is None or len(raw["hist"]) < 30:
                raise RuntimeError("sin historial de precios suficiente")
            res = analyze(raw, W)
            tickers.append(res)
            print(f"  {sym:<7} {str(res['price']):>9}  score {str(res['score']):>4}  {SIGNAL_LABELS[res['signal']]:<14} "
                  f"C{res['h']['short']['s']} M{res['h']['medium']['s']} L{res['h']['long']['s']}  riesgo {res['risk']['label']}"
                  + (f"  [{len(res['errors'])} avisos]" if res["errors"] else ""))
        except Exception as e:
            failed.append({"sym": sym, "error": str(e)[:160]})
            print(f"  {sym:<7} ERROR: {e}", file=sys.stderr)
        if not args.demo:
            time.sleep(args.sleep)

    market = build_market(universe.get("market", {}), args.demo)
    regime = market_regime(market)

    history = load_json(DATA_DIR / "history.json", {})
    history = update_history(history, tickers, today, W["retention"]["history_days"], set(stocks) | set(etfs))
    changes = signal_changes(tickers, history)

    # Clasificación de noticias (heurística + Claude opcional) y titulares de mercado.
    from news_ai import classify_all
    news_stats = classify_all({tk["sym"]: tk["news"] for tk in tickers},
                              max_ai=int(os.environ.get("NEWS_AI_MAX", "250")) if not args.demo else 0)
    print(f"== noticias: {news_stats}")
    seen, market_news = set(), []
    for tk in tickers:
        for nw in tk["news"]:
            if nw["t"] in seen:
                continue
            seen.add(nw["t"])
            market_news.append(dict(nw))
    market_news.sort(key=lambda x: (-(x.get("prio") or 0), x.get("d") or ""))
    market_news = market_news[: W["retention"]["market_news"]]

    tickers.sort(key=lambda x: -(x["score"] or 0))
    latest = {
        "generated_at": now.isoformat(timespec="minutes"),
        "date": today,
        "demo": bool(args.demo),
        "version": 2,
        "weights": {k: v for k, v in W.items() if not k.startswith("_")},
        "labels": SIGNAL_LABELS,
        "regime": regime,
        "market": market,
        "market_news": market_news,
        "news_stats": news_stats,
        "changes": changes[:30],
        "tickers": tickers,
        "failed": failed,
        "stats": {"ok": len(tickers), "failed": len(failed)},
    }
    save_json(DATA_DIR / "latest.json", latest)
    save_json(DATA_DIR / "history.json", history)
    size = (DATA_DIR / "latest.json").stat().st_size / 1024
    hsize = (DATA_DIR / "history.json").stat().st_size / 1024
    print(f"== listo: {len(tickers)} ok, {len(failed)} fallidos. latest.json {size:.0f} KB, history.json {hsize:.0f} KB. Régimen: {regime['label']}")


if __name__ == "__main__":
    main()
