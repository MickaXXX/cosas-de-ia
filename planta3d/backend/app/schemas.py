import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Vec3 = Annotated[list[float], Field(min_length=3, max_length=3)]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ------------------------------------------------------------------ auth
class LoginIn(BaseModel):
    email: str
    password: str


class UserOut(ORM):
    id: uuid.UUID
    email: str
    display_name: str
    is_admin: bool


class LoginOut(BaseModel):
    token: str
    expires_at: datetime
    user: UserOut


class UserCreate(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    display_name: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=10, max_length=200)
    is_admin: bool = False


class MemberIn(BaseModel):
    email: str
    role: Literal["owner", "editor", "viewer"]


class MemberOut(ORM):
    id: uuid.UUID
    role: str
    user: UserOut


# ------------------------------------------------------------------ proyectos
class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    site: str | None = Field(default=None, max_length=200)
    description: str | None = None


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    site: str | None = None
    description: str | None = None


class ProjectOut(ORM):
    id: uuid.UUID
    name: str
    site: str | None
    description: str | None
    created_at: datetime
    my_role: str | None = None
    sector_count: int = 0


class SectorIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    area_type: str | None = Field(default=None, max_length=100)
    description: str | None = None


class SectorPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    area_type: str | None = None
    description: str | None = None
    layout: dict | None = None

    @field_validator("layout")
    @classmethod
    def _layout(cls, v):
        if v is None:
            return v
        allowed = {"x", "y", "rotation", "width", "depth", "color", "level"}
        if set(v) - allowed:
            raise ValueError(f"campos de ubicación permitidos: {sorted(allowed)}")
        for k in v:
            if k != "color" and not isinstance(v[k], (int, float)):
                raise ValueError(f"{k} debe ser numérico")
        return v


class SectorOut(ORM):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    area_type: str | None
    description: str | None
    layout: dict
    created_at: datetime
    photo_count: int = 0
    latest_model_id: uuid.UUID | None = None
    latest_job_status: str | None = None


# ------------------------------------------------------------------ captura
class BatchIn(BaseModel):
    label: str | None = Field(default=None, max_length=200)
    expected_count: int | None = Field(default=None, ge=1)
    capture_date: str | None = Field(default=None, max_length=40)
    operating_condition: str | None = Field(default=None, max_length=300)
    device_notes: str | None = Field(default=None, max_length=300)


class BatchOut(ORM):
    id: uuid.UUID
    sector_id: uuid.UUID
    label: str | None
    status: str
    expected_count: int | None
    capture_date: str | None
    operating_condition: str | None
    device_notes: str | None
    created_at: datetime
    completed_at: datetime | None


class PhotoOut(ORM):
    id: uuid.UUID
    batch_id: uuid.UUID
    original_filename: str
    status: str
    reject_reason: str | None
    duplicate_of_id: uuid.UUID | None
    sha256: str | None
    size_bytes: int | None
    width: int | None
    height: int | None
    working_width: int | None
    working_height: int | None
    exif_orientation: int | None
    camera: dict
    camera_group: str | None
    quality: dict
    flags: list
    included: bool
    inclusion_log: list
    uploaded_at: datetime


class PhotoPatch(BaseModel):
    included: bool
    reason: str = Field(min_length=3, max_length=300)


# ------------------------------------------------------------------ trabajos
class JobIn(BaseModel):
    idempotency_key: str = Field(min_length=8, max_length=100)
    profile: Literal["rapido", "estandar", "detalle"] = "estandar"
    # Corrección manual de focal por grupo de cámara (píxeles, en la resolución orientada original).
    focal_overrides: dict[str, float] = Field(default_factory=dict)
    note: str | None = Field(default=None, max_length=300)


class JobOut(ORM):
    id: uuid.UUID
    sector_id: uuid.UUID
    idempotency_key: str
    status: str
    stage: str | None
    stage_started_at: datetime | None
    profile: str
    params: dict
    error_code: str | None
    error_message: str | None
    attempts: int
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    stages: list
    report: dict
    model_version_id: uuid.UUID | None
    photo_count: int = 0


class JobEventOut(ORM):
    id: int
    at: datetime
    level: str
    message: str
    data: dict


# ------------------------------------------------------------------ modelos
class ArtifactOut(ORM):
    id: uuid.UUID
    kind: str
    sha256: str
    size_bytes: int
    meta: dict
    created_at: datetime


class ModelOut(ORM):
    id: uuid.UUID
    sector_id: uuid.UUID
    number: int
    label: str | None
    source: str
    job_id: uuid.UUID | None
    coordinate_system: str
    alignment: list
    alignment_source: str | None
    scale_state: str
    scale_factor: float | None
    scale_method: str | None
    tolerance_abs_m: float | None
    tolerance_rel: float | None
    tolerance_purpose: str | None
    stats: dict
    notes: str | None
    created_at: datetime
    artifacts: list[ArtifactOut] = []


