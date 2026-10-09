from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User
from ..schemas import LoginIn, LoginOut, UserCreate, UserOut
from ..security import _bearer, current_user, hash_password, issue_token, revoke_token, verify_password

router = APIRouter(prefix="/api", tags=["autenticación"])


@router.post("/auth/login", response_model=LoginOut)
def login(body: LoginIn, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(func.lower(User.email) == body.email.strip().lower()))
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Correo o contraseña incorrectos")
    token, exp = issue_token(db, user)
    return LoginOut(token=token, expires_at=exp, user=UserOut.model_validate(user))


@router.post("/auth/logout", status_code=204)
def logout(creds: HTTPAuthorizationCredentials | None = Depends(_bearer), db: Session = Depends(get_db)):
    if creds:
        revoke_token(db, creds.credentials)


@router.get("/auth/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user


@router.get("/users", response_model=list[UserOut])
def list_users(user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administradores")
    return list(db.scalars(select(User).order_by(User.email)))


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(body: UserCreate, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administradores")
    email = body.email.strip().lower()
    if db.scalar(select(User).where(func.lower(User.email) == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Ya existe un usuario con ese correo")
    u = User(email=email, display_name=body.display_name, password_hash=hash_password(body.password),
             is_admin=body.is_admin)
    db.add(u)
    db.commit()
    return u
