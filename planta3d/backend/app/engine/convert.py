"""Conversión explícita de malla texturizada (PLY con UV por cara/esquina + atlas) a GLB, y verificación.

Por qué un conversor propio: un importador PLY genérico suele descartar la propiedad de lista
`texcoord` por cara. Aquí:
- Cada esquina de cada cara conserva su UV; los vértices se duplican solo donde la UV difiere
  (costuras del atlas), deduplicando pares (vértice, u, v) idénticos.
- Las coordenadas de posición se escriben sin modificar (sistema del motor). La orientación/escala
  se guardan aparte en la base de datos y el visor las aplica.
- Las texturas se embeben en el GLB (sin URIs externas).
- glTF define el origen UV arriba-izquierda. `flip_v=True` convierte desde convención abajo-izquierda.
  La convención correcta se VERIFICA con fotos reales en el informe (`texture_orientation_check`).
"""
from __future__ import annotations

import io
import json
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image
from .ply import PlyError, read_ply

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942


class ConversionError(Exception):
    pass


@dataclass
class TexturedMesh:
    positions: np.ndarray  # (V,3) float32
    faces: np.ndarray  # (F,3) int64
    face_uvs: np.ndarray | None  # (F,3,2) float32
    face_tex: np.ndarray | None  # (F,) int — índice de textura
    textures: list[Path]


def read_textured_ply(path: Path) -> TexturedMesh:
    try:
        h, data = read_ply(path)
    except PlyError as e:
        raise ConversionError(f"PLY inválido: {e}")
    textures = [path.parent / c.split(" ", 1)[1].strip() for c in h.comments if c.startswith("TextureFile ")]
    v = data.get("vertex")
    f = data.get("face")
    if v is None or f is None:
        raise ConversionError("El PLY no contiene vértices y caras")
    positions = np.stack([v["x"], v["y"], v["z"]], axis=1).astype(np.float32)
    idx_name = "vertex_indices" if "vertex_indices" in f else "vertex_index"
    faces = np.asarray(f[idx_name])
    if faces.ndim != 2 or (len(faces) and faces.shape[1] != 3):
        raise ConversionError("La malla contiene caras no triangulares; se esperaba triangulación del motor")
    faces = faces.astype(np.int64).reshape(-1, 3)
    face_uvs = face_tex = None
    if "texcoord" in f:
        tc = np.asarray(f["texcoord"])
        if tc.ndim != 2 or tc.shape[1] != 6:
            raise ConversionError("texcoord por cara debe tener 6 valores (3 esquinas × UV)")
        face_uvs = tc.astype(np.float32).reshape(-1, 3, 2)
        face_tex = (np.asarray(f["texnumber"]).astype(np.int64) if "texnumber" in f
                    else np.zeros(len(faces), np.int64))
    if faces.size and (faces.min() < 0 or faces.max() >= len(positions)):
        raise ConversionError("Índices de cara fuera de rango")
    return TexturedMesh(positions, faces, face_uvs, face_tex, textures)


def _pad4(b: bytes, pad: bytes = b"\x00") -> bytes:
    return b + pad * ((4 - len(b) % 4) % 4)


