import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import Annotation, Asset, DocumentLink, PhotoStatus, Role, SourcePhoto, User
from ..schemas import (
    AnnotationIn,
    AnnotationOut,
    AnnotationPatch,
    AssetIn,
    AssetOut,
    AssetPatch,
    DocumentOut,
    SignedUrlOut,
    TransferIn,
)
from ..security import current_user, require_model, require_sector, sign_resource
from ..storage import TooLarge, get_storage

router = APIRouter(prefix="/api", tags=["marcadores, activos y documentos"])

DOC_MIME = {"application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "text/plain": "txt",
            "text/csv": "csv", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx"}


# ------------------------------------------------------------------ anotaciones


def _ann(db: Session, user: User, ann_id: uuid.UUID, role: Role = Role.viewer) -> Annotation:
    a = db.get(Annotation, ann_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Marcador no encontrado")
    require_model(db, user, a.model_version_id, role)
    return a


def _check_asset(db: Session, asset_id: uuid.UUID | None, sector_id: uuid.UUID) -> None:
    if asset_id is None:
        return
    a = db.get(Asset, asset_id)
    if a is None or a.sector_id != sector_id:
        raise HTTPException(422, "El activo no pertenece a este sector")


@router.get("/models/{model_id}/annotations", response_model=list[AnnotationOut])
def list_annotations(model_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_model(db, user, model_id)
    return list(db.scalars(select(Annotation).where(Annotation.model_version_id == model_id)
                           .order_by(Annotation.created_at)))


@router.post("/models/{model_id}/annotations", response_model=AnnotationOut, status_code=201)
def create_annotation(model_id: uuid.UUID, body: AnnotationIn, user: User = Depends(current_user),
                      db: Session = Depends(get_db)):
    """La posición se guarda en coordenadas del modelo de ESTA versión (nunca de pantalla)."""
    mv = require_model(db, user, model_id, Role.editor)
    _check_asset(db, body.asset_id, mv.sector_id)
    a = Annotation(model_version_id=mv.id, created_by_id=user.id, **body.model_dump())
    db.add(a)
    db.commit()
    return a


@router.patch("/annotations/{ann_id}", response_model=AnnotationOut)
def patch_annotation(ann_id: uuid.UUID, body: AnnotationPatch, user: User = Depends(current_user),
                     db: Session = Depends(get_db)):
    a = _ann(db, user, ann_id, Role.editor)
    data = body.model_dump(exclude_unset=True)
    if "asset_id" in data:
        mv = require_model(db, user, a.model_version_id)
        _check_asset(db, data["asset_id"], mv.sector_id)
    for k, v in data.items():
        setattr(a, k, v)
    db.commit()
    return a


@router.delete("/annotations/{ann_id}", status_code=204)
def delete_annotation(ann_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    a = _ann(db, user, ann_id, Role.editor)
    db.delete(a)
    db.commit()


@router.post("/annotations/transfer", response_model=list[AnnotationOut], status_code=201)
def transfer_annotations(body: TransferIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Copia marcadores a otra versión aplicando una transformación explícita y revisada.
    Nunca ocurre automáticamente al cambiar de versión; queda registro de la revisión."""
    src = require_model(db, user, body.from_model_id, Role.editor)
    dst = require_model(db, user, body.to_model_id, Role.editor)
    if src.sector_id != dst.sector_id:
        raise HTTPException(422, "Solo entre versiones del mismo sector")
    M = np.asarray(body.transform, dtype=float).reshape(4, 4)
    out = []
    review = {"from_model_id": str(src.id), "to_model_id": str(dst.id), "transform": body.transform,
              "review_note": body.review_note, "reviewed_by": str(user.id),
              "at": datetime.now(timezone.utc).isoformat()}
    for aid in body.annotation_ids:
        a = db.get(Annotation, aid)
        if a is None or a.model_version_id != src.id:
            raise HTTPException(422, f"El marcador {aid} no pertenece a la versión de origen")
        p = M @ np.array([*a.position, 1.0])
        n = None
        if a.normal:
            n = (M[:3, :3] @ np.array(a.normal)).tolist()
        c = Annotation(model_version_id=dst.id, asset_id=a.asset_id, kind=a.kind, title=a.title, body=a.body,
                       position=(p[:3] / p[3]).tolist(), normal=n,
                       extra={**(a.extra or {}), "transferred": {**review, "source_annotation_id": str(a.id)}},
                       created_by_id=user.id)
        db.add(c)
        out.append(c)
    db.commit()
    return out


# ------------------------------------------------------------------ activos (fichas de equipos)


def _asset(db: Session, user: User, asset_id: uuid.UUID, role: Role = Role.viewer) -> Asset:
    a = db.get(Asset, asset_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Activo no encontrado")
    require_sector(db, user, a.sector_id, role)
    return a


@router.get("/sectors/{sector_id}/assets", response_model=list[AssetOut])
def list_assets(sector_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_sector(db, user, sector_id)
    return list(db.scalars(select(Asset).where(Asset.sector_id == sector_id).order_by(Asset.tag, Asset.name)))


@router.post("/sectors/{sector_id}/assets", response_model=AssetOut, status_code=201)
def create_asset(sector_id: uuid.UUID, body: AssetIn, user: User = Depends(current_user),
                 db: Session = Depends(get_db)):
    require_sector(db, user, sector_id, Role.editor)
    data = body.model_dump()
    a = Asset(sector_id=sector_id, created_by_id=user.id, **data)
    if body.op_status:
        if not body.op_status_source:
            raise HTTPException(422, "El estado operacional requiere indicar su origen")
        a.op_status_at = datetime.now(timezone.utc)
        a.op_status_set_by_id = user.id
    db.add(a)
    db.commit()
    return a


@router.patch("/assets/{asset_id}", response_model=AssetOut)
def patch_asset(asset_id: uuid.UUID, body: AssetPatch, user: User = Depends(current_user),
                db: Session = Depends(get_db)):
    a = _asset(db, user, asset_id, Role.editor)
    data = body.model_dump(exclude_unset=True)
    if "op_status" in data:
        if data["op_status"] and not (data.get("op_status_source") or a.op_status_source):
            raise HTTPException(422, "El estado operacional requiere indicar su origen")
        a.op_status_at = datetime.now(timezone.utc)
        a.op_status_set_by_id = user.id
    for k, v in data.items():
        setattr(a, k, v)
    db.commit()
    return a


@router.delete("/assets/{asset_id}", status_code=204)
def delete_asset(asset_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    a = _asset(db, user, asset_id, Role.editor)
    db.delete(a)
    db.commit()


# ------------------------------------------------------------------ documentos y fotos de referencia


@router.get("/sectors/{sector_id}/documents", response_model=list[DocumentOut])
def list_documents(sector_id: uuid.UUID, asset_id: uuid.UUID | None = None, annotation_id: uuid.UUID | None = None,
                   user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_sector(db, user, sector_id)
    q = select(DocumentLink).where(DocumentLink.sector_id == sector_id)
    if asset_id:
        q = q.where(DocumentLink.asset_id == asset_id)
    if annotation_id:
        q = q.where(DocumentLink.annotation_id == annotation_id)
    return list(db.scalars(q.order_by(DocumentLink.created_at)))


def _check_targets(db: Session, sector_id: uuid.UUID, asset_id, annotation_id) -> None:
    if asset_id:
        a = db.get(Asset, asset_id)
        if a is None or a.sector_id != sector_id:
            raise HTTPException(422, "Activo inválido para este sector")
    if annotation_id:
        an = db.get(Annotation, annotation_id)
        if an is None:
            raise HTTPException(422, "Marcador inválido")
        from ..models import ModelVersion

        if db.get(ModelVersion, an.model_version_id).sector_id != sector_id:
            raise HTTPException(422, "Marcador inválido para este sector")


@router.post("/sectors/{sector_id}/documents", response_model=DocumentOut, status_code=201)
def create_document(sector_id: uuid.UUID, title: str = Form(..., min_length=1, max_length=300),
                    url: str | None = Form(None), source_photo_id: uuid.UUID | None = Form(None),
                    asset_id: uuid.UUID | None = Form(None), annotation_id: uuid.UUID | None = Form(None),
                    file: UploadFile | None = File(None), user: User = Depends(current_user),
                    db: Session = Depends(get_db)):
    """Un documento es un enlace (http/https), un archivo subido o una foto de referencia del sector."""
    require_sector(db, user, sector_id, Role.editor)
    _check_targets(db, sector_id, asset_id, annotation_id)
    given = sum(x is not None for x in (url, file, source_photo_id))
    if given != 1:
        raise HTTPException(422, "Indica exactamente uno: url, archivo o foto de referencia")
    d = DocumentLink(sector_id=sector_id, title=title, asset_id=asset_id, annotation_id=annotation_id,
                     created_by_id=user.id)
    if url is not None:
        u = urlparse(url)
        if u.scheme not in ("http", "https") or not u.netloc:
            raise HTTPException(422, "Solo se aceptan enlaces http(s)")
        d.kind, d.url = "link", url
    elif source_photo_id is not None:
        p = db.get(SourcePhoto, source_photo_id)
        if p is None or p.sector_id != sector_id or p.status != PhotoStatus.accepted:
            raise HTTPException(422, "Foto de referencia inválida")
        d.kind, d.source_photo_id = "photo", p.id
    else:
        mime = (file.content_type or "").split(";")[0]
        if mime not in DOC_MIME:
            raise HTTPException(415, f"Tipo de archivo no admitido ({mime}). Permitidos: PDF, imágenes, TXT, CSV, "
                                     "DOCX, XLSX.")
        st = get_storage()
        did = uuid.uuid4()
        key = f"documents/{sector_id}/{did}.{DOC_MIME[mime]}"
        try:
            size, _ = st.put_stream(key, file.file, int(get_settings().max_document_mb * 1024 * 1024))
        except TooLarge:
            raise HTTPException(413, "Documento demasiado grande")
        d.id, d.kind, d.file_path, d.mime, d.size_bytes = did, "file", key, mime, size
        if not title.lower().endswith("." + DOC_MIME[mime]):
            d.title = f"{title}.{DOC_MIME[mime]}"
    db.add(d)
    db.commit()
    return d


@router.get("/documents/{doc_id}/url", response_model=SignedUrlOut)
def document_url(doc_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    d = db.get(DocumentLink, doc_id)
    if d is None:
        raise HTTPException(404, "Documento no encontrado")
    require_sector(db, user, d.sector_id)
    ttl = get_settings().signed_url_ttl_seconds
    if d.kind == "link":
        return SignedUrlOut(url=d.url, expires_in=0)
    if d.kind == "photo":
        return SignedUrlOut(url=f"/api/files/{sign_resource(f'photo:{d.source_photo_id}:working', user.id)}",
                            expires_in=ttl)
    return SignedUrlOut(url=f"/api/files/{sign_resource(f'doc:{d.id}', user.id)}", expires_in=ttl)


@router.delete("/documents/{doc_id}", status_code=204)
def delete_document(doc_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    d = db.get(DocumentLink, doc_id)
    if d is None:
        raise HTTPException(404, "Documento no encontrado")
    require_sector(db, user, d.sector_id, Role.editor)
    if d.file_path:
        get_storage().delete(d.file_path)
    db.delete(d)
    db.commit()
