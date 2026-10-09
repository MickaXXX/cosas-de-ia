import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import ModelVersion, PhotoStatus, ProcessingJob, Project, ProjectMember, Role, Sector, SourcePhoto, User
from ..schemas import (
    MemberIn,
    MemberOut,
    ProjectIn,
    ProjectOut,
    ProjectPatch,
    SectorIn,
    SectorOut,
    SectorPatch,
)
from ..security import current_user, project_role, require_project, require_sector

router = APIRouter(prefix="/api", tags=["proyectos y sectores"])


def _project_out(db: Session, p: Project, user: User) -> ProjectOut:
    out = ProjectOut.model_validate(p)
    role = project_role(db, user, p.id)
    out.my_role = role.value if role else None
    out.sector_count = db.scalar(select(func.count()).select_from(Sector).where(Sector.project_id == p.id)) or 0
    return out


@router.get("/projects", response_model=list[ProjectOut])
def list_projects(user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = select(Project).order_by(Project.created_at.desc())
    if not user.is_admin:
        q = q.join(ProjectMember, ProjectMember.project_id == Project.id).where(ProjectMember.user_id == user.id)
    return [_project_out(db, p, user) for p in db.scalars(q)]


@router.post("/projects", response_model=ProjectOut, status_code=201)
def create_project(body: ProjectIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = Project(name=body.name, site=body.site, description=body.description, created_by_id=user.id)
    db.add(p)
    db.flush()
    db.add(ProjectMember(project_id=p.id, user_id=user.id, role=Role.owner))
    db.commit()
    return _project_out(db, p, user)


@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _project_out(db, require_project(db, user, project_id), user)


@router.patch("/projects/{project_id}", response_model=ProjectOut)
def patch_project(project_id: uuid.UUID, body: ProjectPatch, user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    p = require_project(db, user, project_id, Role.editor)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(p, k, v)
    db.commit()
    return _project_out(db, p, user)


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = require_project(db, user, project_id, Role.owner)
    active = db.scalar(select(func.count()).select_from(ProcessingJob).join(Sector)
                       .where(Sector.project_id == p.id,
                              ProcessingJob.status.in_(["queued", "validating", "reconstructing", "converting",
                                                        "cancelling"])))
    if active:
        raise HTTPException(status.HTTP_409_CONFLICT, "Hay trabajos activos; cancélalos antes de eliminar")
    # Los archivos en disco se conservan; la eliminación física es una operación de respaldo explícita.
    db.delete(p)
    db.commit()


# ------------------------------------------------------------------ miembros


@router.get("/projects/{project_id}/members", response_model=list[MemberOut])
def list_members(project_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_project(db, user, project_id)
    return list(db.scalars(select(ProjectMember).where(ProjectMember.project_id == project_id)))


@router.post("/projects/{project_id}/members", response_model=MemberOut, status_code=201)
def add_member(project_id: uuid.UUID, body: MemberIn, user: User = Depends(current_user),
               db: Session = Depends(get_db)):
    require_project(db, user, project_id, Role.owner)
    target = db.scalar(select(User).where(func.lower(User.email) == body.email.strip().lower()))
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No existe un usuario con ese correo")
    m = db.scalar(select(ProjectMember).where(ProjectMember.project_id == project_id,
                                              ProjectMember.user_id == target.id))
    if m:
        m.role = Role(body.role)
    else:
        m = ProjectMember(project_id=project_id, user_id=target.id, role=Role(body.role))
        db.add(m)
    db.commit()
    return m


@router.delete("/projects/{project_id}/members/{member_id}", status_code=204)
def remove_member(project_id: uuid.UUID, member_id: uuid.UUID, user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    require_project(db, user, project_id, Role.owner)
    m = db.get(ProjectMember, member_id)
    if m is None or m.project_id != project_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Miembro no encontrado")
    owners = db.scalar(select(func.count()).select_from(ProjectMember)
                       .where(ProjectMember.project_id == project_id, ProjectMember.role == Role.owner))
    if m.role == Role.owner and owners <= 1:
        raise HTTPException(status.HTTP_409_CONFLICT, "El proyecto debe conservar al menos un propietario")
    db.delete(m)
    db.commit()


# ------------------------------------------------------------------ sectores


def _sector_out(db: Session, s: Sector) -> SectorOut:
    out = SectorOut.model_validate(s)
    out.photo_count = db.scalar(select(func.count()).select_from(SourcePhoto).where(
        SourcePhoto.sector_id == s.id, SourcePhoto.status == PhotoStatus.accepted)) or 0
    out.latest_model_id = db.scalar(select(ModelVersion.id).where(ModelVersion.sector_id == s.id)
                                    .order_by(ModelVersion.number.desc()).limit(1))
    st = db.scalar(select(ProcessingJob.status).where(ProcessingJob.sector_id == s.id)
                   .order_by(ProcessingJob.created_at.desc()).limit(1))
    out.latest_job_status = st.value if st else None
    return out


@router.get("/projects/{project_id}/sectors", response_model=list[SectorOut])
def list_sectors(project_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_project(db, user, project_id)
    return [_sector_out(db, s) for s in db.scalars(select(Sector).where(Sector.project_id == project_id)
                                                   .order_by(Sector.created_at))]


@router.post("/projects/{project_id}/sectors", response_model=SectorOut, status_code=201)
def create_sector(project_id: uuid.UUID, body: SectorIn, user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    require_project(db, user, project_id, Role.editor)
    n = db.scalar(select(func.count()).select_from(Sector).where(Sector.project_id == project_id)) or 0
    s = Sector(project_id=project_id, name=body.name, area_type=body.area_type, description=body.description,
               created_by_id=user.id, layout={"x": (n % 4) * 14.0, "y": (n // 4) * 12.0, "rotation": 0,
                                              "width": 10.0, "depth": 8.0})
    db.add(s)
    db.commit()
    return _sector_out(db, s)


@router.get("/sectors/{sector_id}", response_model=SectorOut)
def get_sector(sector_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _sector_out(db, require_sector(db, user, sector_id))


@router.patch("/sectors/{sector_id}", response_model=SectorOut)
def patch_sector(sector_id: uuid.UUID, body: SectorPatch, user: User = Depends(current_user),
                 db: Session = Depends(get_db)):
    s = require_sector(db, user, sector_id, Role.editor)
    for k, v in body.model_dump(exclude_unset=True).items():
        if k == "layout":
            v = {**(s.layout or {}), **v}
        setattr(s, k, v)
    db.commit()
    return _sector_out(db, s)


@router.delete("/sectors/{sector_id}", status_code=204)
def delete_sector(sector_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)):
    s = require_sector(db, user, sector_id, Role.owner)
    active = db.scalar(select(func.count()).select_from(ProcessingJob).where(
        ProcessingJob.sector_id == s.id,
        ProcessingJob.status.in_(["queued", "validating", "reconstructing", "converting", "cancelling"])))
    if active:
        raise HTTPException(status.HTTP_409_CONFLICT, "Hay trabajos activos en el sector")
    db.delete(s)
    db.commit()
