"""Escala, comprobaciones reservadas y estados (prueba de aceptación 5, parte lógica)."""
import io
import math
from pathlib import Path

import numpy as np

from app.calibration import check_passes, fit_scale
from app.engine.convert import TexturedMesh, mesh_to_glb


class R:
    def __init__(self, a, b, D):
        self.point_a, self.point_b, self.real_distance_m = a, b, D


def test_fit_scale_single_and_least_squares():
    assert fit_scale([R([0, 0, 0], [2, 0, 0], 5.0)]) == 2.5
    s = fit_scale([R([0, 0, 0], [1, 0, 0], 2.0), R([0, 0, 0], [0, 2, 0], 4.2)])
    assert math.isclose(s, (2 * 1 + 4.2 * 2) / (1 + 4))
    assert fit_scale([R([1, 1, 1], [1, 1, 1], 3.0)]) is None


def test_check_passes():
    assert check_passes(0.01, 0.005, 0.02, None) is True
    assert check_passes(0.03, 0.005, 0.02, None) is False
    assert check_passes(0.01, 0.03, 0.02, 0.02) is False
    assert check_passes(0.01, 0.01, None, None) is None


def _glb_box(tmp: Path) -> Path:
    # Caja de 1×1×1 unidades del modelo.
    v = np.array([[x, y, z] for x in (0, 1) for y in (0, 1) for z in (0, 1)], np.float32)
    f = np.array([[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1],
                  [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]])
    out = tmp / "caja.glb"
    mesh_to_glb(TexturedMesh(v, f, None, None, []), out, flip_v=False)
    return out


def test_calibration_states_end_to_end(client, admin, sector, tmp_path):
    sid = sector["sector"]["id"]
    glb = _glb_box(tmp_path).read_bytes()
    r = client.post(f"/api/sectors/{sid}/models/import", headers=admin,
                    files={"file": ("caja.glb", glb, "model/gltf-binary")}, data={"label": "Caja de prueba", "is_demo": "true"})
    assert r.status_code == 201, r.text
    mv = r.json()
    assert mv["scale_state"] == "uncalibrated" and mv["source"] == "demo"
    mid = mv["id"]
    m = client.post(f"/api/models/{mid}/measure", headers=admin, json={"point_a": [0, 0, 0], "point_b": [1, 0, 0]}).json()
    assert m["meters"] is None  # sin calibrar no hay metros
    assert client.post(f"/api/models/{mid}/export?metric=true", headers=admin).status_code == 409

    seg = lambda label, a, b, d, unit="m": {"label": label, "point_a": a, "point_b": b, "real_distance": d,
                                            "unit": unit, "source": "Huincha 5 m (prueba)"}
    assert client.post(f"/api/models/{mid}/references", headers=admin, json=seg("cero", [0, 0, 0], [0, 0, 0], 1)).status_code == 422
    c = client.post(f"/api/models/{mid}/references", headers=admin, json=seg("ancho", [0, 0, 0], [1, 0, 0], 200, "cm")).json()
    assert c["scale_state"] == "calibrated_unverified" and math.isclose(c["scale_factor"], 2.0)
    # Una comprobación no puede reutilizar el segmento de ajuste.
    assert client.post(f"/api/models/{mid}/checks", headers=admin, json=seg("dup", [1, 0, 0], [0, 0, 0], 2)).status_code == 409
    for i, (b, d) in enumerate([([0, 1, 0], 2.01), ([0, 0, 1], 1.99), ([1, 1, 0], 2 * math.sqrt(2) + 0.01)]):
        c = client.post(f"/api/models/{mid}/checks", headers=admin, json=seg(f"c{i}", [0, 0, 0], b, d)).json()
    assert c["n_checks"] == 3 and c["scale_state"] == "calibrated_unverified"  # falta tolerancia
    assert all(abs(ch["abs_error_m"]) < 0.011 for ch in c["checks"])
    client.patch(f"/api/models/{mid}", headers=admin, json={"tolerance_abs_m": 0.02, "tolerance_purpose": "prueba"})
    c = client.get(f"/api/models/{mid}/calibration", headers=admin).json()
    assert c["scale_state"] == "verified", c["notice"]
    client.patch(f"/api/models/{mid}", headers=admin, json={"tolerance_abs_m": 0.005})
    c = client.get(f"/api/models/{mid}/calibration", headers=admin).json()
    assert c["scale_state"] == "calibrated_unverified" and any(ch["within_tolerance"] is False for ch in c["checks"])
    m = client.post(f"/api/models/{mid}/measure", headers=admin, json={"point_a": [0, 0, 0], "point_b": [0, 0, 0.5]}).json()
    assert math.isclose(m["meters"], 1.0)

    # Exportación métrica: la transformación queda incorporada en el archivo.
    url = client.post(f"/api/models/{mid}/export?metric=true", headers=admin).json()["url"]
    data = client.get(url).content
    from app.engine.convert import read_glb

    p = tmp_path / "exp.glb"
    p.write_bytes(data)
    gltf, _ = read_glb(p)
    root = gltf["nodes"][gltf["scenes"][0]["nodes"][0]]
    M = np.array(root["matrix"]).reshape(4, 4).T
    assert np.allclose(M[:3, :3], 2.0 * np.eye(3))


