# Publicar el dashboard en Google Apps Script: paso a paso

Son sólo 2 archivos que copias y pegas: `Code.gs` e `Index`. Hazlo desde un computador con tu cuenta **@ccu.cl**.

Código para copiar:
- Code.gs → https://raw.githubusercontent.com/MickaXXX/cosas-de-ia/claude/dashboard-presupuesto-suministros-2027-ujjx4i/presupuesto-suministros-2027/google-apps-script/Code.gs
- Index → https://raw.githubusercontent.com/MickaXXX/cosas-de-ia/claude/dashboard-presupuesto-suministros-2027-ujjx4i/presupuesto-suministros-2027/google-apps-script/Index.html

## A. Crear el proyecto
1. Abre https://script.google.com/home y haz clic en **＋ Nuevo proyecto** (arriba a la izquierda).
2. Arriba, donde dice **Proyecto sin título**, haz clic y escribe `Dashboard Suministros 2027` → **Cambiar nombre**.

## B. Pegar Code.gs
3. A la izquierda ya existe **Código.gs** con `function myFunction() {…}`. Haz clic en el texto del editor, presiona **Ctrl + A** y luego **Supr** para dejarlo vacío.
4. En otra pestaña abre el link **Code.gs** de arriba. Presiona **Ctrl + A** y **Ctrl + C**.
5. Vuelve al editor y presiona **Ctrl + V**. Guarda con **Ctrl + S**.

## C. Crear y pegar Index
6. A la izquierda, junto a **Archivos**, haz clic en **＋** → **HTML**.
7. Escribe el nombre **`Index`**, exactamente así: con I mayúscula y sin “.html”. Presiona **Enter**.
8. En el nuevo archivo, presiona **Ctrl + A** y **Supr**.
9. Abre el link **Index** de arriba, presiona **Ctrl + A** y **Ctrl + C**, vuelve al editor y presiona **Ctrl + V**. Guarda con **Ctrl + S**.

## D. Autorizar (una vez)
10. Arriba, en el selector de funciones, elige **probar** y haz clic en **▷ Ejecutar**.
11. Aparece “Se necesita autorización” → **Revisar permisos** → elige tu cuenta @ccu.cl → **Permitir**.
12. Abajo, en el registro, debe aparecer `OK: Presupuesto 2027-Afta.xlsm · … KB`.

## E. Publicar y obtener el link
13. Arriba a la derecha: **Implementar** → **Nueva implementación**.
14. Junto a “Seleccionar tipo”, haz clic en el engranaje ⚙️ → **Aplicación web**.
15. Completa:
    - Descripción: `v1`
    - **Ejecutar como:** *Usuario que accede a la aplicación web*
    - **Quién tiene acceso:** *Cualquier usuario de CCU*. Si no aparece, *Cualquier usuario con una cuenta de Google*.
16. **Implementar**. Si lo pide, **Autorizar acceso** → tu cuenta → **Permitir**.
17. Copia la **URL de la aplicación web**, que termina en **/exec**. **Ese es el link del dashboard.**

## Si algo falla
| Mensaje | Solución |
|---|---|
| “No se pudo leer la base en Google Drive” | La cuenta que abre el link no tiene acceso al Excel: pide acceso de lectura a su propietario. |
| La página queda en blanco | En el paso 7 el archivo debe llamarse exactamente `Index`. |
| “Script function not found: doGet” | Falta guardar Code.gs (Ctrl + S) y volver a implementar. |

## Actualizar a una versión nueva del código
Pega el código nuevo y guarda. Luego ve a **Implementar → Gestionar implementaciones → ✏️ (lápiz) → Versión: Nueva versión → Implementar**. El link /exec no cambia.

## Opcional: insertarlo en Google Sites
Abre https://sites.google.com → tu sitio → **Insertar → Insertar → Por URL** → pega el link /exec → **Insertar** → **Publicar**, con visibilidad sólo CCU.
