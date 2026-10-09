"""Configuración central. Todo valor ajustable se lee de variables de entorno (prefijo P3D_)."""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="P3D_", env_file=".env", extra="ignore")

    app_name: str = "Planta 3D"
    database_url: str = "postgresql+psycopg://planta3d:planta3d_dev@127.0.0.1:5432/planta3d"
    redis_url: str = "redis://127.0.0.1:6379/0"
    data_dir: Path = Path("./data")
    # Clave para firmar URLs temporales de archivos. Obligatoria fuera de desarrollo.
    secret_key: str = "dev-insecure-change-me"
    environment: str = "development"  # development | production
    cors_origins: list[str] = ["http://127.0.0.1:5173", "http://localhost:5173"]

    # Usuario inicial (solo se crea si no existe ningún usuario).
    bootstrap_admin_email: str = "admin@planta3d.local"
    bootstrap_admin_password: str = "cambiar-esta-clave"
    token_ttl_hours: int = 12
    signed_url_ttl_seconds: int = 900

    # Límites de carga
    max_photo_mb: float = 40.0
    max_photos_per_batch: int = 1500
    min_photo_side_px: int = 640
    max_photo_megapixels: float = 120.0
    max_document_mb: float = 50.0
    max_import_glb_mb: float = 400.0

    # Indicadores de calidad (umbrales iniciales; deben calibrarse con fotos reales)
    blur_relative_threshold: float = 0.35  # nitidez < 35 % de la mediana del lote => posible desenfoque
    blur_absolute_threshold: float = 15.0  # varianza del laplaciano (imagen a 1024 px)
    dark_fraction_threshold: float = 0.45  # fracción de píxeles con luminancia < 16
    bright_fraction_threshold: float = 0.25  # fracción de píxeles con luminancia > 245

    # Reconstrucción
    max_photos_per_job: int = 400  # la correspondencia exhaustiva crece en O(n²)
    stage_timeout_seconds: int = 6 * 3600
    job_max_attempts: int = 2
    openmvs_bin_dir: Path = Path("/opt/openmvs/bin/OpenMVS")
    engine_threads: int = 0  # 0 = automático

    # Presupuesto web (objetivos de ensayo, no garantías)
    web_max_triangles: int = 600_000
    web_target_glb_mb: float = 50.0
    web_max_texture_size: int = 4096  # muchos teléfonos no admiten texturas WebGL mayores

    # Validación dimensional
    min_validation_checks: int = 3
    default_tolerance_abs_m: float = 0.05
    default_tolerance_rel: float = 0.02

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


def check_production(s: Settings) -> None:
    if s.is_production and (s.secret_key.startswith("dev-") or len(s.secret_key) < 32):
        raise RuntimeError("P3D_SECRET_KEY debe configurarse en producción (≥ 32 caracteres aleatorios)")
    if s.is_production and s.bootstrap_admin_password in ("cambiar-esta-clave", ""):
        raise RuntimeError("P3D_BOOTSTRAP_ADMIN_PASSWORD debe configurarse en producción")


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.data_dir = s.data_dir.resolve()
    check_production(s)
    return s
