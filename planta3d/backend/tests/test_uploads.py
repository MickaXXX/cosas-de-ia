"""Validación de fotos: formato real, corruptos, duplicados, orientación EXIF, sin GPS (prueba de aceptación 2)."""
import hashlib
import io

from PIL import Image

from app.storage import get_storage

from .conftest import jpeg_bytes, upload


def _batch(client, h, sid):
    return client.post(f"/api/sectors/{sid}/batches", headers=h, json={"label": "lote"}).json()["id"]


def test_accept_and_preserve_original(client, admin, sector):
    sid = sector["sector"]["id"]
    bid = _batch(client, admin, sid)
    data = jpeg_bytes(seed=1)
    r = upload(client, admin, bid, "foto.jpg", data)
    assert r.status_code == 201
    p = r.json()
    assert p["status"] == "accepted" and p["included"]
    assert p["sha256"] == hashlib.sha256(data).hexdigest()
    # El original queda inmutable y byte a byte idéntico.
    from app.db import session_factory
    from app.models import SourcePhoto

    db = session_factory()()
    row = db.get(SourcePhoto, __import__("uuid").UUID(p["id"]))
    orig = get_storage().path(row.original_path)
    assert orig.read_bytes() == data
    assert oct(orig.stat().st_mode)[-3:] == "444"
    db.close()


def test_rejections(client, admin, sector):
    sid = sector["sector"]["id"]
    bid = _batch(client, admin, sid)
    good = jpeg_bytes(seed=2)
    truncated = good[: len(good) // 2]
    r = upload(client, admin, bid, "cortada.jpg", truncated).json()
    assert r["status"] == "rejected" and "decodificar" in r["reject_reason"]
    r = upload(client, admin, bid, "ruido.jpg", b"esto no es una imagen" * 100).json()
    assert r["status"] == "rejected"
    heic = b"\x00\x00\x00\x18ftypheic" + b"\x00" * 200
    r = upload(client, admin, bid, "IMG_0001.HEIC", heic, "image/heic").json()
    assert r["status"] == "rejected" and "HEIC" in r["reject_reason"]
    zipf = b"PK\x03\x04" + b"\x00" * 100
    r = upload(client, admin, bid, "fotos.zip", zipf, "application/zip").json()
    assert r["status"] == "rejected" and "comprimido" in r["reject_reason"]
    small = jpeg_bytes(w=320, h=240)
    r = upload(client, admin, bid, "chica.jpg", small).json()
    assert r["status"] == "rejected" and "lado menor" in r["reject_reason"]
    # Las rechazadas no entran al conjunto de trabajo.
    d = client.get(f"/api/sectors/{sid}/diagnostics", headers=admin).json()
    assert d["included"] == 0 and d["by_status"]["rejected"] == 5


def test_png_accepted(client, admin, sector):
    bid = _batch(client, admin, sector["sector"]["id"])
    buf = io.BytesIO()
    Image.new("RGB", (800, 700), (10, 120, 200)).save(buf, "PNG")
    assert upload(client, admin, bid, "x.png", buf.getvalue(), "image/png").json()["status"] == "accepted"


def test_duplicates_and_idempotent_retry(client, admin, sector):
    sid = sector["sector"]["id"]
    bid = _batch(client, admin, sid)
    data = jpeg_bytes(seed=3)
    a = upload(client, admin, bid, "a.jpg", data).json()
    again = upload(client, admin, bid, "a.jpg", data).json()  # reintento del cliente
    assert again["id"] == a["id"]
    dup = upload(client, admin, bid, "copia.jpg", data).json()
    assert dup["status"] == "duplicate" and dup["duplicate_of_id"] == a["id"] and not dup["included"]
    bid2 = _batch(client, admin, sid)
    assert upload(client, admin, bid2, "a.jpg", data).json()["status"] == "duplicate"


def test_exif_orientation_applied_once_and_gps_not_stored(client, admin, sector):
    bid = _batch(client, admin, sector["sector"]["id"])
    base = Image.open(io.BytesIO(jpeg_bytes(w=1200, h=800, seed=4)))
    exif = base.getexif()
    exif[0x0112] = 6  # rotar 90° al mostrar
    exif[0x010F] = "MarcaX"
    exif[0x0110] = "TelefonoY"
    gps = exif.get_ifd(0x8825)
    gps[1] = "S"
    gps[2] = (23.0, 39.0, 0.0)
    buf = io.BytesIO()
    base.save(buf, "JPEG", exif=exif, quality=92)
    p = upload(client, admin, bid, "rotada.jpg", buf.getvalue()).json()
    assert p["status"] == "accepted"
    assert (p["width"], p["height"]) == (800, 1200)  # orientada
    assert p["exif_orientation"] == 6
    assert p["camera"]["has_gps"] is True
    assert "gps" not in str(p["camera"]).lower().replace("has_gps", "")
    from app.db import session_factory
    from app.models import SourcePhoto

    db = session_factory()()
    row = db.get(SourcePhoto, __import__("uuid").UUID(p["id"]))
    work = Image.open(get_storage().path(row.working_path))
    assert work.size == (800, 1200)
    assert not work.getexif().get(0x0112)  # sin etiqueta: no puede rotarse dos veces
    assert not work.getexif().get_ifd(0x8825)
    db.close()


def test_blur_flags_relative(client, admin, sector):
    sid = sector["sector"]["id"]
    bid = _batch(client, admin, sid)
    for i in range(6):
        upload(client, admin, bid, f"n{i}.jpg", jpeg_bytes(seed=10 + i))
    blurry = upload(client, admin, bid, "movida.jpg", jpeg_bytes(seed=99, blur=True)).json()
    client.post(f"/api/batches/{bid}/complete", headers=admin)
    photos = {p["id"]: p for p in client.get(f"/api/sectors/{sid}/photos", headers=admin).json()}
    assert "nitidez_baja_relativa" in photos[blurry["id"]]["flags"]
    assert sum("nitidez_baja_relativa" in p["flags"] for p in photos.values()) == 1
    # Indicador, no eliminación: sigue incluida hasta que una persona la excluya con motivo.
    assert photos[blurry["id"]]["included"]
    assert client.patch(f"/api/photos/{blurry['id']}", headers=admin, json={"included": False, "reason": ""}).status_code == 422
    r = client.patch(f"/api/photos/{blurry['id']}", headers=admin, json={"included": False, "reason": "Foto movida"}).json()
    assert not r["included"] and r["inclusion_log"][-1]["reason"] == "Foto movida"


def test_batch_cancel_excludes_with_log(client, admin, sector):
    sid = sector["sector"]["id"]
    bid = _batch(client, admin, sid)
    upload(client, admin, bid, "a.jpg", jpeg_bytes(seed=20))
    assert client.post(f"/api/batches/{bid}/cancel", headers=admin).json()["status"] == "cancelled"
    p = client.get(f"/api/sectors/{sid}/photos", headers=admin).json()[0]
    assert not p["included"] and p["inclusion_log"][-1]["reason"] == "lote cancelado"
    assert upload(client, admin, bid, "b.jpg", jpeg_bytes(seed=21)).status_code == 409
