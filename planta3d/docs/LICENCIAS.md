# Inventario de licencias y dependencias

Revisión técnica, no asesoría legal. Antes de distribuir el producto o de ofrecerlo como servicio a terceros,
confirma estas licencias con quien corresponda en tu organización.

## Puntos que requieren atención

| Componente | Licencia | Uso en Planta 3D | Consecuencia práctica |
|---|---|---|---|
| **OpenMVS 2.4.0** | **AGPL-3.0** | Binarios externos invocados por el trabajador (subprocesos), no enlazados | Si se distribuye el trabajador o se ofrece OpenMVS por red a terceros, hay que ofrecer su código fuente y el parche aplicado (`deploy/openmvs/opencv46-jpegxl-compat.patch`, incluido). El código de Planta 3D no se enlaza con OpenMVS. |
| CGAL 6.0.1 | GPL-3.0+/LGPL-3.0+ (según paquete) | Solo cabeceras, compiladas dentro de OpenMVS | Cubierto por la distribución de OpenMVS (compatible con AGPL) |
| VCGLib | GPL-3.0 | Compilada dentro de OpenMVS | Igual que la fila anterior |
| psycopg 3 | LGPL-3.0 | Biblioteca dinámica de Python | Uso sin modificar: permitido; conservar el aviso |
| pycolmap 4.2.1 / COLMAP | BSD-3-Clause | Proceso de la app (subprocesos) | La rueda incluye `libgfortran`, `libgomp`, `libquadmath` (GPL-3.0 con excepción de biblioteca de GCC) |
| Redis | 7.4+: RSALv2/SSPL; ≤7.2: BSD | Desarrollo local usa el paquete de Ubuntu 7.0.15 (BSD) | Docker Compose usa **Valkey 8 (BSD-3)** para evitar la cuestión |
| Dataset Sceaux Castle | Repositorio con licencia AGPL-3.0 (imágenes de openMVG) | Solo pruebas; **no se incluye** en el repositorio | — |

Se eliminó la dependencia `plyfile` (GPL-3.0), que se cargaba dentro del proceso de la app, y se reemplazó
por un lector/escritor PLY propio (`backend/app/engine/ply.py`), validado contra `plyfile` con salidas reales.

## Motor y sistema

| Componente | Versión | Licencia |
|---|---|---|
| COLMAP (vía pycolmap) | 4.2.1 | BSD-3-Clause |
| OpenMVS | 2.4.0 (+ parche de compatibilidad) | AGPL-3.0 |
| OpenCV (Ubuntu) | 4.6.0 | Apache-2.0 |
| Boost | 1.83 | BSL-1.0 |
| Eigen | 3.4 | MPL-2.0 |
| nanoflann | 1.5.4 | BSD-2-Clause |
| libjxl | 0.7 | BSD-3-Clause |
| PostgreSQL | 16 | PostgreSQL License |
| Valkey (Docker) | 8 | BSD-3-Clause |
| Ubuntu (imagen base) | 24.04 | Varias (paquetes Debian/Ubuntu) |

## Python (backend/requirements.lock)

| Paquete | Versión | Licencia |
|---|---|---|
| alembic | 1.20.0 | MIT |
| amqp | 5.4.1 | BSD |
| celery | 5.6.3 | BSD-3-Clause |
| certifi | 2026.7.22 | MPL-2.0 |
| click (+ plugins) | 8.5.0 | BSD-3-Clause / MIT |
| fastapi | 0.143.0 | MIT |
| h11 / httpcore / httpx | 0.16.0 / 1.0.9 / 0.28.1 | MIT / BSD-3 / BSD (solo pruebas) |
| httptools / uvloop / watchfiles / websockets | — | MIT / MIT+Apache-2.0 / MIT / BSD-3 |
| kombu / billiard / vine | 5.6.2 / 4.3.1 / 5.1.0 | BSD |
| mako / markupsafe | 1.4.3 / 3.0.4 | MIT / BSD-3 |
| numpy | 2.5.3 | BSD-3-Clause (+ 0BSD, MIT, Zlib, CC0 en componentes) |
| pillow | 12.3.0 | MIT-CMU |
| psycopg / psycopg-binary | 3.3.6 | LGPL-3.0 |
| pycolmap | 4.2.1 | BSD-3-Clause |
| pydantic / pydantic-core / pydantic-settings | 2.14 / 2.50 / 2.15 | MIT |
| python-multipart | 0.0.32 | Apache-2.0 |
| python-dotenv / python-dateutil | 1.2.4 / 2.9.0 | BSD-3 / BSD+Apache-2.0 |
| redis (cliente) | 6.4.0 | MIT |
| sqlalchemy | 2.1.4 | MIT |
| starlette | 1.7.0 | BSD-3-Clause |
| uvicorn | 0.54.0 | BSD-3-Clause |
| pytest, pluggy, iniconfig (solo pruebas) | — | MIT |
| otras transitivas (anyio, idna, packaging, pyyaml, six, typing-*, tzdata, tzlocal, wcwidth, prompt-toolkit, pygments, opentelemetry-api, annotated-*) | — | MIT / BSD / Apache-2.0 / PSF-2.0 |

## JavaScript (frontend/package-lock.json)

| Paquete | Versión | Licencia |
|---|---|---|
| react / react-dom | 19.3.0 | MIT |
| three | 0.186.1 | MIT |
| vite / @vitejs/plugin-react | 8.3.4 / 6.1.2 | MIT (solo compilación) |
| typescript | 5.9.3 | Apache-2.0 (solo compilación) |
| @types/* | — | MIT (solo compilación) |

## Herramientas de prueba (no se distribuyen)

Playwright (Apache-2.0) y Chromium (BSD-3 y otras) se usan en un entorno aparte solo para las pruebas de
interfaz y para renderizar la escena sintética.
