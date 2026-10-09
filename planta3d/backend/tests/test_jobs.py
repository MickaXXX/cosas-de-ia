"""Trabajos: transiciones, idempotencia, límites y cancelación sin trabajador."""
import uuid

import pytest

from app.models import JOB_TRANSITIONS, JobStatus

from .conftest import jpeg_bytes, upload


def test_transitions_table_is_closed():
    for s in (JobStatus.ready, JobStatus.failed, JobStatus.cancelled):
        assert JOB_TRANSITIONS[s] == set()
    assert JobStatus.ready not in JOB_TRANSITIONS[JobStatus.queued]
    assert JobStatus.cancelled in JOB_TRANSITIONS[JobStatus.cancelling]


def _photos(client, admin, sid, n):
    bid = client.post(f"/api/sectors/{sid}/batches", headers=admin, json={}).json()["id"]
    for i in range(n):
        upload(client, admin, bid, f"{i}.jpg", jpeg_bytes(seed=100 + i))


@pytest.fixture()
def engine_ok(monkeypatch):
    import app.api.jobs as jobs_api

    monkeypatch.setattr(jobs_api, "capabilities", lambda: {"reconstruction_available": True, "reasons": []})


def test_job_needs_photos_and_engine(client, admin, sector, monkeypatch):
    sid = sector["sector"]["id"]
    import app.api.jobs as jobs_api

    monkeypatch.setattr(jobs_api, "capabilities", lambda: {"reconstruction_available": False, "reasons": ["sin OpenMVS"]})
    r = client.post(f"/api/sectors/{sid}/jobs", headers=admin, json={"idempotency_key": uuid.uuid4().hex})
    assert r.status_code == 503 and "sin OpenMVS" in r.json()["detail"]
    monkeypatch.setattr(jobs_api, "capabilities", lambda: {"reconstruction_available": True, "reasons": []})
    _photos(client, admin, sid, 2)
    assert client.post(f"/api/sectors/{sid}/jobs", headers=admin, json={"idempotency_key": uuid.uuid4().hex}).status_code == 422


def test_idempotency_and_single_active_job(client, admin, sector, engine_ok):
    sid = sector["sector"]["id"]
    _photos(client, admin, sid, 3)
    key = uuid.uuid4().hex
    a = client.post(f"/api/sectors/{sid}/jobs", headers=admin, json={"idempotency_key": key})
    b = client.post(f"/api/sectors/{sid}/jobs", headers=admin, json={"idempotency_key": key})
    assert a.status_code == 201 and b.status_code == 200 and a.json()["id"] == b.json()["id"]
    assert a.json()["photo_count"] == 3
    c = client.post(f"/api/sectors/{sid}/jobs", headers=admin, json={"idempotency_key": uuid.uuid4().hex})
    assert c.status_code == 409
    assert len(client.get(f"/api/sectors/{sid}/jobs", headers=admin).json()) == 1


def test_cancel_queued_job(client, admin, sector, engine_ok):
    sid = sector["sector"]["id"]
    _photos(client, admin, sid, 3)
    j = client.post(f"/api/sectors/{sid}/jobs", headers=admin, json={"idempotency_key": uuid.uuid4().hex}).json()
    r = client.post(f"/api/jobs/{j['id']}/cancel", headers=admin).json()
    assert r["status"] == "cancelled"
    assert client.post(f"/api/jobs/{j['id']}/cancel", headers=admin).status_code == 409
    # Un trabajador que reciba el mensaje después no lo ejecuta.
    from app.engine.pipeline import JobRunner

    assert JobRunner(uuid.UUID(j["id"])).run().startswith("ya terminado")
    ev = [e["message"] for e in client.get(f"/api/jobs/{j['id']}/events", headers=admin).json()]
    assert any("Cancelado" in m for m in ev)
