import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import BatchStatus, CaptureBatch, PhotoStatus, Role, SourcePhoto, User
from ..photos.processing import PhotoRejected, prepare_photo, relative_blur_flags
from ..schemas import BatchIn, BatchOut, PhotoOut, PhotoPatch, SignedUrlOut
from ..security import current_user, require_sector, sign_resource
from ..storage import TooLarge, get_storage

router = APIRouter(prefix="/api", tags=["captura y fotos"])

ALLOWED_SUFFIX = {"image/jpeg": "jpg", "image/png": "png"}


def _batch(db: Session, user: User, batch_id: uuid.UUID, role: Role = Role.viewer) -> CaptureBatch:
    b = db.get(CaptureBatch, batch_id)
    if b is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lote no encontrado")
    require_sector(db, user, b.sector_id, role)
    return b


@router.post("/sectors/{sector_id}/batches", response_model=BatchOut, status_code=201)
def create_batch(sector_id: uuid.UUID, body: BatchIn, user: User = Depends(current_user),
                 db: Session = Depends(get_db)):
    require_sector(db, user, sector_id, Role.editor)
    if body.expected_count and body.expected_count > get_settings().max_photos_per_batch:
        raise HTTPException(422, f"Máximo {get_settings().max_photos_per_batch} fotos por lote")
    b = CaptureBatch(sector_id=sector_id, created_by_id=user.id, **body.model_dump())
    db.add(b)
    db.commit()
    return b


@router.get("/sectors/{sector_id}/batches", response_model=list[BatchOut])
def list_batches(sector_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_sector(db, user, sector_id)
    return list(db.scalars(select(CaptureBatch).where(CaptureBatch.sector_id == sector_id)
                           .order_by(CaptureBatch.created_at.desc())))


@router.post("/batches/{batch_id}/photos", response_model=PhotoOut, status_code=201,
             summary="Sube una foto (un archivo por petición; el cliente reintenta por archivo)")
def upload_photo(batch_id: uuid.UUID, file: UploadFile = File(...), user: User = Depends(current_user),
                 db: Session = Depends(get_db)):
    s = get_settings()
    b = _batch(db, user, batch_id, Role.editor)
    if b.status != BatchStatus.uploading:
        raise HTTPException(status.HTTP_409_CONFLICT, "El lote ya no admite cargas")
    n = db.scalar(select(func.count()).select_from(SourcePhoto).where(SourcePhoto.batch_id == b.id)) or 0
    if n >= s.max_photos_per_batch:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Se alcanzó el límite de {s.max_photos_per_batch} fotos")

    st = get_storage()
    filename = (file.filename or "sin_nombre")[-300:]
    tmp_key = f"tmp/upload-{uuid.uuid4().hex}"
    try:
        size, digest = st.put_stream(tmp_key, file.file, int(s.max_photo_mb * 1024 * 1024))
    except TooLarge:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, f"La foto supera {s.max_photo_mb} MB")
    tmp_path = st.path(tmp_key)
    try:
        # Reintento del mismo archivo en el mismo lote: idempotente.
        same = db.scalar(select(SourcePhoto).where(SourcePhoto.batch_id == b.id, SourcePhoto.sha256 == digest,
                                                   SourcePhoto.original_filename == filename))
        if same is not None:
            return same
        dup = db.scalar(select(SourcePhoto).where(SourcePhoto.sector_id == b.sector_id,
                                                  SourcePhoto.sha256 == digest,
                                                  SourcePhoto.status == PhotoStatus.accepted))
        photo = SourcePhoto(id=uuid.uuid4(), batch_id=b.id, sector_id=b.sector_id, original_filename=filename,
                            sha256=digest, size_bytes=size, uploaded_by_id=user.id)
        if dup is not None:
            photo.status = PhotoStatus.duplicate
            photo.duplicate_of_id = dup.id
            photo.included = False
            photo.reject_reason = f"Contenido idéntico a «{dup.original_filename}» (SHA-256)."
            db.add(photo)
            db.commit()
            return photo
        work_key = f"working/{b.sector_id}/{photo.id}.jpg"
        thumb_key = f"thumbs/{b.sector_id}/{photo.id}.jpg"
        try:
            prep = prepare_photo(tmp_path, st.path(work_key), st.path(thumb_key))
        except PhotoRejected as e:
            photo.status = PhotoStatus.rejected
            photo.included = False
            photo.reject_reason = e.message
            photo.flags = [e.code]
            db.add(photo)
            db.commit()
            return photo
        orig_key = f"originals/{b.sector_id}/{photo.id}.{ALLOWED_SUFFIX[prep.mime]}"
        st.put_file(orig_key, tmp_path, move=True)
        st.make_immutable(orig_key)
        photo.status = PhotoStatus.accepted
        photo.mime = prep.mime
        photo.original_path = orig_key
        photo.working_path = work_key
        photo.thumb_path = thumb_key
        photo.width, photo.height = prep.width, prep.height
        photo.working_width, photo.working_height = prep.working_width, prep.working_height
        photo.working_scale = prep.working_scale
        photo.exif_orientation = prep.exif_orientation
        photo.camera = prep.camera
        photo.camera_group = prep.camera_group
        photo.quality = prep.quality
        photo.flags = prep.flags
        db.add(photo)
        db.commit()
        return photo
    finally:
        tmp_path.unlink(missing_ok=True)


