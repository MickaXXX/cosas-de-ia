"""Autenticación por token, autorización por proyecto y URLs firmadas de corta duración."""
import base64
import hashlib
import hmac
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import ApiToken, ModelVersion, Project, ProjectMember, Role, Sector, User

_bearer = HTTPBearer(auto_error=False)

ROLE_RANK = {Role.viewer: 1, Role.editor: 2, Role.owner: 3}


# --------------------------------------------------------------------------- contraseñas


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt_b64, dk_b64 = stored.split("$")
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(dk_b64)
    except ValueError:
        return False
    dk = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return hmac.compare_digest(dk, expected)


# --------------------------------------------------------------------------- tokens


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_token(db: Session, user: User) -> tuple[str, datetime]:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(hours=get_settings().token_ttl_hours)
    db.add(ApiToken(user_id=user.id, token_hash=_token_hash(token), expires_at=expires))
    db.commit()
    return token, expires


def revoke_token(db: Session, token: str) -> None:
    row = db.scalar(select(ApiToken).where(ApiToken.token_hash == _token_hash(token)))
    if row:
        db.delete(row)
        db.commit()


def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer), db: Session = Depends(get_db)
) -> User:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Se requiere iniciar sesión")
    row = db.scalar(select(ApiToken).where(ApiToken.token_hash == _token_hash(creds.credentials)))
    if row is None or row.expires_at < datetime.now(timezone.utc) or not row.user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sesión inválida o vencida")
    return row.user


# --------------------------------------------------------------------------- autorización


def project_role(db: Session, user: User, project_id: uuid.UUID) -> Role | None:
    if user.is_admin:
        return Role.owner
    m = db.scalar(
        select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.user_id == user.id)
    )
    return m.role if m else None


def require_project(db: Session, user: User, project_id: uuid.UUID, min_role: Role = Role.viewer) -> Project:
    project = db.get(Project, project_id)
    role = project_role(db, user, project_id) if project else None
    # 404 también cuando no hay acceso: no se revela la existencia de proyectos ajenos.
    if project is None or role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Proyecto no encontrado")
    if ROLE_RANK[role] < ROLE_RANK[min_role]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Permisos insuficientes en este proyecto")
    return project


def require_sector(db: Session, user: User, sector_id: uuid.UUID, min_role: Role = Role.viewer) -> Sector:
    sector = db.get(Sector, sector_id)
    if sector is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Sector no encontrado")
    require_project(db, user, sector.project_id, min_role)
    return sector


def require_model(db: Session, user: User, model_id: uuid.UUID, min_role: Role = Role.viewer) -> ModelVersion:
    mv = db.get(ModelVersion, model_id)
    if mv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Versión de modelo no encontrada")
    require_sector(db, user, mv.sector_id, min_role)
    return mv


# --------------------------------------------------------------------------- URLs firmadas


def sign_resource(resource: str, user_id: uuid.UUID, ttl: int | None = None) -> str:
    """Firma «recurso|usuario|vencimiento». La firma se vuelve a verificar contra permisos al servirse."""
    exp = int(time.time()) + (ttl or get_settings().signed_url_ttl_seconds)
    payload = f"{resource}|{user_id}|{exp}"
    mac = hmac.new(get_settings().secret_key.encode(), payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=") + "." + base64.urlsafe_b64encode(
        mac
    ).decode().rstrip("=")


def verify_signature(token: str) -> tuple[str, uuid.UUID]:
    try:
        p64, m64 = token.split(".")
        payload = base64.urlsafe_b64decode(p64 + "=" * (-len(p64) % 4)).decode()
        mac = base64.urlsafe_b64decode(m64 + "=" * (-len(m64) % 4))
        resource, uid, exp = payload.rsplit("|", 2)
    except Exception:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Enlace inválido")
    expected = hmac.new(get_settings().secret_key.encode(), payload.encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(mac, expected):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Enlace inválido")
    if int(exp) < time.time():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Enlace vencido")
    return resource, uuid.UUID(uid)
