"""Prueba de aceptación 5 con un ejemplo CONTROLADO (escena sintética de dimensiones exactas).

Flujo real completo: subir fotos → reconstruir (API + trabajador) → calibrar con UNA referencia → comprobar
medidas reservadas con la API de calibración → informe JSON.

Cómo se ubican los puntos medidos: con un registro de similitud (Umeyama) entre los centros de cámara
reconstruidos y los verdaderos se decide DÓNDE sondear; luego cada punto se toma intersectando un rayo con la
MALLA reconstruida, a lo largo de la normal de la cara. La distancia medida depende de la geometría real del
modelo, y la escala usada es la de la calibración de la app (no la del registro).
Esto no reemplaza un ensayo de terreno con medidas reales del sector.

Uso: python scripts/acceptance_scale.py --images DIR --truth truth.json --email ... --password ... [--out informe.json]
"""
import argparse
import json
import math
import sys
import time
import uuid
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_api import req  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))
from app.engine.convert import _accessor_array, read_glb  # noqa: E402

# Segmentos (verdad en metros). Cada punto: (punto objetivo verdadero, normal exterior de la superficie).
SEGMENTS = [
    ("ref", "Ancho del skid (caras ±X)", ((-2.0, 0.5, 0.0), (-1, 0, 0)), ((0.0, 0.5, 0.0), (1, 0, 0))),
    ("check", "Fondo del skid (caras ±Z)", ((-1.0, 0.5, -0.6), (0, 0, -1)), ((-1.0, 0.5, 0.6), (0, 0, 1))),
    ("check", "Techo del skid a piso", ((-1.0, 1.0, 0.0), (0, 1, 0)), ((-1.0, 0.0, 1.3), (0, 1, 0))),
    ("check", "Ancho del motor (caras ±X)", ((1.1, 0.3, 0.8), (-1, 0, 0)), ((1.9, 0.3, 0.8), (1, 0, 0))),
    ("check", "Skid (cara +X) a motor (cara −X)", ((0.0, 0.3, 0.55), (1, 0, 0)), ((1.1, 0.3, 0.75), (-1, 0, 0))),
    ("check", "Tapa del estanque a piso", ((1.2, 1.8, -1.8), (0, 1, 0)), ((1.2, 0.0, -1.1), (0, 1, 0))),
    ("check", "Muro posterior a cara −Z del skid", ((-1.0, 1.5, -4.5), (0, 0, 1)), ((-1.0, 0.5, -0.6), (0, 0, -1))),
]


def umeyama(src: np.ndarray, dst: np.ndarray):
    """dst ≈ s·R·src + t"""
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    cov = xd.T @ xs / len(src)
    U, D, Vt = np.linalg.svd(cov)
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1
    R = U @ S @ Vt
    s = np.trace(np.diag(D) @ S) / xs.var(0).sum()
    t = mu_d - s * R @ mu_s
    return s, R, t


