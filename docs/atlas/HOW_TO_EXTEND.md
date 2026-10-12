# Cómo extender Atlas Inversión Santiago

Recetas cortas para crecer la app sin romper lo que funciona. Después de cada receta: `node --test tests/atlas/*.test.mjs` y `python3 -m unittest discover -s scripts/atlas/tests`.

## Agregar una comuna
**Sin código:** Configuración → Comunas y seguridad → "Agregar comuna", luego márcala como activa. Para dejarla para todos: Configuración → Auditoría → Publicar.

**En el repo:** en `docs/atlas/config/defaults.json`:
- agrega la comuna a `communes.available` (o a `active`);
- si quieres, agrega una banda en `commonExpenses.bandsByCommune` y liquidez en `communeLiquidity`, con su fuente.

Si hay referencia de arriendo publicada, agrégala a `docs/atlas/data/rent_reference.json` con `source_url`, `period` y `verification_status`.

Prompt: *"Agrega la comuna La Reina al mapa y al ranking sin modificar los filtros existentes."*

## Agregar proyectos
- **CSV:** Configuración → Importar datos (plantilla descargable). Valida por fila y columna, guarda en el navegador o publica en el repo (issue `atlas-import:`). Por consola: `python3 scripts/atlas/import_data.py projects archivo.csv`.
- **A mano en `data/projects.json`:** copia la forma de un proyecto existente. Sin `lat`/`lon`, el pipeline lo geocodifica con `address` + `commune` (o `geocode_query`), o lo ancla con `"anchor": {"type": "station", "name": "Ñuble"}`.
- **Verificación con la inmobiliaria:** ficha → "Registrar verificación" → publicar.

## Agregar una obra / POI al radar urbano
- **Desde la app:** Radar urbano → "+ Proponer obra" (o "Validar como obra" sobre un candidato del radar de noticias). Se abre un issue `atlas-obra:` y queda `pendiente_revision`.
- **En `data/developments.json`:** campos `id, name, type, impact, description` (resumen propio), `organism, stage, estimated_date, estimated_label, certainty, radius_m, radius_justification, sources[] {title, url, publisher, published_at, official}, last_checked, status`.
  - Ubicación con uno de: `lat/lon`, `geocode_query`, `anchor` (estación o POI de OSM) o `geometry_from` (trazado de OSM).
  - Pasa a `"status": "publicado"` solo con fuente verificada (idealmente dos, una oficial).
- **POI permanente** (malls, clínicas, etc.): viene de OpenStreetMap. Para una categoría nueva, agrégala en `docs/atlas/config/pipeline.json → poi_categories` (consulta Overpass) y su estilo en `docs/atlas/js/map.js → POI_STYLE`.

Prompt: *"Agrega la clínica X como obra en construcción con radio 1 km y su fuente oficial."*

## Agregar un proveedor de datos (conector)
1. Crea `scripts/atlas/<proveedor>.py` con la interfaz `fetch → normalize → validate → upsert → diff`. Copia el patrón de `update_uf.py`: reintentos con backoff, conservar el último dato bueno si falla, `status`, `last_error`.
2. Agrega su paso a `PLANS` en `scripts/atlas/run.py` (diario, semanal o mensual).
3. Credenciales: secreto de GitHub + variable `env:` en `.github/workflows/atlas-data.yml`. Nunca en el código.
4. Agrega su fila de salud en `scripts/atlas/validate.py → build_health` (aparece en "Fuentes y datos").
5. Escribe pruebas con red simulada (`unittest.mock`) en `scripts/atlas/tests/`.
6. Si el proveedor trae avisos de arriendo, escribe a `data/rentals.json` con el esquema de `config/import_schema.json → rentals`. El motor de comparables los usa sin más cambios.

## Agregar un indicador
1. **Cálculo puro** en un módulo de `docs/atlas/js/` (o una función nueva en `analysis.js`), con prueba en `tests/atlas/`.
2. **En el score:** agrégalo a `COMPONENTS` en `scoring.js` (con su valor `missing` bajo) y su peso en los perfiles de `defaults.json → ranking.profiles`.
3. **Mostrarlo:** KPI en `ficha.js` con `why({...})` (fuente, fórmula, confianza) y columna en `ranking.js`/`views.js` si corresponde.

Prompt: *"Agrega el indicador X al score del perfil conservador con peso 10, sin cambiar los demás."*

## Cambiar supuestos o pesos
Configuración (local, con auditoría) → Publicar para todos. O edita `docs/atlas/config/defaults.json` directamente (git guarda el historial).

## Pedidos frecuentes (prompts)
- *"Cambia el radio de proyectos urbanos futuros a 1 km."* → `developments.json → radius_m` (y justificación).
- *"Agrega una alerta cuando un favorito baje 150 UF."* → ficha → Crear alerta (o el default en `views.js → localAlerts`).
- *"Muestra el flujo de caja anual separado por renta corta y tradicional."* → `ficha.js` (ya calcula ambos: `computeUnit` y `analyzeUnit(..., {mode: 'renta_corta'})`).
- *"Crea un panel para comparar gastos comunes estimados vs reales."* → `views.js`, con `estimateCommonExpenses` y los GC publicados/verificados.
