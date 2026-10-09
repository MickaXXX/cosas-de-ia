"""Validación y preparación de fotografías.

- El formato se determina por el contenido (firma + decodificación completa), no por la extensión.
- El original se conserva inmutable. La copia de trabajo se orienta UNA sola vez (EXIF) y se guarda sin
  EXIF, de modo que ninguna etapa posterior pueda volver a rotarla.
- No se guarda ubicación GPS: solo se registra si la foto la traía.
- Las métricas de nitidez y exposición son indicadores, no una prueba de calidad.
"""
from __future__ import annotations

import hashlib
import math
import warnings
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import ExifTags, Image, ImageOps

from ..config import get_settings

Image.MAX_IMAGE_PIXELS = None  # se controla explícitamente con max_photo_megapixels

WORK_MAX_SIDE = 6000  # tope de la copia de trabajo «completa»; los perfiles reducen después
THUMB_SIDE = 384
QUALITY_SIDE = 1024


class PhotoRejected(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


UNSUPPORTED_HELP = {
    "heic": "Formato HEIC/HEIF (iPhone). La primera versión acepta JPEG/PNG: en el iPhone, Ajustes › Cámara › "
    "Formatos › «Más compatible», o exporta como JPEG sin compresión de mensajería.",
    "avif": "Formato AVIF no admitido aún. Exporta como JPEG.",
    "raw": "Archivo RAW/DNG. La conversión RAW requiere un revelado explícito que aún no está implementado; "
    "exporta JPEG de máxima calidad conservando el RAW como respaldo.",
    "video": "Vídeo detectado. La extracción de cuadros no forma parte de esta versión: fotografía el recorrido "
    "deteniéndote en cada toma.",
    "archive": "Archivo comprimido. Por seguridad no se descomprimen archivos subidos; sube las fotos sueltas.",
    "pano": "Panorámica 360 detectada (proyección equirectangular). No se procesa en esta versión.",
}


def sniff(head: bytes) -> str:
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(head) >= 12 and head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1", b"heim", b"heis"):
            return "heic"
        if brand in (b"avif", b"avis"):
            return "avif"
        if brand in (b"crx ",):
            return "raw"
        return "video"
    if head.startswith(b"RIFF") and head[8:12] in (b"AVI ", b"WEBP"):
        return "video" if head[8:12] == b"AVI " else "webp"
    if head.startswith((b"II*\x00", b"MM\x00*")):
        return "raw"  # TIFF / DNG / CR2 / NEF / ARW comparten cabecera TIFF
    if head.startswith((b"PK\x03\x04", b"7z\xbc\xaf", b"Rar!", b"\x1f\x8b", b"BZh")):
        return "archive"
    if head[:4] == b"\x1aE\xdf\xa3":
        return "video"  # matroska/webm
    return "unknown"


@dataclass
class PreparedPhoto:
    mime: str
    width: int
    height: int
    exif_orientation: int | None
    camera: dict
    camera_group: str
    quality: dict
    flags: list[str] = field(default_factory=list)
    working_width: int = 0
    working_height: int = 0
    working_scale: float = 1.0


def _exif_info(img: Image.Image) -> tuple[int | None, dict]:
    try:
        exif = img.getexif()
    except Exception:
        return None, {}
    base = {ExifTags.TAGS.get(k, k): v for k, v in exif.items()}
    try:
        sub = {ExifTags.TAGS.get(k, k): v for k, v in exif.get_ifd(ExifTags.IFD.Exif).items()}
    except Exception:
        sub = {}
    has_gps = False
    try:
        has_gps = bool(exif.get_ifd(ExifTags.IFD.GPSInfo))
    except Exception:
        pass

    def num(v):
        try:
            return float(v)
        except Exception:
            return None

    def txt(v):
        return str(v).strip("\x00 ").strip() if v is not None else None

    cam = {
        "make": txt(base.get("Make")),
        "model": txt(base.get("Model")),
        "lens": txt(sub.get("LensModel")),
        "focal_mm": num(sub.get("FocalLength")),
        "focal_35mm": num(sub.get("FocalLengthIn35mmFilm")),
        "datetime_original": txt(sub.get("DateTimeOriginal")),
        "has_gps": has_gps,  # solo indicador; las coordenadas no se almacenan
    }
    orient = base.get("Orientation")
    return (int(orient) if orient else None), cam


def quality_metrics(gray: np.ndarray) -> dict:
    """Varianza del laplaciano (nitidez) y fracciones de píxeles oscuros/saturados."""
    g = gray.astype(np.float32)
    lap = -4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    return {
        "sharpness": float(lap.var()),
        "mean_luma": float(g.mean()),
        "dark_fraction": float((gray < 16).mean()),
        "bright_fraction": float((gray > 245).mean()),
        "method": f"laplaciano 4-vecinos sobre luminancia a {QUALITY_SIDE}px",
    }


def absolute_flags(q: dict) -> list[str]:
    s = get_settings()
    flags = []
    if q["sharpness"] < s.blur_absolute_threshold:
        flags.append("posible_desenfoque")
    if q["dark_fraction"] > s.dark_fraction_threshold:
        flags.append("posible_subexposicion")
    if q["bright_fraction"] > s.bright_fraction_threshold:
        flags.append("posible_sobreexposicion")
    return flags


def camera_group_key(cam: dict, w: int, h: int) -> str:
    parts = [cam.get("make") or "?", cam.get("model") or "?", cam.get("lens") or "?",
             f"{cam.get('focal_mm') or '?'}", f"{w}x{h}"]
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:16]


