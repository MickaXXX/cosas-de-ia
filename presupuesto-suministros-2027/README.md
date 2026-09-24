# Dashboard · Presupuesto Mantención Suministros 2027 (Planta Antofagasta)

Dashboard ejecutivo para defender técnicamente el presupuesto ante el Gerente de Planta. Tiene 5 vistas:

1. **Resumen**: KPIs y Sankey Suministros → Área → Sistema.
2. **Árbol de activos**: descomposición Área → Sistema → Subsistema/equipo → Actividad, con el valor 2026 comparable en cada nodo.
3. **2026 → 2027**: puente por tipo de cambio (eliminadas, reducidas, aumentadas, nuevas), indicadores de mejora del presupuesto, cambios por sistema, distribución mensual y tabla partida a partida con su fundamento.
4. **Prioridad y calendario**: matriz área × prioridad, monto e intervenciones por mes, calidad de datos y criticidad.
5. **Detalle + Asistente IA**: botón "Defender este gasto" y trazabilidad por fila.

Los sistemas se obtienen agrupando "Máquina / Equipamiento" con reglas explícitas por área (`SYS_RULES` en `template.html`). Si la base trae columnas `Sistema` y `Subsistema`, se usan esas. Las partidas 2026↔2027 se emparejan por área y similitud de texto, luego por mismo equipo, y luego por mismo sistema con igual monto y meses. Los pares se pueden revisar en la vista 3.

## Fuente de datos

La base es `Presupuesto 2027-Afta.xlsm` en Google Drive. El dashboard lee tres hojas: `SUM 2027`, `Presupuesto 2026` y `Proyección de Gastos`.

- **⟳ Actualizar desde Drive**: descarga la versión vigente del Excel mediante el conector Google Drive de claude.ai y recalcula todo en el navegador. Sólo funciona en la versión publicada en claude.ai.
- **Cargar Excel**: lee un `.xlsm`/`.xlsx` desde tu equipo, con la misma lógica.
- **Copia incluida**: `index.html` trae un snapshot generado con `build.py`, para abrir sin conexión.

El navegador recuerda la última base cargada.

### Columnas opcionales que el dashboard reconoce en `SUM 2027`

Agregarlas al Excel activa automáticamente la criticidad, la redundancia, el mapa de riesgo y los KPI asociados:

`Criticidad` (Crítica/Alta/Media/Baja) · `Redundancia` (N+1 disponible / N+1 parcial / Sin respaldo / Respaldo fuera de servicio / No aplica) · `Principal/Respaldo` · `Tipo de riesgo` · `Función` · `Justificación técnica` · `Consecuencia de falla` · `Probabilidad (1-5)` · `Consecuencia (1-5)` · `Tiempo de recuperación` · `Repuestos`.

El botón “Descargar plantilla de criticidad” de la vista 4 entrega esas columnas con la fila de origen de cada actividad.

## Regenerar la copia incluida

```bash
pip install openpyxl
python3 build.py "ruta/Presupuesto 2027-Afta.xlsm"
```

## Versión Google (oficial)

`google-apps-script/` contiene la versión para publicar como aplicación web de Google Apps Script, restringida al dominio CCU. Lee la base directamente desde Drive y no incluye copia de datos ni servicios externos. Los pasos están en [`google-apps-script/GUIA.md`](google-apps-script/GUIA.md).
