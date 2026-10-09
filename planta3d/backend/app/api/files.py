"""Entrega de archivos privados mediante enlaces firmados de corta duración.

La firma solo prueba que el enlace fue emitido; al servirlo se vuelve a comprobar que el usuario sigue
activo y con permiso sobre el proyecto (un enlace no sobrevive a una revocación de acceso).
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import DocumentLink, ModelArtifact, ModelVersion, PhotoStatus, Role, SourcePhoto, User
from ..security import require_sector, verify_signature
from ..storage import get_storage

router = APIRouter(prefix="/api", tags=["archivos"])

MEDIA = {".glb": "model/gltf-binary", ".ply": "application/octet-stream", ".jpg": "image/jpeg",
         ".png": "image/png", ".json": "application/json", ".pdf": "application/pdf", ".zip": "application/zip"}


@router.get("/files/{token}", include_in_schema=False)
def serve(token: str, db: Session = Depends(get_db)):
    resource, uid = verify_signature(token)
    user = db.get(User, uid)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Enlace inválido")
    kind, rid, *rest = resource.split(":")
    st = get_storage()
    if kind == "photo":
        p = db.get(SourcePhoto, uuid.UUID(rid))
        if p is None or p.status != PhotoStatus.accepted:
            raise HTTPException(404)
        variant = rest[0]
        require_sector(db, user, p.sector_id, Role.editor if variant == "original" else Role.viewer)
        key = {"thumb": p.thumb_path, "working": p.working_path, "original": p.original_path}[variant]
        name = p.original_filename if variant == "original" else f"{p.id}-{variant}.jpg"
    elif kind == "artifact":
        a = db.get(ModelArtifact, uuid.UUID(rid))
        if a is None:
            raise HTTPException(404)
        mv = db.get(ModelVersion, a.model_version_id)
        require_sector(db, user, mv.sector_id)
        key, name = a.path, f"modelo-v{mv.number}-{a.kind}{st.path(a.path).suffix}"
    elif kind == "export":
        mv = db.get(ModelVersion, uuid.UUID(rid))
        if mv is None:
            raise HTTPException(404)
        require_sector(db, user, mv.sector_id)
        key, name = rest[0], f"modelo-v{mv.number}-{rest[1]}"
    elif kind == "doc":
        d = db.get(DocumentLink, uuid.UUID(rid))
        if d is None or not d.file_path:
            raise HTTPException(404)
        require_sector(db, user, d.sector_id)
        key, name = d.file_path, d.title
    else:
        raise HTTPException(404)
    path = st.path(key)
    if not path.exists():
        raise HTTPException(status.HTTP_410_GONE, "El archivo no está disponible en el almacenamiento")
    media = MEDIA.get(path.suffix.lower(), "application/octet-stream")
    if kind == "doc":
        d_mime = db.get(DocumentLink, uuid.UUID(rid)).mime
        media = d_mime or media
    return FileResponse(path, media_type=media, filename=name,
                        headers={"Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff"})
