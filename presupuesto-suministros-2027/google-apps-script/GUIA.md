# Publicar el dashboard en Google (Apps Script + opcional Google Sites)

El dashboard queda como una **aplicación web de Google Apps Script** dentro de Google Workspace de CCU:

- La URL es `script.google.com/a/macros/ccu.cl/...` y sólo pueden entrar cuentas @ccu.cl.
- La página lee `Presupuesto 2027-Afta.xlsm` **directamente desde Google Drive, con la cuenta de quien la abre**: si alguien no tiene acceso al Excel, tampoco ve los datos.
- No trae copia de datos, no llama a servicios externos y no usa IA externa. El asistente es un motor local que arma las respuestas con las filas del Excel.
- Se puede insertar en un sitio de **Google Sites** como página oficial.

## 1. Crear el proyecto (10 minutos, una sola vez)

Hazlo con tu cuenta **@ccu.cl**, desde el computador.

1. Entra a <https://script.google.com> → **Nuevo proyecto**. Renómbralo: `Dashboard Presupuesto Suministros 2027`.
2. Mostrar el manifiesto: ⚙️ **Configuración del proyecto** → marca **“Mostrar el archivo de manifiesto appsscript.json en el editor”**.
3. En el editor (**< >**), reemplaza el contenido de estos archivos con los de esta carpeta:
   - `appsscript.json`
   - `Código.gs` (o `Code.gs`) → contenido de `Code.gs`
4. Crea dos archivos HTML con **＋ → HTML**, **con estos nombres exactos**:
   - `Index` → pega el contenido de `Index.html`
   - `Xlsx` → pega el contenido de `Xlsx.html`. Es la librería que lee Excel (SheetJS, ~880 KB): ábrelo en GitHub con el botón **Raw**, selecciona todo y copia.
5. **Guardar** (💾).

## 2. Publicar como aplicación web

1. **Implementar → Nueva implementación** → tipo ⚙️ **Aplicación web**.
2. Configura:
   - **Ejecutar como:** *Usuario que accede a la aplicación web*. Cada persona usa sus propios permisos de Drive.
   - **Quién tiene acceso:** *Cualquier usuario de CCU* (dominio ccu.cl).
3. **Implementar** → **Autorizar acceso**. Google pide dos permisos:
   - leer archivos de Drive;
   - conectarse a una URL externa, sólo si la base se convierte a Hoja de cálculo de Google, para exportarla.
4. Copia la **URL de la aplicación web** (termina en `/exec`). Ese es el link oficial para compartir.

> Cada persona que abra el link autoriza una vez los mismos permisos y necesita **acceso de lectura** al Excel en Drive. Hoy el propietario del Excel es vmarinv@ccu.cl.

## 3. (Opcional) Insertarlo en Google Sites

1. <https://sites.google.com> → crea un sitio (o usa el del área) → **Insertar → Insertar → Por URL**.
2. Pega la URL `/exec` → **Insertar**. Agranda el recuadro a todo el ancho y alto.
3. **Publicar** el sitio con visibilidad **sólo CCU**.

## 4. Uso diario

- Al abrir, el dashboard lee la versión vigente del Excel.
- Si editas el Excel mientras la página está abierta, pulsa **⟳ Actualizar desde Drive**.
- Las columnas opcionales (`Criticidad`, `Redundancia`, `Sistema`, `Subsistema`, …) que agregues en `SUM 2027` se reconocen solas.

## 5. Cambios de código

1. Pega los archivos nuevos en el editor.
2. **Implementar → Gestionar implementaciones → ✏️ → Versión: Nueva versión → Implementar**.

La URL `/exec` no cambia.

Alternativa por consola, con [clasp](https://github.com/google/clasp):

```bash
npm i -g @google/clasp && clasp login
cd google-apps-script && clasp create --type webapp --title "Dashboard Presupuesto Suministros 2027"
clasp push && clasp deploy
```

## Notas

- **Si cambia el Excel:** si se reemplaza el archivo o se convierte a Hoja de cálculo de Google con un **ID nuevo**, actualiza `FILE_ID` en `Code.gs`. El link `docs.google.com/spreadsheets/d/1Lt-agN6d1NV099LCLnDFAdZ2fV5MpEwN/...` es el mismo archivo.
- **Exportar:** PDF usa la impresión del navegador (“Guardar como PDF”). El CSV de trazabilidad se descarga desde la vista 5.
