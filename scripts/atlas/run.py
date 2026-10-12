#!/usr/bin/env python3
"""
Orquestador de tareas programadas de Atlas Inversión Santiago.

  daily      UF + validación (todos los días)
  weekly     lunes 08:00 America/Santiago: UF, capas OSM si están viejas,
             geocodificación, radar de noticias, foto del ranking, validación y
             detección de cambios, digest por correo (si hay SMTP)
  monthly    capas OSM completas (Metro, servicios, comunas) + validación
  bootstrap  lo mínimo para que la app tenga datos: geocodifica, UF si falta,
             OSM si falta o está vieja, valida (corre cuando cambian datos o scripts)
  now        todo, sin restricción horaria (botón "Ejecutar actualización ahora")

Horario de verano: GitHub Actions solo entiende UTC, así que el workflow agenda el
lunes a las 11:00 y a las 12:00 UTC. Este script decide cuál de las dos corre:
solo la que cae a las 08:00 o después en Santiago y solo si esa semana aún no corrió.
Así funciona igual con UTC-3 (verano) que con UTC-4 (invierno), y aguanta que
GitHub atrase un cron.

Cada ejecución queda registrada en data/jobs.json (pasos, duración, errores), que
es lo que muestra la pantalla "Fuentes y datos".
"""
from __future__ import annotations

import argparse
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, SANTIAGO, iso, load_json, log, santiago_now, write_json  # noqa: E402

JOBS = DATA / "jobs.json"


def should_run_weekly(now_utc: datetime, last_run_iso: str | None, hour: int = 8) -> tuple[bool, str]:
    local = now_utc.astimezone(SANTIAGO)
    if local.weekday() != 0:
        return False, f"hoy no es lunes en Santiago ({local:%A %H:%M})"
    if local.hour < hour:
        return False, f"aún no son las {hour:02d}:00 en Santiago (son las {local:%H:%M})"
    if last_run_iso:
        last = datetime.fromisoformat(last_run_iso.replace("Z", "+00:00")).astimezone(SANTIAGO)
        if last.isocalendar()[:2] == local.isocalendar()[:2]:
            return False, f"ya corrió esta semana ({last:%Y-%m-%d %H:%M} Santiago)"
    return True, f"lunes {local:%H:%M} en Santiago"


def step_uf():
    import update_uf
    return update_uf.main()


def step_uf_if_missing():
    uf = load_json(DATA / "uf.json", {}) or {}
    if uf.get("value") and uf.get("date") == santiago_now().date().isoformat():
        log("UF de hoy ya está; se omite")
        return 0
    return step_uf()


def step_geocode():
    import geocode
    return geocode.main()


def step_radar():
    import news_radar
    return news_radar.main()


def step_osm_if_stale():
    import osm_layers
    return osm_layers.main(["--if-stale"])


def step_osm_full():
    import osm_layers
    return osm_layers.main([])


def step_validate():
    import validate
    return validate.main([])


def step_rank():
    """Foto del ranking con el motor JS de la app (requiere Node; si no está, se omite)."""
    import shutil
    import subprocess
    if not shutil.which("node"):
        log("Node no disponible: se omite la foto del ranking")
        return 0
    res = subprocess.run(["node", str(Path(__file__).resolve().parent / "rank_snapshot.mjs")], capture_output=True, text=True, timeout=300)
    log(res.stdout.strip() or res.stderr.strip())
    return res.returncode


def step_digest():
    import digest
    return digest.main()


PLANS = {
    "daily": [("UF", step_uf), ("Validación", step_validate)],
    "weekly": [("UF", step_uf), ("Capas OSM (si están viejas)", step_osm_if_stale), ("Geocodificación", step_geocode),
               ("Radar de noticias", step_radar), ("Foto del ranking", step_rank), ("Validación y cambios", step_validate),
               ("Digest por correo", step_digest)],
    "monthly": [("Capas OSM", step_osm_full), ("Geocodificación", step_geocode), ("Validación", step_validate)],
    "bootstrap": [("Capas OSM (si faltan)", step_osm_if_stale), ("Geocodificación", step_geocode),
                  ("UF (si falta)", step_uf_if_missing), ("Foto del ranking", step_rank), ("Validación", step_validate)],
    "now": [("UF", step_uf), ("Capas OSM (si están viejas)", step_osm_if_stale), ("Geocodificación", step_geocode),
            ("Radar de noticias", step_radar), ("Foto del ranking", step_rank), ("Validación y cambios", step_validate)],
}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("task", choices=sorted(PLANS))
    ap.add_argument("--force", action="store_true", help="ignora la restricción de lunes 08:00")
    args = ap.parse_args(argv)
    jobs = load_json(JOBS, {}) or {}
    if args.task == "weekly" and not args.force:
        ok, why = should_run_weekly(datetime.now().astimezone(), (jobs.get("weekly") or {}).get("started_at"))
        log(f"Semanal: {why}")
        if not ok:
            return 0
    run = {"task": args.task, "started_at": iso(), "steps": []}
    worst = 0
    for name, fn in PLANS[args.task]:
        t0 = time.time()
        try:
            code = fn() or 0
            status = "ok" if code == 0 else "advertencia"
            err = None
        except Exception as e:                       # noqa: BLE001 — un paso caído no detiene a los demás
            code, status, err = 1, "error", f"{e}"
            traceback.print_exc()
        worst = max(worst, code)
        run["steps"].append({"name": name, "status": status, "seconds": round(time.time() - t0, 1), "error": err})
        log(f"[{status}] {name} ({time.time() - t0:.1f}s)")
    run["finished_at"] = iso()
    run["status"] = "ok" if worst == 0 else "con_advertencias"
    jobs[args.task] = run
    hist = jobs.setdefault("history", [])
    hist.insert(0, {k: run[k] for k in ("task", "started_at", "finished_at", "status")})
    jobs["history"] = hist[:60]
    write_json(JOBS, jobs)
    # El registro de jobs se escribe después de validar: se vuelve a generar health.json
    # para que incluya esta ejecución.
    try:
        step_validate()
    except Exception:                                # noqa: BLE001
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