def _encode_texture(path: Path, max_side: int | None) -> tuple[bytes, str, tuple[int, int]]:
    img = Image.open(path)
    img.load()
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")
    if max_side and max(img.size) > max_side:
        s = max_side / max(img.size)
        img = img.resize((round(img.width * s), round(img.height * s)), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    if img.mode == "RGBA":
        img.save(buf, "PNG", optimize=True)
        return buf.getvalue(), "image/png", img.size
    img.save(buf, "JPEG", quality=90)
    return buf.getvalue(), "image/jpeg", img.size


def mesh_to_glb(mesh: TexturedMesh, out: Path, flip_v: bool, texture_max_side: int | None = 8192,
                generator: str = "Planta 3D convert") -> dict:
    """Escribe un GLB con un primitivo por textura. Devuelve estadísticas."""
    if len(mesh.faces) == 0:
        raise ConversionError("La malla no tiene caras")
    bin_parts: list[bytes] = []
    offset = 0
    buffer_views, accessors, meshes_prims, materials, images, textures, samplers = [], [], [], [], [], [], []

    def add_view(data: bytes, target: int | None = None) -> int:
        nonlocal offset
        data = _pad4(data)
        bv = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target:
            bv["target"] = target
        buffer_views.append(bv)
        bin_parts.append(data)
        offset += len(data)
        return len(buffer_views) - 1

    stats = {"triangles": 0, "vertices": 0, "materials": 0, "textures": []}
    groups = [None] if mesh.face_uvs is None else sorted(set(mesh.face_tex.tolist()))
    tex_index_map: dict[int, int] = {}
    if mesh.face_uvs is not None:
        samplers.append({"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071})
        for g in groups:
            if g >= len(mesh.textures) or not mesh.textures[g].exists():
                raise ConversionError(f"Falta la textura {g} referida por la malla")
            data, mime, size = _encode_texture(mesh.textures[g], texture_max_side)
            images.append({"bufferView": add_view(data), "mimeType": mime})
            textures.append({"source": len(images) - 1, "sampler": 0})
            tex_index_map[g] = len(textures) - 1
            stats["textures"].append({"index": g, "size": list(size), "mime": mime, "bytes": len(data)})

    for g in groups:
        if g is None:
            sel = np.arange(len(mesh.faces))
            pos = mesh.positions
            idx = mesh.faces.reshape(-1).astype(np.uint32)
            uv = None
        else:
            sel = np.nonzero(mesh.face_tex == g)[0]
            corners_v = mesh.faces[sel].reshape(-1)
            corners_uv = mesh.face_uvs[sel].reshape(-1, 2).copy()
            if flip_v:
                corners_uv[:, 1] = 1.0 - corners_uv[:, 1]
            # Deduplicar (vértice, u, v) exactos: preserva costuras del atlas.
            key = np.empty(len(corners_v), dtype=[("v", np.int64), ("u", np.float32), ("w", np.float32)])
            key["v"], key["u"], key["w"] = corners_v, corners_uv[:, 0], corners_uv[:, 1]
            uniq, inverse = np.unique(key, return_inverse=True)
            pos = mesh.positions[uniq["v"]]
            uv = np.stack([uniq["u"], uniq["w"]], axis=1).astype(np.float32)
            idx = inverse.astype(np.uint32).reshape(-1)
        pos = np.ascontiguousarray(pos, dtype=np.float32)
        acc_pos = len(accessors)
        accessors.append({"bufferView": add_view(pos.tobytes(), 34962), "componentType": 5126, "count": len(pos),
                          "type": "VEC3", "min": pos.min(0).tolist(), "max": pos.max(0).tolist()})
        attrs = {"POSITION": acc_pos}
        if uv is not None:
            if not np.all(np.isfinite(uv)):
                raise ConversionError("UV no finitas en la malla")
            attrs["TEXCOORD_0"] = len(accessors)
            accessors.append({"bufferView": add_view(np.ascontiguousarray(uv).tobytes(), 34962),
                              "componentType": 5126, "count": len(uv), "type": "VEC2"})
        acc_idx = len(accessors)
        accessors.append({"bufferView": add_view(idx.tobytes(), 34963), "componentType": 5125, "count": len(idx),
                          "type": "SCALAR", "min": [int(idx.min())], "max": [int(idx.max())]})
        mat = {"name": f"material_{g if g is not None else 'sin_textura'}", "doubleSided": True,
               "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 1.0},
               "extensions": {"KHR_materials_unlit": {}}}
        if g is not None:
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": tex_index_map[g]}
        else:
            mat["pbrMetallicRoughness"]["baseColorFactor"] = [0.75, 0.75, 0.75, 1.0]
        materials.append(mat)
        meshes_prims.append({"attributes": attrs, "indices": acc_idx, "material": len(materials) - 1, "mode": 4})
        stats["triangles"] += len(sel)
        stats["vertices"] += len(pos)
    stats["materials"] = len(materials)

    gltf = {
        "asset": {"version": "2.0", "generator": generator},
        "extensionsUsed": ["KHR_materials_unlit"],
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "modelo"}],  # sin transformación: coordenadas del motor
        "meshes": [{"primitives": meshes_prims, "name": "reconstruccion"}],
        "materials": materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": offset}],
    }
    if images:
        gltf.update(images=images, textures=textures, samplers=samplers)
    write_glb(gltf, b"".join(bin_parts), out)
    stats["bytes"] = out.stat().st_size
    stats["flip_v"] = flip_v
    return stats


def write_glb(gltf: dict, bin_data: bytes, out: Path) -> None:
    js = _pad4(json.dumps(gltf, separators=(",", ":")).encode(), b" ")
    bin_data = _pad4(bin_data)
    total = 12 + 8 + len(js) + 8 + len(bin_data)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        f.write(struct.pack("<III", GLB_MAGIC, 2, total))
        f.write(struct.pack("<II", len(js), CHUNK_JSON))
        f.write(js)
        f.write(struct.pack("<II", len(bin_data), CHUNK_BIN))
        f.write(bin_data)


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    if len(data) < 20:
        raise ConversionError("Archivo demasiado corto para GLB")
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise ConversionError("No es un archivo GLB (firma glTF ausente)")
    if version != 2:
        raise ConversionError(f"Versión glTF {version} no admitida (se requiere 2.0)")
    if length != len(data):
        raise ConversionError("Longitud declarada del GLB no coincide con el archivo")
    pos = 12
    gltf, bin_data = None, b""
    while pos < length:
        clen, ctype = struct.unpack_from("<II", data, pos)
        pos += 8
        chunk = data[pos:pos + clen]
        if len(chunk) != clen:
            raise ConversionError("Fragmento GLB truncado")
        if ctype == CHUNK_JSON:
            gltf = json.loads(chunk.decode("utf-8"))
        elif ctype == CHUNK_BIN:
            bin_data = chunk
        pos += clen
    if gltf is None:
        raise ConversionError("GLB sin fragmento JSON")
    return gltf, bin_data


COMPONENT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def _accessor_array(gltf: dict, bin_data: bytes, i: int) -> np.ndarray:
    a = gltf["accessors"][i]
    bv = gltf["bufferViews"][a["bufferView"]]
    if bv.get("buffer", 0) != 0:
        raise ConversionError("Solo se admite un búfer embebido")
    dt = np.dtype(COMPONENT[a["componentType"]])
    n = NCOMP[a["type"]]
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride")
    if stride and stride != dt.itemsize * n:
        raise ConversionError("byteStride intercalado no admitido por el verificador")
    end = start + a["count"] * n * dt.itemsize
    if end > bv.get("byteOffset", 0) + bv["byteLength"] or end > len(bin_data):
        raise ConversionError(f"Accesor {i} fuera de su bufferView")
    return np.frombuffer(bin_data, dtype=dt, count=a["count"] * n, offset=start).reshape(a["count"], n)


def verify_glb(path: Path, require_texture: bool = False) -> dict:
    """Verificación estructural: chunks, accesores dentro de rango, índices válidos, UV finitas,
    texturas embebidas decodificables y ausencia de URIs externas. Devuelve estadísticas."""
    gltf, bin_data = read_glb(path)
    if gltf.get("asset", {}).get("version") != "2.0":
        raise ConversionError("asset.version debe ser 2.0")
    for b in gltf.get("buffers", []):
        if "uri" in b:
            raise ConversionError("El GLB referencia un búfer externo")
    for im in gltf.get("images", []):
        if "uri" in im:
            raise ConversionError("El GLB referencia una imagen externa")
    for ext in gltf.get("extensionsRequired", []):
        if ext not in ("KHR_materials_unlit", "KHR_texture_transform", "KHR_mesh_quantization"):
            raise ConversionError(f"Extensión requerida no soportada por el visor: {ext} "
                                  "(si es compresión Draco/Meshopt/KTX2, configura el decodificador)")
    tris = verts = 0
    has_uv = False
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    for m in gltf.get("meshes", []):
        for p in m["primitives"]:
            if "POSITION" not in p["attributes"]:
                raise ConversionError("Primitivo sin POSITION")
            P = _accessor_array(gltf, bin_data, p["attributes"]["POSITION"]).astype(np.float64)
            if not np.all(np.isfinite(P)):
                raise ConversionError("Posiciones no finitas")
            if len(P):
                lo = np.minimum(lo, P.min(0))
                hi = np.maximum(hi, P.max(0))
            verts += len(P)
            if "TEXCOORD_0" in p["attributes"]:
                UV = _accessor_array(gltf, bin_data, p["attributes"]["TEXCOORD_0"])
                if len(UV) != len(P) or not np.all(np.isfinite(UV)):
                    raise ConversionError("TEXCOORD_0 inconsistente")
                has_uv = True
            if "indices" in p:
                I = _accessor_array(gltf, bin_data, p["indices"]).reshape(-1)
                if len(I) and int(I.max()) >= len(P):
                    raise ConversionError("Índice fuera de rango")
                tris += len(I) // 3 if p.get("mode", 4) == 4 else 0
            elif p.get("mode", 4) == 4:
                tris += len(P) // 3
    images = []
    for im in gltf.get("images", []):
        bv = gltf["bufferViews"][im["bufferView"]]
        raw = bin_data[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
        try:
            with Image.open(io.BytesIO(raw)) as img:
                img.load()
                images.append({"size": list(img.size), "mime": im.get("mimeType")})
        except Exception as e:  # noqa: BLE001
            raise ConversionError(f"Textura embebida no decodificable: {e}")
    if require_texture and (not has_uv or not images):
        raise ConversionError("Se esperaba un modelo texturizado (UV + imagen) y no se encontró")
    return {"triangles": int(tris), "vertices": int(verts), "has_uv": has_uv, "images": images,
            "materials": len(gltf.get("materials", [])),
            "bbox_min": lo.tolist() if verts else None, "bbox_max": hi.tolist() if verts else None,
            "bytes": path.stat().st_size, "extensions_used": gltf.get("extensionsUsed", [])}


def sample_texture(img: np.ndarray, uv: np.ndarray, gltf_convention: bool) -> np.ndarray:
    """Muestrea colores del atlas. `gltf_convention`: v=0 arriba. Si False: v=0 abajo."""
    h, w = img.shape[:2]
    u = np.clip(uv[:, 0], 0, 1) * (w - 1)
    v = np.clip(uv[:, 1], 0, 1)
    v = (v if gltf_convention else 1.0 - v) * (h - 1)
    return img[np.round(v).astype(int), np.round(u).astype(int)].astype(np.float32)


def export_with_root_transform(src: Path, dst: Path, matrix_rowmajor: list[float], markers: list[dict],
                               note: str) -> dict:
    """Derivado de exportación: envuelve la escena en un nodo raíz con la matriz indicada (escala ·
    orientación) y agrega los marcadores como nodos hijos en coordenadas del modelo. El contenido
    geométrico no se toca; cualquier lector glTF conforme aplica la transformación."""
    gltf, bin_data = read_glb(src)
    M = np.asarray(matrix_rowmajor, dtype=np.float64).reshape(4, 4)
    nodes = gltf.setdefault("nodes", [])
    scene_idx = gltf.get("scene", 0)
    scene = gltf["scenes"][scene_idx]
    children = list(scene.get("nodes", []))
    for mk in markers:
        nodes.append({"name": mk["name"], "translation": [float(x) for x in mk["position"]],
                      "extras": mk.get("extras", {})})
        children.append(len(nodes) - 1)
    nodes.append({"name": "planta3d_raiz", "children": children,
                  "matrix": M.T.reshape(-1).tolist(),  # glTF usa orden columna-mayor
                  "extras": {"planta3d": note}})
    scene["nodes"] = [len(nodes) - 1]
    gltf.setdefault("asset", {})["extras"] = {"planta3d_export": note}
    write_glb(gltf, bin_data, dst)
    return verify_glb(dst)
