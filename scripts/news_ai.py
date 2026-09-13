#!/usr/bin/env python3
"""
Clasificación de noticias.

1) Heurística (siempre, sin costo): categoría, prioridad 0-100 y etiqueta en español
   a partir de palabras clave del titular/resumen.
2) Enriquecimiento con Claude (opcional): si existe ANTHROPIC_API_KEY, traduce el
   titular, escribe un resumen de una línea en español y afina prioridad/categoría
   para los titulares más relevantes (máximo NEWS_AI_MAX, por defecto 250).

Modelo: NEWS_MODEL (por defecto claude-opus-5). Costo estimado del run diario con
250 titulares: ~US$0.5. Si no hay clave, la app usa solo la heurística.
"""
from __future__ import annotations

import html
import json
import os
import re
import sys

# Palabras clave → (peso, categoría, etiqueta ES). Se evalúa sobre titular + resumen en minúsculas.
RULES = [
    (r"\b(earnings|results|quarter|q[1-4]\b|guidance|outlook|revenue|eps|beats?|miss(es|ed)?|profit)\b", 30, "resultados", "Resultados / guía"),
    (r"\b(upgrade[sd]?|downgrade[sd]?|price target|rating|initiat(es|ed) coverage|overweight|underweight|outperform|underperform)\b", 28, "analistas", "Cambio de recomendación"),
    (r"\b(acqui(re|res|red|sition)|merger|takeover|buyout|to buy|deal|stake|spin[- ]?off)\b", 26, "m&a", "Fusión / adquisición"),
    (r"\b(fda|approv(al|es|ed)|clinical|trial|phase (1|2|3|i|ii|iii))\b", 26, "regulatorio", "FDA / ensayo clínico"),
    (r"\b(sec|lawsuit|probe|investigation|antitrust|fine[sd]?|regulator|ban|tariff[s]?|sanction[s]?|export (control|curb)s?)\b", 24, "regulatorio", "Regulación / legal"),
    (r"\b(soar(s|ed)?|surge[sd]?|jump(s|ed)?|rall(y|ies|ied)|record high|all[- ]time high|skyrocket)\b", 20, "movimiento", "Fuerte alza"),
    (r"\b(plunge[sd]?|tumble[sd]?|crash(es|ed)?|sink(s)?|slump[sp]?|sell[- ]off|drop(s|ped)? \d+%|falls? \d+%)\b", 22, "movimiento", "Fuerte caída"),
    (r"\b(layoff[s]?|job cuts|restructur|bankrupt|default|going concern|dilution|offering|secondary|convertible)\b", 22, "riesgo", "Riesgo corporativo"),
    (r"\b(contract|order[s]?|partnership|deal with|wins?|award(ed)?|expands?|launch(es|ed)?|unveil[s]?)\b", 14, "catalizador", "Catalizador / contrato"),
    (r"\b(ceo|cfo|resign[s]?|steps down|appoint(s|ed)?|insider|buyback|dividend|split)\b", 14, "corporativo", "Corporativo"),
    (r"\b(fed|fomc|rate (cut|hike)|inflation|cpi|jobs report|payrolls|gdp|treasury yields?|recession|tariffs?)\b", 16, "macro", "Macro"),
    (r"\b(ai|artificial intelligence|data ?center|gpu|chip[s]?|semiconductor|nuclear|uranium|lithium|copper|bitcoin|crypto)\b", 8, "tema", "Tema sectorial"),
    (r"\b(should you buy|is .* a buy|top stocks|best stocks|motley fool|3 stocks|5 stocks|stocks to watch|why .* stock)\b", -18, "opinion", "Opinión / listado"),
]


def clean_title(t: str) -> str:
    """Yahoo entrega los titulares con entidades HTML (&#39;, &amp;): la app los
    escapa otra vez y quedan a la vista. Se decodifican en el origen."""
    return html.unescape(t or "").replace("\u00a0", " ").strip()


def heuristic(item: dict) -> dict:
    text = f"{item.get('t', '')} {item.get('s', '')}".lower()
    score, cat, label = 20, "general", "General"
    best = -999
    for pat, w, c, lab in RULES:
        if re.search(pat, text):
            score += w
            if w > best:
                best, cat, label = w, c, lab
    if item.get("p", "").lower() in ("reuters", "bloomberg", "the wall street journal", "cnbc", "barrons.com", "financial times"):
        score += 6
    score = max(0, min(100, score))
    return {"prio": score, "cat": cat, "tag": label, "ai": False}


