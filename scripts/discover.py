#!/usr/bin/env python3
"""
Descubridor de tickers: mantiene el radar vivo sin intervención manual.

Fuentes (todas gratuitas, vía Yahoo Finance):
  1. Screeners predefinidos: más activas, mayores alzas/bajas, small caps al alza,
     crecimiento tecnológico, growth infravalorado.
  2. Menciones en las noticias del último snapshot: símbolos entre paréntesis o
     con $, y palabras en mayúsculas que resulten ser tickers válidos.

Reglas:
  * Solo acciones de EE.UU. (NMS / NYQ / NGM / ASE / BATS) con capitalización y
    volumen mínimos, para no meter basura al radar.
  * Máximo N nuevos por día (por defecto 25).
  * Poda: los tickers agregados automáticamente que llevan varios días sin
    aparecer en ninguna fuente y no están en tu cartera ni en favoritos se
    eliminan, para que el universo no crezca sin control.

Escribe config/universe.json (campos "stocks" y "watch") y un pequeño registro
en config/discovered.json.

Uso: python scripts/discover.py [--max-new 25] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"
DATA = ROOT / "docs" / "data"

SCREENERS = ["most_actives", "day_gainers", "day_losers", "small_cap_gainers",
             "growth_technology_stocks", "undervalued_growth_stocks", "aggressive_small_caps"]
US_EXCHANGES = {"NMS", "NYQ", "NGM", "ASE", "BTS", "PCX", "NCM", "NYS"}
MIN_CAP = 3e8          # 300 millones
MIN_DOLLAR_VOL = 5e6   # 5 millones de dólares diarios
STOPWORDS = {
    "USD", "CEO", "CFO", "AI", "ETF", "IPO", "SEC", "FDA", "GDP", "CPI", "FED", "EPS", "USA", "US",
    "NYSE", "NASDAQ", "Q1", "Q2", "Q3", "Q4", "EU", "UK", "CHINA", "OPEC", "IMF", "WSJ", "CNBC",
    "THE", "AND", "FOR", "WITH", "FROM", "THIS", "THAT", "NEW", "TOP", "BUY", "SELL", "HOLD",
    "WHY", "HOW", "WHAT", "BEST", "STOCK", "STOCKS", "MARKET", "NEWS", "MORE", "AFTER", "BEFORE",
    "SPDR", "PIMCO", "ASUS", "CFTC", "GTA", "DCF", "BTC", "ETH", "VIX", "CPU", "FY", "CD", "ARK",
    "IPO", "M&A", "ESG", "CEOS", "YTD", "EBIT", "ROE", "ROIC", "PEG", "SP", "DOW", "FOMC", "BLS",
    "ETFS", "AMC", "PRE", "POST", "OPEC", "NATO", "WTI", "OTC", "SPAC", "REIT", "AGM", "AI2",
}


def load(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return default


def from_screeners() -> dict:
    """{sym: [screeners en los que aparece]} desde los screeners de Yahoo."""
    import yfinance as yf
    found = {}
    for name in SCREENERS:
        try:
            res = yf.screen(name, count=50)
            quotes = (res or {}).get("quotes") or []
        except Exception as e:
            print(f"  ! screener {name}: {str(e)[:80]}", file=sys.stderr)
            continue
        for q in quotes:
            sym = (q.get("symbol") or "").upper()
            if not sym or not re.fullmatch(r"[A-Z]{1,5}", sym):
                continue
            if q.get("fullExchangeName") and q.get("exchange") not in US_EXCHANGES:
                continue
            cap = q.get("marketCap") or 0
            vol = (q.get("regularMarketVolume") or 0) * (q.get("regularMarketPrice") or 0)
            if cap and cap < MIN_CAP:
                continue
            if vol and vol < MIN_DOLLAR_VOL:
                continue
            found.setdefault(sym, []).append(name)
        print(f"  screener {name}: {len(quotes)} resultados", flush=True)
    return found


def from_news(latest: dict, known: set) -> dict:
    """Tickers mencionados en los titulares del último snapshot."""
    mentions = {}
    texts = []
    for t in latest.get("tickers", []):
        for n in t.get("news") or []:
            texts.append(f"{n.get('t', '')} {n.get('s', '')}")
    for n in latest.get("market_news", []):
        texts.append(f"{n.get('t', '')} {n.get('s', '')}")
    for txt in texts:
        for m in re.findall(r"\$([A-Z]{1,5})\b", txt):          # $NVDA
            mentions[m] = mentions.get(m, 0) + 3
        for m in re.findall(r"\(([A-Z]{1,5})\)", txt):          # Nvidia (NVDA)
            mentions[m] = mentions.get(m, 0) + 3
        for m in re.findall(r"\b([A-Z]{2,5})\b", txt):          # sueltos en mayúsculas
            mentions[m] = mentions.get(m, 0) + 1
    # Umbral 4: basta una mención explícita ($NVDA o "Nvidia (NVDA)") o cuatro sueltas.
    return {s: c for s, c in mentions.items()
            if c >= 4 and s not in STOPWORDS and s not in known}


def validate(symbols: list) -> dict:
    """Confirma que existan y tengan precio y volumen razonables (descarga en lote)."""
    import pandas as pd
    import yfinance as yf
    ok = {}
    for i in range(0, len(symbols), 60):
        batch = symbols[i:i + 60]
        try:
            df = yf.download(batch, period="1mo", interval="1d", group_by="ticker",
                             auto_adjust=True, progress=False, threads=True, timeout=30)
        except Exception as e:
            print(f"  ! validación lote {i}: {str(e)[:80]}", file=sys.stderr)
            continue
        for sym in batch:
            try:
                sub = df[sym] if isinstance(df.columns, pd.MultiIndex) else df
                sub = sub.dropna(subset=["Close"])
                if len(sub) < 12:
                    continue
                price = float(sub["Close"].iloc[-1])
                dvol = float((sub["Close"] * sub["Volume"]).tail(10).mean())
                if price < 1 or dvol < MIN_DOLLAR_VOL:
                    continue
                ok[sym] = {"price": round(price, 2), "dollar_vol": round(dvol)}
            except Exception:
                continue
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-new", type=int, default=25)
    ap.add_argument("--max-universe", type=int, default=900)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    uni = load(CONFIG / "universe.json", {})
    latest = load(DATA / "latest.json", {})
    log = load(CONFIG / "discovered.json", {"added": {}, "seen": {}, "fails": {}})
    log.setdefault("fails", {})
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    known = set(uni.get("stocks", [])) | set(uni.get("etfs", [])) | set(uni.get("core", []))
    print(f"== descubridor :: universo actual {len(known)}", flush=True)

    scr = from_screeners()
    news = from_news(latest, known)
    print(f"-- screeners: {len(scr)} · menciones en noticias: {len(news)}", flush=True)

    # Registro de apariciones (para poder podar después lo que dejó de importar).
    for sym in set(scr) | set(news):
        log["seen"][sym] = today

    # Relevancia: las menciones en noticias pesan más que aparecer en un screener,
    # y aparecer en varios screeners a la vez pesa más que en uno solo.
    def relevance(sym):
        return news.get(sym, 0) * 3 + len(scr.get(sym, [])) * 2

    candidates = sorted(set(scr) | set(news), key=lambda s: -relevance(s))
    candidates = [s for s in candidates if s not in known]
    print(f"-- candidatos nuevos: {len(candidates)}", flush=True)

    add = []
    if candidates:
        valid = validate(candidates[:150])
        ranked = sorted((s for s in candidates if s in valid),
                        key=lambda s: (-relevance(s), -valid[s]["dollar_vol"]))
        add = ranked[:args.max_new]
        for s in add:
            why = ", ".join(scr.get(s, [])) or f"{news.get(s, 0)} menciones"
            print(f"   + {s:<6} {why} · vol ${valid[s]['dollar_vol'] / 1e6:.0f}M", flush=True)
    print(f"-- validados para agregar: {len(add)}", flush=True)

    # Renombres conocidos: reemplaza el símbolo viejo por el nuevo.
    renames = uni.get("renames") or {}
    protected = set(uni.get("core", [])) | set(uni.get("watch", []))
    drop = []

    # Poda 1: tickers que el motor no logra descargar varias veces seguidas
    # (empresas adquiridas, deslistadas o con símbolo cambiado).
    failing = {f["sym"] for f in latest.get("failed", [])}
    for sym in list(log["fails"]):
        if sym not in failing:
            log["fails"].pop(sym)
    for sym in failing:
        log["fails"][sym] = log["fails"].get(sym, 0) + 1
    dead = [s for s, c in log["fails"].items() if c >= 2 and s not in protected]
    if dead:
        print(f"-- deslistados o sin datos ({len(dead)}): {', '.join(dead)}", flush=True)
        drop += dead
        for s in dead:
            log["fails"].pop(s, None)
            if renames.get(s) and renames[s] not in known:
                add.append(renames[s])
                print(f"   → renombrado: {s} pasa a {renames[s]}", flush=True)

    # Poda 2: auto-agregados que llevan >21 días sin aparecer y no son core/watch.
    protected |= set(uni.get("etfs", []))
    for sym, added_on in list(log["added"].items()):
        if sym in protected:
            continue
        last = log["seen"].get(sym, added_on)
        try:
            age = (datetime.strptime(today, "%Y-%m-%d") - datetime.strptime(last, "%Y-%m-%d")).days
        except Exception:
            age = 0
        if age > 21:
            drop.append(sym)

    stocks = [s for s in uni.get("stocks", []) if s not in drop] + add
    stocks = list(dict.fromkeys(stocks))
    if len(stocks) + len(uni.get("etfs", [])) > args.max_universe:
        # recorta primero los auto-agregados más antiguos que no estén protegidos
        auto = [s for s in stocks if s in log["added"] and s not in protected]
        auto.sort(key=lambda s: log["seen"].get(s, "0"))
        excess = len(stocks) + len(uni.get("etfs", [])) - args.max_universe
        cut = set(auto[:excess])
        stocks = [s for s in stocks if s not in cut]
        drop += sorted(cut)

    for s in add:
        log["added"][s] = today
    for s in drop:
        log["added"].pop(s, None)
    # el registro de apariciones no crece sin límite
    log["seen"] = {k: v for k, v in log["seen"].items() if v >= (datetime.strptime(today, "%Y-%m-%d").replace(year=datetime.strptime(today, "%Y-%m-%d").year - 1)).strftime("%Y-%m-%d")}

    print(f"== agregar {len(add)} · quitar {len(drop)} · universo final {len(stocks) + len(uni.get('etfs', []))}")
    if args.dry_run:
        return
    uni["stocks"] = stocks
    json.dump(uni, open(CONFIG / "universe.json", "w"), ensure_ascii=False, indent=1)
    json.dump(log, open(CONFIG / "discovered.json", "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
