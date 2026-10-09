"""Cola de trabajos. Celery solo transporta el identificador; el estado vive en PostgreSQL."""
from celery import Celery
from celery.signals import worker_ready

from ..config import get_settings

celery = Celery("planta3d", broker=get_settings().redis_url, include=["app.worker.tasks"])
celery.conf.update(
    task_acks_late=True,  # si el trabajador cae, el mensaje vuelve a la cola
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_default_queue="reconstruction",
    broker_connection_retry_on_startup=True,
    broker_transport_options={"visibility_timeout": 12 * 3600},
    task_serializer="json",
    accept_content=["json"],
    timezone="UTC",
)


@worker_ready.connect
def _recover(**_):
    from .tasks import recover_orphans

    recover_orphans()
