#!/usr/bin/env python3
"""
Radar Upwork: busca ofertas con la API oficial de Upwork (GraphQL), las puntúa
contra tu perfil (config/upwork_profile.json) y publica docs/upwork/data/jobs.json
para el panel docs/upwork/.

No inicia sesión con tu contraseña ni lee páginas de Upwork: usa OAuth2, así que
Upwork sabe que es tu app y nada infringe sus términos.

Credenciales (secretos de GitHub Actions):
  UPWORK_CLIENT_ID, UPWORK_CLIENT_SECRET  ← de tu API key en upwork.com/developer
  UPWORK_REFRESH_TOKEN                    ← lo crea el workflow al conectar
  UPWORK_REDIRECT_URI                     ← la misma URL que registraste en la key
  UPWORK_TOKEN_OUT (ruta)                 ← aquí se deja el refresh token nuevo para
                                            que el workflow lo guarde como secreto
  ANTHROPIC_API_KEY (opcional)            ← análisis y borrador de propuesta con Claude
  UPWORK_MODEL (opcional)                 ← por defecto claude-opus-5-5

Uso:
  python scripts/upwork_radar.py                    # run normal
  python scripts/upwork_radar.py --code-from-issue  # primer enlace (lee ISSUE_BODY)
  python scripts/upwork_radar.py --demo scripts/upwork_demo.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROFILE = ROOT / "config" / "upwork_profile.json"
OUT = ROOT / "docs" / "upwork" / "data" / "jobs.json"

TOKEN_URL = "https://www.upwork.com/api/v3/oauth2/token"
GQL_URL = "https://api.upwork.com/graphql"

# Lo que pedimos de cada oferta. Si la API no reconoce un campo, se quita solo y
# se reintenta (ver gql_search): el esquema de Upwork cambia y no queremos que un
# campo renombrado deje el radar sin datos.
NODE_FIELDS = {
    "id": None, "title": None, "description": None, "ciphertext": None,
    "createdDateTime": None, "publishedDateTime": None,
    "experienceLevel": None, "duration": None, "durationLabel": None, "engagement": None,
    "amount": {"rawValue": None, "currency": None},
    "hourlyBudgetType": None,
    "hourlyBudgetMin": {"rawValue": None},
    "hourlyBudgetMax": {"rawValue": None},
    "totalApplicants": None,
    "skills": {"name": None, "prettyName": None},
    "category": None, "subcategory": None,
    "client": {
        "totalHires": None, "totalPostedJobs": None, "totalSpent": {"rawValue": None},
        "verificationStatus": None, "location": {"country": None},
        "totalReviews": None, "totalFeedback": None,
    },
}
MINIMAL_FIELDS = {"id": None, "title": None, "description": None, "ciphertext": None, "createdDateTime": None}
OPTIONAL_ARGS = {"searchType": "USER_JOBS_SEARCH", "sortAttributes": "[{field: RECENCY}]"}

GRAVES = ("telegram", "whatsapp", "skype", "outside upwork", "pay outside", "upfront")
DURACION_ES = {
    "week": "Menos de 1 mes", "month": "1 a 3 meses", "quarter": "3 a 6 meses",
    "semester": "Más de 6 meses", "ongoing": "Más de 6 meses",
    "less than 1 month": "Menos de 1 mes", "less than a month": "Menos de 1 mes",
    "1 to 3 months": "1 a 3 meses", "3 to 6 months": "3 a 6 meses", "more than 6 months": "Más de 6 meses",
}
ESFUERZO_DURACION = {"Menos de 1 mes": 100, "1 a 3 meses": 60, "3 a 6 meses": 30, "Más de 6 meses": 15}


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def warn(msg: str) -> None:
    print(f"::warning::{msg}", file=sys.stderr)


# --------------------------------------------------------------------------- OAuth
def token_request(data: dict) -> dict:
    import requests

    cid, secret = os.environ.get("UPWORK_CLIENT_ID", ""), os.environ.get("UPWORK_CLIENT_SECRET", "")
    body = {**data, "client_id": cid, "client_secret": secret}
    r = requests.post(TOKEN_URL, data=body, headers={"Accept": "application/json"}, timeout=30)
    if r.status_code == 401:
        # Algunos despliegues de OAuth2 exigen las credenciales en Basic auth.
        r = requests.post(TOKEN_URL, data=data, auth=(cid, secret), headers={"Accept": "application/json"}, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"Upwork rechazó el token (HTTP {r.status_code}): {r.text[:300]}")
    return r.json()


def save_refresh_token(tok: dict, old: str) -> bool:
    """Deja el refresh token nuevo donde el workflow lo recoge. Devuelve si rotó."""
    new = tok.get("refresh_token") or ""
    if not new or new == old:
        return False
    out = os.environ.get("UPWORK_TOKEN_OUT")
    if out:
        Path(out).write_text(new, encoding="utf-8")
    return True


def access_token(code: str | None) -> tuple[str, dict]:
    old = os.environ.get("UPWORK_REFRESH_TOKEN", "").strip()
    if code:
        tok = token_request({
            "grant_type": "authorization_code", "code": code,
            "redirect_uri": os.environ.get("UPWORK_REDIRECT_URI", ""),
        })
    elif old:
        tok = token_request({"grant_type": "refresh_token", "refresh_token": old})
    else:
        raise LookupError("sin_credenciales")
    rotated = save_refresh_token(tok, old)
    info = {"renewed_at": iso(now()), "rotated": rotated, "connected_now": bool(code)}
    return tok["access_token"], info


# --------------------------------------------------------------------------- GraphQL
def render(sel: dict) -> str:
    return " ".join(k if v is None else f"{k} {{ {render(v)} }}" for k, v in sel.items())


def drop_field(sel: dict, name: str) -> bool:
    hit = False
    for k in list(sel):
        if k == name:
            del sel[k]
            hit = True
        elif isinstance(sel[k], dict):
            hit = drop_field(sel[k], name) or hit
            if not sel[k]:
                del sel[k]
    return hit


def all_names(sel: dict) -> set[str]:
    out = set()
    for k, v in sel.items():
        out.add(k)
        if isinstance(v, dict):
            out |= all_names(v)
    return out


def gql_search(token: str, expr: str, fields: dict, args: dict, notes: list[str], first: int = 50) -> list[dict]:
    """Una búsqueda. Si la API se queja de un campo o argumento, lo quita y reintenta."""
    import requests

    for _ in range(12):
        extra = "".join(f", {k}: {v}" for k, v in args.items())
        filt = f'{{searchExpression_eq: {json.dumps(expr)}, pagination_eq: {{after: "0", first: {first}}}}}'
        query = (f"query {{ marketplaceJobPostingsSearch(marketPlaceJobFilter: {filt}{extra}) "
                 f"{{ totalCount edges {{ node {{ {render(fields)} }} }} }} }}")
        r = requests.post(GQL_URL, json={"query": query}, timeout=60, headers={
            "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        if r.status_code in (401, 403):
            raise PermissionError(f"HTTP {r.status_code}: {r.text[:300]}")
        try:
            body = r.json()
        except ValueError:
            raise RuntimeError(f"Respuesta no JSON (HTTP {r.status_code}): {r.text[:200]}")
        errs = body.get("errors") or []
        data = ((body.get("data") or {}).get("marketplaceJobPostingsSearch") or {})
        if not errs or data.get("edges"):
            return [e.get("node") or {} for e in (data.get("edges") or [])]

        texto = " ".join(str(e.get("message", "")) for e in errs)
        quitado = False
        for k in list(args):
            if k in texto or str(args[k]).strip("[]{} ").split(":")[-1].strip() in texto:
                notes.append(f"argumento {k} no aceptado")
                del args[k]
                quitado = True
        citados = set(re.findall(r"['\"`]([A-Za-z_][A-Za-z0-9_]*)['\"`]", texto))
        for name in citados & all_names(fields):
            if drop_field(fields, name):
                notes.append(f"campo {name} no existe")
                quitado = True
        if not quitado:
            if fields != MINIMAL_FIELDS:
                notes.append(f"consulta reducida al mínimo: {texto[:160]}")
                fields.clear()
                fields.update(json.loads(json.dumps(MINIMAL_FIELDS)))
                continue
            raise RuntimeError(f"GraphQL: {texto[:300]}")
    raise RuntimeError("GraphQL: demasiados reintentos")


# --------------------------------------------------------------------------- normalización
def money(x) -> float | None:
    if isinstance(x, dict):
        x = x.get("rawValue")
    try:
        v = float(x)
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


def parse_time(x) -> datetime | None:
    if x in (None, ""):
        return None
    try:
        if isinstance(x, (int, float)) or str(x).isdigit():
            v = float(x)
            return datetime.fromtimestamp(v / 1000 if v > 1e11 else v, timezone.utc)
        return datetime.fromisoformat(str(x).replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, OSError):
        return None


def normalize(n: dict) -> dict:
    c = n.get("client") or {}
    cipher = n.get("ciphertext") or ""
    title = (n.get("title") or "").strip()
    url = (f"https://www.upwork.com/jobs/{cipher}" if cipher
           else "https://www.upwork.com/nx/search/jobs/?q=" + re.sub(r"\s+", "%20", title[:80]))
    hmin, hmax = money(n.get("hourlyBudgetMin")), money(n.get("hourlyBudgetMax"))
    fixed = money(n.get("amount"))
    tipo = "hora" if (hmin or hmax or str(n.get("hourlyBudgetType") or "").strip()) and not fixed else ("fijo" if fixed else "")
    dur_raw = str(n.get("durationLabel") or n.get("duration") or "").strip()
    dur = DURACION_ES.get(dur_raw.lower(), dur_raw)
    t = parse_time(n.get("publishedDateTime")) or parse_time(n.get("createdDateTime"))
    skills = [s.get("prettyName") or s.get("name") for s in (n.get("skills") or []) if isinstance(s, dict)]
    verif = c.get("verificationStatus")
    return {
        "id": str(n.get("id") or cipher or title),
        "t": title,
        "d": (n.get("description") or "").strip(),
        "url": url,
        "at": iso(t) if t else None,
        "tipo": tipo,
        "fijo": fixed,
        "hmin": hmin,
        "hmax": hmax,
        "nivel": (n.get("experienceLevel") or "").title() or None,
        "dur": dur or None,
        "carga": n.get("engagement") or None,
        "post": n.get("totalApplicants"),
        "skills": [s for s in skills if s][:12],
        "cat": n.get("subcategory") or n.get("category") or None,
        "cli": {
            "verif": None if verif is None else str(verif).upper() == "VERIFIED",
            "gasto": money(c.get("totalSpent")),
            "contrat": c.get("totalHires"),
            "publ": c.get("totalPostedJobs"),
            "nota": c.get("totalFeedback"),
            "resenas": c.get("totalReviews"),
            "pais": (c.get("location") or {}).get("country"),
        },
    }


# --------------------------------------------------------------------------- puntaje
def kw_hit(text: str, kw: str) -> bool:
    # Palabras cortas (rcm, kpi, sql…) exigen borde de palabra; frases, solo inclusión.
    if len(kw) <= 4 and " " not in kw:
        return re.search(rf"(?<![a-z0-9]){re.escape(kw)}(?![a-z0-9])", text) is not None
    return kw in text


def score(job: dict, P: dict) -> dict:
    pref = P["preferencias"]
    title = job["t"].lower()
    body = (job["d"] + " " + " ".join(job["skills"]) + " " + (job["cat"] or "")).lower()
    full = title + " " + body

    # 1. Afinidad: cada área suma sus palabras; manda la mejor, las demás aportan un tercio.
    por_area, hits = {}, {}
    for key, area in P["areas"].items():
        pts, h = 0, []
        for kw, w in area["palabras"].items():
            if kw_hit(title, kw):
                pts += 2 * w
                h.append(kw)
            elif kw_hit(body, kw):
                pts += w
                h.append(kw)
        por_area[key], hits[key] = pts, h
    mejor = max(por_area, key=por_area.get)
    bruto = por_area[mejor] + sum(v for k, v in por_area.items() if k != mejor) / 3
    bonos = [kw for kw in P.get("bonos", {}) if not kw.startswith("_") and kw_hit(full, kw)]
    bruto += sum(P["bonos"][kw] for kw in bonos)
    afinidad = min(100, round(bruto * 4))

    # 2. Cliente
    cli = job["cli"]
    if all(cli.get(k) is None for k in ("verif", "gasto", "contrat", "nota")):
        cliente = 50
    else:
        cliente = 0
        cliente += 35 if cli.get("verif") else (0 if cli.get("verif") is False else 15)
        g = cli.get("gasto") or 0
        cliente += 30 if g >= 10000 else 22 if g >= 1000 else 12 if g > 0 else 0
        h = cli.get("contrat") or 0
        cliente += 15 if h >= 5 else 10 if h >= 1 else 0
        nota = cli.get("nota") or 0
        cliente += 20 if nota >= 4.7 else 14 if nota >= 4.3 else 6 if nota >= 4 else (10 if not nota else 0)
        cliente = min(100, cliente)

    # 3. Competencia y frescura
    p = job.get("post")
    comp = 60 if p is None else 100 if p < 5 else 80 if p < 10 else 60 if p <= pref["max_postulantes_comodo"] else 35 if p < 50 else 10
    edad_h = None
    if job["at"]:
        edad_h = (now() - parse_time(job["at"])).total_seconds() / 3600
        comp += 10 if edad_h < 6 else 0 if edad_h < 24 else -10 if edad_h < 72 else -25
    comp = max(0, min(100, comp))

    # 4. Pago
    if job["tipo"] == "hora" and (job["hmax"] or job["hmin"]):
        tope = job["hmax"] or job["hmin"]
        lo, obj = pref["tarifa_hora_minima_usd"], pref["tarifa_hora_objetivo_usd"]
        pago = 15 if tope < lo else min(100, round(45 + 55 * (tope - lo) / max(1, obj - lo)))
    elif job["fijo"]:
        f = job["fijo"]
        pago = 10 if f < pref["precio_fijo_minimo_usd"] else 50 if f < 200 else 72 if f < 1000 else 90
    else:
        pago = 45

    # 5. Esfuerzo: si prefieres trabajos cortos, gana lo acotado.
    esfuerzo = ESFUERZO_DURACION.get(job["dur"] or "", 60)
    if any(w in full for w in ("quick", "small task", "one-time", "one time", "simple", "few hours")):
        esfuerzo = min(100, esfuerzo + 15)
    if any(w in full for w in ("full-time", "full time", "40 hours", "long term", "long-term")):
        esfuerzo = max(0, esfuerzo - 25)
    if not pref.get("prefiero_trabajos_cortos", True):
        esfuerzo = 60

    W = P["pesos_puntaje"]
    total = (afinidad * W["afinidad"] + cliente * W["cliente"] + comp * W["competencia"]
             + pago * W["pago"] + esfuerzo * W["esfuerzo"])

    alertas = sorted({msg for kw, msg in P.get("alertas", {}).items() if kw in full})
    graves = [kw for kw in GRAVES if kw in full]
    if graves:
        total -= 25
    if cli.get("verif") is False:
        total -= 8
    total = max(0, min(100, round(total)))

    motivo = None
    for kw in P.get("descartar_si_contiene", []):
        if kw in full:
            motivo = f"contiene «{kw}»"
    if not motivo and graves:
        motivo = "posible estafa: " + ", ".join(graves)
    if not motivo and afinidad < pref["afinidad_minima"]:
        motivo = "no encaja con tu perfil"
    if not motivo and edad_h is not None and edad_h > pref["horas_maximas_antiguedad"]:
        motivo = f"publicada hace {round(edad_h / 24)} días"
    if not motivo and job["tipo"] == "hora" and job["hmax"] and job["hmax"] < pref["tarifa_hora_minima_usd"]:
        motivo = f"tope US${job['hmax']:.0f}/h bajo tu mínimo"
    if not motivo and job["tipo"] == "fijo" and job["fijo"] and job["fijo"] < pref["precio_fijo_minimo_usd"]:
        motivo = f"presupuesto US${job['fijo']:.0f} bajo tu mínimo"

    job.update({
        "score": total,
        "veredicto": "postula" if total >= 70 else "revisa" if total >= 55 else "baja",
        "area": mejor,
        "parciales": {"afinidad": afinidad, "cliente": cliente, "competencia": comp, "pago": pago, "esfuerzo": esfuerzo},
        "coinciden": (hits[mejor] + bonos)[:10],
        "alertas": alertas,
        "grave": bool(graves),
        "descarte": motivo,
    })
    return job


# --------------------------------------------------------------------------- Claude (opcional)
AI_SCHEMA = {
    "type": "object",
    "properties": {"items": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "i": {"type": "integer"},
            "encaje": {"type": "string"},
            "riesgo": {"type": "string"},
            "horas": {"type": "number"},
            "dificultad": {"type": "string", "enum": ["baja", "media", "alta"]},
            "apertura": {"type": "string"},
            "pregunta": {"type": "string"},
        },
        "required": ["i", "encaje", "riesgo", "horas", "dificultad", "apertura", "pregunta"],
        "additionalProperties": False,
    }}},
    "required": ["items"],
    "additionalProperties": False,
}


def enrich(jobs: list[dict], P: dict) -> tuple[int, str | None]:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key or not jobs:
        return 0, None
    try:
        import anthropic
    except ImportError:
        warn("anthropic no instalado; se omite el análisis IA")
        return 0, None
    model = (os.environ.get("UPWORK_MODEL") or "").strip() or "claude-opus-5-5"
    client = anthropic.Anthropic(api_key=api_key)
    perfil = P["perfil"]
    system = (
        "You help a freelancer decide which Upwork jobs to apply to and write the first lines of the proposal. "
        f"Freelancer profile: {perfil['resumen_para_propuestas']} Languages: {', '.join(perfil['idiomas'])}. "
        "For each job return, in Spanish: 'encaje' (max 200 chars, the concrete reason it fits or doesn't, citing the job), "
        "'riesgo' (max 140 chars, the main risk or catch; empty string if none), 'horas' (realistic hours to deliver), "
        "'dificultad' (baja/media/alta for this freelancer), 'pregunta' (one sharp clarifying question to ask the client, "
        "in the job's language). 'apertura': the opening of the proposal in the job's language, 3-4 sentences, max 600 chars, "
        "starting with the client's problem (not 'I am'), mentioning one specific relevant experience from the profile and a "
        "first step. Never invent experience, tools, certifications or numbers that are not in the profile."
    )
    lines = []
    for k, j in enumerate(jobs):
        pres = f"US${j['fijo']:.0f} fijo" if j.get("fijo") else (f"US${j.get('hmin') or 0:.0f}-{j.get('hmax') or 0:.0f}/h" if j.get("hmax") else "sin presupuesto")
        lines.append(f"### {k}. {j['t']} ({pres}; {j.get('dur') or 'duración ?'})\n{j['d'][:1800]}")
    try:
        resp = client.beta.messages.create(
            model=model,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=system,
            messages=[{"role": "user", "content": "Analiza estas ofertas:\n\n" + "\n\n".join(lines)}],
            output_config={"format": {"type": "json_schema", "schema": AI_SCHEMA}, "effort": "low"},
        )
    except anthropic.APIStatusError as e:
        warn(f"Claude respondió {e.status_code}; el radar sigue sin análisis IA")
        return 0, model
    except anthropic.APIConnectionError:
        warn("sin conexión con Claude; el radar sigue sin análisis IA")
        return 0, model
    if resp.stop_reason == "refusal":
        warn("Claude rehusó el lote")
        return 0, model
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        rows = json.loads(text).get("items", [])
    except json.JSONDecodeError:
        warn("Claude devolvió JSON inválido")
        return 0, model
    done = 0
    for row in rows:
        k = row.get("i")
        if isinstance(k, int) and 0 <= k < len(jobs):
            jobs[k]["ai"] = {
                "encaje": row["encaje"][:220], "riesgo": row["riesgo"][:160],
                "horas": row["horas"], "dificultad": row["dificultad"],
                "apertura": row["apertura"][:700], "pregunta": row["pregunta"][:240],
            }
            done += 1
    return done, resp.model


# --------------------------------------------------------------------------- principal
def load_json(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def code_from_issue() -> str | None:
    body = os.environ.get("ISSUE_BODY", "")
    m = re.search(r"code=([A-Za-z0-9._~\-]+)", body) or re.search(r"c[oó]digo:\s*([A-Za-z0-9._~\-]+)", body, re.I)
    return m.group(1) if m else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", help="JSON con nodos de ejemplo (sin red)")
    ap.add_argument("--code-from-issue", action="store_true")
    ap.add_argument("--max-ai", type=int, default=int(os.environ.get("UPWORK_MAX_AI", "12")))
    a = ap.parse_args()

    P = load_json(PROFILE, None)
    if not P:
        print(f"::error::no pude leer {PROFILE}")
        return 1
    prev = load_json(OUT, {})
    prev_jobs = {j["id"]: j for j in prev.get("jobs", []) if prev.get("status") != "demo"}
    seen = {} if prev.get("status") == "demo" else dict(prev.get("seen", {}))
    out = {
        "generated_at": iso(now()), "status": "ok", "message": "",
        "areas": {k: v["etiqueta"] for k, v in P["areas"].items()},
        "token": prev.get("token", {}), "schema_notes": [],
        "ai": {"enabled": bool(os.environ.get("ANTHROPIC_API_KEY")), "model": None, "count": 0},
    }

    nodes: list[dict] = []
    if a.demo:
        demo = load_json(Path(a.demo), {})
        nodes = demo.get("nodes", [])
        for n in nodes:                                   # '-5h' = hace 5 horas
            m = re.fullmatch(r"-(\d+)h", str(n.get("publishedDateTime", "")))
            if m:
                n["publishedDateTime"] = iso(now() - timedelta(hours=int(m.group(1))))
        ai_demo = demo.get("ai", {})
        out["status"] = "demo"
        out["message"] = "Datos de ejemplo: conecta tu API key de Upwork para ver ofertas reales."
    else:
        code = None
        if a.code_from_issue:
            code = code_from_issue()
            if not code:
                out.update(status="error_token", message="El issue no traía el código de Upwork. Vuelve a pulsar «Conectar con Upwork».")
        try:
            if out["status"] == "ok":
                token, info = access_token(code)
                out["token"] = {**out["token"], **info}
                if info["rotated"] and not os.environ.get("UPWORK_TOKEN_OUT"):
                    warn("Upwork entregó un refresh token nuevo y no hay dónde guardarlo")
                notes: list[str] = []
                fields = json.loads(json.dumps(NODE_FIELDS))
                args = dict(OPTIONAL_ARGS)
                for key, area in P["areas"].items():
                    try:
                        got = gql_search(token, area["busqueda"], fields, args, notes)
                        print(f"  {key}: {len(got)} ofertas")
                        nodes += got
                    except RuntimeError as e:
                        notes.append(f"{key}: {e}")
                        warn(f"búsqueda {key}: {e}")
                out["schema_notes"] = sorted(set(notes))[:20]
                if not nodes and notes:
                    out.update(status="error_api", message=notes[-1][:300])
        except LookupError:
            out.update(status="sin_credenciales", message="Falta conectar tu cuenta: sigue los pasos del panel.")
        except PermissionError as e:
            out.update(status="error_permiso", message=f"Upwork negó el acceso. Revisa que tu API key tenga permiso de lectura de ofertas del marketplace. {e}")
        except Exception as e:  # noqa: BLE001 — el panel debe mostrar el error, no quedarse mudo
            out.update(status="error_token", message=f"{type(e).__name__}: {str(e)[:300]}")

    if out["status"] == "sin_credenciales" and prev.get("status") == "demo":
        print("Sin credenciales de Upwork todavía: el panel sigue mostrando el ejemplo.")
        return 0
    if out["status"] not in ("ok", "demo"):
        # Se conserva lo último bueno para que el panel siga siendo útil.
        warn(out["message"])
        for k in ("jobs", "descartadas", "stats", "seen"):
            if k in prev and prev.get("status") != "demo":
                out[k] = prev[k]
        out["last_ok"] = prev.get("last_ok")
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        return 0

    jobs, ids = [], set()
    for n in nodes:
        j = normalize(n)
        if j["id"] in ids or not j["t"]:
            continue
        ids.add(j["id"])
        jobs.append(score(j, P))

    stamp = out["generated_at"]
    for j in jobs:
        j["nueva"] = j["id"] not in seen
        seen.setdefault(j["id"], stamp)
        if j["id"] in prev_jobs and prev_jobs[j["id"]].get("ai"):
            j["ai"] = prev_jobs[j["id"]]["ai"]          # no se paga dos veces el mismo análisis
        if a.demo and j["id"] in ai_demo:
            j["ai"] = ai_demo[j["id"]]

    buenas = sorted((j for j in jobs if not j["descarte"]), key=lambda j: (-j["score"], j["at"] or ""))
    buenas = buenas[: P["preferencias"]["mostrar_maximo"]]
    malas = [j for j in jobs if j["descarte"]]

    pend = [j for j in buenas if not j.get("ai") and j["veredicto"] != "baja"][: a.max_ai]
    if pend and not a.demo:
        n, model = enrich(pend, P)
        out["ai"].update(model=model, count=n)
        if out["ai"]["enabled"]:
            print(f"  Claude analizó {n} ofertas")

    for j in buenas:
        j["d"] = j["d"][:1500]
    out["jobs"] = buenas
    out["descartadas"] = [{"t": j["t"][:120], "url": j["url"], "why": j["descarte"], "score": j["score"]}
                          for j in sorted(malas, key=lambda j: -j["score"])[:80]]
    out["stats"] = {
        "analizadas": len(jobs), "mostradas": len(buenas), "descartadas": len(malas),
        "postula": sum(j["veredicto"] == "postula" for j in buenas),
        "nuevas": sum(j["nueva"] for j in buenas),
        # Leer y descartar una oferta a mano toma ~1,5 min; el radar lo hace por ti.
        "minutos_ahorrados": round(len(malas) * 1.5 + len(buenas) * 0.5),
    }
    out["seen"] = dict(sorted(seen.items(), key=lambda kv: kv[1])[-1500:])
    out["last_ok"] = stamp
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    s = out["stats"]
    print(f"Radar: {s['analizadas']} analizadas · {s['mostradas']} visibles · {s['postula']} para postular · {s['descartadas']} descartadas")
    return 0


if __name__ == "__main__":
    sys.exit(main())
