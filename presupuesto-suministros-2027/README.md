# Dashboard · Presupuesto Mantención Suministros 2027 (Planta Antofagasta)

Dashboard HTML de un solo archivo para defender el presupuesto ante la gerencia.
Abre `index.html` en cualquier navegador; funciona sin conexión (sólo "Exportar PNG" descarga html2canvas desde cdnjs).

| Archivo | Contenido |
|---|---|
| `index.html` | Dashboard (10 pestañas, filtros por área, prioridad y mes, modo claro/oscuro, exportación a PDF y PNG) |
| `trazabilidad.csv` | Área, prioridad, actividad, monto y fila de origen de cada cifra (separador `;`) |
| `datos_pendientes.md` | Insumos faltantes e inconsistencias detectadas en el Excel |
| `template.html` / `build.py` | Plantilla y generador |

## Regenerar con un Excel actualizado

```bash
pip install openpyxl
python3 build.py ruta/Presupuesto_2027-Afta.xlsm
```

Criterio de prioridad (tomado del encabezado de la hoja `SUM 2027`): 1 = Reglamentaria, 2 = Continuidad operacional o seguridad, 3 = Otros. Las filas sin prioridad quedan como "Sin clasificar".

Asistentes: por defecto responde un motor local que arma cada respuesta con las filas del Excel y las fichas técnicas. Opcionalmente se puede ingresar una API key de Anthropic (se guarda sólo en la pestaña del navegador) para responder con Claude usando el mismo contexto.
