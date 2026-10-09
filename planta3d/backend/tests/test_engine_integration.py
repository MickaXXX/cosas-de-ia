"""Pruebas con el motor REAL (lentas). Prueba de aceptación 6: cancelación y recuperación.

Se ejecutan solo con P3D_RUN_ENGINE_TESTS=1 y P3D_TEST_PHOTOS=<carpeta con fotos multivista JPEG/PNG>.
Cada trabajo se ejecuta en un subproceso, como lo haría el trabajador Celery.
"""
import os
import signal
import subprocess
import sys
import time
import uuid
from datetime import timedelta
from pathlib import Path

import pytest

from .conftest import upload

pytestmark = pytest.mark.skipif(os.environ.get("P3D_RUN_ENGINE_TESTS") != "1" or not os.environ.get("P3D_TEST_PHOTOS"),
                                reason="Requiere P3D_RUN_ENGINE_TESTS=1 y P3D_TEST_PHOTOS")
BACKEND = Path(__file__).resolve().parents[1]


def engine_procs() -> list[str]:
    r = subprocess.run(["pgrep", "-af", "OpenMVS/(DensifyPointCloud|ReconstructMesh|TextureMesh)"],
                       capture_output=True, text=True)
    return [l for l in r.stdout.splitlines() if l.strip()]


def start_runner(job_id: str) -> subprocess.Popen:
    code = "import sys, uuid; from app.engine.pipeline import JobRunner; print(JobRunner(uuid.UUID(sys.argv[1])).run())"
    return subprocess.Popen([sys.executable, "-c", code, job_id], cwd=BACKEND, env=os.environ.copy(),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


def job_row(job_id):
    from app.db import session_factory
    from app.models import ProcessingJob

    db = session_factory()()
    try:
        return db.get(ProcessingJob, uuid.UUID(job_id))
    finally:
        db.close()


def wait_stage(job_id, stage, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = job_row(job_id)
        if j.stage == stage and engine_procs():
            return j
        assert j.status.value not in ("failed", "ready", "cancelled"), (j.status, j.error_message)
        time.sleep(1)
    raise TimeoutError(stage)


@pytest.fixture()
def job(client, admin, sector):
    sid = sector["sector"]["id"]
    bid = client.post(f"/api/sectors/{sid}/batches", headers=admin, json={}).json()["id"]
    for p in sorted(Path(os.environ["P3D_TEST_PHOTOS"]).iterdir()):
        if p.suffix.lower() in (".jpg", ".jpeg", ".png"):
            assert upload(client, admin, bid, p.name, p.read_bytes()).json()["status"] == "accepted"
    j = client.post(f"/api/sectors/{sid}/jobs", headers=admin,
                    json={"idempotency_key": uuid.uuid4().hex, "profile": "rapido"})
    assert j.status_code == 201, j.text
    return j.json()["id"]


def test_cancel_real_job_without_orphans(client, admin, job):
    assert engine_procs() == []
    proc = start_runner(job)
    wait_stage(job, "densify")
    r = client.post(f"/api/jobs/{job}/cancel", headers=admin).json()
    assert r["status"] == "cancelling"
    out, _ = proc.communicate(timeout=60)
    assert "cancelado" in out
    j = job_row(job)
    assert j.status.value == "cancelled" and j.model_version_id is None
    time.sleep(1)
    assert engine_procs() == [], "quedaron procesos del motor vivos"


def test_recover_after_worker_crash_reuses_stages(client, admin, job, monkeypatch):
    proc = start_runner(job)
    j = wait_stage(job, "densify")
    pgid = j.worker_pid
    assert pgid and engine_procs()
    proc.send_signal(signal.SIGKILL)  # caída abrupta del trabajador
    proc.wait(timeout=10)
    time.sleep(2)
    assert engine_procs() == [], "PR_SET_PDEATHSIG debió terminar el proceso del motor"

    # Simula el paso del tiempo sin latidos y la recuperación que hace un trabajador al iniciar.
    from app.db import session_factory
    from app.models import ProcessingJob
    import app.worker.tasks as tasks

    db = session_factory()()
    row = db.get(ProcessingJob, uuid.UUID(job))
    row.heartbeat_at = row.heartbeat_at - timedelta(minutes=5)
    db.commit()
    db.close()
    queued = []
    monkeypatch.setattr(tasks, "enqueue", lambda jid: queued.append(str(jid)))
    tasks.recover_orphans()
    j = job_row(job)
    assert j.status.value == "queued" and queued == [job]

    proc2 = start_runner(job)
    out, _ = proc2.communicate(timeout=1800)
    assert out.strip().endswith("ok"), out[-2000:]
    j = job_row(job)
    assert j.status.value == "ready" and j.attempts == 2
    st = {s["name"]: s["status"] for s in j.stages}
    for reused in ("preprocess", "features", "matching", "sfm", "review", "undistort"):
        assert st[reused] == "reused", st
    assert st["densify"] == "done"
    # Sin resultados duplicados: una sola versión de modelo para el trabajo, y relanzarlo no hace nada.
    from app.models import ModelVersion
    from sqlalchemy import func, select

    db = session_factory()()
    assert db.scalar(select(func.count()).select_from(ModelVersion).where(ModelVersion.job_id == j.id)) == 1
    db.close()
    proc3 = start_runner(job)
    out3, _ = proc3.communicate(timeout=60)
    assert "ya terminado" in out3
    assert engine_procs() == []
    rep = client.get(f"/api/models/{j.model_version_id}/report", headers=admin).json()
    assert rep["texture_check"]["status"] == "concluyente"


@pytest.mark.skipif(not os.environ.get("P3D_TEST_PHOTOS_MIXED"), reason="Requiere P3D_TEST_PHOTOS_MIXED (dos escenas sin relación)")
def test_disconnected_photos_are_reported_not_hidden(client, admin, sector):
    sid = sector["sector"]["id"]
    bid = client.post(f"/api/sectors/{sid}/batches", headers=admin, json={}).json()["id"]
    for p in sorted(Path(os.environ["P3D_TEST_PHOTOS_MIXED"]).iterdir()):
        upload(client, admin, bid, p.name, p.read_bytes())
    job = client.post(f"/api/sectors/{sid}/jobs", headers=admin,
                      json={"idempotency_key": uuid.uuid4().hex, "profile": "rapido"}).json()["id"]
    out, _ = start_runner(job).communicate(timeout=3600)
    j = job_row(job)
    assert j.status.value == "ready", (j.error_code, j.error_message, out[-1500:])
    r = j.report
    total, reg = r["photos"]["job_input"], r["photos"]["registered_presented"]
    assert reg < total
    # Lo que no quedó en el modelo presentado se informa con nombre (no registradas u otros componentes).
    assert len(r["photos"]["unregistered"]) + len(r["photos"]["in_other_components"]) == total - reg
    assert any("NO representa todo el conjunto" in w or "componentes desconectados" in w for w in r["warnings"]), r["warnings"]
