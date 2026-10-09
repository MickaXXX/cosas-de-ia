"""Acceso privado y aislamiento entre proyectos (prueba de aceptación 7)."""
import time

from app.security import sign_resource

from .conftest import jpeg_bytes, upload


def test_requires_auth(client):
    assert client.get("/api/projects").status_code == 401
    assert client.get("/api/projects", headers={"Authorization": "Bearer inventado"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "admin@planta3d.local", "password": "mala"}).status_code == 401


def test_project_isolation_and_roles(client, admin, make_user, sector):
    alice = make_user("alice@planta3d.local")
    pid, sid = sector["project"]["id"], sector["sector"]["id"]
    # Alice no ve ni puede tocar el proyecto ajeno: 404 (no se revela su existencia).
    assert client.get("/api/projects", headers=alice).json() == []
    for path in (f"/api/projects/{pid}", f"/api/sectors/{sid}", f"/api/sectors/{sid}/photos",
                 f"/api/sectors/{sid}/models", f"/api/sectors/{sid}/assets", f"/api/sectors/{sid}/diagnostics"):
        assert client.get(path, headers=alice).status_code == 404, path
    assert client.post(f"/api/sectors/{sid}/batches", headers=alice, json={}).status_code == 404

    # Foto subida por el admin + enlace firmado.
    b = client.post(f"/api/sectors/{sid}/batches", headers=admin, json={}).json()
    ph = upload(client, admin, b["id"], "a.jpg", jpeg_bytes()).json()
    assert client.get(f"/api/photos/{ph['id']}/url", headers=alice).status_code == 404

    # Como lectora: ve, pero no edita ni descarga originales.
    assert client.post(f"/api/projects/{pid}/members", headers=admin,
                       json={"email": "alice@planta3d.local", "role": "viewer"}).status_code == 201
    assert client.get(f"/api/sectors/{sid}", headers=alice).status_code == 200
    assert client.post(f"/api/sectors/{sid}/batches", headers=alice, json={}).status_code == 403
    assert client.get(f"/api/photos/{ph['id']}/url?variant=original", headers=alice).status_code == 403
    thumb = client.get(f"/api/photos/{ph['id']}/url?variant=thumb", headers=alice).json()["url"]
    assert client.get(thumb).status_code == 200

    # Al revocar el acceso, el enlace ya emitido deja de servir.
    mid = next(m["id"] for m in client.get(f"/api/projects/{pid}/members", headers=admin).json()
               if m["user"]["email"] == "alice@planta3d.local")
    assert client.delete(f"/api/projects/{pid}/members/{mid}", headers=admin).status_code == 204
    assert client.get(thumb).status_code == 404


def test_signed_url_tampering_and_expiry(client, admin, sector):
    sid = sector["sector"]["id"]
    b = client.post(f"/api/sectors/{sid}/batches", headers=admin, json={}).json()
    ph = upload(client, admin, b["id"], "a.jpg", jpeg_bytes()).json()
    url = client.get(f"/api/photos/{ph['id']}/url?variant=original", headers=admin).json()["url"]
    assert client.get(url).status_code == 200
    payload, mac = url.rsplit("/", 1)[1].split(".")
    assert client.get(f"/api/files/{payload}.{mac[:-2]}AA").status_code == 403
    me = client.get("/api/auth/me", headers=admin).json()
    import uuid

    expired = sign_resource(f"photo:{ph['id']}:original", uuid.UUID(me["id"]), ttl=-5)
    time.sleep(0.01)
    assert client.get(f"/api/files/{expired}").status_code == 403


def test_last_owner_cannot_be_removed(client, admin, sector):
    pid = sector["project"]["id"]
    m = client.get(f"/api/projects/{pid}/members", headers=admin).json()[0]
    assert client.delete(f"/api/projects/{pid}/members/{m['id']}", headers=admin).status_code == 409


def test_path_traversal_rejected():
    import pytest

    from app.storage import get_storage

    with pytest.raises(ValueError):
        get_storage().path("../../etc/passwd")


def test_production_refuses_dev_secrets():
    import pytest

    from app.config import Settings, check_production

    with pytest.raises(RuntimeError):
        check_production(Settings(environment="production", secret_key="dev-insecure-change-me",
                                  bootstrap_admin_password="x" * 20))
    with pytest.raises(RuntimeError):
        check_production(Settings(environment="production", secret_key="a" * 64,
                                  bootstrap_admin_password="cambiar-esta-clave"))
    check_production(Settings(environment="production", secret_key="a" * 64, bootstrap_admin_password="x" * 20))