def _refresh_relative_flags(db: Session, sector_id: uuid.UUID) -> None:
    photos = list(db.scalars(select(SourcePhoto).where(SourcePhoto.sector_id == sector_id,
                                                       SourcePhoto.status == PhotoStatus.accepted)))
    low = relative_blur_flags({p.id: p.quality.get("sharpness", 0.0) for p in photos})
    for p in photos:
        flags = [f for f in (p.flags or []) if f != "nitidez_baja_relativa"]
        if p.id in low:
            flags.append("nitidez_baja_relativa")
        p.flags = flags
    db.commit()


@router.post("/batches/{batch_id}/complete", response_model=BatchOut)
def complete_batch(batch_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    b = _batch(db, user, batch_id, Role.editor)
    if b.status == BatchStatus.uploading:
        b.status = BatchStatus.completed
        b.completed_at = datetime.now(timezone.utc)
        db.commit()
    _refresh_relative_flags(db, b.sector_id)
    return b


@router.post("/batches/{batch_id}/cancel", response_model=BatchOut)
def cancel_batch(batch_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Cancela la carga: las fotos ya recibidas se conservan pero se excluyen, con registro."""
    b = _batch(db, user, batch_id, Role.editor)
    if b.status != BatchStatus.uploading:
        raise HTTPException(status.HTTP_409_CONFLICT, "Solo se puede cancelar un lote en carga")
    b.status = BatchStatus.cancelled
    now = datetime.now(timezone.utc).isoformat()
    for p in db.scalars(select(SourcePhoto).where(SourcePhoto.batch_id == b.id)):
        if p.included:
            p.included = False
            p.inclusion_log = [*(p.inclusion_log or []), {"at": now, "by": str(user.id), "included": False,
                                                          "reason": "lote cancelado"}]
    db.commit()
    return b


@router.get("/sectors/{sector_id}/photos", response_model=list[PhotoOut])
def list_photos(sector_id: uuid.UUID, batch_id: uuid.UUID | None = None, status_: str | None = Query(None, alias="status"),
                user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_sector(db, user, sector_id)
    q = select(SourcePhoto).where(SourcePhoto.sector_id == sector_id)
    if batch_id:
        q = q.where(SourcePhoto.batch_id == batch_id)
    if status_:
        q = q.where(SourcePhoto.status == PhotoStatus(status_))
    return list(db.scalars(q.order_by(SourcePhoto.uploaded_at, SourcePhoto.original_filename)))


@router.patch("/photos/{photo_id}", response_model=PhotoOut)
def patch_photo(photo_id: uuid.UUID, body: PhotoPatch, user: User = Depends(current_user),
                db: Session = Depends(get_db)):
    """Incluir/excluir una foto del conjunto de trabajo. Nunca se elimina: queda registro."""
    p = db.get(SourcePhoto, photo_id)
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Foto no encontrada")
    require_sector(db, user, p.sector_id, Role.editor)
    if body.included and p.status != PhotoStatus.accepted:
        raise HTTPException(status.HTTP_409_CONFLICT, "Solo una foto aceptada puede incluirse")
    if p.included != body.included:
        p.included = body.included
        p.inclusion_log = [*(p.inclusion_log or []), {"at": datetime.now(timezone.utc).isoformat(),
                                                      "by": str(user.id), "included": body.included,
                                                      "reason": body.reason}]
        db.commit()
    return p


@router.get("/photos/{photo_id}/url", response_model=SignedUrlOut)
def photo_url(photo_id: uuid.UUID, variant: str = Query("thumb", pattern="^(thumb|working|original)$"),
              user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = db.get(SourcePhoto, photo_id)
    if p is None or p.status != PhotoStatus.accepted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Foto no disponible")
    require_sector(db, user, p.sector_id, Role.editor if variant == "original" else Role.viewer)
    ttl = get_settings().signed_url_ttl_seconds
    return SignedUrlOut(url=f"/api/files/{sign_resource(f'photo:{p.id}:{variant}', user.id)}", expires_in=ttl)


@router.get("/sectors/{sector_id}/diagnostics")
def diagnostics(sector_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Resumen de captura: estados, indicadores y grupos de cámara (con supuestos explícitos)."""
    require_sector(db, user, sector_id)
    photos = list(db.scalars(select(SourcePhoto).where(SourcePhoto.sector_id == sector_id)))
    by_status = Counter(p.status.value for p in photos)
    accepted = [p for p in photos if p.status == PhotoStatus.accepted]
    included = [p for p in accepted if p.included]
    flag_counts = Counter(f for p in accepted for f in (p.flags or []))
    groups: dict[str, dict] = defaultdict(lambda: {"count": 0})
    for p in included:
        g = groups[p.camera_group or "?"]
        g["count"] += 1
        g.setdefault("make", p.camera.get("make"))
        g.setdefault("model", p.camera.get("model"))
        g.setdefault("lens", p.camera.get("lens"))
        g.setdefault("focal_mm", p.camera.get("focal_mm"))
        g.setdefault("resolution", f"{p.width}×{p.height}")
        g.setdefault("focal_prior_px", p.camera.get("focal_prior_px_oriented"))
        g.setdefault("focal_prior_source", p.camera.get("focal_prior_source"))
    advice = []
    if len(included) < 20:
        advice.append("Menos de 20 fotos incluidas: la reconstrucción probablemente será incompleta.")
    if len(groups) > 1:
        advice.append(f"{len(groups)} grupos de cámara/resolución: se estimarán intrínsecos por grupo. "
                      "Idealmente usa una sola cámara y configuración por secuencia.")
    if any(g["focal_prior_px"] is None for g in groups.values()):
        advice.append("Hay grupos sin focal EXIF: el motor partirá de un valor por defecto y lo refinará; "
                      "puedes corregirlo al crear el trabajo.")
    flagged = flag_counts.get("posible_desenfoque", 0) + flag_counts.get("nitidez_baja_relativa", 0)
    if flagged:
        advice.append(f"{flagged} foto(s) con indicador de posible desenfoque. Revísalas: los indicadores no "
                      "son concluyentes y sus umbrales deben calibrarse con ejemplos.")
    if len(included) > get_settings().max_photos_per_job:
        advice.append(f"Más de {get_settings().max_photos_per_job} fotos incluidas: divide el sector o ajusta "
                      "el límite (la correspondencia exhaustiva crece de forma cuadrática).")
    return {
        "total": len(photos),
        "by_status": dict(by_status),
        "accepted": len(accepted),
        "included": len(included),
        "excluded": len(accepted) - len(included),
        "flags": dict(flag_counts),
        "camera_groups": dict(groups),
        "thresholds": {
            "blur_absolute": get_settings().blur_absolute_threshold,
            "blur_relative": get_settings().blur_relative_threshold,
            "dark_fraction": get_settings().dark_fraction_threshold,
            "bright_fraction": get_settings().bright_fraction_threshold,
            "note": "Umbrales iniciales; calibrar con ejemplos reales del sitio.",
        },
        "advice": advice,
    }


@router.get("/sectors/{sector_id}/photos/thumbs", summary="URLs firmadas de miniaturas (en bloque)")
def photo_thumbs(sector_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_sector(db, user, sector_id)
    ids = db.scalars(select(SourcePhoto.id).where(SourcePhoto.sector_id == sector_id,
                                                  SourcePhoto.status == PhotoStatus.accepted))
    return {str(i): f"/api/files/{sign_resource(f'photo:{i}:thumb', user.id)}" for i in ids}