def focal_prior_px(cam: dict, w: int, h: int) -> tuple[float | None, str]:
    """Estimación inicial de focal en píxeles para la orientación dada. Devuelve (valor, origen)."""
    f35 = cam.get("focal_35mm")
    if f35 and f35 > 0:
        return f35 * math.hypot(w, h) / math.hypot(36.0, 24.0), "EXIF FocalLengthIn35mmFilm (diagonal)"
    return None, "sin datos EXIF de focal: se usará el valor por defecto del motor (1,2 × lado mayor) y se refinará"


def prepare_photo(src: Path, working_dst: Path, thumb_dst: Path) -> PreparedPhoto:
    s = get_settings()
    with open(src, "rb") as f:
        head = f.read(32)
    kind = sniff(head)
    if kind in UNSUPPORTED_HELP:
        raise PhotoRejected(f"formato_{kind}", UNSUPPORTED_HELP[kind])
    if kind not in ("jpeg", "png"):
        raise PhotoRejected("formato_desconocido", "El contenido no es una imagen JPEG o PNG válida.")

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(src) as probe:
                probe.verify()
            img = Image.open(src)
            img.load()  # decodificación completa: detecta archivos truncados
    except PhotoRejected:
        raise
    except Exception as e:  # noqa: BLE001
        raise PhotoRejected("ilegible", f"La imagen no se pudo decodificar completa ({type(e).__name__}).")

    if img.format not in ("JPEG", "PNG"):
        raise PhotoRejected("formato_desconocido", f"Formato {img.format} no admitido.")
    w0, h0 = img.size
    if w0 * h0 / 1e6 > s.max_photo_megapixels:
        raise PhotoRejected("demasiado_grande", f"{w0}×{h0} supera {s.max_photo_megapixels} MP.")
    if min(w0, h0) < s.min_photo_side_px:
        raise PhotoRejected("resolucion_baja", f"{w0}×{h0}: el lado menor debe ser ≥ {s.min_photo_side_px} px.")
    if abs(w0 / h0 - 2.0) < 0.01 and w0 >= 4000:
        raise PhotoRejected("formato_pano", UNSUPPORTED_HELP["pano"])

    orientation, cam = _exif_info(img)
    oriented = ImageOps.exif_transpose(img)  # aplica la orientación EXIF exactamente una vez
    if oriented.mode not in ("RGB", "L"):
        oriented = oriented.convert("RGB")
    elif oriented.mode == "L":
        oriented = oriented.convert("RGB")
    w, h = oriented.size

    scale = 1.0
    work = oriented
    if max(w, h) > WORK_MAX_SIDE:
        scale = WORK_MAX_SIDE / max(w, h)
        work = oriented.resize((round(w * scale), round(h * scale)), Image.Resampling.LANCZOS)
    working_dst.parent.mkdir(parents=True, exist_ok=True)
    work.save(working_dst, "JPEG", quality=95, subsampling=0)  # sin EXIF: orientación ya aplicada

    thumb = oriented.copy()
    thumb.thumbnail((THUMB_SIDE, THUMB_SIDE), Image.Resampling.BILINEAR)
    thumb_dst.parent.mkdir(parents=True, exist_ok=True)
    thumb.save(thumb_dst, "JPEG", quality=80)

    qimg = oriented.convert("L")
    qimg.thumbnail((QUALITY_SIDE, QUALITY_SIDE), Image.Resampling.BILINEAR)
    q = quality_metrics(np.asarray(qimg))

    fpx, fsrc = focal_prior_px(cam, w, h)
    cam["focal_prior_px_oriented"] = fpx
    cam["focal_prior_source"] = fsrc
    return PreparedPhoto(
        mime="image/jpeg" if img.format == "JPEG" else "image/png",
        width=w,
        height=h,
        exif_orientation=orientation,
        camera=cam,
        camera_group=camera_group_key(cam, w, h),
        quality=q,
        flags=absolute_flags(q),
        working_width=work.size[0],
        working_height=work.size[1],
        working_scale=scale,
    )


def relative_blur_flags(sharpness_by_id: dict, threshold: float | None = None) -> set:
    """IDs cuya nitidez es baja en relación con la mediana del lote/sector."""
    if len(sharpness_by_id) < 5:
        return set()
    thr = threshold if threshold is not None else get_settings().blur_relative_threshold
    med = float(np.median(list(sharpness_by_id.values())))
    return {pid for pid, v in sharpness_by_id.items() if v < thr * med}
