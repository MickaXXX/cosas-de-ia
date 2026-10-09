"""Etapas COLMAP ejecutadas en un proceso independiente (cancelable con señales, con stdout/stderr propios).

Uso: python -m app.engine.colmap_stage <etapa> <config.json>

Se usa COLMAP 4.2.1 a través de su binding oficial `pycolmap` (misma biblioteca que la CLI). En este
entorno no hay binario `colmap` con CUDA; la elección y sus límites están documentados en
docs/ARQUITECTURA.md. Cada etapa escribe un resumen JSON en `summary_path`.
"""
import json
import sys
import time
from pathlib import Path

import pycolmap

SEED = 1  # semilla fija: ejecuciones reproducibles


def features(cfg: dict) -> dict:
    db = Path(cfg["database"])
    if db.exists():
        db.unlink()  # la etapa se repite completa: nunca se mezcla con una base parcial
    out = {"groups": []}
    for g in cfg["groups"]:
        ro = pycolmap.ImageReaderOptions()
        ro.camera_model = cfg.get("camera_model", "SIMPLE_RADIAL")
        if g.get("camera_params"):
            ro.camera_params = g["camera_params"]
        eo = pycolmap.FeatureExtractionOptions()
        eo.max_image_size = cfg.get("max_image_size", -1)
        eo.num_threads = cfg.get("threads", -1)
        eo.sift.max_num_features = cfg.get("max_num_features", 8192)
        t = time.time()
        pycolmap.extract_features(db, cfg["image_path"], image_names=g["images"],
                                  camera_mode=pycolmap.CameraMode.SINGLE, reader_options=ro,
                                  extraction_options=eo, device=pycolmap.Device.cpu)
        out["groups"].append({"group": g["name"], "images": len(g["images"]), "seconds": time.time() - t,
                              "camera_params_prior": g.get("camera_params") or None})
    with pycolmap.Database.open(db) as d:
        out["num_images"] = d.num_images()
        out["num_cameras"] = d.num_cameras()
        out["num_keypoints"] = d.num_keypoints()
    return out


def matching(cfg: dict) -> dict:
    mo = pycolmap.FeatureMatchingOptions()
    mo.num_threads = cfg.get("threads", -1)
    t = time.time()
    # Estrategia única y reproducible del primer alcance: correspondencia exhaustiva.
    pycolmap.match_exhaustive(cfg["database"], matching_options=mo, device=pycolmap.Device.cpu)
    with pycolmap.Database.open(cfg["database"]) as d:
        n_pairs = d.num_matched_image_pairs() if hasattr(d, "num_matched_image_pairs") else None
        n_verified = d.num_verified_image_pairs() if hasattr(d, "num_verified_image_pairs") else None
    return {"strategy": "exhaustive", "seconds": time.time() - t, "matched_pairs": n_pairs,
            "verified_pairs": n_verified}


def mapping(cfg: dict) -> dict:
    opts = pycolmap.IncrementalPipelineOptions()
    opts.random_seed = SEED
    opts.num_threads = cfg.get("threads", -1)
    opts.min_model_size = cfg.get("min_model_size", 3)
    out_dir = Path(cfg["output_path"])
    out_dir.mkdir(parents=True, exist_ok=True)
    recs = pycolmap.incremental_mapping(cfg["database"], cfg["image_path"], out_dir, options=opts)
    comps = []
    for idx, r in sorted(recs.items()):
        comps.append({
            "index": idx,
            "path": str(out_dir / str(idx)),
            "registered_images": r.num_reg_images(),
            "points3D": r.num_points3D(),
            "mean_reprojection_error_px": r.compute_mean_reprojection_error(),
            "mean_track_length": r.compute_mean_track_length(),
            "image_names": sorted(im.name for im in r.images.values() if im.has_pose),
        })
    comps.sort(key=lambda c: (-c["registered_images"], -c["points3D"]))
    return {"components": comps}


def undistort(cfg: dict) -> dict:
    uo = pycolmap.UndistortCameraOptions()
    uo.max_image_size = cfg.get("max_image_size", -1)
    pycolmap.undistort_images(cfg["output_path"], cfg["input_path"], cfg["image_path"], output_type="COLMAP",
                              undistort_options=uo, num_threads=cfg.get("threads", -1))
    r = pycolmap.Reconstruction(Path(cfg["output_path"]) / "sparse")
    cams = {cid: {"model": c.model_name, "width": c.width, "height": c.height, "params": list(c.params)}
            for cid, c in r.cameras.items()}
    return {"registered_images": r.num_reg_images(), "cameras": cams}


STAGES = {"features": features, "matching": matching, "mapping": mapping, "undistort": undistort}


def main() -> int:
    stage, cfg_path = sys.argv[1], Path(sys.argv[2])
    cfg = json.loads(cfg_path.read_text())
    result = STAGES[stage](cfg)
    result["pycolmap_version"] = pycolmap.__version__
    Path(cfg["summary_path"]).write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(f"[planta3d] etapa {stage} completada", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
