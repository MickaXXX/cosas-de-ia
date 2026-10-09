import logging
import socket
import uuid
from datetime import timedelta

from ..config import get_settings
from ..db import session_factory
from ..engine.runner import group_alive, kill_group
from ..jobstate import active_jobs, lock_is_free, log, now, transition
from ..models import JobStatus
from .celery_app import celery

logger = logging.getLogger(__name__)


@celery.task(name="planta3d.run_job")
def run_job(job_id: str) -> str:
    from ..engine.pipeline import JobRunner

    return JobRunner(uuid.UUID(job_id)).run()


def enqueue(job_id: uuid.UUID) -> None:
    run_job.delay(str(job_id))


def recover_orphans() -> None:
    """Al iniciar un trabajador: recupera trabajos cuyo trabajador cayó.

    Un trabajo está huérfano si figura activo, su latido es antiguo y nadie tiene su bloqueo.
    Antes de reencolar se termina cualquier grupo de procesos registrado en este mismo equipo.
    La reutilización de etapas ya completadas se decide después verificando archivos y parámetros.
    """
    db = session_factory()()
    try:
        host = socket.gethostname()
        stale_before = now() - timedelta(minutes=2)
        for job in active_jobs(db):
            if job.status == JobStatus.queued:
                continue  # sigue en la cola de Celery (acks tardíos)
            if job.heartbeat_at and job.heartbeat_at > stale_before:
                continue
            if not lock_is_free(job.id):
                continue
            if job.worker_host == host and job.worker_pid and group_alive(job.worker_pid):
                kill_group(job.worker_pid)
                log(db, job.id, f"Proceso huérfano {job.worker_pid} terminado durante la recuperación", "warning")
            if job.status == JobStatus.cancelling:
                transition(db, job, JobStatus.cancelled, worker_pid=None)
                continue
            if job.attempts >= get_settings().job_max_attempts:
                transition(db, job, JobStatus.failed, error_code="trabajador_caido",
                           error_message="El trabajador se detuvo repetidamente durante este trabajo. "
                                         "Revisa memoria/tiempo disponibles o reduce el perfil.")
                continue
            log(db, job.id, "Trabajador anterior detenido: se reencola el trabajo (se verificarán las etapas "
                            "completadas antes de reutilizarlas)", "warning")
            transition(db, job, JobStatus.queued, worker_pid=None)
            enqueue(job.id)
    finally:
        db.close()
