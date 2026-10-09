import json
import math
import uuid

import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import calibration as cal
from ..config import get_settings
from ..db import get_db
from ..engine.convert import ConversionError, export_with_root_transform, verify_glb
from ..models import (
    Annotation,
    CalibrationReference,
    ModelArtifact,
    ModelSource,
    ModelVersion,
    Role,
    ScaleState,
    User,
    ValidationCheck,
)
from ..schemas import (
    CalibrationOut,
    MeasureIn,
    ModelOut,
    ModelPatch,
    SegmentIn,
    SegmentOut,
    SignedUrlOut,
)
from ..security import current_user, require_model, require_sector, sign_resource
from ..storage import TooLarge, get_storage

router = APIRouter(prefix="/api", tags=["modelos 3D y calibración"])

IDENTITY = np.eye(4).reshape(-1).tolist()


@router.get("/sectors/{sector_id}/models", response_model=list[ModelOut])
def list_models(sector_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_sector(db, user, sector_id)
    return list(db.scalars(select(ModelVersion).where(ModelVersion.sector_id == sector_id)
                           .order_by(ModelVersion.number.desc())))


@router.post("/sectors/{sector_id}/models/import", response_model=ModelOut, status_code=201)
def import_glb(sector_id: uuid.UUID, file: UploadFile = File(...), label: str = Form(...),
               is_demo: bool = Form(False), notes: str | None = Form(None),
               user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Importa un GLB (verificado). No reemplaza la función fotos→3D: queda identificado como importado."""
    require_sector(db, user, sector_id, Role.editor)
    s = get_settings()
    st = get_storage()
    mv_id = uuid.uuid4()
    key = f"models/{sector_id}/{mv_id}/web_glb.glb"
    try:
        size, digest = st.put_stream(key, file.file, int(s.max_import_glb_mb * 1024 * 1024))
    except TooLarge:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, f"El GLB supera {s.max_import_glb_mb} MB")
    try:
        info = verify_glb(st.path(key))
    except (ConversionError, ValueError, KeyError, json.JSONDecodeError) as e:
        st.delete(key)
        raise HTTPException(422, f"GLB inválido: {e}")
    number = (db.scalar(select(func.max(ModelVersion.number)).where(ModelVersion.sector_id == sector_id)) or 0) + 1
    mv = ModelVersion(id=mv_id, sector_id=sector_id, number=number, label=label,
                      source=ModelSource.demo if is_demo else ModelSource.imported, notes=notes,
                      coordinate_system="Coordenadas del archivo importado (glTF, Y arriba). El formato no "
                                        "demuestra que las unidades sean metros reales.",
                      alignment=IDENTITY, alignment_source="Identidad (archivo importado)",
                      stats={k: info[k] for k in ("triangles", "vertices", "bytes", "bbox_min", "bbox_max",
                                                  "has_uv")},
                      created_by_id=user.id)
    db.add(mv)
    db.add(ModelArtifact(model_version_id=mv.id, kind="web_glb", path=key, sha256=digest, size_bytes=size,
                         meta={"original_filename": file.filename, "verification": info}))
    db.commit()
    db.refresh(mv)
    return mv


@router.get("/models/{model_id}", response_model=ModelOut)
def get_model(model_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return require_model(db, user, model_id)


@router.patch("/models/{model_id}", response_model=ModelOut)
def patch_model(model_id: uuid.UUID, body: ModelPatch, user: User = Depends(current_user),
                db: Session = Depends(get_db)):
    mv = require_model(db, user, model_id, Role.editor)
    data = body.model_dump(exclude_unset=True)
    if "alignment" in data:
        M = np.asarray(data["alignment"], dtype=float).reshape(4, 4)
        R = M[:3, :3]
        # Solo transformaciones rígidas: la escala se gestiona exclusivamente por calibración.
        if not np.allclose(R @ R.T, np.eye(3), atol=1e-4) or abs(np.linalg.det(R) - 1) > 1e-4 or \
                not np.allclose(M[3], [0, 0, 0, 1]):
            raise HTTPException(422, "La alineación debe ser una transformación rígida (rotación + traslación)")
        if "alignment_source" not in data:
            data["alignment_source"] = f"Ajustada manualmente por {user.display_name}"
    for k, v in data.items():
        setattr(mv, k, v)
    db.commit()
    if {"tolerance_abs_m", "tolerance_rel"} & data.keys():
        cal.apply(db, mv)
    return mv


@router.get("/models/{model_id}/artifacts/{kind}/url", response_model=SignedUrlOut)
def artifact_url(model_id: uuid.UUID, kind: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_model(db, user, model_id)
    a = db.scalar(select(ModelArtifact).where(ModelArtifact.model_version_id == model_id, ModelArtifact.kind == kind))
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Artefacto no disponible para esta versión")
    return SignedUrlOut(url=f"/api/files/{sign_resource(f'artifact:{a.id}', user.id)}",
                        expires_in=get_settings().signed_url_ttl_seconds)


@router.get("/models/{model_id}/cameras")
def model_cameras(model_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Poses de las fotos registradas (coordenadas del modelo) para navegar «desde donde se tomó la foto»."""
    require_model(db, user, model_id)
    a = db.scalar(select(ModelArtifact).where(ModelArtifact.model_version_id == model_id,
                                              ModelArtifact.kind == "cameras_json"))
    if a is None:
        return {"cameras": [], "convention": None}
    return json.loads(get_storage().path(a.path).read_text())


@router.get("/models/{model_id}/report")
def model_report(model_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_model(db, user, model_id)
    a = db.scalar(select(ModelArtifact).where(ModelArtifact.model_version_id == model_id,
                                              ModelArtifact.kind == "report_json"))
    if a is None:
        raise HTTPException(404, "Esta versión no tiene informe de reconstrucción (p. ej. fue importada)")
    return json.loads(get_storage().path(a.path).read_text())


# ------------------------------------------------------------------ calibración y validación


def _seg_out(row: dict) -> SegmentOut:
    o = SegmentOut.model_validate(row["obj"])
    for k in ("model_distance", "scaled_distance_m", "abs_error_m", "rel_error", "within_tolerance"):
        setattr(o, k, row.get(k))
    return o


def _calib_out(db: Session, mv: ModelVersion) -> CalibrationOut:
    ev = cal.evaluate(db, mv)
    return CalibrationOut(
        scale_state=ev["scale_state"].value, scale_factor=ev["scale_factor"], method=ev["method"],
        references=[_seg_out(r) for r in ev["reference_rows"]], checks=[_seg_out(r) for r in ev["check_rows"]],
        n_checks=ev["n_checks"], min_checks_required=ev["min_checks_required"],
        tolerance_abs_m=mv.tolerance_abs_m, tolerance_rel=mv.tolerance_rel, tolerance_purpose=mv.tolerance_purpose,
        max_abs_error_m=ev["max_abs_error_m"], max_rel_error=ev["max_rel_error"], rms_error_m=ev["rms_error_m"],
        notice=ev["notice"])


@router.get("/models/{model_id}/calibration", response_model=CalibrationOut)
def get_calibration(model_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _calib_out(db, require_model(db, user, model_id))


def _validate_segment(db: Session, mv: ModelVersion, body: SegmentIn) -> None:
    d = cal.dist(body.point_a, body.point_b)
    if d <= cal.MIN_MODEL_DISTANCE:
        raise HTTPException(422, "Los dos puntos del modelo coinciden: la distancia del modelo debe ser > 0")
    bb = mv.stats.get("bbox_min"), mv.stats.get("bbox_max")
    if all(bb):
        diag = math.dist(bb[0], bb[1])
        eps = max(diag * 1e-4, 1e-9)
        others = list(db.scalars(select(CalibrationReference).where(CalibrationReference.model_version_id == mv.id))) \
            + list(db.scalars(select(ValidationCheck).where(ValidationCheck.model_version_id == mv.id)))
        for o in others:
            if cal.same_segment(body.point_a, body.point_b, o.point_a, o.point_b, eps):
                raise HTTPException(409, f"Ese segmento ya está registrado como «{o.label}». Las referencias de "
                                         "ajuste y las comprobaciones deben ser medidas independientes.")


@router.post("/models/{model_id}/references", response_model=CalibrationOut, status_code=201)
def add_reference(model_id: uuid.UUID, body: SegmentIn, user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    mv = require_model(db, user, model_id, Role.editor)
    _validate_segment(db, mv, body)
    db.add(CalibrationReference(model_version_id=mv.id, label=body.label, point_a=body.point_a,
                                point_b=body.point_b, real_distance=body.real_distance, unit=body.unit,
                                real_distance_m=cal.to_meters(body.real_distance, body.unit), source=body.source,
                                endpoints_description=body.endpoints_description, created_by_id=user.id))
    db.commit()
    cal.apply(db, mv)
    return _calib_out(db, mv)


@router.post("/models/{model_id}/checks", response_model=CalibrationOut, status_code=201)
def add_check(model_id: uuid.UUID, body: SegmentIn, user: User = Depends(current_user),
              db: Session = Depends(get_db)):
    mv = require_model(db, user, model_id, Role.editor)
    _validate_segment(db, mv, body)
    db.add(ValidationCheck(model_version_id=mv.id, label=body.label, point_a=body.point_a, point_b=body.point_b,
                           real_distance=body.real_distance, unit=body.unit,
                           real_distance_m=cal.to_meters(body.real_distance, body.unit), source=body.source,
                           endpoints_description=body.endpoints_description, created_by_id=user.id))
    db.commit()
    cal.apply(db, mv)
    return _calib_out(db, mv)


@router.delete("/models/{model_id}/references/{ref_id}", response_model=CalibrationOut)
def delete_reference(model_id: uuid.UUID, ref_id: uuid.UUID, user: User = Depends(current_user),
                     db: Session = Depends(get_db)):
    mv = require_model(db, user, model_id, Role.editor)
    r = db.get(CalibrationReference, ref_id)
    if r is None or r.model_version_id != mv.id:
        raise HTTPException(404, "Referencia no encontrada")
    db.delete(r)
    db.commit()
    cal.apply(db, mv)
    return _calib_out(db, mv)


@router.delete("/models/{model_id}/checks/{check_id}", response_model=CalibrationOut)
def delete_check(model_id: uuid.UUID, check_id: uuid.UUID, user: User = Depends(current_user),
                 db: Session = Depends(get_db)):
    mv = require_model(db, user, model_id, Role.editor)
    c = db.get(ValidationCheck, check_id)
    if c is None or c.model_version_id != mv.id:
        raise HTTPException(404, "Comprobación no encontrada")
    db.delete(c)
    db.commit()
    cal.apply(db, mv)
    return _calib_out(db, mv)


@router.post("/models/{model_id}/measure")
def measure(model_id: uuid.UUID, body: MeasureIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Distancia entre dos puntos del modelo. En metros solo si existe calibración; siempre es una estimación."""
    mv = require_model(db, user, model_id)
    d = cal.dist(body.point_a, body.point_b)
    out = {"model_distance": d, "scale_state": mv.scale_state.value, "meters": None,
           "notice": "Sin calibrar: distancia en unidades del modelo, no en metros."}
    if mv.scale_state != ScaleState.uncalibrated and mv.scale_factor:
        out["meters"] = d * mv.scale_factor
        out["notice"] = ("Estimación verificada para la tolerancia registrada." if mv.scale_state == ScaleState.verified
                         else "Estimación calibrada sin verificar.")
    return out


@router.post("/models/{model_id}/export", response_model=SignedUrlOut)
def export_model(model_id: uuid.UUID, metric: bool = True, user: User = Depends(current_user),
                 db: Session = Depends(get_db)):
    """Genera un derivado GLB con orientación (y escala, si está calibrado) y los marcadores como nodos."""
    mv = require_model(db, user, model_id)
    a = db.scalar(select(ModelArtifact).where(ModelArtifact.model_version_id == mv.id,
                                              ModelArtifact.kind == "web_glb"))
    if a is None:
        raise HTTPException(404, "Sin GLB")
    if metric and (mv.scale_state == ScaleState.uncalibrated or not mv.scale_factor):
        raise HTTPException(409, "No se puede exportar en metros: el modelo no está calibrado")
    M = np.asarray(mv.alignment or IDENTITY, dtype=float).reshape(4, 4)
    s = mv.scale_factor if metric else 1.0
    S = np.diag([s, s, s, 1.0])
    T = S @ M
    anns = list(db.scalars(select(Annotation).where(Annotation.model_version_id == mv.id)))
    markers = [{"name": f"marcador:{x.title}", "position": x.position,
                "extras": {"id": str(x.id), "kind": x.kind, "title": x.title, "body": x.body,
                           "asset_id": str(x.asset_id) if x.asset_id else None}} for x in anns]
    note = (f"Derivado de exportación de la versión {mv.number}. Transformación raíz = escala({s:.9g}) · "
            f"alineación. Estado de escala: {mv.scale_state.value}. " +
            ("Unidades: metros (estimación)." if metric else "Unidades: del modelo (sin escala métrica)."))
    st = get_storage()
    kind = "metrico" if metric else "orientado"
    key = f"exports/{mv.id}/{uuid.uuid4().hex}-{kind}.glb"
    st.path(key).parent.mkdir(parents=True, exist_ok=True)
    export_with_root_transform(st.path(a.path), st.path(key), T.reshape(-1).tolist(), markers, note)
    return SignedUrlOut(url=f"/api/files/{sign_resource(f'export:{mv.id}:{key}:{kind}.glb', user.id)}",
                        expires_in=get_settings().signed_url_ttl_seconds)
