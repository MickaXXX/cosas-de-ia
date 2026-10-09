"""Prueba de extremo a extremo vía API: proyecto → sector → lote → fotos → trabajo → modelo.

Uso: python scripts/e2e_api.py --base http://127.0.0.1:8000 --email ... --password ... --photos DIR [--profile rapido]
Solo usa la API pública (requests vía urllib) para que sirva de ejemplo funcional.
"""
import argparse
import json
import mimetypes
import sys
import time
import urllib.request
import uuid
from pathlib import Path


def req(base, method, path, token=None, body=None, files=None):
    headers = {}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if files:
        boundary = uuid.uuid4().hex
        parts = []
        for name, (fname, content, ctype) in files.items():
            parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{fname}\"\r\n"
                         f"Content-Type: {ctype}\r\n\r\n".encode() + content + b"\r\n")
        data = b"".join(parts) + f"--{boundary}--\r\n".encode()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=600) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw and resp.headers.get_content_type() == "application/json" else raw)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--photos", required=True)
    ap.add_argument("--profile", default="rapido")
    ap.add_argument("--sector-name", default="Prueba E2E")
    a = ap.parse_args()
    b = a.base
    st, login = req(b, "POST", "/api/auth/login", body={"email": a.email, "password": a.password})
    assert st == 200, login
    tok = login["token"]
    st, proj = req(b, "POST", "/api/projects", tok, {"name": "Planta 3D – pruebas", "site": "Entorno de desarrollo"})
    st, sec = req(b, "POST", f"/api/projects/{proj['id']}/sectors", tok, {"name": a.sector_name, "area_type": "prueba"})
    st, batch = req(b, "POST", f"/api/sectors/{sec['id']}/batches", tok, {"label": "lote e2e"})
    photos = sorted(p for p in Path(a.photos).iterdir() if p.is_file())
    counts = {}
    for p in photos:
        ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        st, ph = req(b, "POST", f"/api/batches/{batch['id']}/photos", tok, files={"file": (p.name, p.read_bytes(), ctype)})
        counts[ph.get("status", st)] = counts.get(ph.get("status", st), 0) + 1
    req(b, "POST", f"/api/batches/{batch['id']}/complete", tok)
    print("carga:", counts)
    st, diag = req(b, "GET", f"/api/sectors/{sec['id']}/diagnostics", tok)
    print("diagnóstico:", json.dumps({k: diag[k] for k in ("accepted", "included", "flags", "advice")}, ensure_ascii=False))
    key = uuid.uuid4().hex
    st, job = req(b, "POST", f"/api/sectors/{sec['id']}/jobs", tok, {"idempotency_key": key, "profile": a.profile})
    assert st == 201, job
    st2, again = req(b, "POST", f"/api/sectors/{sec['id']}/jobs", tok, {"idempotency_key": key, "profile": a.profile})
    print("idempotencia:", st2, again["id"] == job["id"])
    t0 = time.time()
    last = None
    while True:
        st, j = req(b, "GET", f"/api/jobs/{job['id']}", tok)
        cur = (j["status"], j["stage"])
        if cur != last:
            print(f"[{time.time() - t0:7.1f}s] {j['status']:<15} {j['stage']}")
            last = cur
        if j["status"] in ("ready", "failed", "cancelled"):
            break
        time.sleep(3)
    if j["status"] != "ready":
        print("ERROR:", j["error_code"], j["error_message"])
        print(json.dumps(j["report"].get("failure"), indent=1, ensure_ascii=False))
        sys.exit(1)
    st, mv = req(b, "GET", f"/api/models/{j['model_version_id']}", tok)
    print("modelo:", json.dumps({k: mv[k] for k in ("number", "source", "scale_state", "stats")}, ensure_ascii=False))
    st, url = req(b, "GET", f"/api/models/{mv['id']}/artifacts/web_glb/url", tok)
    st, glb = req(b, "GET", url["url"])
    print("GLB descargado:", st, len(glb), "bytes; firma", glb[:4])
    print(json.dumps({"project": proj["id"], "sector": sec["id"], "job": job["id"], "model": mv["id"]}))


if __name__ == "__main__":
    main()