def test_alignment_must_be_rigid(client, admin, sector, tmp_path):
    sid = sector["sector"]["id"]
    mid = client.post(f"/api/sectors/{sid}/models/import", headers=admin,
                      files={"file": ("caja.glb", _glb_box(tmp_path).read_bytes(), "model/gltf-binary")},
                      data={"label": "c"}).json()["id"]
    scaled = list(np.diag([2, 2, 2, 1.0]).reshape(-1))
    assert client.patch(f"/api/models/{mid}", headers=admin, json={"alignment": scaled}).status_code == 422
    rot = np.eye(4)
    rot[:3, :3] = [[0, 0, 1], [0, 1, 0], [-1, 0, 0]]
    assert client.patch(f"/api/models/{mid}", headers=admin, json={"alignment": list(rot.reshape(-1))}).status_code == 200


def test_import_rejects_invalid_glb(client, admin, sector):
    sid = sector["sector"]["id"]
    r = client.post(f"/api/sectors/{sid}/models/import", headers=admin,
                    files={"file": ("x.glb", io.BytesIO(b"no soy glb" * 10), "model/gltf-binary")}, data={"label": "x"})
    assert r.status_code == 422


def test_annotations_and_reviewed_transfer(client, admin, sector, tmp_path):
    sid = sector["sector"]["id"]
    up = lambda: client.post(f"/api/sectors/{sid}/models/import", headers=admin,
                             files={"file": ("c.glb", _glb_box(tmp_path).read_bytes(), "model/gltf-binary")},
                             data={"label": "c"}).json()["id"]
    m1, m2 = up(), up()
    asset = client.post(f"/api/sectors/{sid}/assets", headers=admin, json={"name": "Bomba", "tag": "P-101"}).json()
    assert client.post(f"/api/sectors/{sid}/assets", headers=admin,
                       json={"name": "x", "op_status": "Detenida"}).status_code == 422  # estado sin origen
    a = client.post(f"/api/models/{m1}/annotations", headers=admin,
                    json={"title": "Bomba", "position": [1, 2, 3], "asset_id": asset["id"]}).json()
    assert client.get(f"/api/models/{m2}/annotations", headers=admin).json() == []  # no se trasladan solos
    T = np.eye(4)
    T[:3, 3] = [10, 0, 0]
    r = client.post("/api/annotations/transfer", headers=admin, json={
        "from_model_id": m1, "to_model_id": m2, "annotation_ids": [a["id"]], "transform": list(T.reshape(-1)),
        "review_note": "Revisado con 3 puntos homólogos"}).json()
    assert r[0]["position"] == [11, 2, 3] and r[0]["extra"]["transferred"]["review_note"].startswith("Revisado")
