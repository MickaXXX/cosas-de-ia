# Datos pendientes e inconsistencias detectadas

Fuente: `Presupuesto_2027-Afta.xlsm` — total detalle SUM 2027: 455,130,800 CLP (113 actividades).

1. Fila 151 'SUM 2027': la columna TOTAL (455,130,800) no cuadra con la suma de Ene–Dic de esa misma fila (456,630,799); diferencia 1,500,000 CLP. El detalle suma 455,130,800. Revisar fórmula de junio.
2. Filas 84, 85, 86 de 'SUM 2027' no tienen Área ni CC (1,143,000 CLP). Se muestran en Planta de RILES por contigüidad y quedan marcadas; confirmar.
3. 52 actividades (255.0 MM CLP, 56% del total) no tienen prioridad en 'SUM 2027'. Se muestran como 'Sin clasificar'; no se infiere prioridad.
4. 'Proyección de Gastos' asigna a Suministros 326.4 MM (C29) dentro de Mantención 735.2 MM, pero el detalle 'SUM 2027' suma 455.1 MM. Aclarar cuál es la cifra oficial a defender y el periodo de la columna 'Real' (B29).
5. N° de motobombas físicas y cuántas operan sin respaldo +1 (referencia verbal ~45 / ~25; no está en el Excel).
6. Configuración de redundancia (N / N+1) por equipo crítico — el Excel sólo la explicita en algunos equipos de RILES.
7. Descomposición del puente 2026→2027 en efecto volumen, nuevas actividades, reprogramación y precio/IPC (el Excel no trae el vínculo actividad 2026 ↔ 2027 ni el supuesto de IPC).
8. Capacidad de HH disponibles por mes (operadores mantenedores + contratistas) para el gráfico de carga vs capacidad.
9. Número y año de la norma aplicable a caldera / línea GNL, antes de citarla ante gerencia.
10. Gasto real 2026 por área de Suministros (sólo existe el presupuesto 2026 por área).

## Notas de limpieza

- Fila 151 de 'SUM 2027' es una fila de totales (TOTAL 455,130,800; suma de meses 456,630,799); se excluye para no duplicar. El dashboard suma las filas de detalle.
- Nombres de área normalizados (trim, mayúsculas, tildes): p. ej. 'planta de frio ' → 'Planta de Frío'; 'caldera ' (2026) → 'Sala de Caldera'.
- Filas con TOTAL 0 excluidas; textos como '$ -' o '#REF!' en meses se tratan como 0.
- Filas sin prioridad se conservan como 'Sin clasificar'.
