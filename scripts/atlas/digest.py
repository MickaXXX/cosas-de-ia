#!/usr/bin/env python3
"""
Digest semanal por correo: "Mis 10 mejores oportunidades de la semana" + cambios.

Opcional. Solo envía si están los secretos SMTP del repositorio:
  SMTP_HOST, SMTP_PORT (587 por defecto), SMTP_USER, SMTP_PASS, ALERT_EMAIL_TO
  ATLAS_URL (opcional, por defecto la URL de GitHub Pages del repo)
Si faltan, registra "no configurado" en data/digest.json y termina sin error.
No reenvía la misma semana dos veces.
"""
from __future__ import annotations

import os
import smtplib
import sys
from datetime import timedelta
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, iso, load_json, log, santiago_now, utc_now, write_json  # noqa: E402

LABELS = {"proyecto_nuevo": "Proyecto nuevo", "baja_precio": "Baja de precio", "alza_precio": "Alza de precio",
          "cambio_entrega": "Cambio de entrega", "cambio_stock": "Cambio de stock", "obra_nueva": "Obra nueva",
          "cambio_obra": "Cambio en obra", "cambio_ranking": "Cambio en el ranking"}


def build(url: str) -> tuple[str, str]:
    snap = load_json(DATA / "ranking_snapshot.json", {}) or {}
    rows = snap.get("rows", [])[:10]
    since = (utc_now() - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    events = [e for e in (load_json(DATA / "changes.json", {}) or {}).get("events", []) if e.get("detected_at", "") >= since]
    lines = [f"Atlas Inversión Santiago — semana del {santiago_now():%d-%m-%Y}", "",
             "Mis 10 mejores oportunidades (perfil " + str(snap.get("profile")) + "):"]
    for r in rows:
        flag = "verificada" if r.get("passed") else "provisional: " + "; ".join(r.get("pending", [])[:2])
        cf = r.get("monthly_cf_clp")
        lines.append(f"  {r['position']}. {r['name']} ({r['commune']}) · score {r['score']} · "
                     f"flujo {'s/d' if cf is None else f'{cf:,.0f}'.replace(',', '.')} CLP/mes · {flag}")
    plan = snap.get("investor_plan") or {}
    if plan.get("cash_today_clp") is not None:
        money = lambda x: f"{x:,.0f}".replace(",", ".")
        ok = [r for r in snap.get("rows", []) if (r.get("plan") or {}).get("status") in ("alcanzable", "ajustado")]
        near = sorted((r for r in snap.get("rows", []) if (r.get("plan") or {}).get("min_installments_needed")),
                      key=lambda r: r["plan"]["min_installments_needed"])[:3]
        lines += ["", f"Con tu plan (caja ${money(plan['cash_today_clp'])} + ahorro ${money(plan['monthly_savings_clp'] or 0)}/mes):"]
        lines += [f"  - {r['name']} ({r['commune']}): {r['plan']['status']}" for r in ok[:5]] or ["  - Ninguno alcanza con las condiciones de pie conocidas."]
        lines += [f"  - {r['name']}: alcanzaría con pie en {r['plan']['min_installments_needed']} cuotas" for r in near]
    lines += ["", f"Cambios detectados en los últimos 7 días ({len(events)}):"]
    for e in events[:40]:
        lines.append(f"  - {LABELS.get(e['type'], e['type'])}: {e['title']}"
                     + (f" (antes {e.get('before')} → después {e.get('after')})" if e.get("before") is not None else "")
                     + (f" · {e['source_url']}" if e.get("source_url") else ""))
    lines += ["", f"Abrir la app: {url}", "",
              "Recomendaciones condicionadas a los datos y supuestos de la app. No es asesoría financiera."]
    return f"Atlas: {len(events)} cambios y tus 10 mejores oportunidades", "\n".join(lines)


def main() -> int:
    state = load_json(DATA / "digest.json", {}) or {}
    host, to = os.environ.get("SMTP_HOST", "").strip(), os.environ.get("ALERT_EMAIL_TO", "").strip()
    week = santiago_now().strftime("%G-W%V")
    if not host or not to:
        write_json(DATA / "digest.json", {**state, "status": "no_configurado", "checked_at": iso(),
                                         "detail": "Faltan secretos SMTP_HOST / ALERT_EMAIL_TO"})
        log("Digest por correo: no configurado (faltan secretos SMTP).")
        return 0
    if state.get("last_week") == week:
        log(f"Digest de la semana {week} ya enviado.")
        return 0
    url = os.environ.get("ATLAS_URL", "https://mickaxxx.github.io/cosas-de-ia/atlas/")
    subject, body = build(url)
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, os.environ.get("SMTP_USER") or to, to
    msg.set_content(body)
    try:
        with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", "587")), timeout=30) as s:
            s.starttls()
            if os.environ.get("SMTP_USER"):
                s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASS", ""))
            s.send_message(msg)
    except Exception as e:                           # noqa: BLE001
        write_json(DATA / "digest.json", {**state, "status": "error", "checked_at": iso(), "detail": str(e)[:300]})
        log(f"::warning::No se pudo enviar el digest: {e}")
        return 0
    write_json(DATA / "digest.json", {"status": "ok", "last_week": week, "sent_at": iso(), "to_count": len(to.split(","))})
    log(f"Digest enviado ({week}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
