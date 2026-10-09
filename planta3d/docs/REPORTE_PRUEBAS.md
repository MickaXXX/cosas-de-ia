# Reporte de pruebas

Fecha: 9 de octubre de 2026. Entorno: Ubuntu 24.04 (Linux nativo), Xeon 2,1 GHz × 4 núcleos, 15,7 GB RAM,
**sin GPU**. PostgreSQL 16, Redis 7.0 (local) / Valkey 8 (Docker), Chromium para la interfaz.

Leyenda: ✅ ejecutada y aprobada · ⚠️ ejecutada con limitaciones · ⏳ **no ejecutada** (con procedimiento).

## Estado por hito

| Hito | Estado | Evidencia |
|---|---|---|
| 0 · Prueba del motor | ✅ con fotos reales públicas | [HITO0.md](HITO0.md) |
| 1 · Proyectos, visor, fichas, persistencia | ✅ | Pruebas de API, capturas, prueba de reinicio |
| 2 · Flujo fotos → modelo integrado | ✅ local y en Docker Compose (CPU) | `scripts/e2e_api.py`, capturas |
| 3 · Calibración, validación, versiones | ✅ con ensayo controlado sintético · ⏳ terreno | `docs/evidencia/aceptacion_escala.json` |

## Pruebas de aceptación

### 1. Fotos reales → motor → modelo texturizado en la web ✅

- Datos: 11 fotos reales (Sceaux Castle, ver procedencia en [HITO0.md](HITO0.md)).
- Subidas por la API, trabajo en cola, 11 etapas, publicado en **2 min 56 s** (local) y **2 min 52 s**
  (Docker Compose, perfil `cpu`). 11/11 fotos registradas; reproyección 0,36 px; 286–308 mil triángulos;
  GLB de 7,9–8,8 MB; verificación de textura concluyente.
- Abierto en el visor web real (Chromium): `docs/capturas/escritorio-4-visor-orbita.png`; vista desde una
  foto con la imagen original superpuesta y alineada: `escritorio-6-visor-desde-foto.png`; móvil 390×844:
  `movil-4-visor-orbita.png`.
- Comando: `python scripts/e2e_api.py --email … --password … --photos <carpeta> --profile rapido`.

### 2. Archivos corruptos y fotos desconectadas ✅

- `tests/test_uploads.py`: JPEG truncado, bytes aleatorios, HEIC, ZIP, resolución insuficiente → rechazados
  con motivo; duplicados por SHA-256; reintento idempotente; orientación EXIF aplicada una vez; GPS no
  almacenado; indicador de nitidez relativo; exclusión con motivo y registro; cancelación de lote.
- `tests/test_engine_integration.py::test_disconnected_photos_are_reported_not_hidden` (motor real):
  27 fotos de dos escenas sin relación → **2 componentes (16 y 11 fotos)**; se presenta el mayor sin mezclar
  sistemas de coordenadas; advertencias «Se formaron 2 componentes desconectados…» y «Solo 59 % de las fotos
  quedó en el modelo presentado: el resultado NO representa todo el conjunto»; las 11 fotos del otro
  componente se listan por nombre.

### 3. Persistencia tras recargar y reiniciar servicios ✅

Se creó un marcador, se detuvieron PostgreSQL, Redis, API y trabajador (`scripts/dev_local.sh down`) y se
volvieron a iniciar: proyectos, modelos, marcadores y el GLB siguieron disponibles. PostgreSQL además
se recuperó correctamente de un reinicio abrupto del contenedor de desarrollo. Respaldo y restauración
probados en una base separada (59 fotos, marcadores y archivos recuperados; sumas SHA-256 verificadas) y
respaldo en modo Docker.

### 4. Conversión UV/textura y coordenadas ✅

- Ejemplo controlado (`tests/test_convert.py`): malla con atlas de cuadrantes de colores conocidos en
  convención OpenMVS → GLB: cada esquina conserva su vértice, el nodo no tiene transformación y el color
  muestreado con la UV del GLB es el esperado; sin invertir V el error se detecta. El verificador rechaza
  búferes/imágenes externos, índices fuera de rango, GLB truncados y extensiones sin decodificador.
- Salida real: en cada trabajo se proyectan 3.000 caras sobre las fotos (diferencia mediana 9–10/255 con la
  convención elegida vs. 55–86/255 con la opuesta). Si no es concluyente, el trabajo **falla** en lugar de
  publicar una textura posiblemente invertida. Esta verificación detectó un defecto real de OpenMVS
  (manchas negras por la nivelación de costuras).
- Revisión visual: capturas del visor y de la vista desde foto (la foto coincide con el modelo).

### 5. Escala con dimensiones conocidas y ≥ 3 medidas reservadas ✅ (controlado) · ⏳ (terreno)

Ensayo controlado: escena sintética con dimensiones exactas (skid 2,0×1,0×1,2 m, motor 0,8×0,6×0,6 m,
estanque Ø1,0×1,8 m, piso y muros) renderizada desde 48 posiciones a 3 alturas (`scripts/synthetic/`).
Flujo real completo por la API (15 min en CPU): 48/48 registradas, reproyección 0,28 px, malla maestra de
1,04 M caras simplificada a 600 k para la web. Calibración con **una** referencia (ancho del skid) y
6 comprobaciones reservadas, tolerancia ±3 cm y ±3 %:

| Comprobación reservada | Real | Modelo | Error |
|---|---|---|---|
| Fondo del skid | 1,200 m | 1,200 m | −0,01 cm |
| Techo del skid a piso | 1,640 m | 1,640 m | −0,00 cm |
| Ancho del motor | 0,800 m | 0,800 m | −0,02 cm |
| Skid a motor | 1,118 m | 1,118 m | +0,03 cm |
| **Tapa del estanque a piso** | 1,931 m | 1,899 m | **−3,26 cm (−1,7 %) fuera** |
| Muro posterior a skid | 4,026 m | 4,027 m | +0,09 cm |

Resultado: la app dejó el modelo **«calibrado sin verificar»** porque una comprobación excede la tolerancia
(la tapa del estanque solo se observa en ángulo rasante). Es el comportamiento esperado.

Límites del ensayo: imágenes sintéticas ideales (cámara perfecta, sin desenfoque, ruido ni reflejos); los
puntos se ubican con un registro de los centros de cámara y se miden sobre la malla. **Los errores en terreno
serán mayores.** Se usó corrección manual de focal (conocida del render), funcionalidad que también existe
para fotos sin EXIF.

⏳ **Pendiente: ensayo de terreno** en la planta. Procedimiento:
1. Capturar un sector de 10–30 m² según [CAPTURA.md](CAPTURA.md) y medir ≥ 4 distancias con instrumento,
   anotando extremos.
2. Reconstruir (perfil Estándar) y, en el visor, registrar 1 referencia y ≥ 3 comprobaciones con la
   herramienta 📐 y la tolerancia según el uso.
3. Exportar el informe (`GET /api/models/{id}/calibration`) y anotar fotos, tiempo, hardware y errores.

### 6. Cancelación y recuperación de un trabajo real ✅

`tests/test_engine_integration.py` (motor real, subprocesos como el trabajador):
- **Cancelación** durante la densificación: el trabajo pasa a `cancelling` → `cancelled`, sin versión de
  modelo y **sin procesos del motor vivos**.
- **Caída del trabajador** (SIGKILL) durante la densificación: el proceso de OpenMVS muere con él
  (`PR_SET_PDEATHSIG`); la recuperación lo reencola; la segunda ejecución **reutiliza 6 etapas tras verificar
  SHA-256 y parámetros**, repite la densificación y termina `ready` con 2 intentos; existe **una sola** versión
  de modelo; relanzar el mismo trabajo no hace nada.
- Apagado ordenado: SIGTERM al trabajador retira su anuncio de capacidades (la API deja de ofrecer
  reconstrucción). Se corrigió que `pycolmap` instalaba un manejador de señales que abortaba el proceso.

### 7. Acceso privado y aislamiento entre proyectos ✅

`tests/test_security.py`: rutas sin token → 401; proyecto ajeno → 404 en proyecto, sector, fotos, modelos,
activos y diagnóstico; lector no puede subir ni descargar originales; enlaces firmados: manipulación y
vencimiento rechazados; **revocar el acceso invalida enlaces ya emitidos**; último propietario no se puede
quitar; rutas de almacenamiento fuera del directorio rechazadas. Producción se niega a iniciar con secretos
de desarrollo.

## Otras pruebas

| Prueba | Resultado |
|---|---|
| `pytest` (27 pruebas rápidas contra PostgreSQL real, migraciones incluidas) | ✅ 27/27 |
| Motor real (3 pruebas de integración, ≈ 11 min) | ✅ 3/3 |
| Interfaz en Chromium (escritorio 1440×900 y móvil 390×844, sin errores de consola) | ✅ `scripts/ui_smoke.py` |
| Tipos TypeScript estrictos + compilación | ✅ |
| Imágenes Docker (API y trabajador con OpenMVS) + Compose `cpu` con reconstrucción real | ✅ |
| Lector PLY propio vs. `plyfile` en salidas reales | ✅ idénticos |

## No ejecutado o con limitaciones

| Tema | Estado | Qué falta |
|---|---|---|
| Perfil GPU (OpenMVS con CUDA) | ⏳ | Equipo con NVIDIA + NVIDIA Container Toolkit: `docker compose --profile gpu up -d --build` y repetir la prueba 1 |
| Ensayo de terreno con fotos y medidas de la planta | ⏳ | Ver procedimiento en la prueba 5 |
| Conjuntos grandes (> 48 fotos) | ⏳ | Medir tiempo/memoria con 150–300 fotos antes de fijar el hardware |
| Fluidez en el teléfono objetivo | ⚠️ | Solo emulado (Chromium + SwiftShader). Medir FPS con el modelo real en el teléfono que se usará |
| Rendimiento del visor con GLB > 50 MB | ⏳ | Presupuesto web 600 k triángulos y texturas ≤ 4096 px por defecto |
| HEIC, RAW, vídeo, 360 | Fuera de alcance | Se rechazan con una explicación útil |
| `mesh_texturer` de COLMAP | No usado | La ruta CPU usa OpenMVS; documentado en ARQUITECTURA.md |
| Despliegue compartido con HTTPS | ⏳ | Requiere proxy inverso con TLS y política de usuarios de la planta |
