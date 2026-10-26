# Plano Fotográfico de Planta (piloto)

Plano interactivo de la planta (plano `ANT-PLA-GEN-004`) con puntos por sector, una bandeja para subir fotos del celular y fichas por punto con galería, historial y observaciones.

Piloto publicado en Claude: https://claude.ai/artifact/UBLVEFEjjP3thFb3ZVEMPZ

## Archivos

```
index.html     la aplicación completa (HTML + CSS + JS, sin dependencias)
plano-hi.png   plano rotado 3427×2853, líneas finas (zoom cercano)
plano-lo.png   mismo plano a media resolución con líneas engrosadas (vista general)
```

## Qué hace

- **Plano**: zoom con rueda o pellizco, puntos de color por sector, agrupación automática de puntos cercanos, filtros por sector, búsqueda.
- **Bandeja**: subes muchas fotos de una vez. Se reducen a 2048 px en el navegador, se lee la fecha de captura de la cámara (EXIF) y se agrupan solas por sesión (más de 30 min de diferencia = otro grupo).
- **Repartir**: seleccionas fotos y tocas *Ubicar en el plano* → tocas el punto (o lo eliges de una lista). En computador también se pueden arrastrar al punto. Siempre hay *Deshacer*.
- **Ficha del punto**: código, sector, equipo, descripción, fotos, historial por fecha con comparador antes/después, observaciones con autor y fecha.
- **Modo edición**: clic en el plano crea un punto, arrastrar lo mueve, la ficha se edita en línea. Eliminar un punto devuelve sus fotos a la bandeja.

## Modelo de datos

| Colección | Campos |
|---|---|
| `points` | `code, name, sector, equipo, descripcion, x, y` (x, y normalizados 0–1 sobre el plano), `createdAt, updatedAt` |
| `photos` | `assetId, thumbId, pointId` (null = bandeja), `capturedAt, dateSource, uploadedAt, by, filename, w, h, size, caption, author, example` |
| `notes`  | `pointId, text, by, createdAt` |

Sectores: `agua, vapor, frio, electrica, riles, proceso, apoyo`.

## Traspaso a Apps Script (dominio de la empresa)

| Piloto (Claude) | Apps Script |
|---|---|
| `db` colección `points` | Hoja `Puntos` en un Google Sheet |
| `db` colección `photos` | Hoja `Fotos` |
| `db` colección `notes` | Hoja `Observaciones` |
| `assets.upload` | `DriveApp` → carpeta *Plano Fotográfico/Fotos* (archivo + miniatura) |
| `/_blob/<id>` | `https://drive.google.com/thumbnail?id=<id>&sz=w2048` |
| `user.id()` | `Session.getActiveUser().getEmail()` |
| `onSnapshot` (tiempo real) | recarga al volver a la pestaña + sondeo cada 30–60 s |
| escritura por documento | `google.script.run` + `LockService` al escribir en la hoja |

Pasos:

1. Crear el Sheet con las tres hojas y la carpeta de Drive dentro de una unidad compartida del área.
2. `Code.gs`: `doGet()` sirve `index.html` con `HtmlService`; funciones `listar()`, `guardarPunto()`, `moverFotos(ids, puntoId)`, `subirFoto(base64, meta)`, `eliminarFoto(id)`, `agregarObservacion()`.
3. En `index.html` solo cambia la capa de almacenamiento (`makeCloudStore`): el resto de la interfaz se reutiliza tal cual. El redimensionado en el navegador se mantiene, así cada llamada a `subirFoto` pesa pocos cientos de KB.
4. Publicar como aplicación web: *Ejecutar como* el usuario que accede, *Acceso*: cualquier usuario del dominio.
5. Cargar los 30 puntos base y mover las fotos reales.

Pendiente de definir antes del traspaso: quién puede editar puntos (todos o solo coordinación), dueño de la carpeta de Drive, y ubicación de la subestación eléctrica (no aparece rotulada en el plano, se agrega en modo edición).
