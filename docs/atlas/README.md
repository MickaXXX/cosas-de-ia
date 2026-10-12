# 🏠 Atlas Inversión Santiago

Mapa interactivo de proyectos de departamentos en Santiago, con análisis de inversión por unidad: color de entrega, dividendo, arriendo en un radio de 2 km, gasto común, flujo mes a mes, escenarios, riesgo, obras urbanas cercanas, ranking explicable y un asesor. Todo en español de Chile, CLP con separador de miles, UF y fechas de `America/Santiago`.

> La app ayuda a evitar malas decisiones. No vende ilusiones de rentabilidad. Cada número dice de dónde sale. Lo que no está verificado aparece como **provisional**, y lo inventado para pruebas como **DEMO**.

- **App:** `https://mickaxxx.github.io/cosas-de-ia/atlas/` (cuando la rama esté en `main`)
- **Código:** `docs/atlas/` (app), `scripts/atlas/` (pipeline), `tests/atlas/` (pruebas JS), `.github/workflows/atlas-*.yml`

---

## 1. Puesta en marcha

### Ver la app en GitHub Pages (recomendado)
1. Fusiona la rama en `main`. El repositorio ya publica `docs/` en GitHub Pages, así que la app queda en `/cosas-de-ia/atlas/` sin pasos extra.
2. Abre la URL. En el iPhone: Safari → Compartir → *Agregar a pantalla de inicio*.
3. Los workflows programados (`Atlas · actualizar datos`) solo corren sobre `main`. Para correrlos ya: *Actions → Atlas · actualizar datos → Run workflow → `now`*.

### En tu computador
```bash
cd docs && python3 -m http.server 8000
# abrir http://localhost:8000/atlas/
```
No necesita build ni `npm install`. MapLibre GL viene incluido en `docs/atlas/vendor/`. El mapa base (OpenFreeMap) y el geocodificador se cargan de internet. Sin conexión se ven igual los límites comunales, el Metro y los proyectos.

### Pruebas
```bash
node --test tests/atlas/*.test.mjs                  # motor financiero, colores, comparables, ranking, CSV (29 pruebas)
python3 -m unittest discover -s scripts/atlas/tests # pipeline: DST, UF de respaldo, cambios/alertas, issues, geometría (22 pruebas)
python3 scripts/atlas/validate.py --strict          # calidad de los datos (falla si hay errores)
```
La CI (`atlas-tests.yml`) corre las tres en cada cambio de Atlas.

---

## 2. Qué hace (y con qué datos)

