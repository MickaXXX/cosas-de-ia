# Hito 0 — Prueba técnica del motor

**Resultado: cumplido** con un conjunto multivista real y público. Fecha: 9 de octubre de 2026.

## Entorno

| | |
|---|---|
| Sistema | Linux nativo, Ubuntu 24.04.5 LTS, kernel 6.18 (contenedor de desarrollo; no WSL2) |
| CPU / RAM | Intel Xeon @ 2,10 GHz, 4 núcleos / 15,7 GB |
| GPU | Ninguna (sin `nvidia-smi`) |
| Python / Node | 3.13.16 / 22.22.0 |
| COLMAP | 4.2.1 (`pycolmap==4.2.1`, sin CUDA). Ubuntu solo ofrece COLMAP 3.9.1 por apt |
| OpenMVS | v2.4.0 (commit `58117204`), compilado en CPU con CGAL 6.0.1 y el parche `deploy/openmvs/opencv46-jpegxl-compat.patch` |

## Datos

*Sceaux Castle*: 11 fotos reales de 2832×2128 px tomadas a pie alrededor de una fachada. Origen:
repositorio público [cdcseacave/openMVS_sample](https://github.com/cdcseacave/openMVS_sample) (archivo de
licencia AGPL-3.0; imágenes originalmente de openMVG ImageDataset_SceauxCastle). Se usaron solo para pruebas
y **no se incluyen** en este repositorio.

## Ejecución manual (resolución de trabajo 2000 px)

| Etapa | Tiempo | Memoria | Resultado |
|---|---|---|---|
| Extracción SIFT | 24,7 s | — | 11 imágenes, 1 cámara |
| Correspondencia exhaustiva | 4,5 s | — | |
| SfM incremental | 9,0 s | — | **11/11 registradas**, 8.818 puntos, error de reproyección 0,55 px |
| Sin distorsión | ≈1 s | — | |
| Densificación (OpenMVS) | 2 min 54 s | pico virtual 1,0 GB | 236.042 puntos |
| Malla | 15 s | 0,9 GB | 438.828 caras |
| Textura | 33 s | 1,9 GB | atlas 4096² |

Comprobaciones:

- **Sistema de coordenadas**: la caja de la malla de OpenMVS coincide con la nube dispersa de COLMAP
  (mismo marco; no hay que convertir).
- **Convención de cámaras**: `cam_from_world.translation` ≠ centro de proyección (p. ej. t=(1,09; 0,32; 1,68)
  vs. centro (−1,32; −0,32; −1,51)). La app usa `projection_center()`.
- **Convención UV**: verificada proyectando 3.000 caras sobre la foto más frontal: con origen V abajo la
  diferencia mediana de color atlas/foto es 9/255, con origen arriba 85/255 → el GLB invierte V.

## Hallazgo: atlas con regiones negras

Con la configuración por defecto de `TextureMesh`, el atlas salía con manchas negras dentro de los parches
(18,9 % de píxeles negros) y la verificación de textura resultó «no concluyente» (108 vs. 85).
Desactivando la nivelación de costuras global y local el negro bajó a 0 % y la verificación pasó a
concluyente (9 vs. 85). Valores de `--ignore-mask-label` distintos del predeterminado provocan *segfault* en
esta compilación. Configuración adoptada: `--global-seam-leveling 0 --local-seam-leveling 0`
(costuras algo más visibles). Si una versión futura corrige esto, se puede reactivar y la verificación
automática lo confirmará.

## Ejecución integrada (por la app, perfil Rápido, 1600 px)

Mismas 11 fotos subidas por la API y procesadas por el trabajador: listo en **2 min 56 s**; 11/11 registradas;
error de reproyección 0,36 px; 307.544 triángulos; GLB de 8,8 MB; textura verificada (9,0 vs. 85,7).
Ver capturas en `docs/capturas/`.
