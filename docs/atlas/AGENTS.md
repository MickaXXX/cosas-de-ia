# AGENTS.md — Atlas Inversión Santiago

Reglas para cualquier agente (Claude Code, Cursor, Codex…) que trabaje en `docs/atlas`, `scripts/atlas`, `tests/atlas` o `.github/workflows/atlas-*.yml`.

## Antes de tocar nada
1. Lee `docs/atlas/README.md` (arquitectura, qué es real, qué es estimado, qué está pendiente).
2. Ubica el módulo correcto (tabla abajo). Cambios puntuales = cambios incrementales: **no reescribas módulos enteros**.
3. Corre las pruebas antes y después:
   ```bash
   node --test tests/atlas/*.test.mjs
   python3 -m unittest discover -s scripts/atlas/tests
   for f in docs/atlas/js/*.js; do node --check "$f"; done
   ```

## Dónde va cada cosa
| Pedido | Módulo |
|---|---|
| Fórmulas de dividendo, flujos, escenarios, TIR | `docs/atlas/js/finance.js` (+ pruebas en `tests/atlas/core.test.mjs`) |
| Colores de pin / reglas de entrega | `docs/atlas/js/status.js` |
| Comparables de arriendo, radio, estadísticos | `docs/atlas/js/rentals.js` |
| Gasto común estimado | `docs/atlas/js/commonexp.js` + `config/defaults.json → commonExpenses` |
| Riesgo y Monte Carlo | `docs/atlas/js/risk.js` + `config/defaults.json → risk` |
| Score, perfiles, puertas de calidad | `docs/atlas/js/scoring.js` + `config/defaults.json → ranking` |
| Unir todo por unidad | `docs/atlas/js/analysis.js` |
| Capas del mapa, estilos, pines | `docs/atlas/js/map.js` |
| Filtros, panel de oportunidades, carga de datos | `docs/atlas/js/app.js` |
| Ficha | `docs/atlas/js/ficha.js` · Ranking `ranking.js` · Comparador/Simulador/Radar/Alertas/Favoritos/Fuentes `views.js` · Configuración `admin.js` · Asesor `advisor.js` |
| Supuestos numéricos | **`docs/atlas/config/defaults.json`** (no los hardcodees en JS) |
| Fuentes del pipeline, búsquedas del radar, umbrales | `docs/atlas/config/pipeline.json` |
| Columnas del CSV | `docs/atlas/config/import_schema.json` (lo usan navegador y pipeline) |
| Proyectos / obras / avisos curados | `docs/atlas/data/projects.json`, `developments.json`, `rentals.json` |
| Descargas programadas | `scripts/atlas/*.py`, `scripts/atlas/run.py`, `.github/workflows/atlas-data.yml` |

## Reglas que no se rompen
- **Honestidad de datos.** Nunca inventes proyectos, direcciones, precios, disponibilidad, fechas, arriendos, ocupación Airbnb, delitos, avances de obra ni tasas. Lo que no tenga fuente queda `null` / "sin datos verificados". Cada dato nuevo lleva `source_name`, `source_url`, `observed_at` y `verification_status` (`verificado`, `importado_sin_verificar`, `captura_usuario`, `extraido_busqueda_web`).
- **DEMO aislado.** Los datos ficticios viven solo en `data/demo.json` (`demo: true`, nombres "DEMO ·", enlaces a example.com). Nunca entran al ranking real ni se mezclan con avisos reales.
- **Rojo** solo con entrega Y stock verificados y recientes. Fecha vencida sin confirmación = **gris**.
- **Arriendo base** = mediana de comparables homogéneos (o referencia rotulada de baja confianza). Nunca el máximo. Menos de `minSample` comparables = "evidencia insuficiente" y sin estadísticos robustos.
- **El dueño paga el gasto común en meses vacíos**, en todos los escenarios.
- **Probabilidades = SIMULADAS** (rótulo obligatorio). Plusvalía separada del flujo observado.
- **La falta de datos nunca sube un score.**
- **Conector caído:** conserva el último dato verificado con estado `desactualizado`. Nunca ceros.
- **Sin scraping** que viole términos de uso, robots o muros de pago. Preferir APIs oficiales, licencias, datos abiertos y CSV del usuario.
- **Sin secretos en el repo.** Las claves van en GitHub Secrets (pipeline) o en el navegador del usuario (Asesor IA).
- **Configuración ≠ código:** números editables en `defaults.json`. Si agregas una clave nueva, agrégala también a la pantalla de Configuración (`admin.js → SECTIONS`) y documéntala.
- **Pruebas:** toda fórmula nueva lleva prueba en `tests/atlas/`. Todo cambio del pipeline, en `scripts/atlas/tests/`.

## Al terminar cada iteración, informa
**Qué implementé / Qué puedo probar / Qué falta / Qué requiere API o autorización.** No declares desplegado ni automatizado algo que no verificaste.