| Función | Estado | Datos |
|---|---|---|
| Mapa con pines de casa por color de entrega, clusters con recuento por estado, leyenda, capas | ✅ Funciona | Proyectos de `data/projects.json` + tus importaciones |
| Rojo = entrega inmediata **con entrega y stock verificados** (≤ 60 días); amarillo ≤ 365 días; verde > 365; gris = desconocida, vencida o sin verificar | ✅ Probado (365 vs 366 días) | Borde punteado = precio o stock sin verificar |
| Metro operativo (colores oficiales) y estaciones | ✅ Real | OpenStreetMap, 7 líneas, 126 estaciones |
| Metro en construcción/proyectado (L7, extensión L6) | ✅ Real | OpenStreetMap (trazado comunitario, no oficial) |
| Malls, supermercados, hospitales, clínicas, universidades, parques, museos y cultura | ✅ Real | OpenStreetMap (~2.100 puntos) |
| Límites comunales, microsectores de Santiago Centro | ✅ / propuesta | OSM; los microsectores son **propuestas editables** |
| Radar urbano: obras con radio justificado (L7, L8, L9, Mall Vivo Ñuble, Teleférico, Hospital del Salvador, Plaza Baquedano…) | ✅ 12 obras con fuente | Prensa y fuentes oficiales citadas; resumen propio |
| Radar de noticias (candidatos sin validar) | ✅ Semanal | Google News RSS (titulares + enlace) |
| UF del día | ✅ Diario | SII (tabla oficial); CMF si configuras la clave |
| Ficha completa con "¿De dónde sale este número?" | ✅ | Fuente, fecha, fórmula y confianza |
| Dividendo francés en UF, seguros, gastos de compra, bono pie, 70/80/90%, 15–30 años | ✅ Probado | Reproduce GoodProp: UF 3.249,18 al 3,8% a 30 años = **UF 15,14** |
| Compra en verde: pie en cuotas, crédito y arriendo desde la entrega, atraso, alza de tasa | ✅ Probado | |
| Arriendo en 2 km: promedio, mediana, mín., máx., p25, p75, CLP/m², histograma, exclusiones | ✅ Lógica probada | ⚠️ **No hay avisos reales cargados.** Sin 8 comparables homogéneos se usa una referencia comunal publicada (Assetplan/Yapo 2025), rotulada de **baja confianza** |
| Gasto común: publicado > comparables > banda por comuna (ESTIMADO) | ✅ | Bandas derivadas de promedios publicados (Millacero/Impulsa jul-2026) ÷ superficie típica supuesta |
| Flujo mes a mes (vacancia, corretaje, contribuciones en abr/jun/sep/nov), escenarios conservador/base/optimista/estrés | ✅ Probado | El dueño paga el GC en meses vacíos en todos los escenarios |
| Proyección 1–30 años, TIR real y nominal, VAN, venta neta | ✅ | Plusvalía separada del flujo |
| Riesgo multidimensional + Monte Carlo reproducible | ✅ | Probabilidades rotuladas **SIMULADAS** |
| Airbnb mes a mes, IVA, ocupación y tarifa de equilibrio, legalidad | ✅ Modo supuestos | Sin AirDNA: **simulación de supuestos**, no datos de mercado |
| Ranking con 8 pestañas, perfiles y pesos editables, puertas de calidad | ✅ Probado | DEMO nunca entra al ranking real |
| Comparador (2–5 unidades, mismo escenario) | ✅ | |
| Alertas: proyecto nuevo, baja de precio, cambio de entrega/stock, obra nueva, cambio de posición en el ranking | ✅ | Repo (cada lunes) + reglas locales sobre favoritos |
| Digest semanal "Mis 10 mejores oportunidades" | ✅ En la app · correo opcional | Correo requiere secretos SMTP |
| Asesor guiado (sin IA) y tutorial | ✅ | |
| Chat con Claude que consulta la app vía herramientas | ✅ Opcional | Requiere tu clave de Anthropic (costo por uso) |
| Configuración sin código + auditoría + publicar para todos | ✅ | Local y vía issue `atlas-config:` |
| Importación CSV con validación por fila/columna | ✅ | Plantillas en `templates/` |
| Registro de verificaciones con la inmobiliaria | ✅ | Convierte un gris en rojo/amarillo/verde con tu respaldo |
| Exportar informe | ✅ | PDF (imprimir ficha), Excel (.xls), CSV |

### Los 17 proyectos reales precargados
Salen de búsquedas web en portales (Enlace Inmobiliario, Portal Inmobiliario, Paz) y de tus capturas de GoodProp (Rau Santa Lucía unidad 404 y Mosaic Art). **Ninguno tiene entrega ni stock verificados**: por eso salen en gris o con borde punteado, y en la lista "provisional". Sus precios son "desde" y pueden tener meses de antigüedad. Mosaic Art no aparece en el mapa porque la captura no trae dirección. Para que un proyecto pase a ser una oportunidad verificada:
1. Cotiza con la inmobiliaria.
2. Usa **Registrar verificación** en la ficha (unidad, m², precio, entrega, stock).
3. Importa avisos de arriendo reales cercanos (≥ 8 homogéneos).

### Seguridad y turismo
- **Seguridad:** no se declara "segura" ninguna comuna. El indicador usa la tasa CEAD **comunal** que tú ingresas (Configuración → Comunas y seguridad), con período y fuente. Sin ese dato, el componente queda bajo y no favorece el puntaje.
- **Turismo:** índice propio = museos, atractivos y teatros de OSM a 1,5 km. No mide ocupación de Airbnb.

---

## 3. Arquitectura

```
docs/atlas/                    ← app estática (GitHub Pages)
  index.html, styles.css, manifest.webmanifest, icons/
  js/  finance.js   dividendo, estructura de compra, flujos, escenarios, TIR/VAN, equilibrio
       status.js    colores de entrega
       rentals.js   comparables 2 km, deduplicación, extremos, estadísticos, referencia comunal
       commonexp.js gasto común publicado/estimado
       risk.js      riesgo y Monte Carlo (PRNG con semilla)
       scoring.js   score por perfil, puertas de calidad, plusvalía proyectiva, explicaciones
       analysis.js  une todo por unidad (único módulo que conoce a los demás)
       geo.js, format.js, csv.js
       map.js       MapLibre: capas, pines, clusters, radios, zona dibujada
       app.js       carga de datos, filtros, mapa ↔ panel, navegación
       ficha.js, ranking.js, views.js, admin.js, advisor.js, charts.js, ui.js, core.js
  config/defaults.json         ← supuestos editables (tasas, costos, escenarios, pesos…)
  config/pipeline.json         ← fuentes, búsquedas del radar, umbrales de frescura
  config/import_schema.json    ← esquema CSV único (navegador + pipeline)
  data/                        ← datos publicados (los escribe el pipeline o tú vía issue)
    projects.json, developments.json, rentals.json, rent_reference.json, market.json
    uf.json, health.json, jobs.json, changes.json, radar_candidates.json, ranking_snapshot.json
    osm/*.geojson              ← Metro, estaciones, POIs, comunas (OpenStreetMap)
    demo.json                  ← DATOS FICTICIOS, solo con "Modo DEMO"
  vendor/maplibre/             ← MapLibre GL JS 4.7.1 (BSD-3)
scripts/atlas/                 ← pipeline en Python estándar (sin dependencias)
  run.py (orquestador), update_uf.py, osm_layers.py, geocode.py, news_radar.py,
  validate.py, rank_snapshot.mjs, digest.py, import_data.py, apply_issue.py, make_demo.py
.github/workflows/atlas-data.yml    ← diario (UF), lunes 08:00 Santiago, mensual (OSM), on push
.github/workflows/atlas-issues.yml  ← cambios desde la app (issues atlas-*)
.github/workflows/atlas-tests.yml   ← pruebas
```

