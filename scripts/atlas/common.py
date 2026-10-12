"""
Utilidades compartidas del pipeline de Atlas Inversión Santiago.

Todo el pipeline usa solo la biblioteca estándar de Python: corre igual en
GitHub Actions que en un computador sin instalar nada.

Reglas que se respetan en todos los conectores:
  * Un conector que falla NUNCA reemplaza datos buenos por ceros ni por datos
    ficticios: se conserva el último dato verificado y se marca "desactualizado".
  * Las fechas se guardan en UTC (ISO 8601) y se presentan en America/Santiago.
  * Cada archivo se escribe de forma atómica (archivo temporal + rename) para
    que la app nunca lea un JSON a medio escribir.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent.parent
APP = ROOT / "docs" / "atlas"
DATA = APP / "data"
OSM = DATA / "osm"
CONFIG = APP / "config"

SANTIAGO = ZoneInfo("America/Santiago")
USER_AGENT = "AtlasInversionSantiago/1.0 (+https://github.com/MickaXXX/cosas-de-ia)"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None = None) -> str:
    return (dt or utc_now()).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def santiago_now(now: datetime | None = None) -> datetime:
    return (now or utc_now()).astimezone(SANTIAGO)


def parse_date(value) -> date | None:
    """Acepta 'YYYY-MM-DD', 'YYYY-MM' (día 1) o 'DD-MM-YYYY'. Devuelve None si no se entiende."""
    if value in (None, ""):
        return None
    if isinstance(value, date):
        return value
    s = str(value).strip()
    for fmt in ("%Y-%m-%d", "%Y-%m", "%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def load_json(path: Path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as e:
        log(f"::warning::{path.relative_to(ROOT)} no es JSON válido: {e}")
        return default


def write_json(path: Path, data, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        if compact:
            json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def http_get(url: str, params: dict | None = None, timeout: int = 60, retries: int = 3,
             headers: dict | None = None, data: bytes | None = None) -> bytes:
    """GET (o POST si hay data) con reintentos y backoff exponencial: 2s, 4s, 8s…"""
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json, */*"}
    hdrs.update(headers or {})
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=hdrs, data=data)
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
            if isinstance(e, urllib.error.HTTPError) and e.code in (400, 401, 403, 404):
                break                                  # no tiene sentido reintentar
            wait = 2 ** (attempt + 1)
            log(f"  · {url[:90]}… falló ({e}); reintento en {wait}s")
            time.sleep(wait)
    raise RuntimeError(f"No se pudo descargar {url[:120]}: {last}")


def http_json(url: str, **kw):
    return json.loads(http_get(url, **kw).decode("utf-8"))


def gh_output(key: str, value: str) -> None:
    """Escribe una salida para el paso siguiente del workflow (si corre en Actions)."""
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            if "\n" in value:                       # valores de varias líneas: sintaxis heredoc
                import uuid
                delim = f"EOF_{uuid.uuid4().hex}"
                fh.write(f"{key}<<{delim}\n{value}\n{delim}\n")
            else:
                fh.write(f"{key}={value}\n")


def slug(text: str) -> str:
    import re
    import unicodedata
    t = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")[:80]
