"""Pipeline de reconstrucción fotos → modelo texturizado → GLB, ejecutado por el trabajador.

Etapas (cada una verificable y registrada):
  validating     1 preprocess   copias de trabajo por perfil, grupos de cámara, focal inicial
  reconstructing 2 features     extracción SIFT (COLMAP)
                 3 matching     correspondencia exhaustiva + verificación geométrica (COLMAP)
                 4 sfm          SfM incremental: cámaras, puntos, ajuste de haces (COLMAP)
                 5 review       imágenes registradas y componentes desconectados
                 6 undistort    imágenes/cámaras sin distorsión para el denso (COLMAP)
                 7 densify      importación + mapas de profundidad multivista y fusión (OpenMVS)
                 8 mesh         malla maestra (OpenMVS ReconstructMesh), sin cierre de huecos
                 9 texture      simplificación controlada + texturizado (OpenMVS TextureMesh)
  converting    10 convert      verificación de orientación UV con fotos, conversión a GLB y verificación
                11 publish      informe, artefactos y versión de modelo

Reutilización tras una caída: una etapa solo se omite si su marcador coincide con el hash de parámetros
(encadenado con las etapas previas) y todos sus archivos de salida existen con el mismo SHA-256.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import socket
import sys
import time
import traceback
import uuid
from pathlib import Path

import numpy as np
from PIL import Image
from sqlalchemy import func, select

from ..config import get_settings
from ..db import session_factory
from ..jobstate import job_lock, log, now, transition
from ..models import (
    JobStatus,
    ModelArtifact,
    ModelSource,
    ModelVersion,
    PhotoStatus,
    ProcessingJob,
    SourcePhoto,
)
from ..storage import get_storage, sha256_file
from . import runner
from .capabilities import capabilities, hardware
from .convert import ConversionError, mesh_to_glb, read_textured_ply, verify_glb
from .texcheck import _load, check_texture_orientation, empty_color_area_fraction

PROFILES = {
    # max_side: copias de trabajo; dense_max: imágenes sin distorsión; dens_level: --resolution-level
    "rapido": {"max_side": 1600, "dense_max": 1600, "dens_level": 1, "dens_max_res": 1600, "tex_level": 0},
    "estandar": {"max_side": 2400, "dense_max": 2400, "dens_level": 1, "dens_max_res": 2400, "tex_level": 0},
    "detalle": {"max_side": 3200, "dense_max": 3200, "dens_level": 0, "dens_max_res": 3200, "tex_level": 0},
}

STAGE_LABELS = {
    "preprocess": "Preprocesamiento y perfil",
    "features": "Extracción de características",
    "matching": "Correspondencia de características",
    "sfm": "SfM: cámaras y puntos",
    "review": "Revisión de registro y componentes",
    "undistort": "Preparación para reconstrucción densa",
    "densify": "Profundidad multivista y fusión",
    "mesh": "Construcción de malla",
    "texture": "Simplificación y texturizado",
    "convert": "Verificación UV y conversión a GLB",
    "publish": "Informe y publicación",
}
STAGE_STATUS = {"preprocess": JobStatus.validating, **{k: JobStatus.reconstructing for k in (
    "features", "matching", "sfm", "review", "undistort", "densify", "mesh", "texture")},
    "convert": JobStatus.converting, "publish": JobStatus.converting}


class StageFailed(Exception):
    def __init__(self, code: str, message: str, detail: str | None = None):
        super().__init__(message)
        self.code, self.message, self.detail = code, message, detail


def _hash(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()


class JobRunner:
    def __init__(self, job_id: uuid.UUID):
        self.job_id = job_id
        self.s = get_settings()
        self.db = session_factory()()
        self.st = get_storage()
        self.work = self.st.path(f"jobs/{job_id}")
        self.chain = ""  # hash encadenado de etapas
        self.results: dict[str, dict] = {}
        self.stage_rows: list[dict] = []

    # ------------------------------------------------------------------ utilidades
    @property
    def job(self) -> ProcessingJob:
        return self.db.get(ProcessingJob, self.job_id)

    def _should_cancel(self) -> bool:
        self.db.expire_all()
        return self.job.status == JobStatus.cancelling

    def _heartbeat(self) -> None:
        j = self.job
        j.heartbeat_at = now()
        self.db.commit()

    def _on_start(self, pgid: int) -> None:
        j = self.job
        j.worker_pid = pgid
        j.worker_host = socket.gethostname()
        self.db.commit()

    def _save_stages(self) -> None:
        j = self.job
        j.stages = list(self.stage_rows)
        self.db.commit()

    def _run(self, name: str, args: list, cwd: Path, env: dict | None = None) -> runner.RunResult:
        res = runner.run([str(a) for a in args], cwd=cwd, log_prefix=self.work / "logs" / name,
                         timeout_s=self.s.stage_timeout_seconds, should_cancel=self._should_cancel,
                         on_start=self._on_start, heartbeat=self._heartbeat, env=env)
        self._cmds.append({"args": res.args, "exit_code": res.returncode, "seconds": round(res.seconds, 2),
                           "max_rss_mb": round(res.max_rss_mb, 1), "stdout": res.stdout_path,
                           "stderr": res.stderr_path})
        if res.returncode != 0:
            raise StageFailed(f"{name}_error", f"El comando {Path(args[0]).name} terminó con código "
                              f"{res.returncode}.", runner.tail(res.stderr_path) or runner.tail(res.stdout_path))
        return res

    def _colmap(self, stage: str, cfg: dict) -> dict:
        cfg = {**cfg, "summary_path": str(self.work / "summaries" / f"{stage}.json"),
               "threads": self.s.engine_threads or -1}
        (self.work / "summaries").mkdir(parents=True, exist_ok=True)
        cfg_path = self.work / "summaries" / f"{stage}.config.json"
        cfg_path.write_text(json.dumps(cfg, indent=2))
        backend = Path(__file__).resolve().parents[2]
        self._run(stage, [sys.executable, "-m", "app.engine.colmap_stage", stage, cfg_path], cwd=backend)
        return json.loads(Path(cfg["summary_path"]).read_text())

    def _openmvs(self, name: str, tool: str, args: list, cwd: Path) -> None:
        threads = ["--max-threads", str(self.s.engine_threads)] if self.s.engine_threads else []
        self._run(name, [self.s.openmvs_bin_dir / tool, *args, *threads, "--process-priority", "-1"], cwd=cwd)

    # ------------------------------------------------------------------ marcadores de etapa
    def _marker(self, name: str) -> Path:
        return self.work / "stages" / f"{name}.json"

    def _outputs_digest(self, outputs: list[Path]) -> dict:
        files: dict[str, dict] = {}
        for o in outputs:
            paths = sorted(p for p in o.rglob("*") if p.is_file()) if o.is_dir() else [o]
            for p in paths:
                files[str(p.relative_to(self.work))] = {"size": p.stat().st_size, "sha256": sha256_file(p)}
        return files

    def _try_reuse(self, name: str, params_hash: str) -> dict | None:
        m = self._marker(name)
        if not m.exists():
            return None
        try:
            data = json.loads(m.read_text())
        except json.JSONDecodeError:
            return None
        if data.get("params_hash") != params_hash:
            return None
        for rel, meta in data.get("files", {}).items():
            p = self.work / rel
            if not p.exists() or p.stat().st_size != meta["size"] or sha256_file(p) != meta["sha256"]:
                return None
        return data

    def stage(self, name: str, params: dict, fn, outputs: list[Path]) -> dict:
        params_hash = _hash({"prev": self.chain, "stage": name, "params": params})
        if self._should_cancel():
            raise runner.Cancelled()
        status = STAGE_STATUS[name]
        j = self.job
        if j.status != status:
            transition(self.db, j, status)
        j = self.job
        j.stage, j.stage_started_at = name, now()
        self.db.commit()
        row = {"name": name, "label": STAGE_LABELS[name], "status": "running", "started_at": now().isoformat()}
        self.stage_rows.append(row)
        self._save_stages()
        reused = self._try_reuse(name, params_hash)
        if reused is not None:
            row.update(status="reused", seconds=reused.get("seconds"), commands=reused.get("commands", []),
                       finished_at=now().isoformat())
            log(self.db, self.job_id, f"Etapa «{STAGE_LABELS[name]}» reutilizada tras verificar archivos y "
                                      "parámetros", stage=name)
            self.chain = params_hash
            self.results[name] = reused.get("result", {})
            self._save_stages()
            return self.results[name]
        log(self.db, self.job_id, f"Inicio: {STAGE_LABELS[name]}", stage=name)
        self._cmds: list[dict] = []
        t0 = time.time()
        try:
            result = fn() or {}
        except runner.Cancelled:
            row.update(status="cancelled", seconds=round(time.time() - t0, 2), commands=self._cmds)
            self._save_stages()
            raise
        except StageFailed as e:
            row.update(status="failed", seconds=round(time.time() - t0, 2), commands=self._cmds,
                       error=e.message)
            self._save_stages()
            raise
        except Exception:
            row.update(status="failed", seconds=round(time.time() - t0, 2), commands=self._cmds)
            self._save_stages()
            raise
        secs = round(time.time() - t0, 2)
        files = self._outputs_digest(outputs)
        self._marker(name).parent.mkdir(parents=True, exist_ok=True)
        self._marker(name).write_text(json.dumps({"params_hash": params_hash, "files": files, "result": result,
                                                  "seconds": secs, "commands": self._cmds}, default=str))
        peak = max((c["max_rss_mb"] for c in self._cmds), default=None)
        row.update(status="done", seconds=secs, commands=self._cmds, max_rss_mb=peak,
                   finished_at=now().isoformat())
        self._save_stages()
        log(self.db, self.job_id, f"Fin: {STAGE_LABELS[name]} ({secs:.1f} s)", stage=name, seconds=secs)
        self.chain = params_hash
        self.results[name] = result
        return result

    # ------------------------------------------------------------------ ejecución
    def run(self) -> str:
        with job_lock(self.job_id) as got:
            if not got:
                return "otro trabajador ejecuta este trabajo"
            j = self.job
            if j is None:
                return "inexistente"
            if j.status in (JobStatus.ready, JobStatus.failed, JobStatus.cancelled):
                return f"ya terminado ({j.status.value})"
            if j.status == JobStatus.cancelling:
                transition(self.db, j, JobStatus.cancelled)
                return "cancelado antes de iniciar"
            j.attempts += 1
            j.started_at = j.started_at or now()
            j.worker_host = socket.gethostname()
            j.heartbeat_at = now()
            self.stage_rows = []
            self.db.commit()
            try:
                self._pipeline()
                return "ok"
            except runner.Cancelled:
                transition(self.db, self.job, JobStatus.cancelled, worker_pid=None)
                log(self.db, self.job_id, "Trabajo cancelado: procesos del motor terminados", "warning")
                return "cancelado"
            except (StageFailed, runner.StageTimeout, ConversionError) as e:
                code = getattr(e, "code", "tiempo_maximo" if isinstance(e, runner.StageTimeout) else "conversion")
                msg = getattr(e, "message", str(e))
                detail = getattr(e, "detail", None)
                self._fail(code, msg, detail)
                return "fallido"
            except Exception as e:  # noqa: BLE001
                self._fail("error_interno", f"Error interno del trabajador: {type(e).__name__}: {e}",
                           traceback.format_exc()[-4000:])
                return "fallido"
            finally:
                self.db.close()

    def _fail(self, code: str, message: str, detail: str | None) -> None:
        self.db.rollback()
        j = self.job
        if j.status == JobStatus.cancelling:
            transition(self.db, j, JobStatus.cancelled, worker_pid=None)
            return
        log(self.db, self.job_id, message, "error", code=code, detail=detail)
        report = dict(j.report or {})
        report["failure"] = {"code": code, "message": message, "detail": detail}
        report["stages"] = self.stage_rows
        transition(self.db, j, JobStatus.failed, error_code=code, error_message=message, report=report,
                   worker_pid=None)

    def _pipeline(self) -> None:
        caps = capabilities()
        if not caps["reconstruction_available"]:
            raise StageFailed("motor_no_disponible", "El motor de reconstrucción no está disponible en este "
                              "equipo: " + "; ".join(caps["reasons"]))
        self.work.mkdir(parents=True, exist_ok=True)
        j = self.job
        prof = PROFILES[j.profile]
        engine_ver = {"colmap": caps["colmap"]["version"], "openmvs": caps["openmvs"]["version"]}
        self.chain = _hash({"engine": engine_ver, "profile": prof})

        images = self.work / "images"
        manifest = self.stage("preprocess", {"photos": j.photo_ids, "focal": j.params.get("focal_overrides", {}),
                                             "max_side": prof["max_side"]},
                              lambda: self._preprocess(images, prof), [images])
        db_path = self.work / "colmap" / "database.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.stage("features", {}, lambda: self._colmap("features", {
            "database": str(db_path), "image_path": str(images), "groups": manifest["colmap_groups"],
            "max_image_size": prof["max_side"]}), [db_path])
        self.stage("matching", {"strategy": "exhaustive"},
                   lambda: self._colmap("matching", {"database": str(db_path)}), [db_path])
        sparse = self.work / "colmap" / "sparse"
        sfm = self.stage("sfm", {"seed": 1}, lambda: self._sfm(db_path, images, sparse), [sparse])
        review = self.stage("review", {}, lambda: self._review(sfm, manifest), [])
        dense = self.work / "dense"
        self.stage("undistort", {"max": prof["dense_max"]}, lambda: self._undistort(review, images, dense, prof),
                   [dense / "images", dense / "sparse"])
        self.stage("densify", {"level": prof["dens_level"], "max": prof["dens_max_res"]},
                   lambda: self._densify(dense, prof), [dense / "scene_dense.mvs", dense / "scene_dense.ply"])
        mesh = self.stage("mesh", {"close_holes": 0}, lambda: self._mesh(dense), [dense / "mesh_master.ply"])
        tex = self.stage("texture", {"budget": self.s.web_max_triangles, "seam_leveling": 0,
                                    "max_tex": self.s.web_max_texture_size},
                         lambda: self._texture(dense, mesh, prof), [dense / "textured.ply"])
        conv = self.stage("convert", {}, lambda: self._convert(dense, tex), [self.work / "output" / "model.glb"])
        self.stage("publish", {}, lambda: self._publish(manifest, sfm, review, mesh, tex, conv, caps), [])

    # ------------------------------------------------------------------ etapas
    def _preprocess(self, images: Path, prof: dict) -> dict:
        j = self.job
        if len(j.photo_ids) < 3:
            raise StageFailed("pocas_fotos", "Se requieren al menos 3 fotos (recomendado ≥ 20 con 70–80 % de "
                              "superposición).")
        if images.exists():
            shutil.rmtree(images)
        photos = {str(p.id): p for p in self.db.scalars(
            select(SourcePhoto).where(SourcePhoto.id.in_([uuid.UUID(x) for x in j.photo_ids])))}
        missing = [pid for pid in j.photo_ids if pid not in photos or photos[pid].status != PhotoStatus.accepted]
        if missing:
            raise StageFailed("fotos_no_disponibles", f"{len(missing)} foto(s) del trabajo ya no están disponibles.")
        groups: dict[str, list] = {}
        entries = []
        overrides = j.params.get("focal_overrides", {})
        for i, pid in enumerate(j.photo_ids):
            if i % 10 == 0 and self._should_cancel():
                raise runner.Cancelled()
            p = photos[pid]
            src = self.st.path(p.working_path)
            try:
                img = Image.open(src)
                img.load()
            except Exception as e:  # noqa: BLE001
                raise StageFailed("copia_ilegible", f"La copia de trabajo de «{p.original_filename}» no se puede "
                                  f"leer ({e}).")
            w, h = img.size
            s = min(1.0, prof["max_side"] / max(w, h))
            if s < 1.0:
                img = img.resize((round(w * s), round(h * s)), Image.Resampling.LANCZOS)
            g = (p.camera_group or "sin_grupo")[:16]
            rel = f"{g}/{p.id}.jpg"
            (images / g).mkdir(parents=True, exist_ok=True)
            img.save(images / rel, "JPEG", quality=95, subsampling=0)
            total_scale = (p.working_scale or 1.0) * s  # respecto de la imagen orientada original
            groups.setdefault(g, []).append(rel)
            prior = overrides.get(p.camera_group or "") or p.camera.get("focal_prior_px_oriented")
            entries.append({"photo_id": pid, "image": rel, "group": g, "filename": p.original_filename,
                            "width": img.width, "height": img.height, "scale_from_oriented": total_scale,
                            "focal_prior_px": prior * total_scale if prior else None,
                            "focal_source": ("corrección manual" if overrides.get(p.camera_group or "")
                                             else p.camera.get("focal_prior_source"))})
        colmap_groups = []
        assumptions = []
        for g, rels in groups.items():
            e = next(x for x in entries if x["group"] == g)
            sizes = {(x["width"], x["height"]) for x in entries if x["group"] == g}
            if len(sizes) != 1:
                raise StageFailed("intrinsecos_incoherentes", f"El grupo {g} mezcla resoluciones {sizes}: no se "
                                  "comparten intrínsecos con dimensiones incoherentes.")
            params = None
            if e["focal_prior_px"]:
                params = f"{e['focal_prior_px']:.3f},{e['width'] / 2:.3f},{e['height'] / 2:.3f},0"
            else:
                assumptions.append(f"Grupo {g}: sin focal conocida; COLMAP parte de 1,2 × lado mayor y la refina.")
            colmap_groups.append({"name": g, "images": rels, "camera_params": params})
        return {"entries": entries, "colmap_groups": colmap_groups, "assumptions": assumptions,
                "working_max_side": prof["max_side"]}

    def _sfm(self, db_path: Path, images: Path, sparse: Path) -> dict:
        if sparse.exists():
            shutil.rmtree(sparse)
        out = self._colmap("mapping", {"database": str(db_path), "image_path": str(images),
                                       "output_path": str(sparse)})
        if not out["components"]:
            raise StageFailed("sfm_sin_modelo", "No se pudo inicializar la reconstrucción: las fotos no comparten "
                              "suficientes puntos. Revisa superposición (70–80 %), textura de las superficies y "
                              "desplazamiento real entre tomas (no solo giro).")
        return out

    def _review(self, sfm: dict, manifest: dict) -> dict:
        comps = sfm["components"]
        best = comps[0]
        all_imgs = {e["image"] for e in manifest["entries"]}
        in_best = set(best["image_names"])
        in_other = set().union(*[set(c["image_names"]) for c in comps[1:]]) - in_best if len(comps) > 1 else set()
        unregistered = sorted(all_imgs - in_best - in_other)
        by_image = {e["image"]: e for e in manifest["entries"]}
        if best["registered_images"] < 3:
            raise StageFailed("registro_insuficiente", f"Solo {best['registered_images']} foto(s) quedaron "
                              "registradas en el componente principal.")
        warnings = []
        if len(comps) > 1:
            warnings.append(f"Se formaron {len(comps)} componentes desconectados. Se presenta el mayor "
                            f"({best['registered_images']} fotos). Los demás no se mezclan: no hay registro "
                            "geométrico entre ellos. Une los recorridos con fotos de zonas comunes.")
        ratio = best["registered_images"] / max(1, len(all_imgs))
        if ratio < 0.8:
            warnings.append(f"Solo {ratio:.0%} de las fotos quedó en el modelo presentado: el resultado NO "
                            "representa todo el conjunto capturado.")
        return {
            "presented_component": best["index"],
            "components": [{k: c[k] for k in ("index", "registered_images", "points3D",
                                               "mean_reprojection_error_px")} for c in comps],
            "registered": best["registered_images"],
            "total": len(all_imgs),
            "unregistered": [by_image[i]["filename"] for i in unregistered],
            "in_other_components": [by_image[i]["filename"] for i in sorted(in_other)],
            "warnings": warnings,
        }

    def _undistort(self, review: dict, images: Path, dense: Path, prof: dict) -> dict:
        if dense.exists():
            shutil.rmtree(dense)
        return self._colmap("undistort", {
            "input_path": str(self.work / "colmap" / "sparse" / str(review["presented_component"])),
            "image_path": str(images), "output_path": str(dense), "max_image_size": prof["dense_max"]})

    def _densify(self, dense: Path, prof: dict) -> dict:
        self._openmvs("openmvs_import", "InterfaceCOLMAP", ["-i", ".", "-o", "scene.mvs", "--image-folder",
                                                            "images"], cwd=dense)
        self._openmvs("densify", "DensifyPointCloud", [
            "-i", "scene.mvs", "--resolution-level", prof["dens_level"], "--max-resolution", prof["dens_max_res"],
            "--min-resolution", 640], cwd=dense)
        from plyfile import PlyData

        n = PlyData.read(str(dense / "scene_dense.ply"))["vertex"].count
        if n < 1000:
            raise StageFailed("denso_insuficiente", f"La nube densa solo tiene {n} puntos: superficies sin textura, "
                              "reflejos o poca superposición.")
        for f in dense.glob("depth*.dmap"):
            f.unlink()  # intermedios grandes; no se reutilizan
        return {"dense_points": n}

    def _mesh(self, dense: Path) -> dict:
        self._openmvs("mesh", "ReconstructMesh", ["-i", "scene_dense.mvs", "-o", "mesh_master.ply",
                                                  "--close-holes", 0], cwd=dense)
        from plyfile import PlyData

        ply = PlyData.read(str(dense / "mesh_master.ply"))
        return {"master_vertices": ply["vertex"].count, "master_faces": ply["face"].count}

    def _texture(self, dense: Path, mesh: dict, prof: dict) -> dict:
        faces = mesh["master_faces"]
        ratio = min(1.0, self.s.web_max_triangles / max(faces, 1))
        # La nivelación de costuras global/local está desactivada: en la compilación probada producía
        # regiones negras en el atlas (detectado por la verificación con fotos). Ver docs/HITO0.md.
        self._openmvs("texture", "TextureMesh", [
            "-i", "scene_dense.mvs", "-m", "mesh_master.ply", "-o", "textured.mvs", "--export-type", "ply",
            "--decimate", f"{ratio:.6f}", "--close-holes", 0, "--resolution-level", prof["tex_level"],
            "--global-seam-leveling", 0, "--local-seam-leveling", 0, "--texture-size-multiple", 256,
            "--max-texture-size", self.s.web_max_texture_size], cwd=dense)
        if not (dense / "textured.ply").exists():
            raise StageFailed("textura_sin_salida", "TextureMesh terminó sin generar textured.ply")
        return {"decimate_ratio": ratio}

    def _convert(self, dense: Path, tex: dict) -> dict:
        mesh = read_textured_ply(dense / "textured.ply")
        if mesh.face_uvs is None:
            raise StageFailed("sin_uv", "La malla texturizada no contiene coordenadas UV por cara.")
        check = check_texture_orientation(mesh, dense / "sparse", dense / "images")
        if check.get("status") != "concluyente":
            raise StageFailed("verificacion_uv", "No se pudo verificar la orientación de la textura contra las "
                              "fotos; no se publica un modelo con textura posiblemente invertida.", json.dumps(check))
        if min(check["median_abs_diff_v_origin_top"], check["median_abs_diff_v_origin_bottom"]) > 45:
            raise StageFailed("textura_inconsistente", "La textura no coincide con las fotos (diferencia de color "
                              "elevada).", json.dumps(check))
        atl = [_load(p, 4096)[0] for p in mesh.textures]
        empty = empty_color_area_fraction(mesh, atl, flip_v=check["flip_v"])
        out = self.work / "output" / "model.glb"
        stats = mesh_to_glb(mesh, out, flip_v=check["flip_v"], texture_max_side=self.s.web_max_texture_size,
                            generator="Planta 3D (COLMAP + OpenMVS)")
        verified = verify_glb(out, require_texture=True)
        if verified["triangles"] != len(mesh.faces):
            raise StageFailed("conversion_incoherente", "El GLB no conserva el número de triángulos de la malla.")
        return {"texture_check": check, "glb": verified, "convert": stats, "empty_area_fraction": empty}

    # ------------------------------------------------------------------ publicación
    def _alignment(self, rec_dir: Path, mesh_path: Path) -> tuple[list, dict]:
        """Orientación de visualización estimada (no reescribe el modelo): 'arriba' a partir del eje Y de
        las cámaras (fotos orientadas en vertical), ejes horizontales por PCA y suelo en y≈0."""
        import pycolmap
        from plyfile import PlyData

        rec = pycolmap.Reconstruction(rec_dir)
        downs = []
        for im in rec.images.values():
            if im.has_pose:
                R = im.cam_from_world().rotation.matrix()  # mundo→cámara
                downs.append(R.T @ np.array([0.0, 1.0, 0.0]))  # eje y de la cámara (abajo) en mundo
        down = np.mean(downs, axis=0)
        consistency = float(np.linalg.norm(down))  # 1 = todas las cámaras coinciden en «abajo»
        up = -down / max(np.linalg.norm(down), 1e-12)
        v = PlyData.read(str(mesh_path))["vertex"].data
        P = np.stack([v["x"], v["y"], v["z"]], 1).astype(np.float64)
        if len(P) > 200000:
            P = P[np.random.default_rng(0).choice(len(P), 200000, replace=False)]
        # Base ortonormal con y = up; x por PCA en el plano horizontal.
        tmp = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 0, 1.0])
        e1 = np.cross(up, tmp)
        e1 /= np.linalg.norm(e1)
        e2 = np.cross(e1, up)
        H = np.stack([(P - P.mean(0)) @ e1, (P - P.mean(0)) @ e2], 1)
        w, V = np.linalg.eigh(H.T @ H)
        major = V[:, -1]
        x_axis = major[0] * e1 + major[1] * e2
        x_axis /= np.linalg.norm(x_axis)
        z_axis = np.cross(x_axis, up)
        R = np.stack([x_axis, up, z_axis])  # filas: mundo→display
        Q = P @ R.T
        lo, hi = np.percentile(Q, 1, axis=0), np.percentile(Q, 99, axis=0)
        t = -np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2])
        M = np.eye(4)
        M[:3, :3] = R
        M[:3, 3] = t
        info = {"up_consistency": consistency,
                "source": "Estimada: «arriba» desde la orientación de las cámaras; ejes horizontales por PCA; "
                          "suelo en el percentil 1 de altura. Ajustable por la persona."}
        return M.reshape(-1).tolist(), info

    def _cameras_json(self, rec_dir: Path, manifest: dict, out: Path) -> int:
        import pycolmap

        rec = pycolmap.Reconstruction(rec_dir)
        by_rel = {e["image"]: e for e in manifest["entries"]}
        cams = []
        for im in rec.images.values():
            if not im.has_pose:
                continue
            e = by_rel.get(im.name)
            cfw = im.cam_from_world()
            R = cfw.rotation.matrix()
            cams.append({
                "photo_id": e["photo_id"] if e else None, "image": im.name,
                "filename": e["filename"] if e else im.name,
                # Convención COLMAP: X_cam = R·X_mundo + t. El centro es −Rᵀt (no t).
                "center": im.projection_center().tolist(),
                "world_from_cam_rotation": R.T.tolist(),
                "camera_model": im.camera.model_name, "params": list(im.camera.params),
                "width": im.camera.width, "height": im.camera.height,
            })
        out.write_text(json.dumps({"convention": "COLMAP: cámara mira +Z, x derecha, y abajo; coordenadas del "
                                                 "modelo", "cameras": cams}, ensure_ascii=False))
        return len(cams)

    def _publish(self, manifest, sfm, review, mesh, tex, conv, caps) -> dict:
        j = self.job
        dense = self.work / "dense"
        out_dir = self.work / "output"
        rec_dir = self.work / "colmap" / "sparse" / str(review["presented_component"])
        alignment, align_info = self._alignment(rec_dir, dense / "mesh_master.ply")
        n_cams = self._cameras_json(rec_dir, manifest, out_dir / "cameras.json")

        sector_photos = list(self.db.scalars(select(SourcePhoto).where(SourcePhoto.sector_id == j.sector_id)))
        best = next(c for c in sfm["components"] if c["index"] == review["presented_component"])
        stage_rows = [r for r in self.stage_rows if r["name"] != "publish"]
        warnings = list(review["warnings"])
        if conv["empty_area_fraction"] and conv["empty_area_fraction"] > 0.05:
            warnings.append(f"{conv['empty_area_fraction']:.1%} del área de la malla no tiene imagen asignada "
                            "(color naranja): son zonas no observadas o interpoladas.")
        report = {
            "generated_at": now().isoformat(),
            "photos": {
                "sector_received": len(sector_photos),
                "sector_rejected": sum(p.status == PhotoStatus.rejected for p in sector_photos),
                "sector_duplicates": sum(p.status == PhotoStatus.duplicate for p in sector_photos),
                "sector_excluded": sum(p.status == PhotoStatus.accepted and not p.included for p in sector_photos),
                "job_input": len(j.photo_ids),
                "registered_presented": review["registered"],
                "unregistered": review["unregistered"],
                "in_other_components": review["in_other_components"],
            },
            "components": review["components"],
            "presented_component": review["presented_component"],
            "reprojection_error_px": best["mean_reprojection_error_px"],
            "working_resolution_max_side": manifest["working_max_side"],
            "profile": j.profile,
            "intrinsics_assumptions": manifest["assumptions"],
            "dense_points": self.results.get("densify", {}).get("dense_points"),
            "mesh_master": mesh,
            "web_model": {"triangles": conv["glb"]["triangles"], "vertices": conv["glb"]["vertices"],
                          "bytes": conv["glb"]["bytes"], "textures": conv["glb"]["images"],
                          "decimate_ratio": tex["decimate_ratio"],
                          "budget": {"max_triangles": self.s.web_max_triangles,
                                     "target_mb": self.s.web_target_glb_mb,
                                     "note": "Objetivos de ensayo; medir en el dispositivo objetivo."}},
            "texture_check": conv["texture_check"],
            "unobserved_area_fraction": conv["empty_area_fraction"],
            "unobserved_area_method": "Área de caras con el color de relleno de TextureMesh (sin vista asignada). "
                                      "No es una medida de cobertura del sector.",
            "coverage": "No calculada: esta versión no dispone de un método validado de cobertura del sector.",
            "stages": stage_rows,
            "hardware": hardware(),
            "engine": {"colmap": caps["colmap"], "openmvs": caps["openmvs"],
                       "matching": "exhaustiva", "seed": 1},
            "alignment": align_info,
            "calibration": "Sin calibrar: la escala del modelo es arbitraria hasta registrar una referencia.",
            "warnings": warnings,
            "camera_poses": n_cams,
        }
        (out_dir / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str))

        # Versión de modelo + artefactos (idempotente: si ya existe para este trabajo, se reutiliza).
        mv = self.db.scalar(select(ModelVersion).where(ModelVersion.job_id == j.id))
        if mv is None:
            number = (self.db.scalar(select(func.max(ModelVersion.number))
                                     .where(ModelVersion.sector_id == j.sector_id)) or 0) + 1
            mv = ModelVersion(sector_id=j.sector_id, number=number, source=ModelSource.reconstructed, job_id=j.id,
                              label=f"Reconstrucción {now().strftime('%Y-%m-%d %H:%M')}",
                              created_by_id=j.created_by_id)
            self.db.add(mv)
            self.db.flush()
        mv.coordinate_system = ("Coordenadas del motor (COLMAP/OpenMVS), sin escala métrica. El GLB no lleva "
                                "transformación; orientación y escala se guardan aparte.")
        mv.alignment = alignment
        mv.alignment_source = align_info["source"]
        mv.stats = {"triangles": conv["glb"]["triangles"], "bytes": conv["glb"]["bytes"],
                    "bbox_min": conv["glb"]["bbox_min"], "bbox_max": conv["glb"]["bbox_max"],
                    "registered_photos": review["registered"], "components": len(review["components"]),
                    "master_faces": mesh["master_faces"]}
        base = f"models/{j.sector_id}/{mv.id}"
        files = {
            "web_glb": out_dir / "model.glb",
            "master_mesh_ply": dense / "mesh_master.ply",
            "textured_ply": dense / "textured.ply",
            "dense_points_ply": dense / "scene_dense.ply",
            "cameras_json": out_dir / "cameras.json",
            "report_json": out_dir / "report.json",
        }
        for i, t in enumerate(sorted(dense.glob("textured*.png")) + sorted(dense.glob("textured*.jpg"))):
            files[f"texture_{i}"] = t
        for kind, src in files.items():
            key = f"{base}/{kind}{src.suffix}"
            size, digest = self.st.put_file(key, src)
            art = self.db.scalar(select(ModelArtifact).where(ModelArtifact.model_version_id == mv.id,
                                                             ModelArtifact.kind == kind))
            if art is None:
                art = ModelArtifact(model_version_id=mv.id, kind=kind, path=key, sha256=digest, size_bytes=size)
                self.db.add(art)
            art.path, art.sha256, art.size_bytes = key, digest, size
            art.meta = {"source_file": src.name}
        self.db.commit()
        report["stages"] = [*stage_rows]
        transition(self.db, self.job, JobStatus.ready, model_version_id=mv.id, report=report, worker_pid=None,
                   stage=None)
        return {"model_version_id": str(mv.id)}