def level(prio: int) -> str:
    return "alta" if prio >= 55 else ("media" if prio >= 35 else "baja")


def enrich_with_claude(items: list) -> int:
    """Traduce/resume/afina con Claude. Devuelve cuántos ítems se enriquecieron."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key or not items:
        return 0
    try:
        import anthropic
    except ImportError:
        print("  ! anthropic no instalado; se omite el enriquecimiento IA", file=sys.stderr)
        return 0

    model = (os.environ.get("NEWS_MODEL") or "").strip() or "claude-opus-5"
    client = anthropic.Anthropic(api_key=api_key)
    schema = {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "i": {"type": "integer"},
                        "titulo": {"type": "string"},
                        "resumen": {"type": "string"},
                        "nivel": {"type": "string", "enum": ["alta", "media", "baja"]},
                        "accion": {"type": "string", "enum": ["oportunidad", "vender", "anticipar", "informativo"]},
                        "etiqueta": {"type": "string"},
                    },
                    "required": ["i", "titulo", "resumen", "nivel", "accion", "etiqueta"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["items"],
        "additionalProperties": False,
    }
    system = (
        "Eres analista de un inversionista minorista chileno que invierte en acciones y ETFs de EE.UU. "
        "Recibes titulares (en inglés) con su ticker. Para cada uno devuelve: título traducido al español "
        "(máx 110 caracteres), resumen de una línea en español (máx 160 caracteres, concreto, sin relleno), "
        "nivel de prioridad: 'alta' = puede implicar oportunidad de compra clara o razón para vender/reducir "
        "(resultados, guía, cambios de rating con impacto, M&A, regulación, FDA, caídas o alzas fuertes con causa); "
        "'media' = ayuda a anticipar un movimiento próximo (catalizadores, contratos, tendencias sectoriales, macro relevante); "
        "'baja' = opinión, listados genéricos, ruido. 'accion': 'oportunidad', 'vender', 'anticipar' o 'informativo'. "
        "'etiqueta': 2-3 palabras en español (ej. 'Resultados', 'Rating', 'Regulación', 'Contrato', 'Macro')."
    )
    done = 0
    for start in range(0, len(items), 40):
        batch = items[start:start + 40]
        lines = [f"{k}. [{it.get('sym', '')}] {it['t']}" + (f" — {it['s']}" if it.get("s") else "") for k, it in enumerate(batch)]
        try:
            resp = client.messages.create(
                model=model,
                max_tokens=16000,
                system=system,
                messages=[{"role": "user", "content": "Clasifica y traduce estos titulares:\n" + "\n".join(lines)}],
                output_config={"format": {"type": "json_schema", "schema": schema}, "effort": "low"},
            )
            if resp.stop_reason == "refusal":
                print("  ! Claude rehusó el lote", file=sys.stderr)
                continue
            text = next(b.text for b in resp.content if b.type == "text")
            data = json.loads(text)
            for row in data.get("items", []):
                k = row.get("i")
                if k is None or k < 0 or k >= len(batch):
                    continue
                it = batch[k]
                it["t_es"] = row["titulo"][:120]
                it["r_es"] = row["resumen"][:170]
                it["nivel"] = row["nivel"]
                it["accion"] = row["accion"]
                it["tag"] = row["etiqueta"][:24]
                it["ai"] = True
                it.pop("s", None)          # el resumen en inglés ya no hace falta
                # Reconciliar prioridad numérica con el nivel de Claude.
                floor = {"alta": 60, "media": 38, "baja": 5}[row["nivel"]]
                cap = {"alta": 100, "media": 54, "baja": 34}[row["nivel"]]
                it["prio"] = max(floor, min(cap, it.get("prio", 30)))
                done += 1
        except Exception as e:
            print(f"  ! Claude lote {start}: {e}", file=sys.stderr)
    return done


def classify_all(news_by_ticker: dict, max_ai: int) -> dict:
    """news_by_ticker: {sym: [items]} — modifica in place. Devuelve estadísticas."""
    flat = []
    for sym, items in news_by_ticker.items():
        for it in items:
            it["t"] = clean_title(it.get("t"))
            if it.get("s"):
                it["s"] = clean_title(it["s"])
            it.update(heuristic(it))
            it["nivel"] = level(it["prio"])
            it["sym"] = sym
            flat.append(it)
    # Deduplicar por titular para no pagar dos veces; priorizar los de mayor score heurístico.
    seen, uniq = set(), []
    for it in sorted(flat, key=lambda x: -x["prio"]):
        if it["t"] in seen:
            continue
        seen.add(it["t"])
        uniq.append(it)
    ai_done = enrich_with_claude(uniq[:max_ai]) if max_ai > 0 else 0
    # Propagar el enriquecimiento a duplicados (mismo titular en varios tickers).
    by_title = {it["t"]: it for it in uniq if it.get("ai")}
    for it in flat:
        src = by_title.get(it["t"])
        if src and not it.get("ai"):
            for k in ("t_es", "r_es", "nivel", "accion", "tag", "prio", "ai"):
                it[k] = src[k]
    return {"total": len(flat), "unique": len(uniq), "ai": ai_done}


def market_brief(regime: dict, tickers: list, changes: list, news: list, portfolio_syms: list = None) -> dict:
    """Resumen del día escrito por Claude: qué pasa en el mercado y qué vigilar.

    Se guarda en latest.json y la app lo muestra arriba de la pestaña Hoy y como
    primer mensaje del chat. Sin ANTHROPIC_API_KEY devuelve un resumen heurístico.
    """
    top = [t for t in tickers if not t.get("etf") and t.get("conf") != "baja"][:12]
    top_txt = "\n".join(
        f"- {t['sym']} ({t.get('name','')}): {t['signal']} {t['score']}/100, corto {t['h']['short']['s']}, "
        f"mediano {t['h']['medium']['s']}, largo {t['h']['long']['s']}, riesgo {t['risk']['label']}"
        + (f", potencial {t['analysts']['upside']}%" if (t.get('analysts') or {}).get('upside') is not None else "")
        for t in top)
    chg_txt = "\n".join(f"- {c['sym']}: {c['from']} → {c['to']} (score {c['score_from']} → {c['score_to']})"
                        for c in (changes or [])[:8])
    news_txt = "\n".join(f"- [{n.get('sym','')}] {n.get('t_es') or n.get('t','')}" for n in (news or [])[:15])

    fallback = {
        "text": f"Régimen {regime.get('label','')}. {regime.get('desc','')} "
                f"{len([t for t in tickers if t.get('signal')=='strong_buy'])} activos en compra fuerte y "
                f"{len(changes or [])} cambios de señal en el radar.",
        "bullets": [n.get("t_es") or n.get("t", "") for n in (news or [])[:3]],
        "ai": False,
    }
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return fallback
    try:
        import anthropic
    except ImportError:
        return fallback

    schema = {
        "type": "object",
        "properties": {
            "resumen": {"type": "string"},
            "vigilar": {"type": "array", "items": {"type": "string"}},
            "riesgo": {"type": "string"},
        },
        "required": ["resumen", "vigilar", "riesgo"],
        "additionalProperties": False,
    }
    prompt = f"""Eres el analista de cabecera de un inversionista minorista chileno que invierte en acciones y ETFs de EE.UU.