class ModelPatch(BaseModel):
    label: str | None = Field(default=None, max_length=200)
    notes: str | None = None
    alignment: list[float] | None = Field(default=None, min_length=16, max_length=16)
    alignment_source: str | None = Field(default=None, max_length=200)
    tolerance_abs_m: float | None = Field(default=None, gt=0)
    tolerance_rel: float | None = Field(default=None, gt=0, lt=1)
    tolerance_purpose: str | None = Field(default=None, max_length=300)


Unit = Literal["m", "cm", "mm", "in", "ft"]


class SegmentIn(BaseModel):
    label: str = Field(min_length=1, max_length=200)
    point_a: Vec3
    point_b: Vec3
    real_distance: float = Field(gt=0)
    unit: Unit = "m"
    source: str = Field(min_length=3, max_length=300, description="Instrumento y procedencia de la medida")
    endpoints_description: str | None = None


class SegmentOut(ORM):
    id: uuid.UUID
    label: str
    point_a: list[float]
    point_b: list[float]
    real_distance: float
    unit: str
    real_distance_m: float
    source: str
    endpoints_description: str | None
    created_at: datetime
    model_distance: float | None = None
    scaled_distance_m: float | None = None
    abs_error_m: float | None = None
    rel_error: float | None = None
    within_tolerance: bool | None = None


class CalibrationOut(BaseModel):
    scale_state: str
    scale_factor: float | None
    method: str | None
    references: list[SegmentOut]
    checks: list[SegmentOut]
    n_checks: int
    min_checks_required: int
    tolerance_abs_m: float | None
    tolerance_rel: float | None
    tolerance_purpose: str | None
    max_abs_error_m: float | None
    max_rel_error: float | None
    rms_error_m: float | None
    notice: str


class MeasureIn(BaseModel):
    point_a: Vec3
    point_b: Vec3


# ------------------------------------------------------------------ activos / anotaciones / documentos
class AssetIn(BaseModel):
    tag: str | None = Field(default=None, max_length=100)
    name: str = Field(min_length=1, max_length=200)
    asset_type: str | None = Field(default=None, max_length=100)
    description: str | None = None
    notes: str | None = None
    op_status: str | None = Field(default=None, max_length=100)
    op_status_source: str | None = Field(default=None, max_length=200)


class AssetPatch(BaseModel):
    tag: str | None = None
    name: str | None = Field(default=None, min_length=1, max_length=200)
    asset_type: str | None = None
    description: str | None = None
    notes: str | None = None
    op_status: str | None = None
    op_status_source: str | None = None


class AssetOut(ORM):
    id: uuid.UUID
    sector_id: uuid.UUID
    tag: str | None
    name: str
    asset_type: str | None
    description: str | None
    notes: str | None
    op_status: str | None
    op_status_source: str | None
    op_status_at: datetime | None
    created_at: datetime
    updated_at: datetime


class AnnotationIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    kind: Literal["equipo", "nota", "riesgo", "medicion", "inspeccion"] = "equipo"
    body: str | None = None
    position: Vec3
    normal: Vec3 | None = None
    asset_id: uuid.UUID | None = None
    extra: dict = Field(default_factory=dict)


class AnnotationPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    kind: Literal["equipo", "nota", "riesgo", "medicion", "inspeccion"] | None = None
    body: str | None = None
    position: Vec3 | None = None
    normal: Vec3 | None = None
    asset_id: uuid.UUID | None = None
    extra: dict | None = None


class AnnotationOut(ORM):
    id: uuid.UUID
    model_version_id: uuid.UUID
    asset_id: uuid.UUID | None
    kind: str
    title: str
    body: str | None
    position: list[float]
    normal: list[float] | None
    extra: dict
    created_at: datetime
    updated_at: datetime


class TransferIn(BaseModel):
    from_model_id: uuid.UUID
    to_model_id: uuid.UUID
    annotation_ids: list[uuid.UUID]
    transform: list[float] = Field(min_length=16, max_length=16, description="Matriz 4x4 fila-mayor origen→destino")
    review_note: str = Field(min_length=5, max_length=500)


class DocumentOut(ORM):
    id: uuid.UUID
    sector_id: uuid.UUID
    asset_id: uuid.UUID | None
    annotation_id: uuid.UUID | None
    kind: str
    title: str
    url: str | None
    mime: str | None
    size_bytes: int | None
    source_photo_id: uuid.UUID | None
    created_at: datetime


class SignedUrlOut(BaseModel):
    url: str
    expires_in: int
