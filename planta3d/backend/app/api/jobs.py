import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..engine.capabilities import capabilities
from ..jobstate import lock_is_free, log, transition
from ..models import ACTIVE_JOB_STATUSES, JobEvent, JobStatus, PhotoStatus, ProcessingJob, Role, SourcePhoto, User
from ..schemas import JobEventOut, JobIn, JobOut
from ..security import current_user, require_sector

router = APIRouter(prefix="/api", tags=["trabajos de reconstrucción"])


def _out(j: ProcessingJob) -> JobOut:
    o = JobOut.model_validate(j)
    o.photo_count = len(j.photo_ids or [])
    return o


def _job(db: Session, user: User, job_id: uuid.UUID, role: Role = Role.viewer) -> ProcessingJob:
    j = db.get(ProcessingJob, job_id)
    if j is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Trabajo no encontrado")
    require_sector(db, user, j.sector_id, role)
    return j


@router.get("/system/capabilities", tags=["sistema"])
def system_capabilities(user: User = Depends(current_user)):
    return capabilities()


@router.post("/sectors/{sector_id}/jobs", response_model=JobOut, status_code=201,
             responses={200: {"description": "Ya existía un trabajo con esa clave de idempotencia"}})
def create_job(sector_id: uuid.UUID, body: JobIn, response: Response, user: User = Depends(current_user),
               db: Session = Depends(get_db)):
    require_sector(db, user, sector_id, Role.editor)
    existing = db.scalar(select(ProcessingJob).where(ProcessingJob.sector_id == sector_id,
                                                     ProcessingJob.idempotency_key == body.idempotency_key))
    if existing:
        response.status_code = 200
        return _out(existing)
    caps = capabilities()
    if not caps["reconstruction_available"]:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "Reconstrucción no disponible en este equipo: " + "; ".join(caps["reasons"]) +
                            ". Puedes importar un GLB mientras tanto.")
    active = db.scalar(select(ProcessingJob).where(ProcessingJob.sector_id == sector_id,
                                                   ProcessingJob.status.in_(ACTIVE_JOB_STATUSES)))
    if active:
        raise HTTPException(status.HTTP_409_CONFLICT, "Ya hay un trabajo activo en este sector")
    photos = list(db.scalars(select(SourcePhoto).where(SourcePhoto.sector_id == sector_id,
                                                       SourcePhoto.status == PhotoStatus.accepted,
                                                       SourcePhoto.included.is_(True))
                             .order_by(SourcePhoto.uploaded_at, SourcePhoto.original_filename)))
    if len(photos) < 3:
        raise HTTPException(422, "Se requieren al menos 3 fotos incluidas (recomendado ≥ 20).")
    if len(photos) > get_settings().max_photos_per_job:
        raise HTTPException(422, f"Máximo {get_settings().max_photos_per_job} fotos por trabajo con la estrategia "
                                 "de correspondencia exhaustiva. Divide el sector o excluye fotos redundantes.")
    j = ProcessingJob(sector_id=sector_id, idempotency_key=body.idempotency_key, profile=body.profile,
                      params={"focal_overrides": body.focal_overrides, "note": body.note},
                      photo_ids=[str(p.id) for p in photos], created_by_id=user.id, status=JobStatus.queued)
    db.add(j)
    try:
        db.commit()
    except IntegrityError:  # carrera con la misma clave
        db.rollback()
        response.status_code = 200
        return _out(db.scalar(select(ProcessingJob).where(ProcessingJob.sector_id == sector_id,
                                                          ProcessingJob.idempotency_key == body.idempotency_key)))
    log(db, j.id, f"Trabajo creado con {len(photos)} fotos, perfil «{body.profile}»")
    from ..worker.tasks import enqueue

    enqueue(j.id)
    return _out(j)


@router.get("/sectors/{sector_id}/jobs", response_model=list[JobOut])
def list_jobs(sector_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_sector(db, user, sector_id)
    return [_out(j) for j in db.scalars(select(ProcessingJob).where(ProcessingJob.sector_id == sector_id)
                                        .order_by(ProcessingJob.created_at.desc()))]


@router.get("/jobs/{job_id}", response_model=JobOut)
def get_job(job_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _out(_job(db, user, job_id))


@router.get("/jobs/{job_id}/events", response_model=list[JobEventOut])
def job_events(job_id: uuid.UUID, after: int = 0, user: User = Depends(current_user),
               db: Session = Depends(get_db)):
    _job(db, user, job_id)
    return list(db.scalars(select(JobEvent).where(JobEvent.job_id == job_id, JobEvent.id > after)
                           .order_by(JobEvent.id).limit(500)))


@router.post("/jobs/{job_id}/cancel", response_model=JobOut)
def cancel_job(job_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    j = _job(db, user, job_id, Role.editor)
    if j.status in (JobStatus.ready, JobStatus.failed, JobStatus.cancelled):
        raise HTTPException(status.HTTP_409_CONFLICT, f"El trabajo ya terminó ({j.status.value})")
    if j.status == JobStatus.cancelling:
        return _out(j)
    if lock_is_free(j.id):
        # Ningún trabajador lo ejecuta (en cola o trabajador caído): se cancela directamente. Los procesos
        # del motor mueren con su trabajador (PR_SET_PDEATHSIG).
        transition(db, j, JobStatus.cancelling)
        transition(db, j, JobStatus.cancelled, worker_pid=None)
        log(db, j.id, "Cancelado (sin trabajador activo)", "warning", by=str(user.id))
    else:
        transition(db, j, JobStatus.cancelling)
        log(db, j.id, "Cancelación solicitada; el trabajador terminará los procesos del motor", "warning",
            by=str(user.id))
    return _out(j)
