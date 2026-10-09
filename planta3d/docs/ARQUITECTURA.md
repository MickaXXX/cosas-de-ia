# Arquitectura

```
 Teléfono / navegador ──HTTPS──▶  API FastAPI (+ web compilada)  ──▶ PostgreSQL  (estado autoritativo)
   React + Three.js                  │  valida, guarda archivos       ▲
                                     │  privados, firma enlaces       │ estado, etapas, eventos
                                     ▼                                │
                               Redis/Valkey (cola) ──▶ Trabajador Celery (1 trabajo a la vez)
                                                       ├─ subprocesos COLMAP 4.2.1 (pycolmap)
                                                       ├─ binarios OpenMVS 2.4.0
                                                       └─ conversor GLB + verificación
                         Almacenamiento privado (volumen local; interfaz reemplazable por objetos privados)
```

| Capa | Elección | Notas |
|---|---|---|
| Interfaz | React 19 + TypeScript + Vite | PWA instalable, adaptable a móvil; español |
| Visualización | Three.js 0.186, GLB | Sin decodificadores Draco/KTX2: el verificador rechaza GLB que los requieran con un mensaje explícito |
| API | Python + FastAPI | OpenAPI en `/docs` |
| Trabajos | Celery + Redis/Valkey | La cola solo transporta el id; acks tardíos; el estado vive en PostgreSQL |
| Datos | PostgreSQL 16 + Alembic | Migraciones reproducibles (`alembic upgrade head`) |
| Archivos | Volumen local privado | Claves internas; nunca rutas del usuario; enlaces firmados de 15 min |
| Motor | COLMAP 4.2.1 vía `pycolmap` + OpenMVS 2.4.0 | Ver «Decisiones» |
| Ejecución | Docker Compose (básico / cpu / gpu) o `scripts/dev_local.sh` | |

## Decisiones (y alternativas evaluadas)

- **COLMAP por `pycolmap` en lugar del binario CLI**: el entorno no tenía binario COLMAP 4.2.1 (Ubuntu trae
  3.9.1). `pycolmap==4.2.1` es el binding oficial de la misma biblioteca. Cada etapa corre en un **subproceso
  propio** (`python -m app.engine.colmap_stage <etapa> config.json`), con stdout/stderr, código de salida,
  tiempo y memoria registrados, y cancelación por señales: las mismas garantías que con la CLI.
- **OpenMVS para el denso, la malla y la textura**: la estéreo densa de COLMAP (`patch_match_stereo`)
  requiere CUDA y en el equipo probado no hay GPU. OpenMVS funciona en CPU y opcionalmente con CUDA.
  Licencia AGPL-3.0: se usa como **binario externo**; el único cambio es un parche de compatibilidad
  publicado en `deploy/openmvs/` (ver [LICENCIAS.md](LICENCIAS.md)).
- **Una sola estrategia de correspondencia**: exhaustiva, reproducible (semilla fija). Falla en
  rendimiento sobre ~400 fotos por trabajo (crecimiento cuadrático): por eso el límite configurable
  `P3D_MAX_PHOTOS_PER_JOB` y la recomendación de dividir en sectores. No se asume orden de las fotos.
- **Nivelación de costuras de textura desactivada**: en la compilación probada producía regiones negras en
  el atlas; lo detectó la verificación automática de textura contra las fotos ([HITO0.md](HITO0.md)).
- **Sin cierre de huecos** (`--close-holes 0`) en malla y textura: no se fabrica geometría para tapar zonas
  no observadas.

## Etapas del trabajo

| # | Estado | Etapa | Qué hace / verifica |
|---|---|---|---|
| 1 | validating | preprocess | Copias por perfil desde las copias de trabajo; grupos de cámara; focal inicial (EXIF 35 mm o corrección manual); falla si un grupo mezcla resoluciones |
| 2 | reconstructing | features | SIFT por grupo de cámara (intrínsecos compartidos solo dentro del grupo) |
| 3 | | matching | Correspondencia exhaustiva + verificación geométrica (sobre copia de la base) |
| 4 | | sfm | SfM incremental, semilla fija; todos los componentes quedan registrados |
| 5 | | review | Componente presentado (el mayor), fotos no registradas y en otros componentes; advertencias si < 80 % |
| 6 | | undistort | Imágenes y cámaras PINHOLE sin distorsión |
| 7 | | densify | Mapas de profundidad y fusión (OpenMVS); falla si la nube es insuficiente |
| 8 | | mesh | Malla maestra (sin cierre de huecos) |
| 9 | | texture | Simplificación al presupuesto web **antes** de texturizar (UV correctas por construcción) y atlas ≤ 4096 px |
| 10 | converting | convert | Verificación de orientación UV contra fotos; PLY+atlas → GLB; verificación estructural del GLB |
| 11 | | publish | Alineación de visualización, poses de cámaras, informe, artefactos y versión de modelo |

