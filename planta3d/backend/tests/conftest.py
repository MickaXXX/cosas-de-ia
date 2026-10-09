"""Pruebas contra PostgreSQL real (base planta3d_test). El esquema se crea con las migraciones Alembic."""
import io
import os
import tempfile
from pathlib import Path

os.environ.setdefault("P3D_DATABASE_URL", "postgresql+psycopg://planta3d:planta3d_dev@127.0.0.1:5432/planta3d_test")
os.environ.setdefault("P3D_DATA_DIR", tempfile.mkdtemp(prefix="p3d-test-"))
os.environ["P3D_SECRET_KEY"] = "test-secret"
os.environ["P3D_BOOTSTRAP_ADMIN_PASSWORD"] = "admin-test-password"

import numpy as np  # noqa: E402
import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402
from sqlalchemy import text  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session", autouse=True)
def _schema():
    from app.db import get_engine

    with get_engine().begin() as c:
        c.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public"))
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    command.upgrade(cfg, "head")
    yield


@pytest.fixture(autouse=True)
def _clean(_schema, monkeypatch):
    from app.db import get_engine

    with get_engine().begin() as c:
        tables = [r[0] for r in c.execute(text(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'alembic_version'"))]
        c.execute(text("TRUNCATE " + ", ".join(tables) + " RESTART IDENTITY CASCADE"))
    import app.worker.tasks as tasks

    monkeypatch.setattr(tasks, "enqueue", lambda job_id: None)  # sin cola en pruebas de API
    yield


@pytest.fixture()
def client():
    from app.main import app

    with TestClient(app) as c:
        yield c


def login(client, email, password):
    r = client.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture()
def admin(client):
    return login(client, "admin@planta3d.local", "admin-test-password")


@pytest.fixture()
def make_user(client, admin):
    def _make(email, password="clave-segura-123"):
        r = client.post("/api/users", headers=admin, json={"email": email, "display_name": email.split("@")[0],
                                                           "password": password})
        assert r.status_code == 201, r.text
        return login(client, email, password)
    return _make


@pytest.fixture()
def sector(client, admin):
    p = client.post("/api/projects", headers=admin, json={"name": "Proyecto prueba"}).json()
    s = client.post(f"/api/projects/{p['id']}/sectors", headers=admin, json={"name": "Sala de bombas"}).json()
    return {"project": p, "sector": s}


def jpeg_bytes(w=1200, h=900, seed=0, exif=None, blur=False, quality=92) -> bytes:
    rng = np.random.default_rng(seed)
    arr = (rng.random((h // 8, w // 8, 3)) * 255).astype(np.uint8)
    img = Image.fromarray(arr).resize((w, h), Image.Resampling.NEAREST)
    if blur:
        from PIL import ImageFilter

        img = img.filter(ImageFilter.GaussianBlur(12))
    buf = io.BytesIO()
    kw = {"quality": quality}
    if exif is not None:
        kw["exif"] = exif
    img.save(buf, "JPEG", **kw)
    return buf.getvalue()


def upload(client, headers, batch_id, name, data, ctype="image/jpeg"):
    return client.post(f"/api/batches/{batch_id}/photos", headers=headers, files={"file": (name, data, ctype)})
