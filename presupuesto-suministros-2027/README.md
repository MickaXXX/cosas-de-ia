# Dashboard · Presupuesto Mantención Suministros 2027 (Planta Antofagasta)

Dashboard ejecutivo para defender técnicamente el presupuesto ante el Gerente de Planta. Tiene 5 vistas: Resumen ejecutivo · Presupuesto por área y prioridad · Plan anual y carga · Criticidad y continuidad · Detalle + Asistente IA.

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