Transiciones válidas (cualquier otra se rechaza):
`queued → validating → reconstructing → converting → ready`; desde cualquier estado activo →
`cancelling → cancelled`, o → `failed`; un estado activo puede volver a `queued` solo durante la recuperación.

**Reutilización tras una caída**: cada etapa guarda un marcador con el hash de sus parámetros, encadenado
con los SHA-256 de las salidas anteriores, y los SHA-256 de sus propias salidas. Solo se omite si todo
coincide. **Exclusión**: bloqueo `pg_try_advisory_lock` por trabajo durante la ejecución (se libera si el
proceso muere). **Procesos**: cada binario en su propio grupo de procesos, con `PR_SET_PDEATHSIG` y tiempo
máximo; la cancelación termina el grupo completo. **Idempotencia**: clave única por sector al crear trabajos.

## Coordenadas y transformaciones

- El GLB web conserva las **coordenadas del motor** (COLMAP/OpenMVS, sin escala métrica) y no lleva
  transformación en su nodo: una sola conversión de convenciones (UV abajo→arriba, verificada).
- La **alineación** (rotación + traslación rígida, 4×4 fila-mayor) se guarda en `model_versions.alignment`;
  se estima con el eje «abajo» de las cámaras (fotos orientadas), PCA horizontal y el piso en el percentil 1.
  La persona puede ajustarla (nivelar con 3 puntos, girar). El visor la aplica como matriz del nodo raíz.
- La **escala** es un factor uniforme aparte (`scale_factor`, metros por unidad) definido solo por calibración.
- Marcadores y puntos de calibración se guardan en **coordenadas del modelo** de su versión
  (`model_version_id`), nunca de pantalla. Cambiar de versión no los traslada: hay una transferencia explícita
  con matriz y nota de revisión registrada.
- Poses de cámara: COLMAP define `X_cam = R·X_mundo + t`; el centro es `−Rᵀt`, **no** `t`
  (comprobado en el Hito 0). El visor convierte la cámara COLMAP (y abajo, mira +Z) a Three.js (y arriba,
  mira −Z) con `diag(1, −1, −1)`.
- Exportación métrica: derivado GLB con un nodo raíz cuya matriz es `escala · alineación`, más los marcadores
  como nodos hijos. El maestro no se modifica.

## Modelo de datos

`User`, `ApiToken`, `ProjectMember` (roles owner/editor/viewer), `Project`, `Sector` (con ubicación
esquemática), `CaptureBatch`, `SourcePhoto` (hash, original inmutable, copia de trabajo, métricas, indicadores,
registro de inclusión), `ProcessingJob` (estado, etapa, etapas, informe, intentos, latido), `JobEvent`,
`ModelVersion` (fuente, alineación, escala, tolerancia, estadísticas), `ModelArtifact` (tipo, ruta interna,
SHA-256), `CalibrationReference`, `ValidationCheck`, `Asset` (TAG manual, estado operacional con origen y
fecha), `Annotation`, `DocumentLink`. Ver `backend/app/models.py` y `backend/alembic/versions/`.

## Seguridad

- Toda ruta de la API exige token Bearer (salvo login y salud). Contraseñas con scrypt; tokens guardados
  como hash con vencimiento.
- Autorización por proyecto en **cada** acceso (incluidas descargas). Un proyecto ajeno responde 404.
- Archivos privados: enlaces firmados HMAC de 15 minutos ligados al usuario; al servirlos se vuelve a
  comprobar el permiso (revocar el acceso invalida enlaces ya emitidos). Originales solo para editores.
- Sin rutas arbitrarias (las claves de almacenamiento se validan contra el directorio de datos), sin
  comandos del usuario, binarios con argumentos estructurados (sin shell), sin descompresión de archivos
  subidos, límites de tamaño por foto, documento, lote, trabajo y tiempo por etapa.
- No se guardan coordenadas GPS; solo un indicador de que la foto las traía.
- Desarrollo: todo escucha en 127.0.0.1. Para uso compartido: HTTPS delante (proxy inverso), `P3D_SECRET_KEY`
  propia (la app se niega a iniciar en producción con la clave de desarrollo), contraseñas fuertes,
  respaldos y revisión de usuarios. No hay ninguna conexión de escritura a PLC/SCADA.
