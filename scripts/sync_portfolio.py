#!/usr/bin/env python3
"""
Sincroniza una cartera enviada desde la app.

La app no tiene credenciales: cuando el dueño pulsa "Agregar al radar", abre un
issue de GitHub ya rellenado con su cartera en JSON. Este script lee ese cuerpo,
lo valida y deja el repositorio al día:

  * docs/data/portfolios.json → la cartera publicada (visible en todos sus
    dispositivos y para quien abra el enlace).
  * config/universe.json      → cada símbolo que tenga pasa a "core", así que el
    radar lo analiza completo todos los días y la poda nunca lo toca.

Imprime en GITHUB_OUTPUT los símbolos nuevos, para que el workflow los analice
de inmediato en vez de esperar al run de la noche.

Uso: ISSUE_BODY="$(cat cuerpo.txt)" python scripts/sync_portfolio.py
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"
DATA = ROOT / "docs" / "data"

SYM_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
MAX_TX = 400


def fail(msg: str):
    print(f"::error::{msg}")
    sys.exit(1)


def extract_json(body: str) -> dict:
    """El cuerpo del issue trae el JSON dentro de un bloque ```json … ```."""
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", body, re.S)
    raw = m.group(1) if m else body.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        fail(f"El cuerpo del issue no trae un JSON válido: {e}")


def clean_tx(tx: list) -> list:
    """Solo se acepta lo que el motor sabe usar; el resto se descarta en silencio."""
    out = []
    for t in tx[:MAX_TX]:
        if not isinstance(t, dict):
            continue
        sym = str(t.get("s") or t.get("sym") or "").strip().upper()
        if not SYM_RE.match(sym):
            continue
        try:
            qty = float(t.get("q", t.get("qty", 0)) or 0)
            price = float(t.get("p", t.get("price", 0)) or 0)
        except (TypeError, ValueError):
            continue
        if qty <= 0 or price < 0:
            continue
        tipo = "sell" if (t.get("t") or t.get("type")) == "sell" else "buy"
        fecha = str(t.get("d") or t.get("date") or "")[:10]
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", fecha):
            fecha = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        out.append({"sym": sym, "type": tipo, "qty": round(qty, 6),
                    "price": round(price, 4), "date": fecha})
    return out


def held(tx: list) -> list:
    """Símbolos con posición abierta después de aplicar compras y ventas."""
    saldo = {}
    for t in tx:
        saldo[t["sym"]] = saldo.get(t["sym"], 0) + (-t["qty"] if t["type"] == "sell" else t["qty"])
    return sorted(s for s, q in saldo.items() if q > 1e-9)


def main():
    body = os.environ.get("ISSUE_BODY") or ""
    if not body.strip():
        fail("Falta ISSUE_BODY.")
    payload = extract_json(body)

    pf_in = payload.get("pf") or payload
    tx = clean_tx(pf_in.get("tx") or [])
    if not tx:
        fail("La cartera no trae movimientos utilizables.")
    name = str(pf_in.get("name") or "Mi cartera")[:40]
    pid = str(pf_in.get("id") or "mia")[:24]
    if not re.match(r"^[A-Za-z0-9_-]+$", pid):
        pid = "mia"
    fav = [s for s in (pf_in.get("fav") or []) if isinstance(s, str) and SYM_RE.match(s)][:60]

    ahora = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    book = {"list": []}
    if (DATA / "portfolios.json").exists():
        try:
            book = json.load(open(DATA / "portfolios.json", encoding="utf-8"))
        except Exception:
            book = {"list": []}
    lista = [p for p in book.get("list", []) if p.get("id") != pid]
    lista.append({"id": pid, "name": name, "updated": ahora, "fav": fav, "tx": tx})
    json.dump({"updated": ahora, "list": lista},
              open(DATA / "portfolios.json", "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))

    # Todo lo que alguien tenga en una cartera publicada entra al radar como core.
    uni = json.load(open(CONFIG / "universe.json", encoding="utf-8"))
    tenidos = sorted({s for p in lista for s in held(p.get("tx", []))})
    antes = set(uni.get("core", []))
    conocidos = antes | set(uni.get("stocks", [])) | set(uni.get("etfs", [])) | set(uni.get("watch", []))
    nuevos = [s for s in tenidos if s not in conocidos]

    # Tickers pedidos desde el buscador del radar: entran en observación.
    pedidos = [s.strip().upper() for s in (payload.get("watch") or []) if isinstance(s, str)]
    pedidos = [s for s in pedidos if SYM_RE.match(s) and s not in conocidos and s not in tenidos][:20]
    if pedidos:
        uni["watch"] = list(dict.fromkeys(list(uni.get("watch", [])) + pedidos))
        nuevos += pedidos

    uni["core"] = tenidos
    # Lo que se vendió sale de core pero sigue en el radar general.
    vendidos = [s for s in antes if s not in tenidos]
    if vendidos:
        uni["stocks"] = list(dict.fromkeys(list(uni.get("stocks", [])) + vendidos))
    json.dump(uni, open(CONFIG / "universe.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print(f"Cartera '{name}': {len(tx)} movimientos, {len(tenidos)} posiciones abiertas.")
    print(f"Nuevos en el radar: {', '.join(nuevos) if nuevos else 'ninguno'}")
    if pedidos:
        print(f"En observación (pedidos desde el buscador): {', '.join(pedidos)}")
    if vendidos:
        print(f"Salen de core (vendidos): {', '.join(vendidos)}")

    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"new_symbols={','.join(nuevos)}\n")
            f.write(f"positions={len(tenidos)}\n")
            f.write(f"name={name}\n")


if __name__ == "__main__":
    main()
