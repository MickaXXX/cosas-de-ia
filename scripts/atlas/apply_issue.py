#!/usr/bin/env python3
"""
Aplica cambios enviados desde el panel de administración de la app.

La app no guarda credenciales. Cuando el dueño del repositorio guarda un cambio
"para todos", la app abre un issue de GitHub ya rellenado; el workflow
atlas-issues.yml verifica que el autor sea el dueño y llama a este script:

  atlas-config: …     cuerpo con ```json {config completa}```  → docs/atlas/config/defaults.json
  atlas-import: proyectos|arriendos  cuerpo con ```csv …```    → import_data.py
  atlas-obra: …       cuerpo con ```json {desarrollo}```       → data/developments.json
  atlas-actualizar:   (sin cuerpo)                             → el workflow corre run.py now

Auditoría: el issue guarda quién y cuándo; el commit guarda antes/después (git diff);
revertir es `git revert` o restaurar desde la app ("Restablecer supuestos originales").
Escribe en GITHUB_OUTPUT `summary` para comentar el issue.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CONFIG, DATA, gh_output, iso, load_json, log, slug, write_json  # noqa: E402


def block(body: str, lang: str) -> str | None:
    m = re.search(rf"```{lang}\s*\n(.*?)\n```", body, re.S)
    return m.group(1) if m else None


def fail(msg: str) -> int:
    log(f"::error::{msg}")
    gh_output("summary", f"No se aplicó: {msg}")
    return 1


def apply_config(body: str, actor: str) -> int:
    raw = block(body, "json")
    if not raw:
        return fail("el issue no trae un bloque ```json con la configuración")
    try:
        new = json.loads(raw)
    except json.JSONDecodeError as e:
        return fail(f"JSON inválido: {e}")
    cur = load_json(CONFIG / "defaults.json", {})
    # Solo se aceptan claves que ya existen en la configuración: un error de tipeo no
    # crea parámetros fantasma que el código nunca lee.
    unknown = sorted(set(new) - set(cur) - {"_meta"})
    if unknown:
        return fail(f"claves desconocidas: {', '.join(unknown)}")
    for k, v in new.items():
        if k in cur and type(v) is not type(cur[k]) and not (isinstance(v, (int, float)) and isinstance(cur[k], (int, float))):
            return fail(f"«{k}» debe ser {type(cur[k]).__name__}")
    merged = {**cur, **new}
    merged["_meta"] = {**cur.get("_meta", {}), "updated_at": iso(), "updated_by": actor, "version": int(cur.get("_meta", {}).get("version", 0)) + 1}
    write_json(CONFIG / "defaults.json", merged)
    changed = [k for k in new if k != "_meta" and new[k] != cur.get(k)]
    gh_output("summary", f"Configuración publicada (versión {merged['_meta']['version']}). Cambiaron: {', '.join(changed) or 'nada'}.")
    gh_output("files", "docs/atlas/config/defaults.json")
    return 0


def apply_import(title: str, body: str, actor: str) -> int:
    import import_data
    kind = "rentals" if re.search(r"arriendo|rental", title, re.I) else "projects"
    raw = block(body, "csv")
    if not raw:
        return fail("el issue no trae un bloque ```csv")
    res = import_data.run_import(kind, import_data.read_rows(raw, is_text=True), f"issue: {title}", actor)
    if res["status"] != "importado":
        errs = "\n".join(f"- {e}" for e in res.get("errors", [])[:30])
        log(errs)
        gh_output("summary", f"Importación rechazada ({len(res.get('errors', []))} errores). Primeros:\n{errs}")
        return 1
    files = "docs/atlas/data/projects.json" if kind == "projects" else "docs/atlas/data/rentals.json"
    gh_output("files", f"{files} docs/atlas/data/import_log.json")
    gh_output("summary", f"Importación OK: {res.get('added', 0)} nuevos, {res.get('updated', res.get('duplicates', 0))} actualizados/duplicados.")
    return 0


def apply_development(body: str, actor: str) -> int:
    raw = block(body, "json")
    if not raw:
        return fail("el issue no trae un bloque ```json con la obra")
    try:
        dev = json.loads(raw)
    except json.JSONDecodeError as e:
        return fail(f"JSON inválido: {e}")
    if not dev.get("name") or not dev.get("sources"):
        return fail("la obra necesita nombre y al menos una fuente")
    dev.setdefault("id", slug(dev["name"]))
    dev.setdefault("status", "pendiente_revision")
    dev["last_checked"] = iso()[:10]
    dev["added_by"] = actor
    doc = load_json(DATA / "developments.json", {"developments": []}) or {"developments": []}
    others = [d for d in doc["developments"] if d["id"] != dev["id"]]
    doc["developments"] = others + [dev]
    doc["updated_at"] = iso()
    write_json(DATA / "developments.json", doc)
    gh_output("files", "docs/atlas/data/developments.json")
    gh_output("summary", f"Obra «{dev['name']}» guardada con estado {dev['status']}.")
    return 0


def main() -> int:
    title = os.environ.get("ISSUE_TITLE", "")
    body = os.environ.get("ISSUE_BODY", "")
    actor = os.environ.get("ISSUE_AUTHOR", "desconocido")
    t = title.lower()
    if t.startswith("atlas-config:"):
        return apply_config(body, actor)
    if t.startswith("atlas-import:"):
        return apply_import(title, body, actor)
    if t.startswith("atlas-obra:"):
        return apply_development(body, actor)
    return fail(f"título no reconocido: {title}")


if __name__ == "__main__":
    sys.exit(main())
