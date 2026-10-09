"""Diagnóstico de capacidades del motor. Si falta algo, la app lo dice y NO simula una reconstrucción."""
from __future__ import annotations

import os
import json
import platform
import re
import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

from ..config import get_settings

OPENMVS_TOOLS = ["InterfaceCOLMAP", "DensifyPointCloud", "ReconstructMesh", "TextureMesh"]


def _openmvs_version(bin_dir: Path) -> str | None:
    exe = bin_dir / "DensifyPointCloud"
    try:
        r = subprocess.run([str(exe), "--help"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(r"OpenMVS\s+\S+\s+v(\d+\.\d+\.\d+)", r.stdout + r.stderr)
    return f"OpenMVS {m.group(1)}" if m else "desconocida"


def hardware() -> dict:
    cpu = platform.processor() or ""
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    mem_gb = None
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal"):
                mem_gb = round(int(line.split()[1]) / 1024 / 1024, 1)
    except OSError:
        pass
    gpu = None
    if shutil.which("nvidia-smi"):
        try:
            r = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                               capture_output=True, text=True, timeout=10)
            gpu = r.stdout.strip() or None
        except (OSError, subprocess.TimeoutExpired):
            gpu = None
    return {"os": f"{platform.system()} {platform.release()}", "cpu": cpu, "cpu_count": os.cpu_count(),
            "ram_gb": mem_gb, "gpu": gpu or "ninguna detectada", "python": platform.python_version()}


@lru_cache
def capabilities() -> dict:
    s = get_settings()
    reasons: list[str] = []
    out: dict = {"engine": "COLMAP (SfM) + OpenMVS (densificación, malla y textura)", "hardware": hardware()}
    # En un subproceso: importar pycolmap instala manejadores de señales de glog en el proceso que lo importa.
    probe = "import json, pycolmap; print(json.dumps([pycolmap.__version__, bool(getattr(pycolmap, 'has_cuda', False))]))"
    try:
        r = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, timeout=120)
        version, cuda = json.loads(r.stdout.strip().splitlines()[-1])
        out["colmap"] = {"version": version, "binding": "pycolmap", "cuda": cuda}
    except Exception as e:  # noqa: BLE001
        out["colmap"] = None
        reasons.append(f"pycolmap no disponible: {type(e).__name__}")
    missing = [t for t in OPENMVS_TOOLS if not (s.openmvs_bin_dir / t).exists()]
    if missing:
        out["openmvs"] = None
        reasons.append(f"OpenMVS no encontrado en {s.openmvs_bin_dir} (faltan {', '.join(missing)}). "
                       "Ver docs/INSTALACION.md para compilarlo.")
    else:
        out["openmvs"] = {"bin_dir": str(s.openmvs_bin_dir), "version": _openmvs_version(s.openmvs_bin_dir),
                          "cuda": False}
    out["reconstruction_available"] = not reasons
    out["reasons"] = reasons
    out["notes"] = [
        "Estéreo denso de COLMAP requiere CUDA; en CPU se usa OpenMVS (licencia AGPL-3.0, binario externo).",
        "Sin GPU el procesamiento es más lento; los tiempos reales quedan en el informe de cada trabajo.",
    ]
    return out


WORKER_CAPS_KEY = "planta3d:worker_capabilities"
WORKER_CAPS_TTL = 180


def publish_worker_capabilities() -> None:
    """Lo llama el trabajador al iniciar y periódicamente: la API no tiene el motor instalado."""
    import json
    import socket

    import redis

    caps = dict(capabilities())
    caps["worker_host"] = socket.gethostname()
    redis.Redis.from_url(get_settings().redis_url).set(WORKER_CAPS_KEY, json.dumps(caps), ex=WORKER_CAPS_TTL)


def worker_capabilities() -> dict:
    """Capacidades del trabajador activo (vistas desde la API). Sin trabajador → no hay reconstrucción."""
    import json

    import redis

    try:
        raw = redis.Redis.from_url(get_settings().redis_url, socket_timeout=2).get(WORKER_CAPS_KEY)
    except Exception as e:  # noqa: BLE001
        raw = None
        err = f"No se pudo consultar la cola ({type(e).__name__})"
    else:
        err = "No hay un trabajador de reconstrucción activo (inicia el servicio «worker»)"
    if raw:
        return json.loads(raw)
    return {"engine": "COLMAP (SfM) + OpenMVS (densificación, malla y textura)", "hardware": hardware(),
            "colmap": None, "openmvs": None, "reconstruction_available": False, "reasons": [err],
            "notes": ["Puedes importar modelos GLB y usar el visor sin trabajador."]}
