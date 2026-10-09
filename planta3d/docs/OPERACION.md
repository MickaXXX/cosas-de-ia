# Operación

## Iniciar y detener

| Acción | Docker | Local |
|---|---|---|
| Iniciar | `docker compose --profile cpu up -d` (en `deploy/`) | `scripts/dev_local.sh up` |
| Estado | `docker compose ps` | `scripts/dev_local.sh status` |
| Registros | `docker compose logs -f api worker` | `~/.planta3d/logs/api.log`, `worker.log` |
| Detener | `docker compose --profile cpu down` | `scripts/dev_local.sh down` |

Detener el trabajador durante una reconstrucción es seguro: al volver a iniciar, recupera el trabajo,
verifica los archivos de cada etapa ya terminada (SHA-256 y parámetros) y continúa desde la primera que no
se puede reutilizar. Una etapa interrumpida se repite completa (los algoritmos no se reanudan a la mitad).

## Usuarios y acceso

- El primer inicio crea el usuario administrador de `P3D_BOOTSTRAP_ADMIN_EMAIL`. Cambia esa contraseña.
- Otros usuarios: `POST /api/users` (administrador) desde `/docs`. Luego agrégalos a cada proyecto en
  «Miembros» con rol lector, editor o propietario.

## Cargar fotos y reconstruir

1. Sector › Captura › «Tomar fotos» o «Elegir archivos». Las fotos se suben de a tres en paralelo con hasta
   tres reintentos cada una. «Detener carga» corta las subidas; «Finalizar lote» lo cierra; «Descartar lote»
   excluye lo recibido (con registro).
2. Revisa el diagnóstico y excluye fotos dudosas con motivo.
3. Reconstrucción › «Reconstruir con fotos incluidas». Un doble clic no crea dos trabajos (clave de
   idempotencia). Solo puede haber un trabajo activo por sector.
4. Cancelar termina los procesos del motor y deja el trabajo «cancelado».

Errores frecuentes y qué hacer:

| Código | Significado | Acción |
|---|---|---|
| `sfm_sin_modelo` | Las fotos no comparten suficientes puntos | Más superposición, desplazarse entre tomas |
| `registro_insuficiente` | Pocas fotos quedaron en el modelo | Revisar fotos no registradas en el informe; recapturar |
| `denso_insuficiente` | Superficies sin textura o reflejos | Perfil Estándar/Detalle o recapturar con mejor luz |
| `verificacion_uv` / `textura_inconsistente` | La textura no coincide con las fotos | No se publica el modelo; reportar con el registro |
| `motor_no_disponible` | No hay OpenMVS/pycolmap en el trabajador | Ver INSTALACION.md |
| `tiempo_maximo` | Etapa superó `P3D_STAGE_TIMEOUT_SECONDS` | Dividir el sector o reducir perfil |

## Inspeccionar, calibrar y exportar

- Visor: 🛰 órbita, 🚶 recorrido (WASD/flechas, Q/E; joystick en móvil), 🗺 planta, ✂ corte, 📏 medir,
  📍 marcar, 📐 calibrar, 📷 fotos (ver desde la posición de cada foto), ⛶ encuadrar.
- Panel «Modelo»: orientación (nivelar con 3 puntos del piso, girar, invertir). La orientación es una
  transformación aparte: no modifica el modelo ni los marcadores.
- Exportar: «GLB en metros» (requiere calibración), «GLB orientado», «Captura JPG» y «Exportar CSV» de
  marcadores (coordenadas del modelo y, si hay escala, en metros).
- Los artefactos completos (malla maestra PLY, malla texturizada, nube densa, poses de cámaras, informe)
  están disponibles por API: `GET /api/models/{id}/artifacts/{tipo}/url` con
  `tipo` ∈ `web_glb, master_mesh_ply, textured_ply, texture_0, dense_points_ply, cameras_json, report_json`.

## Respaldo y restauración

Qué respaldar: la base de datos (metadatos, marcadores, calibraciones, registros) **y** la carpeta de datos
(originales inmutables, copias de trabajo, modelos, documentos). Los intermedios de trabajos (`jobs/`) se
pueden regenerar y no se incluyen en el respaldo local.

```bash
scripts/backup.sh /ruta/respaldos            # local
scripts/backup.sh /ruta/respaldos --docker   # con docker compose activo
scripts/restore.sh /ruta/respaldos/planta3d-AAAAMMDDTHHMMSSZ   # local, servicios detenidos
```

Cada respaldo incluye `SHA256SUMS`; la restauración lo verifica antes de escribir. Guarda copia fuera del
servidor. Prueba la restauración periódicamente en una base separada (`P3D_ENV_FILE=/ruta/otro.env`).
