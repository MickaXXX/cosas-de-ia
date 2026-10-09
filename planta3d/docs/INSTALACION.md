# Instalación

## Requisitos

| Uso | Mínimo probado | Recomendado para ensayos medianos |
|---|---|---|
| Visor e importación (perfil básico) | Cualquier equipo con Docker o Python 3.11+ | — |
| Reconstrucción en CPU | 4 núcleos, 16 GB RAM, sin GPU (entorno de desarrollo) | 8+ núcleos, 32–64 GB RAM, SSD holgado |
| Reconstrucción con GPU | **No probado** | NVIDIA 8–12 GB VRAM o más, CUDA |

Tiempos medidos en CPU (Xeon 2,1 GHz, 4 núcleos, 16 GB, sin GPU), perfil Rápido:
11 fotos → 3 min; 48 fotos → 15 min. Los tiempos crecen con el número de fotos (la correspondencia exhaustiva
es cuadrática) y con la resolución. Estos números no son una estimación para tu sector: mide con un ensayo.

Sobre el Acer Nitro 5 de 16 GB: sirve para programar, usar el visor y ensayos pequeños en CPU. Para
reconstrucción más pesada, verifica la GPU exacta y su memoria antes de decidir hardware.

Sistemas: Linux nativo (Ubuntu 24.04 probado) o **Windows con WSL2** (Ubuntu 24.04) o Docker Desktop.
No hay soporte para Windows nativo sin WSL2.

## Opción A: Docker

```bash
cd planta3d/deploy
cp .env.example .env
# Edita .env: P3D_DB_PASSWORD, P3D_SECRET_KEY (openssl rand -hex 32), P3D_BOOTSTRAP_ADMIN_PASSWORD
docker compose up -d --build                  # perfil básico: visor + importación
docker compose --profile cpu up -d --build    # + trabajador de reconstrucción (compila OpenMVS ≈20–30 min la 1.ª vez)
docker compose ps
docker compose logs -f worker
```

- La app queda en http://127.0.0.1:8000 (solo en el propio equipo). Para usarla desde teléfonos en la red de
  la planta, publica el puerto detrás de un proxy con HTTPS y revisa [ARQUITECTURA.md](ARQUITECTURA.md#seguridad).
- Proxy corporativo con inspección TLS: copia el certificado raíz (`.crt`) a `deploy/certs/` antes de construir.
- GPU (no probado): instala NVIDIA Container Toolkit y usa `docker compose --profile gpu up -d --build`.

## Opción B: local sin Docker (Ubuntu 24.04 / WSL2)

```bash
# 1. Sistema
sudo apt-get install -y postgresql redis-server curl git
curl -LsSf https://astral.sh/uv/install.sh | sh          # gestor de entornos Python
# Node 22: https://nodejs.org o nvm

# 2. Motor (una vez)
sudo bash planta3d/scripts/build_openmvs.sh              # instala en /opt/openmvs

# 3. Backend
cd planta3d/backend
uv venv .venv --python 3.12 && uv pip sync --python .venv/bin/python requirements.lock
cp .env.example .env   # define P3D_BOOTSTRAP_ADMIN_PASSWORD y P3D_SECRET_KEY

# 4. Frontend
cd ../frontend && npm ci && npm run build

# 5. Servicios (crea la base local la primera vez; escucha solo en 127.0.0.1)
cd .. && scripts/dev_local.sh up
scripts/dev_local.sh status
scripts/dev_local.sh down
```

`dev_local.sh` usa `~/.planta3d/pgdata` y `~/.planta3d/logs` (configurables con `P3D_PGDATA` y `P3D_LOGS`).
Si ya tienes PostgreSQL como servicio del sistema, crea el usuario/base `planta3d` y ajusta
`P3D_DATABASE_URL` en `backend/.env`.

## Comprobar la instalación

```bash
cd planta3d/backend
.venv/bin/pytest -q                                    # 27 pruebas rápidas (requiere base planta3d_test)
P3D_RUN_ENGINE_TESTS=1 P3D_TEST_PHOTOS=/ruta/fotos .venv/bin/pytest -q tests/test_engine_integration.py
python ../scripts/e2e_api.py --email admin@planta3d.local --password '...' --photos /ruta/fotos
```

La pestaña Reconstrucción muestra si hay un trabajador activo y qué motor y hardware detectó.
