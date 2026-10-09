"""Estado autoritativo de trabajos: transiciones válidas, eventos y exclusión por trabajo."""
from __future__ import annotations

import contextlib
import uuid
from collections.abc import Iterator
from datetime import datetime, timezone

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .db import get_engine
from .models import JOB_TRANSITIONS, JobEvent, JobStatus, ProcessingJob


class InvalidTransition(Exception):
    pass


def now() -> datetime:
    return datetime.now(timezone.utc)


def lock_key(job_id: uuid.UUID) -> int:
    return int.from_bytes(job_id.bytes[:8], "big", signed=True)


def log(db: Session, job_id: uuid.UUID, message: str, level: str = "info", **data) -> None:
    db.add(JobEvent(job_id=job_id, message=message, level=level, data=data))
    db.commit()


def transition(db: Session, job: ProcessingJob, new: JobStatus, **fields) -> None:
    """Aplica una transición validada. Relee la fila con bloqueo para no pisar una cancelación."""
    db.refresh(job, with_for_update=True)
    if new != job.status and new not in JOB_TRANSITIONS[job.status]:
        db.rollback()
        raise InvalidTransition(f"{job.status.value} → {new.value} no es una transición válida")
    old = job.status
    job.status = new
    for k, v in fields.items():
        setattr(job, k, v)
    if new in (JobStatus.ready, JobStatus.failed, JobStatus.cancelled):
        job.finished_at = now()
    db.commit()
    if old != new:
        log(db, job.id, f"Estado: {old.value} → {new.value}", data_from=old.value, data_to=new.value)


@contextlib.contextmanager
def job_lock(job_id: uuid.UUID) -> Iterator[bool]:
    """Bloqueo exclusivo de sesión en PostgreSQL. Se libera solo si la conexión se cierra
    (incluida la caída del trabajador), por lo que impide ejecuciones duplicadas."""
    conn = get_engine().connect()
    try:
        got = conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": lock_key(job_id)}).scalar()
        conn.commit()
        try:
            yield bool(got)
        finally:
            if got:
                conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": lock_key(job_id)})
                conn.commit()
    finally:
        conn.close()


def lock_is_free(job_id: uuid.UUID) -> bool:
    with job_lock(job_id) as got:
        return got


def active_jobs(db: Session) -> list[ProcessingJob]:
    return list(db.scalars(select(ProcessingJob).where(ProcessingJob.status.in_([
        JobStatus.queued, JobStatus.validating, JobStatus.reconstructing, JobStatus.converting,
        JobStatus.cancelling]))))
