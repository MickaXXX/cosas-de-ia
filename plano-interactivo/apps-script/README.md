# Plano Fotográfico — versión Apps Script

App web para el dominio de la empresa. El Google Sheet es la base de datos y las fotos se guardan en una carpeta de Drive.

| Archivo | Qué es |
|---|---|
| `Code.gs` | Servidor: lectura y escritura en la hoja, subida a Drive, permisos, instalación |
| `Index.html` | La app (misma interfaz del piloto) |
| `Plano.html` | El plano ANT-PLA-GEN-004 embebido como imagen (por eso es largo) |
| `appsscript.json` | Manifiesto: zona horaria de Santiago, app web solo para el dominio |

## Instalación (unos 10 minutos)

1. **Crea la hoja.** En Google Drive, idealmente en una unidad compartida del área, crea una hoja de cálculo nueva. Nombre sugerido: *Plano Fotográfico — Base de datos*.
2. **Abre el editor.** En la hoja: *Extensiones → Apps Script*.
3. **Copia los archivos** desde esta carpeta:
   - `Code.gs`: borra el contenido del archivo `Código.gs` y pega el de `Code.gs`.
   - `Index.html`: botón **+** → *HTML* → nombre `Index` → pega el contenido.
   - `Plano.html`: botón **+** → *HTML* → nombre `Plano` → pega el contenido.
   - `appsscript.json`: ⚙ *Configuración del proyecto* → marca *Mostrar el archivo de manifiesto "appsscript.json"* → vuelve al editor y reemplaza su contenido.
4. **Instala.** Guarda (Ctrl+S). Arriba, elige la función `instalar` y presiona ▶ *Ejecutar*. Acepta los permisos de Sheets y Drive con tu cuenta.
   Se crean las hojas **Puntos** (con los 30 puntos del plano), **Fotos**, **Observaciones** y **Config**, y la carpeta *Plano Fotográfico — Fotos* junto a la hoja.
5. **Publica.** *Implementar → Nueva implementación* → ⚙ *Aplicación web*:
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **cualquier usuario de tu dominio**
   - *Implementar* y copia la URL.
6. **Úsala.** Abre la URL. En el celular: *Compartir → Agregar a pantalla de inicio* para tenerla como app.

Con [clasp](https://github.com/google/clasp) los pasos 2 y 3 son: `clasp create --type sheets --title "Plano Fotográfico" --rootDir apps-script` y luego `clasp push`.

## Permisos (hoja Config)

| clave | qué controla | valor inicial |
|---|---|---|
| `editores_puntos` | quién crea, mueve, edita o borra puntos del plano | el correo de quien instaló |
| `editores_fotos` | quién sube, mueve o borra fotos y escribe observaciones | vacío = todos los que abren la app |
| `subtitulo` | texto bajo el título | Planta Antofagasta · Suministros |

Los correos van separados por coma. `@dominio.cl` habilita a todo el dominio. El dueño del script siempre tiene todos los permisos. Los permisos también se validan en el servidor, no solo en la pantalla.

Quién **ve** la app se define al publicar (paso 5).

## Cómo funciona

- **Hoja de cálculo**: cada foto, punto y observación es una fila. La columna *punto* se actualiza sola, así que puedes filtrar la hoja por punto o por fecha. No cambies los encabezados ni la columna *id*.
- **Fotos**: el celular las reduce a 2048 px antes de subirlas (300–600 KB cada una) y guarda además una miniatura de 480 px en la subcarpeta *miniaturas*. El archivo se nombra con la fecha de captura y el nombre original.
- **Fecha de captura**: se lee de la cámara (EXIF). Si la foto no la trae, se usa la fecha del archivo. Se puede corregir en el visor.
- **Eliminar una foto** borra su fila y envía los archivos a la papelera de Drive, donde se pueden recuperar durante 30 días.
- **Varias personas a la vez**: la app consulta cada 30 segundos y al volver a la pestaña si alguien hizo cambios. Cada acción se ve al instante y se guarda en segundo plano; el indicador superior muestra *Guardando…*.
- **Imágenes**: se muestran directo desde Drive. Si la política del dominio bloquea compartir con enlace interno, la app las pide al script. Es más lento, pero funciona sin configurar nada.

## Actualizar la app sin cambiar la URL

Pega los archivos nuevos → *Implementar → Administrar implementaciones* → ✏ → *Versión: nueva versión* → *Implementar*.

## Si algo falla

| Mensaje | Qué hacer |
|---|---|
| "La app no está instalada" | En la hoja: menú *Plano Fotográfico → Instalar o reparar* |
| "No tienes permiso…" | Agrega el correo en la hoja **Config** |
| Falta una hoja o columna | *Instalar o reparar* la recrea sin borrar datos |
| Una foto HEIC de iPhone no sube | Al elegirla desde Safari el iPhone la convierte a JPG; si falla, expórtala como JPG |

La subestación eléctrica no está rotulada en el plano: agrégala desde la app con *Editar puntos*.
