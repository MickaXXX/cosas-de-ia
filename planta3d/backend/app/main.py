import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select

from .api import annotations, auth, captures, files, jobs, models3d, projects
from .config import get_settings
from .db import session_factory
from .models import User
from .security import hash_password

logger = logging.getLogger("planta3d")


def bootstrap_admin() -> None:
    s = get_settings()
    db = session_factory()()
    try:
        if (db.scalar(select(func.count()).select_from(User)) or 0) == 0:
            db.add(User(email=s.bootstrap_admin_email.lower(), display_name="Administración",
                        password_hash=hash_password(s.bootstrap_admin_password), is_admin=True))
            db.commit()
            logger.warning("Usuario inicial creado: %s (cambia la contraseña)", s.bootstrap_admin_email)
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_settings().data_dir.mkdir(parents=True, exist_ok=True)
    bootstrap_admin()
    yield


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title=f"{s.app_name} API", version="0.1.0", lifespan=lifespan,
                  description="Reconstrucción fotogramétrica y documentación de sectores industriales. "
                              "Todas las rutas requieren token Bearer salvo /api/auth/login y /api/health.")
    app.add_middleware(CORSMiddleware, allow_origins=s.cors_origins, allow_credentials=False,
                       allow_methods=["*"], allow_headers=["*"])
    for r in (auth, projects, captures, jobs, models3d, annotations, files):
        app.include_router(r.router)

    @app.get("/api/health", tags=["sistema"])
    def health():
        return {"status": "ok", "app": s.app_name}

    @app.get("/api/config/public", tags=["sistema"])
    def public_config():
        return {"app_name": s.app_name, "max_photo_mb": s.max_photo_mb, "max_photos_per_batch": s.max_photos_per_batch,
                "accepted_formats": ["image/jpeg", "image/png"], "min_validation_checks": s.min_validation_checks,
                "default_tolerance_abs_m": s.default_tolerance_abs_m, "default_tolerance_rel": s.default_tolerance_rel}

    # Interfaz web compilada (opcional): se sirve desde el mismo origen.
    dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if dist.exists():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            if path.startswith("api/"):
                from fastapi import HTTPException

                raise HTTPException(404, "Ruta de API inexistente")
            f = (dist / path).resolve()
            if path and f.is_file() and dist in f.parents:
                return FileResponse(f)
            return FileResponse(dist / "index.html")
    return app


app = create_app()
