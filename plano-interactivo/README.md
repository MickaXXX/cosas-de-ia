# Plano Fotográfico de Planta (piloto)

Plano interactivo de la planta (plano `ANT-PLA-GEN-004`) con puntos por sector, una bandeja para subir fotos del celular y fichas por punto con galería, historial y observaciones.

Piloto publicado en Claude: https://claude.ai/artifact/UBLVEFEjjP3thFb3ZVEMPZ

## Archivos

```
index.html       piloto publicado en Claude (HTML + CSS + JS, sin dependencias)
plano-hi.png     plano rotado 3427×2853, líneas finas (zoom cercano)
plano-lo.png     mismo plano a media resolución con líneas engrosadas (vista general)
apps-script/     versión para el dominio de la empresa: Google Sheet + Drive + app web
```

La versión de producción es **`apps-script/`**. Su `README.md` tiene la instalación paso a paso.

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

## Del piloto a Apps Script

| Piloto (Claude) | Apps Script |
|---|---|
| colección `points` | hoja `Puntos` |
| colección `photos` | hoja `Fotos` |
| colección `notes` | hoja `Observaciones` |
| almacenamiento de archivos | carpeta de Drive *Plano Fotográfico — Fotos* (+ `miniaturas/`) |
| identidad del usuario | `Session.getActiveUser().getEmail()` |
| tiempo real | consulta de versión cada 30 s y al volver a la pestaña |
| permisos | hoja `Config` (`editores_puntos`, `editores_fotos`), validados en el servidor |
