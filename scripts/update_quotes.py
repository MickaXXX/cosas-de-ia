#!/usr/bin/env python3
"""
Cotizaciones intradía (ligeras): un solo request por lote a Yahoo Finance para
todo el universo + índices. Escribe docs/data/quotes.json (~20 KB).

Se ejecuta cada hora en horario de mercado (workflow quotes.yml). La app fusiona
estos precios sobre el snapshot diario de latest.json.

Uso: python scripts/update_quotes.py
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "universe.json"
OUT = ROOT / "docs" / "data" / "quotes.json"


def main():
    import pandas as pd
    import yfinance as yf

    uni = json.load(open(CONFIG, encoding="utf-8"))
    symbols = list(dict.fromkeys(uni.get("stocks", []) + uni.get("etfs", []) + list(uni.get("market", {}).keys())))
    print(f"== quotes :: {len(symbols)} símbolos")

    quotes = {}
    # Lotes de 150 para no exceder el tamaño de URL de Yahoo.
    for i in range(0, len(symbols), 150):
        batch = symbols[i:i + 150]
        try:
            df = yf.download(batch, period="5d", interval="1d", group_by="ticker", auto_adjust=True,
                             progress=False, threads=True)
        except Exception as e:
            print(f"  ! lote {i}: {e}", file=sys.stderr)
            continue
        for sym in batch:
            try:
                sub = df[sym] if isinstance(df.columns, pd.MultiIndex) else df
                closes = sub["Close"].dropna()
                if len(closes) == 0:
                    continue
                price = float(closes.iloc[-1])
                prev = float(closes.iloc[-2]) if len(closes) >= 2 else None
                chg = (price / prev - 1) * 100 if prev else None
                quotes[sym] = {"p": round(price, 4 if price < 1 else 2), "c": round(chg, 2) if chg is not None else None,
                               "t": closes.index[-1].strftime("%Y-%m-%d")}
            except Exception:
                continue

    # Intradía real (regularMarketPrice) para los símbolos más relevantes es costoso;
    # el cierre parcial del día de yf.download ya refleja el último precio durante la sesión.
    out = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="minutes"), "n": len(quotes), "q": quotes}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"== listo: {len(quotes)} cotizaciones → {OUT.name} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