**Por qué estática y no Next.js + Supabase/PostGIS (como sugería el prompt maestro):** el repositorio ya publica una app así (GitHub Pages + Actions). Esta forma funciona hoy sin claves, sin servidor y sin costo, y queda auditada en git. Las consultas geoespaciales (radio de 2 km con haversine, punto en polígono) corren en el navegador, rápido para cientos o pocos miles de puntos. Cuando haya un feed con decenas de miles de avisos, conviene migrar los datos a Postgres/PostGIS (`ST_DWithin(geography, 2000)`). El motor (`docs/atlas/js/*.js`) no cambia porque son funciones puras.

**Cómo se guardan los cambios sin servidor:** la app no guarda credenciales. Para publicar supuestos, importaciones u obras, abre un issue de GitHub ya rellenado:
- `atlas-config:`
- `atlas-import:`
- `atlas-obra:`
- `atlas-actualizar:`

`atlas-issues.yml` verifica que el autor sea el dueño del repositorio, aplica el cambio con validación, publica y comenta el resultado. Queda registro de quién y cuándo (issue) y del antes y después (commit). Revertir = `git revert` o "Restablecer supuestos originales".

---

## 4. Actualizaciones programadas

| Cuándo | Qué | Workflow |
|---|---|---|
| Diario ~06:20/07:20 Santiago | UF (SII; CMF con clave) + validación | `atlas-data.yml` (`daily`) |
| **Lunes 08:00 America/Santiago** | UF, capas OSM si están viejas, geocodificación, radar de noticias, foto del ranking, validación y cambios (alertas), digest por correo | `atlas-data.yml` (`weekly`) |
| Día 3 de cada mes | Capas OSM completas | `atlas-data.yml` (`monthly`) |
| Al cambiar datos curados o scripts | Lo que falte (OSM, geocodificación, UF) + validación | `atlas-data.yml` (`bootstrap`) |
| Al abrir un issue `atlas-*` | Aplica tu cambio | `atlas-issues.yml` |

**Horario de verano:** Actions agenda en UTC. El lunes se agendan las 11:00 y las 12:00 UTC, y `run.py` solo ejecuta la que cae a las 08:00 o después en Santiago y una sola vez por semana. Funciona con UTC-3 y con UTC-4, y aunque GitHub atrase el cron (probado).

**Si un conector falla:** se conserva el último dato verificado y se marca `desactualizado`, con fecha y error (Fuentes y datos). Nunca se escribe un cero ni un dato ficticio. Probado: con mindicador.cl cortando desde GitHub, la UF sale del SII.

---

## 5. Integraciones que requieren claves, pagos o acuerdos