def raycast(V, F, o, d):
    """Möller–Trumbore vectorizado. Devuelve el punto de impacto más cercano o None."""
    v0, v1, v2 = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    e1, e2 = v1 - v0, v2 - v0
    p = np.cross(d, e2)
    det = (e1 * p).sum(1)
    ok = np.abs(det) > 1e-12
    inv = np.where(ok, 1.0 / np.where(ok, det, 1), 0)
    tv = o - v0
    u = (tv * p).sum(1) * inv
    q = np.cross(tv, e1)
    v = (q * d).sum(1) * inv
    t = (e2 * q).sum(1) * inv
    hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-9)
    if not hit.any():
        return None
    return o + d * t[hit].min()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--images", required=True)
    ap.add_argument("--truth", required=True)
    ap.add_argument("--profile", default="rapido")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    b = a.base
    truth = json.loads(Path(a.truth).read_text())
    tok = req(b, "POST", "/api/auth/login", body={"email": a.email, "password": a.password})[1]["token"]
    _, proj = req(b, "POST", "/api/projects", tok, {"name": "Ensayo controlado de escala", "site": "Escena sintética"})
    _, sec = req(b, "POST", f"/api/projects/{proj['id']}/sectors", tok,
                 {"name": "Escena de control (sintética)", "area_type": "prueba",
                  "description": "Skid 2,0×1,0×1,2 m; motor 0,8×0,6×0,6 m; estanque Ø1,0×1,8 m"})
    _, batch = req(b, "POST", f"/api/sectors/{sec['id']}/batches", tok, {"label": "render sintético"})
    for p in sorted(Path(a.images).glob("*.jpg")):
        st, r = req(b, "POST", f"/api/batches/{batch['id']}/photos", tok, files={"file": (p.name, p.read_bytes(), "image/jpeg")})
        assert r["status"] == "accepted", r
    req(b, "POST", f"/api/batches/{batch['id']}/complete", tok)
    _, diag = req(b, "GET", f"/api/sectors/{sec['id']}/diagnostics", tok)
    group = next(iter(diag["camera_groups"]))
    t0 = time.time()
    st, job = req(b, "POST", f"/api/sectors/{sec['id']}/jobs", tok, {
        "idempotency_key": uuid.uuid4().hex, "profile": a.profile,
        "focal_overrides": {group: truth["focal_px"]}, "note": "focal conocida del render (corrección manual)"})
    assert st == 201, job
    while True:
        _, j = req(b, "GET", f"/api/jobs/{job['id']}", tok)
        if j["status"] in ("ready", "failed", "cancelled"):
            break
        time.sleep(5)
    assert j["status"] == "ready", (j["error_code"], j["error_message"])
    mid = j["model_version_id"]
    print(f"reconstrucción lista en {time.time() - t0:.0f} s")

    # Registro (solo para ubicar sondas) a partir de los centros de cámara.
    _, cams = req(b, "GET", f"/api/models/{mid}/cameras", tok)
    true_c = {c["name"]: np.array(c["center"]) for c in truth["cameras"]}
    pairs = [(np.array(c["center"]), true_c[c["filename"]]) for c in cams["cameras"] if c["filename"] in true_c]
    src, dst = np.array([p[0] for p in pairs]), np.array([p[1] for p in pairs])
    s, R, t = umeyama(src, dst)
    resid = np.linalg.norm((s * (R @ src.T)).T + t - dst, axis=1)
    print(f"registro de cámaras: {len(pairs)} pares, residuo RMS {math.sqrt((resid ** 2).mean()) * 100:.2f} cm")

    _, url = req(b, "GET", f"/api/models/{mid}/artifacts/web_glb/url", tok)
    _, glb = req(b, "GET", url["url"])
    tmp = Path("/tmp") / f"acc-{mid}.glb"
    tmp.write_bytes(glb)
    gltf, bin_data = read_glb(tmp)
    Vs, Fs, off = [], [], 0
    for prim in gltf["meshes"][0]["primitives"]:
        P = _accessor_array(gltf, bin_data, prim["attributes"]["POSITION"]).astype(np.float64)
        I = _accessor_array(gltf, bin_data, prim["indices"]).reshape(-1, 3).astype(np.int64)
        Vs.append(P)
        Fs.append(I + off)
        off += len(P)
    V, F = np.vstack(Vs), np.vstack(Fs)

    def to_model(x):
        return (R.T @ (np.asarray(x) - t)) / s

    def probe(target, normal):
        n = np.asarray(normal, float)
        origin = to_model(np.asarray(target) + n * 0.4)
        d = R.T @ (-n)
        return raycast(V, F, origin, d / np.linalg.norm(d))

    results = []
    for role, label, (pa, na), (pb, nb) in SEGMENTS:
        ha, hb = probe(pa, na), probe(pb, nb)
        true_d = float(np.linalg.norm(np.subtract(pb, pa)))
        if ha is None or hb is None:
            results.append({"role": role, "label": label, "true_m": true_d, "status": "sin superficie reconstruida"})
            continue
        body = {"label": label, "point_a": ha.tolist(), "point_b": hb.tolist(), "real_distance": true_d, "unit": "m",
                "source": "Verdad de la escena sintética (dimensión exacta del render)",
                "endpoints_description": f"Intersección del rayo normal con la malla en {pa} y {pb}"}
        st, cal = req(b, "POST", f"/api/models/{mid}/{'references' if role == 'ref' else 'checks'}", tok, body)
        assert st == 201, cal
        results.append({"role": role, "label": label, "true_m": true_d, "status": "registrada"})
    req(b, "PATCH", f"/api/models/{mid}", tok, {"tolerance_abs_m": 0.03, "tolerance_rel": 0.03,
                                                 "tolerance_purpose": "Ensayo controlado sintético (no es terreno)"})
    _, cal = req(b, "GET", f"/api/models/{mid}/calibration", tok)
    print(f"\nEstado: {cal['scale_state']} · factor {cal['scale_factor']:.6f} m/u (registro de cámaras: {s:.6f})")
    print(f"{'Comprobación':<38}{'real (m)':>10}{'modelo (m)':>12}{'error (cm)':>12}{'rel.':>8}")
    for c in cal["checks"]:
        print(f"{c['label']:<38}{c['real_distance_m']:>10.3f}{c['scaled_distance_m']:>12.3f}"
              f"{c['abs_error_m'] * 100:>12.2f}{c['rel_error'] * 100:>7.2f}% {'OK' if c['within_tolerance'] else 'FUERA'}")
    print(f"Error máx. {cal['max_abs_error_m'] * 100:.2f} cm · RMS {cal['rms_error_m'] * 100:.2f} cm · {cal['notice']}")
    report = {"project": proj["id"], "sector": sec["id"], "job": job["id"], "model": mid,
              "job_seconds": time.time() - t0, "camera_registration": {"pairs": len(pairs), "scale": s,
                                                                       "rms_m": float(math.sqrt((resid ** 2).mean()))},
              "segments": results, "calibration": cal, "job_report": j["report"]}
    if a.out:
        Path(a.out).write_text(json.dumps(report, indent=1, ensure_ascii=False, default=str))
    ok = cal["n_checks"] >= 3
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
