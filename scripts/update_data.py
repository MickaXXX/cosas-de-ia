#!/usr/bin/env python3
"""
Market Intelligence AI - generador de datos (motor rápido v2).

Optimizaciones frente a la v1:
  * Precios en lote  : un solo request por cada ~120 símbolos (yf.download).
  * Metadatos en 1   : una sola llamada quoteSummary por activo trae fundamentales,
                       analistas, revisiones de EPS y fecha de resultados
                       (antes eran 5 peticiones distintas).
  * Paralelismo      : ThreadPoolExecutor sobre los activos que toca refrescar.
  * Caché rotativa   : los fundamentales cambian poco; se reutilizan del snapshot
                       anterior salvo para los prioritarios (cartera, gurús,
                       tendencia) y una tanda rotatoria del resto.

Modos:
    --mode fast    solo precios y técnico de todo el universo (~1-2 min)
    --mode daily   fast + metadatos de prioritarios y rotación (por defecto)
    --mode full    fast + metadatos de todo el universo

Uso:
    python scripts/update_data.py --mode daily
    python scripts/update_data.py --demo          # datos sintéticos, sin red
    python scripts/update_data.py --only NVDA,AAPL
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
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

# Un solo request de quoteSummary trae todo esto:
QS_MODULES = [
    "price", "summaryDetail", "summaryProfile", "defaultKeyStatistics",
    "financialData", "recommendationTrend", "earningsTrend", "calendarEvents",
]


# --------------------------------------------------------------------------- #
# Utilidades
# --------------------------------------------------------------------------- #
def env_int(name: str, default: int) -> int:
    """Variables de GitHub Actions sin definir llegan como cadena vacía."""
    try:
        return int((os.environ.get(name) or "").strip() or default)
    except ValueError:
        return default


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
    """Convierte a float o None. Desenvuelve {'raw': ...} de la API de Yahoo."""
    if isinstance(x, dict):
        x = x.get("raw")
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
    total_w = acc = used_w = 0.0
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
    return (100 - (100 / (1 + rs))).fillna(50)


def technicals(hist: pd.DataFrame) -> dict:
    """Indicadores a partir de OHLCV diario (>= 30 filas)."""
    if hist is None or len(hist) < 30:
        return {}
    c = hist["Close"].astype(float)
    h = hist["High"].astype(float) if "High" in hist else c
    l = hist["Low"].astype(float) if "Low" in hist else c
    v = hist["Volume"].astype(float) if "Volume" in hist else pd.Series(0.0, index=c.index)
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
        upper, lower = sma20 + 2 * std20, sma20 - 2 * std20
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
    dd = (c / c.cummax() - 1) * 100
    max_dd = float(dd.min()) if n else None

    vol_ratio = None
    if n >= 50 and float(v.tail(50).mean()) > 0:
        vol_ratio = float(v.tail(5).mean() / v.tail(50).mean())

    hi52, lo52 = float(h.tail(252).max()), float(l.tail(252).min())
    rsi_s = rsi(c)
    rsi14 = float(rsi_s.iloc[-1])
    rsi_prev = float(rsi_s.iloc[-4]) if n > 20 else rsi14

    return {
        "price": price, "sma20": sma20, "sma50": sma(50), "sma200": sma(200),
        "rsi": rsi14, "rsi_rising": rsi14 > rsi_prev,
        "macd": float(macd.iloc[-1]), "macd_signal": float(signal.iloc[-1]),
        "macd_hist": float(hist_macd.iloc[-1]),
        "macd_hist_prev": float(hist_macd.iloc[-2]) if n > 2 else None,
        "bb_pct": bb_pct, "atr_pct": (atr14 / price * 100) if atr14 and price else None,
        "ret_1w": ret(5), "ret_1m": ret(21), "ret_3m": ret(63), "ret_6m": ret(126),
        "ret_1y": ret(252) if n > 252 else ret(n - 1),
        "vol30": vol30, "max_dd": max_dd, "vol_ratio": vol_ratio,
        "hi52": hi52, "lo52": lo52,
        "dist_hi52": (price / hi52 - 1) * 100 if hi52 else None,
        "dist_lo52": (price / lo52 - 1) * 100 if lo52 else None,
        "avg_dollar_vol": float((c * v).tail(30).mean()),
        "spark": [round(float(x), 2) for x in c.tail(129).iloc[::3]],  # ~6 meses
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
    score = (buy - sell) / len(votes) if votes else 0
    label = ("strong_buy" if score >= 0.5 else "buy" if score >= 0.1
             else "strong_sell" if score <= -0.5 else "sell" if score <= -0.1 else "neutral")
    return {"label": label, "buy": buy, "sell": sell, "neutral": len(votes) - buy - sell}


# --------------------------------------------------------------------------- #
# Scoring por horizonte
# --------------------------------------------------------------------------- #
def score_short(t: dict, W: dict) -> tuple:
    if not t:
        return None, 0.0, {}
    p = t["price"]
    parts = {}
    trend = []
    if t.get("sma20"):
        trend.append(scale((p / t["sma20"] - 1) * 100, -6, 6))
    if t.get("sma50"):
        trend.append(scale((p / t["sma50"] - 1) * 100, -10, 10))
    parts["trend"] = sum(trend) / len(trend) if trend else None

    rsi_v = t.get("rsi")
    if rsi_v is not None:
        if rsi_v < 30:
            rsi_s = 55 if t.get("rsi_rising") else 35
        elif rsi_v < 45:
            rsi_s = scale(rsi_v, 30, 45, 40, 55)
        elif rsi_v <= 65:
            rsi_s = scale(rsi_v, 45, 65, 60, 85)
        elif rsi_v <= 75:
            rsi_s = scale(rsi_v, 65, 75, 75, 50)
        else:
            rsi_s = 30
        mom = [rsi_s]
        if t.get("ret_1m") is not None:
            mom.append(scale(t["ret_1m"], -12, 12))
        parts["momentum"] = sum(mom) / len(mom)

    if t.get("macd_hist") is not None and p:
        base = scale(t["macd_hist"] / p * 100, -2, 2)
        if t.get("macd_hist_prev") is not None:
            base += 8 if t["macd_hist"] > t["macd_hist_prev"] else -8
        parts["macd"] = clamp(base)

    if t.get("vol_ratio") is not None and t.get("ret_1w") is not None:
        vr, up = t["vol_ratio"], t["ret_1w"] >= 0
        parts["volume"] = (80 if up else 20) if vr > 1.3 else (45 if vr < 0.7 else (60 if up else 40))

    if t.get("bb_pct") is not None:
        b = t["bb_pct"]
        parts["bollinger"] = (65 if b < 0.1 else 55 + (b - 0.1) * 50 if b < 0.5
                              else 75 - (b - 0.5) * 30 if b < 0.85 else 35)

    s, cov = weighted(parts, W["short"])
    return s, cov, parts


def score_medium(t: dict, f: dict, a: dict, W: dict) -> tuple:
    parts = {}
    rm = a.get("mean_rating")
    if rm is not None and (a.get("count") or 0) >= 3:
        parts["analysts"] = scale(rm, 4.2, 1.4)
    if a.get("upside") is not None:
        parts["upside"] = scale(a["upside"], -25, 45)
    rev = a.get("revisions")
    if rev and (rev.get("up") or rev.get("down")):
        tot = rev["up"] + rev["down"]
        parts["revisions"] = scale((rev["up"] - rev["down"]) / tot, -1, 1)
    g = []
    if f.get("revenue_growth") is not None:
        g.append(scale(f["revenue_growth"], -10, 35))
    if f.get("earnings_growth") is not None:
        g.append(scale(f["earnings_growth"], -25, 60))
    parts["growth"] = sum(g) / len(g) if g else None
    if t:
        m = []
        if t.get("ret_3m") is not None:
            m.append(scale(t["ret_3m"], -20, 25))
        if t.get("ret_6m") is not None:
            m.append(scale(t["ret_6m"], -30, 40))
        if t.get("sma200"):
            m.append(scale((t["price"] / t["sma200"] - 1) * 100, -15, 20))
        parts["momentum"] = sum(m) / len(m) if m else None
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
    if f.get("debt_to_equity") is not None:
        parts["balance"] = scale(f["debt_to_equity"], 250, 20)
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
        parts.append(scale(math.log10(max(mc, 1)), 11.5, 8.7))
    if t.get("avg_dollar_vol") is not None:
        parts.append(scale(math.log10(max(t["avg_dollar_vol"], 1)), 9, 6.5))
    if t.get("price") is not None and t["price"] < 5:
        parts.append(90)
    if not parts:
        return None, "desconocido"
    s = sum(parts) / len(parts)
    return s, "Bajo" if s < 35 else ("Medio" if s < 60 else "Alto")


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
    return ("strong_buy" if s >= 78 else "buy" if s >= 62 else "hold" if s >= 42
            else "sell" if s >= 28 else "strong_sell")


def build_reasons(t, f, a, risk_label) -> tuple:
    """Explicaciones cortas en español: (positivas, negativas)."""
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
            up = (t.get("ret_1w") or 0) >= 0
            (pos if up else neg).append(
                f"Volumen {t['vol_ratio']:.1f}x el promedio" + (" confirmando alza" if up else " en caída"))
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
# Descarga
# --------------------------------------------------------------------------- #
def _download_chunk(part: list, period: str, out: dict):
    import yfinance as yf
    try:
        df = yf.download(part, period=period, interval="1d", group_by="ticker",
                         auto_adjust=True, progress=False, threads=True, timeout=30)
    except Exception as e:
        print(f"  ! lote precios: {str(e)[:90]}", file=sys.stderr)
        return
    for sym in part:
        try:
            sub = df[sym] if isinstance(df.columns, pd.MultiIndex) else df
            sub = sub.dropna(subset=["Close"])
            if len(sub) >= 30:
                out[sym] = sub
        except Exception:
            continue


def batch_history(symbols: list, chunk=120, period="1y") -> dict:
    """Precios de todos los símbolos en pocas peticiones, con dos reintentos
    en lotes cada vez más chicos para recuperar los que fallan de forma
    intermitente (un lote grande a veces vuelve incompleto)."""
    out = {}
    for i in range(0, len(symbols), chunk):
        _download_chunk(symbols[i:i + chunk], period, out)
        print(f"  precios {min(i + chunk, len(symbols))}/{len(symbols)} ({len(out)} ok)", flush=True)
    for size in (25, 8):
        missing = [s for s in symbols if s not in out]
        if not missing:
            break
        print(f"  reintento de {len(missing)} símbolos en lotes de {size}", flush=True)
        for i in range(0, len(missing), size):
            _download_chunk(missing[i:i + size], period, out)
            time.sleep(0.4)
    missing = [s for s in symbols if s not in out]
    if missing:
        print(f"  sin precios tras reintentos: {', '.join(missing)}", file=sys.stderr)
    return out


def fetch_meta(sym: str, want_news: bool = True, want_qs: bool = True) -> dict:
    """Un request de quoteSummary (+ noticias) por activo."""
    from yfinance.data import YfData
    from yfinance.scrapers.quote import _QUOTE_SUMMARY_URL_
    out = {"sym": sym, "errors": [], "mods": {}}
    params = {"modules": ",".join(QS_MODULES), "corsDomain": "finance.yahoo.com",
              "formatted": "false", "symbol": sym}
    for attempt in range(3 if want_qs else 0):
        try:
            j = YfData().get_raw_json(f"{_QUOTE_SUMMARY_URL_}/{sym}", params=params, timeout=20)
            res = (j.get("quoteSummary") or {}).get("result") or []
            out["mods"] = res[0] if res else {}
            break
        except Exception as e:
            msg = str(e)[:80]
            if attempt == 2:
                out["errors"].append(f"quoteSummary: {msg}")
            else:
                time.sleep(1.5 * (attempt + 1) + random.random())
    if want_news:
        try:
            import yfinance as yf
            out["news"] = yf.Ticker(sym).get_news(count=6) or []
        except Exception as e:
            out["news"] = []
            out["errors"].append(f"news: {str(e)[:60]}")
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
        res.append({
            "t": title[:180], "p": (publisher or "")[:40], "u": link or c.get("link"),
            "d": ts.isoformat(timespec="minutes") if ts else None,
            "s": (c.get("summary") or "")[:150],
        })
    res.sort(key=lambda x: x["d"] or "", reverse=True)
    return res[:limit]


def parse_modules(mods: dict, price_hint=None) -> dict:
    """Convierte los módulos crudos de Yahoo en {fund, analysts, earnings_date}."""
    price_m = mods.get("price") or {}
    sd = mods.get("summaryDetail") or {}
    sp = mods.get("summaryProfile") or {}
    ks = mods.get("defaultKeyStatistics") or {}
    fd = mods.get("financialData") or {}

    mc = num(price_m.get("marketCap")) or num(sd.get("marketCap"))
    fcf = num(fd.get("freeCashflow"))
    dy = num(sd.get("dividendYield")) or num(sd.get("trailingAnnualDividendYield"))
    if dy is not None and dy <= 1:      # Yahoo entrega fracción en el JSON crudo
        dy *= 100
    pct_ = lambda d, k: (num(d.get(k)) * 100) if num(d.get(k)) is not None else None

    fund = {
        "name": (price_m.get("shortName") or price_m.get("longName") or "")[:40],
        "sector": sp.get("sector") or ("ETF" if price_m.get("quoteType") == "ETF" else None),
        "industry": (sp.get("industry") or "")[:40] or None,
        "market_cap": mc,
        "trailing_pe": num(sd.get("trailingPE")),
        "forward_pe": num(sd.get("forwardPE")) or num(ks.get("forwardPE")),
        "peg": num(ks.get("trailingPegRatio")) or num(ks.get("pegRatio")),
        "revenue_growth": pct_(fd, "revenueGrowth"),
        "earnings_growth": pct_(fd, "earningsGrowth") if num(fd.get("earningsGrowth")) is not None else pct_(ks, "earningsQuarterlyGrowth"),
        "profit_margin": pct_(fd, "profitMargins"),
        "operating_margin": pct_(fd, "operatingMargins"),
        "roe": pct_(fd, "returnOnEquity"),
        "debt_to_equity": num(fd.get("debtToEquity")),
        "fcf_yield": (fcf / mc * 100) if fcf and mc else None,
        "dividend_yield": dy,
        "beta": num(sd.get("beta")) or num(ks.get("beta")) or num(ks.get("beta3Year")),
        "currency": price_m.get("currency") or "USD",
        "quote_type": price_m.get("quoteType"),
        "price": num(fd.get("currentPrice")) or num(price_m.get("regularMarketPrice")),
    }

    a = {}
    a["key"] = (fd.get("recommendationKey") or "").replace("-", "_") or None
    a["mean_rating"] = num(fd.get("recommendationMean"))
    a["count"] = int(num(fd.get("numberOfAnalystOpinions")) or 0)
    mean_t = num(fd.get("targetMeanPrice"))
    a["target_mean"] = mean_t
    a["target_high"] = num(fd.get("targetHighPrice"))
    a["target_low"] = num(fd.get("targetLowPrice"))
    p_ref = fund["price"] or price_hint
    a["upside"] = (mean_t / p_ref - 1) * 100 if mean_t and p_ref else None

    trend = (mods.get("recommendationTrend") or {}).get("trend") or []
    if trend:
        row = trend[0]
        a["dist"] = {"sb": int(num(row.get("strongBuy")) or 0), "b": int(num(row.get("buy")) or 0),
                     "h": int(num(row.get("hold")) or 0), "s": int(num(row.get("sell")) or 0),
                     "ss": int(num(row.get("strongSell")) or 0)}
        if a["count"] == 0:
            a["count"] = sum(a["dist"].values())
    else:
        a["dist"] = None

    up = down = 0
    for tr in (mods.get("earningsTrend") or {}).get("trend") or []:
        er = tr.get("epsRevisions") or {}
        up += int(num(er.get("upLast30days")) or 0)
        down += int(num(er.get("downLast30days")) or 0)
    a["revisions"] = {"up": up, "down": down} if (up or down) else None

    earn = None
    try:
        ed = ((mods.get("calendarEvents") or {}).get("earnings") or {}).get("earningsDate") or []
        if ed:
            ts = num(ed[0])
            if ts:
                earn = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        earn = None

    return {"fund": fund, "analysts": a, "earnings_date": earn}


# --------------------------------------------------------------------------- #
# Modo demo (sin red)
# --------------------------------------------------------------------------- #
def demo_bundle(sym: str, is_etf: bool, seed: int) -> tuple:
    rng = random.Random(seed)
    n = 260
    drift, vol, price = rng.uniform(-0.0008, 0.0025), rng.uniform(0.008, 0.035), rng.uniform(15, 600)
    closes = []
    for _ in range(n):
        price *= math.exp(rng.gauss(drift, vol))
        closes.append(price)
    idx = pd.bdate_range(end=datetime.now(), periods=n)
    c = pd.Series(closes, index=idx)
    hist = pd.DataFrame({"Open": c.shift(1).fillna(c), "High": c * 1.01, "Low": c * 0.99,
                         "Close": c, "Volume": [rng.uniform(5e5, 5e7) for _ in range(n)]})
    cur = float(c.iloc[-1])
    fund = {"name": f"{sym} (demo)", "sector": "ETF" if is_etf else rng.choice(
        ["Technology", "Healthcare", "Energy", "Financial Services", "Consumer Cyclical", "Industrials"]),
        "industry": None if is_etf else "Demo industry", "market_cap": None if is_etf else rng.uniform(5e9, 3e12),
        "currency": "USD", "quote_type": "ETF" if is_etf else "EQUITY", "price": cur,
        "trailing_pe": None, "forward_pe": None, "peg": None, "revenue_growth": None,
        "earnings_growth": None, "profit_margin": None, "operating_margin": None, "roe": None,
        "debt_to_equity": None, "fcf_yield": None, "dividend_yield": None, "beta": None}
    a = {"key": None, "mean_rating": None, "count": 0, "target_mean": None, "target_high": None,
         "target_low": None, "upside": None, "dist": None, "revisions": None}
    if not is_etf:
        fund.update({"trailing_pe": rng.uniform(8, 80), "forward_pe": rng.uniform(8, 60),
                     "peg": rng.uniform(0.5, 4), "revenue_growth": rng.uniform(-10, 60),
                     "earnings_growth": rng.uniform(-30, 90), "profit_margin": rng.uniform(-10, 45),
                     "operating_margin": rng.uniform(-10, 50), "roe": rng.uniform(-10, 60),
                     "debt_to_equity": rng.uniform(0, 300), "fcf_yield": rng.uniform(-2, 8),
                     "dividend_yield": rng.choice([0, rng.uniform(0.5, 4)]), "beta": rng.uniform(0.4, 2.5)})
        rm = rng.uniform(1.3, 3.8)
        a.update({"mean_rating": rm, "count": rng.randint(4, 50), "target_mean": cur * rng.uniform(0.8, 1.6),
                  "target_low": cur * 0.8, "target_high": cur * 1.8,
                  "key": "strong_buy" if rm < 1.6 else ("buy" if rm < 2.5 else ("hold" if rm < 3.2 else "sell")),
                  "dist": {"sb": rng.randint(0, 20), "b": rng.randint(0, 20), "h": rng.randint(0, 15),
                           "s": rng.randint(0, 5), "ss": rng.randint(0, 3)},
                  "revisions": {"up": rng.randint(0, 12), "down": rng.randint(0, 12)}})
        a["upside"] = (a["target_mean"] / cur - 1) * 100
    news = [{"content": {"title": f"{sym}: noticia de demostración #{i + 1}",
                         "pubDate": (datetime.now(timezone.utc) - timedelta(hours=6 * i)).isoformat(),
                         "provider": {"displayName": "Demo News"},
                         "canonicalUrl": {"url": "https://finance.yahoo.com/quote/" + sym},
                         "summary": "Texto sintético. Ejecuta el workflow para datos reales."}} for i in range(2)]
    meta = {"fund": fund, "analysts": a,
            "earnings_date": (datetime.now() + timedelta(days=rng.randint(3, 80))).strftime("%Y-%m-%d") if not is_etf else None,
            "news": news}
    return hist, meta


# --------------------------------------------------------------------------- #
# Ensamblado
# --------------------------------------------------------------------------- #
def analyze(sym, hist, meta, is_etf, W, gurus) -> dict:
    t = technicals(hist)
    f = dict(meta.get("fund") or {})
    a = dict(meta.get("analysts") or {}) if not is_etf else {}
    price = t.get("price") or f.get("price")
    if t and not t.get("price"):
        t["price"] = price
    if a.get("target_mean") and price and a.get("upside") is None:
        a["upside"] = (a["target_mean"] / price - 1) * 100

    sh, cov_s, ps = score_short(t, W)
    md, cov_m, pm = score_medium(t, f, a, W)
    lg, cov_l, pl = score_long(t, f, a, W)
    risk, risk_label = score_risk(t, f)

    hw = dict(W["horizons"])
    total, _ = weighted({"short": sh, "medium": md, "long": lg}, hw)
    coverage = cov_s * hw["short"] + cov_m * hw["medium"] + cov_l * hw["long"]
    confidence = "alta" if coverage >= 0.8 else ("media" if coverage >= 0.5 else "baja")
    sig = signal_from_score(total, sh, md, lg, risk, W["signal"])
    if confidence == "baja":
        sig = {"strong_buy": "buy", "strong_sell": "sell"}.get(sig, sig)

    prev_close = float(hist["Close"].iloc[-2]) if hist is not None and len(hist) >= 2 else None
    change_1d = (price / prev_close - 1) * 100 if price and prev_close else None

    pos_r, neg_r = build_reasons(t, f, a, risk_label)
    reasons = (neg_r[:5] + pos_r[:5]) if sig in ("sell", "strong_sell") else (pos_r[:5] + neg_r[:5])

    return {
        "sym": sym, "name": f.get("name") or sym, "etf": is_etf,
        "sector": f.get("sector"), "industry": f.get("industry"),
        "price": r(price), "chg1d": r(change_1d), "currency": f.get("currency") or "USD",
        "score": r(total, 0), "signal": sig, "conf": confidence,
        "gurus": gurus.get(sym) or None,
        "h": {
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
            "hi52": r(t.get("hi52")), "lo52": r(t.get("lo52")), "spark": t.get("spark") if t else [],
        },
        "fund": {k: (r(v, 2) if isinstance(v, (int, float)) else v) for k, v in f.items()
                 if k not in ("name", "sector", "industry", "currency", "quote_type", "price")},
        "analysts": ({"key": a.get("key"), "mean": r(a.get("mean_rating")), "count": a.get("count"),
                      "target": {"mean": r(a.get("target_mean")), "high": r(a.get("target_high")), "low": r(a.get("target_low"))},
                      "upside": r(a.get("upside"), 1), "dist": a.get("dist"), "revisions": a.get("revisions")}
                     if a else None),
        "earnings_date": meta.get("earnings_date"),
        "meta_at": meta.get("meta_at"),
        "reasons": reasons,
        "news": meta.get("news_parsed") or [],
    }


def market_regime(market: dict) -> dict:
    spx, vix = market.get("^GSPC") or {}, market.get("^VIX") or {}
    points, notes = 0, []
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
        points += 1 if m1 > 2 else (-1 if m1 < -4 else 0)
    label = "Risk-on" if points >= 2 else ("Risk-off" if points <= -1 else "Neutral")
    desc = {"Risk-on": "Entorno favorable: las señales de compra tienen más respaldo.",
            "Neutral": "Entorno mixto: exige más confluencia antes de comprar fuerte.",
            "Risk-off": "Entorno defensivo: prioriza proteger capital y reduce tamaño de posiciones."}[label]
    return {"label": label, "desc": desc, "notes": notes}


def build_market(symbols: dict, hists: dict) -> dict:
    out = {}
    for sym, name in symbols.items():
        hist = hists.get(sym)
        if hist is None or len(hist) < 5:
            continue
        c = hist["Close"].astype(float)
        price = float(c.iloc[-1])
        sma200 = float(c.rolling(200).mean().iloc[-1]) if len(c) >= 200 else None

        def ret(d):
            return (price / float(c.iloc[-1 - d]) - 1) * 100 if len(c) > d else None

        out[sym] = {"name": name, "price": r(price, 2 if price < 1000 else 0), "chg1d": r(ret(1)),
                    "ret_1w": r(ret(5), 1), "ret_1m": r(ret(21), 1),
                    "above_sma200": (price > sma200) if sma200 else None,
                    "spark": [round(float(x), 2) for x in c.tail(60).iloc[::2]]}
    return out


def update_history(history: dict, tickers: list, today: str, keep_days: int, universe: set) -> dict:
    new_hist = {}
    for tk in tickers:
        rows = [row for row in history.get(tk["sym"], []) if row.get("d") != today]
        rows.append({"d": today, "p": tk["price"], "s": tk["score"], "sig": tk["signal"],
                     "sh": tk["h"]["short"]["s"], "md": tk["h"]["medium"]["s"], "lg": tk["h"]["long"]["s"]})
        rows.sort(key=lambda x: x["d"])
        new_hist[tk["sym"]] = rows[-keep_days:]
    for sym in list(history.keys()):
        if sym in universe and sym not in new_hist:
            new_hist[sym] = history[sym][-keep_days:]
    return new_hist


def signal_changes(tickers: list, history: dict) -> list:
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


def guru_map(investors: dict) -> dict:
    """{ticker: [nombres de inversionistas]} a partir de config/investors.json."""
    out = {}
    for inv in investors.get("investors", []):
        for sym in inv.get("holdings", []):
            out.setdefault(sym, []).append(inv["short"])
    return {k: sorted(set(v)) for k, v in out.items()}


# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true", help="datos sintéticos, sin internet")
    ap.add_argument("--only", help="lista de tickers separada por comas")
    ap.add_argument("--mode", choices=["fast", "news", "daily", "full"], default="daily")
    ap.add_argument("--workers", type=int, default=env_int("WORKERS", 8))
    ap.add_argument("--refresh-days", type=float, default=3.0, help="antigüedad máxima de los metadatos")
    ap.add_argument("--max-meta", type=int, default=0, help="0 = automático según el modo")
    args = ap.parse_args()

    t0 = time.time()
    universe = load_json(CONFIG_DIR / "universe.json", {})
    W = load_json(CONFIG_DIR / "weights.json", {})
    investors = load_json(CONFIG_DIR / "investors.json", {})
    if not universe or not W:
        print("Faltan config/universe.json o config/weights.json", file=sys.stderr)
        sys.exit(1)
    gurus = guru_map(investors)

    stocks = list(dict.fromkeys(universe.get("stocks", [])))
    etfs = [e for e in dict.fromkeys(universe.get("etfs", [])) if e not in stocks]
    core = [c for c in universe.get("core", []) if c]
    if args.only:
        wanted = {s.strip().upper() for s in args.only.split(",") if s.strip()}
        stocks = [s for s in stocks if s in wanted] + [s for s in wanted if s not in stocks and s not in etfs]
        etfs = [s for s in etfs if s in wanted]

    all_syms = stocks + etfs
    market_syms = universe.get("market", {})
    is_etf = {s: (s in set(etfs)) for s in all_syms}

    now = datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")
    print(f"== Market Intelligence AI :: {today} :: modo {args.mode.upper()}"
          f"{' DEMO' if args.demo else ''} :: {len(stocks)} acciones + {len(etfs)} ETFs", flush=True)

    prev = load_json(DATA_DIR / "latest.json", {})
    prev_by_sym = {t["sym"]: t for t in prev.get("tickers", [])}

    # ---------------- precios ----------------
    if args.demo:
        hists, demo_meta = {}, {}
        for i, s in enumerate(all_syms + list(market_syms)):
            h, m = demo_bundle(s, is_etf.get(s, True), seed=i * 7919)
            hists[s] = h
            demo_meta[s] = m
    else:
        hists = batch_history(all_syms + list(market_syms))
    print(f"-- precios listos en {time.time() - t0:.0f}s ({len(hists)} series)", flush=True)

    # ---------------- a quién refrescar metadatos ----------------
    def meta_age_days(sym):
        p = prev_by_sym.get(sym)
        if not p or not p.get("meta_at"):
            return 999.0
        try:
            return (now - datetime.fromisoformat(p["meta_at"])).total_seconds() / 86400
        except Exception:
            return 999.0

    priority = set(core) | set(gurus) | set(universe.get("watch", []))
    for t in prev.get("tickers", [])[:80]:          # los mejores del ranking anterior
        priority.add(t["sym"])
    for c in prev.get("changes", [])[:30]:          # los que cambiaron de señal
        priority.add(c["sym"])
    priority &= set(all_syms)

    news_only = args.mode == "news"
    if args.mode == "fast":
        need = sorted(s for s in all_syms if meta_age_days(s) > 30)  # solo los que no tienen nada
        cap = 60
    elif news_only:
        # Refresco barato cada pocas horas: solo titulares de lo que te importa.
        need = sorted(priority) + [t["sym"] for t in prev.get("tickers", [])[:120]]
        need = list(dict.fromkeys(need))
        cap = env_int("NEWS_TICKERS", 260)
    elif args.mode == "full":
        need, cap = all_syms, len(all_syms)
    else:
        stale = [s for s in all_syms if meta_age_days(s) >= args.refresh_days]
        stale.sort(key=meta_age_days, reverse=True)
        need = list(dict.fromkeys(list(priority) + stale))
        cap = args.max_meta or env_int("MAX_META", 420)
    universe_set = set(all_syms)
    need = [s for s in need if s in universe_set and (s in hists or args.demo)][:max(cap, 0)]
    print(f"-- metadatos a refrescar: {len(need)} de {len(all_syms)} "
          f"(prioritarios {len(priority)}, resto por antigüedad)", flush=True)

    metas, news_map = {}, {}
    if args.demo:
        metas = {s: demo_meta[s] for s in need}
        news_map = {s: demo_meta[s].get("news") or [] for s in need}
    elif need:
        t1 = time.time()
        done = 0
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = {ex.submit(fetch_meta, s, True, not news_only): s for s in need}
            for fut in as_completed(futs):
                s = futs[fut]
                try:
                    raw = fut.result()
                    news_map[s] = raw.get("news") or []
                    if news_only:
                        done += 1
                        continue
                    parsed = parse_modules(raw.get("mods") or {},
                                           price_hint=float(hists[s]["Close"].iloc[-1]) if s in hists else None)
                    parsed["errors"] = raw.get("errors") or []
                    metas[s] = parsed
                except Exception as e:
                    print(f"  ! {s}: {e}", file=sys.stderr)
                done += 1
                if done % 50 == 0:
                    print(f"  metadatos {done}/{len(need)} ({time.time() - t1:.0f}s)", flush=True)
        print(f"-- metadatos listos en {time.time() - t1:.0f}s", flush=True)

    # ---------------- ensamblado ----------------
    tickers, failed = [], []
    for sym in all_syms:
        hist = hists.get(sym)
        p = prev_by_sym.get(sym)
        fresh = metas.get(sym)
        if hist is None and not args.demo:
            if p:                                    # sin precio hoy: conserva el registro anterior
                p = dict(p)
                p["stale"] = True
                tickers.append(p)
            else:
                failed.append({"sym": sym, "error": "sin historial de precios"})
            continue
        if fresh and not (fresh["fund"].get("name") or fresh["fund"].get("market_cap") or fresh["fund"].get("price")):
            fresh = None                             # respuesta vacía: mejor conservar la caché
        cutoff_news = (now - timedelta(days=W["retention"]["news_max_age_days"])).isoformat()[:16]
        fresh_news = (parse_news(news_map[sym], W["retention"]["news_max_age_days"],
                                 W["retention"]["news_per_ticker"]) if sym in news_map else None)
        if fresh:
            meta = {"fund": fresh["fund"], "analysts": fresh["analysts"],
                    "earnings_date": fresh["earnings_date"], "meta_at": now.isoformat(timespec="minutes"),
                    "news_parsed": fresh_news if fresh_news is not None else []}
        elif p:                                      # reutiliza metadatos del snapshot anterior
            f = dict(p.get("fund") or {})
            f.update({"name": p.get("name"), "sector": p.get("sector"), "industry": p.get("industry"),
                      "currency": p.get("currency"), "price": None})
            a = p.get("analysts") or {}
            meta = {"fund": f, "meta_at": p.get("meta_at"),
                    "analysts": {"key": a.get("key"), "mean_rating": a.get("mean"), "count": a.get("count"),
                                 "target_mean": (a.get("target") or {}).get("mean"),
                                 "target_high": (a.get("target") or {}).get("high"),
                                 "target_low": (a.get("target") or {}).get("low"),
                                 "upside": None, "dist": a.get("dist"), "revisions": a.get("revisions")} if a else {},
                    "earnings_date": p.get("earnings_date"),
                    "news_parsed": fresh_news if fresh_news is not None
                    else [n for n in (p.get("news") or []) if n.get("d", "") >= cutoff_news]}
        else:
            meta = {"fund": {}, "analysts": {}, "earnings_date": None, "meta_at": None, "news_parsed": []}
        try:
            tickers.append(analyze(sym, hist, meta, is_etf.get(sym, False), W, gurus))
        except Exception as e:
            failed.append({"sym": sym, "error": str(e)[:120]})

    market = build_market(market_syms, hists)
    regime = market_regime(market)

    history = load_json(DATA_DIR / "history.json", {})
    history = update_history(history, tickers, today, W["retention"]["history_days"], set(all_syms))
    changes = signal_changes(tickers, history)

    # ---------------- noticias ----------------
    from news_ai import classify_all, market_brief
    news_by_tk = {t["sym"]: t["news"] for t in tickers if t.get("news")}
    max_ai = 0 if args.demo else env_int("NEWS_AI_MAX", 250)
    news_stats = classify_all(news_by_tk, max_ai=max_ai)
    print(f"== noticias: {news_stats}", flush=True)

    seen, market_news = set(), []
    for t in tickers:
        for nw in t.get("news") or []:
            if nw["t"] in seen:
                continue
            seen.add(nw["t"])
            market_news.append(dict(nw))
    market_news.sort(key=lambda x: (-(x.get("prio") or 0), x.get("d") or ""))
    market_news = market_news[: W["retention"]["market_news"]]

    tickers.sort(key=lambda x: -(x["score"] or 0))
    brief = market_brief(regime, tickers, changes, market_news,
                         portfolio_syms=universe.get("core") or None) if not args.demo else {
        "text": "Resumen de demostración.", "bullets": [], "ai": False}
    print(f"== resumen del día: {'IA' if brief.get('ai') else 'heurístico'}", flush=True)
    latest = {
        "generated_at": now.isoformat(timespec="minutes"), "date": today, "demo": bool(args.demo),
        "version": 3, "mode": args.mode, "elapsed_s": round(time.time() - t0),
        "weights": {k: v for k, v in W.items() if not k.startswith("_")},
        "labels": SIGNAL_LABELS, "regime": regime, "market": market, "market_news": market_news,
        "changes": changes[:40], "tickers": tickers, "failed": failed,
        "investors": {i["short"]: i.get("name", i["short"]) for i in investors.get("investors", [])},
        "investors_note": investors.get("_note", ""),
        "news_stats": news_stats, "brief": brief,
        "stats": {"ok": len(tickers), "failed": len(failed), "meta_refreshed": len(metas),
                  "news_refreshed": len(news_map)},
    }
    save_json(DATA_DIR / "latest.json", latest)
    save_json(DATA_DIR / "history.json", history)
    print(f"== listo en {time.time() - t0:.0f}s: {len(tickers)} activos, {len(failed)} fallidos, "
          f"{len(metas)} metadatos frescos. latest.json "
          f"{(DATA_DIR / 'latest.json').stat().st_size / 1024:.0f} KB. Régimen: {regime['label']}")


if __name__ == "__main__":
    main()
