# Plano Fotográfico — versión Apps Script

App web para el dominio de la empresa. El Google Sheet es la base de datos y las fotos se guardan en una carpeta de Drive.

| Archivo | Qué es |
|---|---|
| `Code.gs` | Servidor: lectura y escritura en la hoja, subida a Drive, permisos, instalación y diagnóstico |
| `Index.html` | La app (misma interfaz del piloto) |
| `appsscript.json` | Manifiesto: zona horaria de Santiago, app web solo para el dominio |

El plano no va en el código: `instalar` lo descarga una sola vez a Drive (carpeta *Plano Fotográfico — Fotos/plano*).

## Instalación (unos 10 minutos)

1. **Crea la hoja.** En Google Drive, idealmente en una unidad compartida del área, crea una hoja de cálculo nueva. Nombre sugerido: *Plano Fotográfico — Base de datos*.
2. **Abre el editor.** En la hoja: *Extensiones → Apps Script*.
3. **Copia los 3 archivos.** Abre cada enlace, selecciona todo (Ctrl+A), copia (Ctrl+C) y pégalo completo en el editor:
   - [Code.gs](https://raw.githubusercontent.com/MickaXXX/cosas-de-ia/claude/magical-einstein-2xcxtj/plano-interactivo/apps-script/Code.gs) → borra el contenido de `Código.gs` y pega.
   - [Index.html](https://raw.githubusercontent.com/MickaXXX/cosas-de-ia/claude/magical-einstein-2xcxtj/plano-interactivo/apps-script/Index.html) → botón **+** → *HTML* → nombre `Index` (sin .html) → pega. Debe terminar con la línea `<!-- FIN-INDEX-PLANO-FOTOGRAFICO … -->` y luego `</body>` y `</html>`.
   - [appsscript.json](https://raw.githubusercontent.com/MickaXXX/cosas-de-ia/claude/magical-einstein-2xcxtj/plano-interactivo/apps-script/appsscript.json) → ⚙ *Configuración del proyecto* → marca *Mostrar el archivo de manifiesto "appsscript.json"* → vuelve al editor y reemplaza su contenido.
4. **Instala.** Guarda (Ctrl+S). Arriba, elige la función `instalar` y presiona ▶ *Ejecutar*. Acepta los permisos (Sheets, Drive y conexión externa, que se usa una vez para bajar el plano).
   Se crean las hojas **Puntos** (con los 30 puntos del plano), **Fotos**, **Observaciones** y **Config**, la carpeta *Plano Fotográfico — Fotos* junto a la hoja y el plano dentro de ella.
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
| `plano_archivo` | enlace de Drive a otra imagen del plano (misma encuadre 3427 × 2853) para reemplazar el incluido | vacío |

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

1. Pega los archivos nuevos y guarda.
2. *Implementar → Administrar implementaciones* → ✏ → *Versión: nueva versión* → *Implementar*.

El enlace `/exec` muestra la **última versión publicada**, no la última guardada. Si no haces el paso 2, sigues viendo la versión anterior.

## Si algo falla

Primero usa el menú del Google Sheet **Plano Fotográfico → Diagnóstico**: revisa archivos, hojas, carpetas, plano, publicación y tus permisos, y marca con ✗ lo que falta.

| Lo que ves | Qué hacer |
|---|---|
| El plano se ve gigante, sin puntos ni paneles | El código de la página no arrancó. Vuelve a copiar `Index.html` desde el enlace de arriba y publica una **nueva versión** |
| Página "El archivo Index quedó incompleto" | El pegado se cortó: repite el paso 3 para `Index.html` y publica una nueva versión |
| Recuadro rojo "La app encontró un error" | Envía una captura del recuadro |
| "La app no está instalada" o "Falta el plano" | Menú *Plano Fotográfico → Instalar o reparar* |
| "No tienes permiso…" | Agrega el correo en la hoja **Config** |
| Una foto HEIC de iPhone no sube | Al elegirla desde Safari el iPhone la convierte a JPG; si falla, expórtala como JPG |

Si quedó un archivo `Plano` de la primera versión, bórralo: ya no se usa.

La subestación eléctrica no está rotulada en el plano: agrégala desde la app con *Editar puntos*.