| Integración | Para qué | Cómo activarla | Costo | Sin ella |
|---|---|---|---|---|
| **CMF API** | UF oficial con API | Clave gratuita en api.cmfchile.cl → secreto `CMF_API_KEY` | Gratis | SII (funciona) |
| **Banco Central SIETE** | Tasa de colocación vivienda | Usuario/clave gratuitos (conector pendiente) | Gratis | Tasa de referencia citada en `market.json` |
| **Feed de proyectos** (Portal Inmobiliario, TOCTOC, Enlace, GoodProp) | Precios y stock semanales | Acuerdo de datos / API privada. No se hace scraping que viole términos | Según proveedor | Importación CSV y verificación manual |
| **Avisos de arriendo autorizados** | Comparables de 2 km reales | Proveedor licenciado o levantamiento propio (CSV) | Según proveedor | Referencia comunal (baja confianza) |
| **AirDNA** u otro | Ocupación/tarifa Airbnb | Licencia | Pagada | Simulación de supuestos |
| **CEAD/SIED** | Seguridad comunal | Descarga manual del portal → formulario | Gratis | "Sin datos verificados" |
| **Anthropic API** | Chat con Claude en el Asesor | Tu clave en el navegador (Asesor → Chat) | Por uso (modelo `claude-opus-5-5`, US$4 / US$20 por millón de tokens de entrada/salida); una consulta típica con herramientas cuesta centavos de dólar | Asesor guiado sin IA |
| **SMTP** | Digest y alertas por correo | Secretos `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `ALERT_EMAIL_TO` | Gratis con Gmail (contraseña de aplicación) | Alertas dentro de la app |
| **Google Maps/Places** | No se usa | — | — | OpenFreeMap + Nominatim (gratis, con atribución) |

El chat con Claude usa el SDK oficial (`@anthropic-ai/sdk`) cargado bajo demanda. Tiene activado por defecto el respaldo por rechazo del lado del servidor (`fallbacks: "default"`): si el modelo declina, la API reintenta con un modelo de respaldo en la misma llamada. La clave queda solo en tu navegador: usa una con límite de gasto.

---

## 6. Supuestos principales (todos editables en Configuración)

- **Tasa:** 4,2% anual. Referencia: promedio BCCh 3,97% (jun-2026) + margen para inversionista. Convención anual/12. Plazo 30 años, crédito 80% (máx. 90%), regla dividendo ≤ 25% de la renta.
- **Gastos de compra:** tasación 3 UF, estudio de títulos 5, borrador 6, notaría 4, CBR 0,4% del precio, impuesto de timbres 0,8% del crédito.
- **Seguros:** desgravamen 0,012% mensual del saldo; incendio y sismo 0,022% mensual sobre el 80% del precio.
- **Arriendo:** contratos de 24 meses, 1 mes para arrendar, 1 mes vacío entre contratos, corretaje 59,5% de un mes, incobrabilidad 2%, mantención 5%, reserva de mejoras 0,3 UF/mes. Estando arrendado el arrendatario paga el GC.
- **Contribuciones:** (60% del precio como avalúo supuesto − exento $61.711.570) × 0,933% (tasa a confirmar en sii.cl).
- **Valorización:** plusvalía real 1% anual (base), costo de venta 2,5%, inflación 3,5% para TIR nominal.
- **Escenarios:** conservador, base, optimista y estrés, con arriendo, vacancia, mantención, GC, plusvalía, atraso de entrega y alza de tasa en verde.

---

## 7. Cómo pedir mejoras

Ver `HOW_TO_EXTEND.md` (agregar comuna, proveedor, POI, indicador) y `AGENTS.md` (reglas para agentes). Prompt corto:

> Trabaja sobre el repositorio existente de Atlas Inversión Santiago (`docs/atlas`, `scripts/atlas`), respetando el PROMPT MAESTRO y `docs/atlas/AGENTS.md`. Quiero esta mejora específica: **[DESCRIBIR CAMBIO]**. Primero identifica los módulos afectados; después modifica código, configuración o datos sin romper funciones actuales. Actualiza pruebas y documentación. Al terminar, indica qué cambió, cómo verificarlo y qué datos o credenciales faltan. No reemplaces datos reales por demo.

---

## 8. Limitaciones honestas

- No hay avisos de arriendo reales cargados. Las cifras de arriendo de los proyectos reales son referencias comunales de baja confianza hasta que importes avisos o conectes un proveedor.
- Precios, entregas y stock de los proyectos reales salen de portales vía búsqueda web y no están verificados.
- Las direcciones se geocodificaron con Nominatim. Dos quedaron marcadas "por revisar": 252 Marathon y Bilbao 514.
- La seguridad comunal (CEAD) no está cargada.
- Las probabilidades de pérdida son simuladas con distribuciones supuestas, no calibradas con datos observados.
- Los microsectores de Santiago Centro son propuestas a verificar.
- El trazado de la Línea 7 viene de OpenStreetMap (comunitario). Las estaciones de L8 y L9 se ubican en las combinaciones confirmadas; no se dibujan trazados no publicados.
- El "panel /admin con autenticación" es la pestaña Configuración más issues de GitHub. La autenticación y el permiso los da GitHub (solo el dueño publica). No hay una base de datos con roles.
- Las rutas a pie son estimaciones en línea recta × 1,3, no ruteo real.

Licencias: datos © colaboradores de OpenStreetMap (ODbL); mapa base OpenFreeMap; respaldo CARTO; MapLibre GL JS (BSD-3).