RÉGIMEN DE MERCADO: {regime.get('label')} — {regime.get('desc')} {' '.join(regime.get('notes') or [])}

MEJORES SEÑALES DEL MODELO HOY:
{top_txt}

CAMBIOS DE SEÑAL:
{chg_txt or '(ninguno)'}

TITULARES PRIORITARIOS:
{news_txt or '(sin noticias)'}
{('ACCIONES EN SU CARTERA: ' + ', '.join(portfolio_syms)) if portfolio_syms else ''}

Escribe en español de Chile, directo y sin relleno:
- "resumen": 3 o 4 frases sobre qué está pasando hoy y qué implica para alguien con esta cartera.
- "vigilar": 3 puntos concretos y accionables para hoy (menciona tickers).
- "riesgo": una frase sobre el principal riesgo del día.
No prometas rentabilidades ni des órdenes de compra: son señales cuantitativas, no asesoría."""
    try:
        client = anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(
            model=(os.environ.get("NEWS_MODEL") or "").strip() or "claude-opus-5",
            max_tokens=4000,
            messages=[{"role": "user", "content": prompt}],
            output_config={"format": {"type": "json_schema", "schema": schema}, "effort": "low"},
        )
        if resp.stop_reason == "refusal":
            return fallback
        data = json.loads(next(b.text for b in resp.content if b.type == "text"))
        return {"text": data["resumen"][:700], "bullets": [b[:200] for b in data["vigilar"][:4]],
                "riesgo": data["riesgo"][:250], "ai": True}
    except Exception as e:
        print(f"  ! brief: {e}", file=sys.stderr)
        return fallback
