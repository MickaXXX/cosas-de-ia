"""Verificación de orientación de textura con fotografías reales.

Para una muestra de caras texturizadas se compara el color del atlas (en el centroide UV) con el color
de la foto donde esa cara se ve de la forma más frontal (proyección con las cámaras sin distorsión de
COLMAP). Se evalúan ambas convenciones de V; la correcta produce una diferencia claramente menor.
No hay prueba de oclusión, por eso se usa la mediana sobre muchas caras.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

from .convert import TexturedMesh, sample_texture


def _load(path: Path, max_side: int = 2048) -> tuple[np.ndarray, float]:
    img = Image.open(path).convert("RGB")
    s = 1.0
    if max(img.size) > max_side:
        s = max_side / max(img.size)
        img = img.resize((round(img.width * s), round(img.height * s)), Image.Resampling.BILINEAR)
    return np.asarray(img), s


def face_geometry(mesh: TexturedMesh, sel: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    tri = mesh.positions[mesh.faces[sel]].astype(np.float64)
    c = tri.mean(1)
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    area = np.linalg.norm(n, axis=1) / 2
    n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    return c, n, area


def empty_color_area_fraction(mesh: TexturedMesh, atlases: list[np.ndarray], empty_rgb=(255, 127, 39),
                              flip_v: bool = True, tol: float = 12.0) -> float | None:
    """Fracción del área de la malla cuyas caras recibieron el color de relleno de TextureMesh
    (caras que ninguna foto seleccionada observa)."""
    if mesh.face_uvs is None:
        return None
    _, _, area = face_geometry(mesh, np.arange(len(mesh.faces)))
    uvc = mesh.face_uvs.mean(1)
    empty = np.zeros(len(mesh.faces), bool)
    for t, atlas in enumerate(atlases):
        m = mesh.face_tex == t
        col = sample_texture(atlas, uvc[m], gltf_convention=not flip_v) if flip_v else \
            sample_texture(atlas, uvc[m], gltf_convention=True)
        empty[np.nonzero(m)[0]] = np.abs(col - np.array(empty_rgb, np.float32)).max(1) < tol
    total = float(area.sum())
    return float(area[empty].sum() / total) if total > 0 else None


def check_texture_orientation(mesh: TexturedMesh, recon_dir: Path, images_dir: Path,
                              n_samples: int = 3000, seed: int = 0) -> dict:
    from .colmap_import import pycolmap as _load_pycolmap
    pycolmap = _load_pycolmap()

    rec = pycolmap.Reconstruction(recon_dir)
    if mesh.face_uvs is None:
        return {"status": "sin_textura"}
    atlases = [_load(p, 4096)[0] for p in mesh.textures]
    rng = np.random.default_rng(seed)
    sel = rng.choice(len(mesh.faces), size=min(n_samples, len(mesh.faces)), replace=False)
    c, n, _ = face_geometry(mesh, sel)

    images = [im for im in rec.images.values() if im.has_pose]
    centers = np.array([im.projection_center() for im in images])
    best_cos = np.full(len(sel), 0.0)
    best_img = np.full(len(sel), -1)
    best_xy = np.zeros((len(sel), 2))
    for k, im in enumerate(images):
        cam = im.camera
        Xc = _transform(im, c)
        front = Xc[:, 2] > 1e-6
        xy = np.full((len(sel), 2), -1.0)
        xy[front] = cam.img_from_cam(Xc[front])
        inside = front & (xy[:, 0] >= 0) & (xy[:, 1] >= 0) & (xy[:, 0] < cam.width) & (xy[:, 1] < cam.height)
        view = centers[k] - c
        view /= np.maximum(np.linalg.norm(view, axis=1, keepdims=True), 1e-12)
        cos = np.abs((view * n).sum(1))
        better = inside & (cos > best_cos)
        best_cos[better] = cos[better]
        best_img[better] = k
        best_xy[better] = xy[better]
    ok = best_img >= 0
    if ok.sum() < 50:
        return {"status": "muestra_insuficiente", "samples": int(ok.sum())}
    photo_col = np.zeros((len(sel), 3), np.float32)
    for k in np.unique(best_img[ok]):
        m = best_img == k
        img, s = _load(images_dir / images[k].name)
        px = np.clip(np.round(best_xy[m] * s).astype(int), 0, [img.shape[1] - 1, img.shape[0] - 1])
        photo_col[m] = img[px[:, 1], px[:, 0]]
    uvc = mesh.face_uvs[sel].mean(1)
    tex_top = np.zeros_like(photo_col)
    tex_bottom = np.zeros_like(photo_col)
    for t, atlas in enumerate(atlases):
        m = mesh.face_tex[sel] == t
        tex_top[m] = sample_texture(atlas, uvc[m], gltf_convention=True)
        tex_bottom[m] = sample_texture(atlas, uvc[m], gltf_convention=False)
    d_top = float(np.median(np.abs(tex_top[ok] - photo_col[ok]).mean(1)))
    d_bottom = float(np.median(np.abs(tex_bottom[ok] - photo_col[ok]).mean(1)))
    # flip_v=True significa que el PLY usa origen abajo-izquierda y hay que invertir V para glTF.
    flip_v = d_bottom < d_top
    ratio = max(d_top, d_bottom) / max(min(d_top, d_bottom), 1e-6)
    return {
        "status": "concluyente" if ratio > 1.5 else "no_concluyente",
        "samples": int(ok.sum()),
        "median_abs_diff_v_origin_top": d_top,
        "median_abs_diff_v_origin_bottom": d_bottom,
        "flip_v": bool(flip_v),
        "ratio": ratio,
        "method": "color atlas (centroide UV) vs. foto más frontal (proyección COLMAP sin distorsión), mediana",
    }


def _transform(im, pts: np.ndarray) -> np.ndarray:
    T = im.cam_from_world().matrix()  # 3x4
    return pts @ T[:, :3].T + T[:, 3]
