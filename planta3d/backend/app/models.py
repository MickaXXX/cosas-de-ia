"""Modelo de datos. El estado autoritativo de los trabajos vive aquí (PostgreSQL), no en la cola."""
import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> uuid.UUID:
    return uuid.uuid4()


class Timestamped:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )


# --------------------------------------------------------------------------- usuarios y acceso


class Role(str, enum.Enum):
    owner = "owner"
    editor = "editor"
    viewer = "viewer"


class User(Timestamped, Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(300), nullable=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class ApiToken(Base):
    __tablename__ = "api_tokens"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    user: Mapped[User] = relationship()


class ProjectMember(Base):
    __tablename__ = "project_members"
    __table_args__ = (UniqueConstraint("project_id", "user_id"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role: Mapped[Role] = mapped_column(Enum(Role, name="member_role"), nullable=False)
    user: Mapped[User] = relationship()


# --------------------------------------------------------------------------- proyectos


class Project(Timestamped, Base):
    __tablename__ = "projects"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    site: Mapped[str | None] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    sectors: Mapped[list["Sector"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class Sector(Timestamped, Base):
    __tablename__ = "sectors"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    area_type: Mapped[str | None] = mapped_column(String(100))  # sala de bombas, skid, ...
    description: Mapped[str | None] = mapped_column(Text)
    # Ubicación esquemática en el plano de planta (no es un registro geométrico entre sectores).
    layout: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    project: Mapped[Project] = relationship(back_populates="sectors")


# --------------------------------------------------------------------------- captura


class BatchStatus(str, enum.Enum):
    uploading = "uploading"
    completed = "completed"
    cancelled = "cancelled"


class CaptureBatch(Timestamped, Base):
    __tablename__ = "capture_batches"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)
    sector_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sectors.id", ondelete="CASCADE"), nullable=False)
    label: Mapped[str | None] = mapped_column(String(200))
    status: Mapped[BatchStatus] = mapped_column(Enum(BatchStatus, name="batch_status"), default=BatchStatus.uploading)
    expected_count: Mapped[int | None] = mapped_column(Integer)
    capture_date: Mapped[str | None] = mapped_column(String(40))
    operating_condition: Mapped[str | None] = mapped_column(String(300))
    device_notes: Mapped[str | None] = mapped_column(String(300))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PhotoStatus(str, enum.Enum):
    accepted = "accepted"  # válida y en el conjunto de trabajo
    rejected = "rejected"  # formato/archivo inválido (no hay copia de trabajo)
    duplicate = "duplicate"  # contenido idéntico a otra foto del sector


class SourcePhoto(Base):
    __tablename__ = "source_photos"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)
    batch_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("capture_batches.id", ondelete="CASCADE"), nullable=False)
    sector_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sectors.id", ondelete="CASCADE"), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(300), nullable=False)
    status: Mapped[PhotoStatus] = mapped_column(Enum(PhotoStatus, name="photo_status"), nullable=False)
    reject_reason: Mapped[str | None] = mapped_column(Text)
    duplicate_of_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("source_photos.id", ondelete="SET NULL"))
    sha256: Mapped[str | None] = mapped_column(String(64), index=True)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    mime: Mapped[str | None] = mapped_column(String(50))
    # Rutas internas relativas al directorio de datos (nunca expuestas directamente).
    original_path: Mapped[str | None] = mapped_column(String(500))
    working_path: Mapped[str | None] = mapped_column(String(500))
    thumb_path: Mapped[str | None] = mapped_column(String(500))
    width: Mapped[int | None] = mapped_column(Integer)  # tras orientar
    height: Mapped[int | None] = mapped_column(Integer)
    working_width: Mapped[int | None] = mapped_column(Integer)
    working_height: Mapped[int | None] = mapped_column(Integer)
    working_scale: Mapped[float | None] = mapped_column(Float)  # working / orientada
    exif_orientation: Mapped[int | None] = mapped_column(Integer)
    camera: Mapped[dict] = mapped_column(JSON, default=dict)  # marca, modelo, lente, focal (sin GPS)
    camera_group: Mapped[str | None] = mapped_column(String(64))
    quality: Mapped[dict] = mapped_column(JSON, default=dict)  # métricas e indicadores
    flags: Mapped[list] = mapped_column(JSON, default=list)
    included: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    inclusion_log: Mapped[list] = mapped_column(JSON, default=list)  # registro de exclusiones/reinclusiones
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    uploaded_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


# --------------------------------------------------------------------------- trabajos


class JobStatus(str, enum.Enum):
    queued = "queued"
    validating = "validating"
    reconstructing = "reconstructing"
    converting = "converting"
    ready = "ready"
    failed = "failed"
    cancelling = "cancelling"
    cancelled = "cancelled"


ACTIVE_JOB_STATUSES = {JobStatus.queued, JobStatus.validating, JobStatus.reconstructing, JobStatus.converting}
TERMINAL_JOB_STATUSES = {JobStatus.ready, JobStatus.failed, JobStatus.cancelled}

# Transiciones válidas. Cualquier otra se rechaza.
JOB_TRANSITIONS: dict[JobStatus, set[JobStatus]] = {
    JobStatus.queued: {JobStatus.validating, JobStatus.cancelling, JobStatus.cancelled, JobStatus.failed},
    JobStatus.validating: {JobStatus.reconstructing, JobStatus.failed, JobStatus.cancelling, JobStatus.queued},
    JobStatus.reconstructing: {JobStatus.converting, JobStatus.failed, JobStatus.cancelling, JobStatus.queued},
    JobStatus.converting: {JobStatus.ready, JobStatus.failed, JobStatus.cancelling, JobStatus.queued},
    JobStatus.cancelling: {JobStatus.cancelled, JobStatus.failed},
    JobStatus.ready: set(),
    JobStatus.failed: set(),
    JobStatus.cancelled: set(),
}


class ProcessingJob(Timestamped, Base):
    __tablename__ = "processing_jobs"
    __table_args__ = (UniqueConstraint("sector_id", "idempotency_key", name="uq_job_idempotency"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)
    sector_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sectors.id", ondelete="CASCADE"), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus, name="job_status"), default=JobStatus.queued)
    stage: Mapped[str | None] = mapped_column(String(60))  # etapa interna actual
    stage_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    profile: Mapped[str] = mapped_column(String(40), default="estandar")
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    photo_ids: Mapped[list] = mapped_column(JSON, default=list)  # conjunto congelado al crear
    error_code: Mapped[str | None] = mapped_column(String(80))
    error_message: Mapped[str | None] = mapped_column(Text)  # mensaje accionable para la persona
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    worker_host: Mapped[str | None] = mapped_column(String(200))
    worker_pid: Mapped[int | None] = mapped_column(Integer)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    stages: Mapped[list] = mapped_column(JSON, default=list)  # [{name, status, started, finished, seconds, ...}]
    report: Mapped[dict] = mapped_column(JSON, default=dict)
    model_version_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class JobEvent(Base):
    __tablename__ = "job_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("processing_jobs.id", ondelete="CASCADE"), index=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    level: Mapped[str] = mapped_column(String(10), default="info")
    message: Mapped[str] = mapped_column(Text, nullable=False)
    data: Mapped[dict] = mapped_column(JSON, default=dict)


# --------------------------------------------------------------------------- modelos 3D


class ModelSource(str, enum.Enum):
    imported = "imported"
    reconstructed = "reconstructed"
    demo = "demo"


class ScaleState(str, enum.Enum):
    uncalibrated = "uncalibrated"
    calibrated_unverified = "calibrated_unverified"
    verified = "verified"


class ModelVersion(Timestamped, Base):
    __tablename__ = "model_versions"
    __table_args__ = (UniqueConstraint("sector_id", "number"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)
    sector_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sectors.id", ondelete="CASCADE"), nullable=False)
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    label: Mapped[str | None] = mapped_column(String(200))
    source: Mapped[ModelSource] = mapped_column(Enum(ModelSource, name="model_source"), nullable=False)
    job_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("processing_jobs.id", ondelete="SET NULL"))
    # Coordenadas: el GLB conserva las coordenadas del modelo (motor). La orientación y la escala se
    # guardan aparte y el visor las aplica; nunca se reescriben sobre el maestro.
    coordinate_system: Mapped[str] = mapped_column(String(200), default="")
    alignment: Mapped[list] = mapped_column(JSON, default=list)  # matriz 4x4 fila-mayor (rotación/traslación)
    alignment_source: Mapped[str | None] = mapped_column(String(200))
    scale_state: Mapped[ScaleState] = mapped_column(
        Enum(ScaleState, name="scale_state"), default=ScaleState.uncalibrated
    )
    scale_factor: Mapped[float | None] = mapped_column(Float)  # metros por unidad del modelo
    scale_method: Mapped[str | None] = mapped_column(String(200))
    tolerance_abs_m: Mapped[float | None] = mapped_column(Float)
    tolerance_rel: Mapped[float | None] = mapped_column(Float)
    tolerance_purpose: Mapped[str | None] = mapped_column(String(300))
    stats: Mapped[dict] = mapped_column(JSON, default=dict)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    artifacts: Mapped[list["ModelArtifact"]] = relationship(cascade="all, delete-orphan")


class ModelArtifact(Base):
    __tablename__ = "model_artifacts"
    __table_args__ = (UniqueConstraint("model_version_id", "kind"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)
    model_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("model_versions.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(50), nullable=False)  # web_glb, master_mesh, textured_ply, ...
    path: Mapped[str] = mapped_column(String(500), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class MeasureRole(str, enum.Enum):
    fit = "fit"  # referencia usada para ajustar la escala
    check = "check"  # medida reservada para comprobar


class CalibrationReference(Base):
    __tablename__ = "calibration_references"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)
    model_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("model_versions.id", ondelete="CASCADE"), nullable=False
    )
    label: Mapped[str] = mapped_column(String(200), nullable=False)
    point_a: Mapped[list] = mapped_column(JSON, nullable=False)  # coordenadas del modelo
    point_b: Mapped[list] = mapped_column(JSON, nullable=False)
    real_distance: Mapped[float] = mapped_column(Float, nullable=False)
    unit: Mapped[str] = mapped_column(String(10), default="m")
    real_distance_m: Mapped[float] = mapped_column(Float, nullable=False)
    source: Mapped[str] = mapped_column(String(300), nullable=False)  # instrumento / procedencia
    endpoints_description: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class ValidationCheck(Base):
    __tablename__ = "validation_checks"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)
    model_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("model_versions.id", ondelete="CASCADE"), nullable=False
    )
    label: Mapped[str] = mapped_column(String(200), nullable=False)
    point_a: Mapped[list] = mapped_column(JSON, nullable=False)
    point_b: Mapped[list] = mapped_column(JSON, nullable=False)
    real_distance: Mapped[float] = mapped_column(Float, nullable=False)
    unit: Mapped[str] = mapped_column(String(10), default="m")
    real_distance_m: Mapped[float] = mapped_column(Float, nullable=False)
    source: Mapped[str] = mapped_column(String(300), nullable=False)
    endpoints_description: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


# --------------------------------------------------------------------------- activos y anotaciones


class Asset(Timestamped, Base):
    __tablename__ = "assets"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)
    sector_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sectors.id", ondelete="CASCADE"), nullable=False)
    tag: Mapped[str | None] = mapped_column(String(100))  # TAG manual; nunca inferido
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    asset_type: Mapped[str | None] = mapped_column(String(100))
    description: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    # Estado operacional: solo manual o desde una fuente real, siempre con fecha y origen.
    op_status: Mapped[str | None] = mapped_column(String(100))
    op_status_source: Mapped[str | None] = mapped_column(String(200))
    op_status_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    op_status_set_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class Annotation(Timestamped, Base):
    __tablename__ = "annotations"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)
    model_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("model_versions.id", ondelete="CASCADE"), nullable=False
    )
    asset_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("assets.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(40), default="equipo")  # equipo, nota, riesgo, medicion
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str | None] = mapped_column(Text)
    position: Mapped[list] = mapped_column(JSON, nullable=False)  # coordenadas del modelo (no de pantalla)
    normal: Mapped[list | None] = mapped_column(JSON)
    extra: Mapped[dict] = mapped_column(JSON, default=dict)  # p.ej. segundo punto de una medición
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class DocumentLink(Base):
    __tablename__ = "document_links"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)
    sector_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sectors.id", ondelete="CASCADE"), nullable=False)
    asset_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("assets.id", ondelete="CASCADE"))
    annotation_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("annotations.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(20), nullable=False)  # link | file | photo
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    url: Mapped[str | None] = mapped_column(String(1000))
    file_path: Mapped[str | None] = mapped_column(String(500))
    mime: Mapped[str | None] = mapped_column(String(100))
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    source_photo_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("source_photos.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
