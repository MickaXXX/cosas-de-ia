"""Conversión UV/textura y coordenadas con un ejemplo controlado (prueba de aceptación 4)."""
import json
import struct

import numpy as np
import pytest
from PIL import Image

from app.engine.ply import write_ply
from app.engine.convert import (
    ConversionError,
    _accessor_array,
    read_glb,
    read_textured_ply,
    mesh_to_glb,
    sample_texture,
    verify_glb,
    write_glb,
)

COLORS = {"abajo_izq": (255, 0, 0), "abajo_der": (0, 255, 0), "arriba_izq": (0, 0, 255), "arriba_der": (255, 255, 0)}


def _atlas(path):
    # Atlas 64×64 en cuadrantes. Convención de la malla de prueba: origen UV ABAJO-izquierda (como OpenMVS).
    a = np.zeros((64, 64, 3), np.uint8)
    a[32:, :32] = COLORS["abajo_izq"]
    a[32:, 32:] = COLORS["abajo_der"]
    a[:32, :32] = COLORS["arriba_izq"]
    a[:32, 32:] = COLORS["arriba_der"]
    Image.fromarray(a).save(path)


def _ply(tmp):
    _atlas(tmp / "tex0.png")
    V = np.array([(0, 0, 0), (2, 0, 0), (2, 3, 0), (0, 3, 0), (5, -1, 7)], np.float32)
    verts = np.zeros(len(V), dtype=[("x", "f4"), ("y", "f4"), ("z", "f4")])
    verts["x"], verts["y"], verts["z"] = V[:, 0], V[:, 1], V[:, 2]
    # Cada cara se mapea entera a un cuadrante (UV en convención abajo-izquierda).
    q = {"abajo_izq": (0.25, 0.25), "abajo_der": (0.75, 0.25), "arriba_izq": (0.25, 0.75), "arriba_der": (0.75, 0.75)}
    faces_def = [((0, 1, 2), "abajo_izq"), ((0, 2, 3), "arriba_der"), ((1, 4, 2), "abajo_der"), ((3, 2, 4), "arriba_izq")]
    F = np.array([f for f, _ in faces_def])
    UV = np.array([[q[k][0] - .1, q[k][1] - .1, q[k][0] + .1, q[k][1] - .1, q[k][0], q[k][1] + .1] for _, k in faces_def])
    write_ply(tmp / "m.ply", V, F, UV, comments=["TextureFile tex0.png"])
    return tmp / "m.ply", faces_def, verts


def test_uv_texture_and_coordinates_preserved(tmp_path):
    path, faces_def, verts = _ply(tmp_path)
    mesh = read_textured_ply(path)
    out = tmp_path / "m.glb"
    stats = mesh_to_glb(mesh, out, flip_v=True)
    info = verify_glb(out, require_texture=True)
    assert info["triangles"] == 4 and info["has_uv"] and stats["flip_v"]
    gltf, bin_data = read_glb(out)
    prim = gltf["meshes"][0]["primitives"][0]
    P = _accessor_array(gltf, bin_data, prim["attributes"]["POSITION"])
    UV = _accessor_array(gltf, bin_data, prim["attributes"]["TEXCOORD_0"])
    I = _accessor_array(gltf, bin_data, prim["indices"]).reshape(-1, 3)
    # Posiciones sin transformar y nodo sin matriz: una sola conversión de convenciones.
    assert "matrix" not in gltf["nodes"][0] and "rotation" not in gltf["nodes"][0]
    orig = np.stack([verts["x"], verts["y"], verts["z"]], 1)
    from PIL import Image as PI
    import io

    bv = gltf["bufferViews"][gltf["images"][0]["bufferView"]]
    atlas = np.asarray(PI.open(io.BytesIO(bin_data[bv["byteOffset"]: bv["byteOffset"] + bv["byteLength"]])).convert("RGB"))
    for f, (idx, quad) in enumerate(faces_def):
        assert np.allclose(P[I[f]], orig[list(idx)])  # cada esquina conserva su vértice
        col = sample_texture(atlas, UV[I[f]].mean(0, keepdims=True), gltf_convention=True)[0]
        assert np.abs(col - COLORS[quad]).max() < 40, (quad, col)  # color correcto en convención glTF


def test_wrong_convention_would_be_detected(tmp_path):
    path, faces_def, _ = _ply(tmp_path)
    out = tmp_path / "x.glb"
    mesh_to_glb(read_textured_ply(path), out, flip_v=False)
    gltf, bin_data = read_glb(out)
    prim = gltf["meshes"][0]["primitives"][0]
    UV = _accessor_array(gltf, bin_data, prim["attributes"]["TEXCOORD_0"])
    I = _accessor_array(gltf, bin_data, prim["indices"]).reshape(-1, 3)
    atlas = np.asarray(Image.open(tmp_path / "tex0.png").convert("RGB"))
    col = sample_texture(atlas, UV[I[0]].mean(0, keepdims=True), gltf_convention=True)[0]
    assert np.abs(col - COLORS["abajo_izq"]).max() > 100  # sin invertir V el color sería otro


def test_verify_rejects_external_and_bad_indices(tmp_path):
    gltf = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": 0, "uri": "externo.bin"}]}
    write_glb(gltf, b"", tmp_path / "e.glb")
    with pytest.raises(ConversionError):
        verify_glb(tmp_path / "e.glb")
    pos = np.zeros((3, 3), np.float32).tobytes()
    idx = np.array([0, 1, 7], np.uint32).tobytes()
    gltf = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": len(pos) + len(idx)}],
            "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(pos)},
                            {"buffer": 0, "byteOffset": len(pos), "byteLength": len(idx)}],
            "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"},
                          {"bufferView": 1, "componentType": 5125, "count": 3, "type": "SCALAR"}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}]}
    write_glb(gltf, pos + idx, tmp_path / "b.glb")
    with pytest.raises(ConversionError, match="fuera de rango"):
        verify_glb(tmp_path / "b.glb")
    (tmp_path / "t.glb").write_bytes(struct.pack("<III", 0x46546C67, 2, 999) + b"x" * 20)
    with pytest.raises(ConversionError):
        verify_glb(tmp_path / "t.glb")


def test_draco_required_is_explained(tmp_path):
    gltf = {"asset": {"version": "2.0"}, "extensionsRequired": ["KHR_draco_mesh_compression"]}
    write_glb(gltf, b"", tmp_path / "d.glb")
    with pytest.raises(ConversionError, match="decodificador"):
        verify_glb(tmp_path / "d.glb")
