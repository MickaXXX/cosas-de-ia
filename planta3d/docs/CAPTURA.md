# Guía de captura

La calidad del modelo depende sobre todo de las fotos. Esta guía resume lo que la fotogrametría necesita.
La app la muestra en la pestaña «Captura».

## Antes de empezar

- Define el alcance: qué equipos y superficies se necesita ver. Registra fecha y **condición de operación**
  (la app tiene campos para eso en cada lote).
- Primer piloto sugerido: un sector accesible de 10–30 m² (bombas, un skid o un tramo de sala de servicios),
  con superficies texturadas y buena luz. Deja para después acero inoxidable muy reflectante, agua, vapor y
  zonas con muchas obstrucciones.
- Captura solo desde zonas habilitadas y sin intervenir equipos para mejorar una foto.

## Cámara

- Cámara principal del teléfono a **1×**. Sin modo retrato, filtros, HDR agresivo ni zoom digital.
- Misma cámara y configuración toda la secuencia (la app agrupa fotos por cámara y resolución; mezclar
  vertical y horizontal crea grupos distintos, lo que es válido pero no ideal).
- iPhone: Ajustes › Cámara › Formatos › **Más compatible** (JPEG). HEIC aún no se acepta.
- Transfiere los archivos originales (cable, carpeta compartida o la propia app). **No por mensajería**: comprime.

## Cómo moverse

1. **Desplázate y detente** en cada toma. Girar el teléfono desde un mismo punto aporta poca geometría.
2. Busca **70–80 % de superposición** entre fotos vecinas: cada superficie debe aparecer en varias tomas desde
   posiciones diferentes.
3. Haz recorridos a **distintas alturas** (agachado, de pie, brazo alzado si es seguro).
4. Conecta vistas **generales, intermedias y de detalle**. Al pasar de un recorrido a otro, fotografía zonas
   comunes: si no, la app reportará «componentes desconectados» y solo mostrará el mayor.
5. Rodea los equipos si necesitas sus caras ocultas. Lo que nunca se fotografía puede faltar o salir
   interpolado; la textura naranja en el modelo indica caras sin imagen asignada.

## Qué evitar

- Fotos movidas, desenfocadas, muy oscuras o con reflejos quemados (la app avisa al instante, pero revisa).
- Personas, ventiladores, correas o equipos moviéndose entre fotos; agua y vapor.
- Superficies lisas sin textura (paredes blancas): agrega puntos de referencia removibles si está permitido.

## Medidas para la escala (obligatorio si se van a medir distancias)

- Mide en terreno **al menos 4 distancias** con instrumento (huincha, distanciómetro): una para **ajustar**
  la escala y **al menos tres reservadas para comprobar**. Distribúyelas en distintas zonas y direcciones.
- Anota exactamente **qué extremos** se midieron y con qué instrumento. Elige extremos que se vean en las
  fotos y sean fáciles de tocar en el modelo (esquinas de bases, pernos, bordes de placas).
- No uses dimensiones nominales de catálogo como si fueran medidas de terreno.
- Define antes la **tolerancia** según el uso (p. ej. ±5 cm para inventario espacial). La app solo marca
  «verificado» si todas las comprobaciones cumplen la tolerancia registrada.

## Cantidad de fotos (orientativo)

| Sector | Fotos | Comentario |
|---|---|---|
| Equipo aislado (bomba, tablero) | 40–100 | Rodeándolo a 2–3 alturas |
| Skid o sector 10–30 m² | 150–300 | Punto de partida del piloto |
| Sala completa | 300–400 por sector | Divide en sectores; el límite por trabajo es configurable (400 por defecto) |

Son puntos de partida, no mínimos universales. Un sector con muchas caras ocultas exige más.

## Perfiles de reconstrucción

| Perfil | Resolución de trabajo | Uso |
|---|---|---|
| Rápido | 1600 px | Validar la captura en el mismo día |
| Estándar | 2400 px | Uso normal |
| Detalle | 3200 px, profundidad a resolución completa | Más lento y exigente en memoria |

Si la reconstrucción falla o queda incompleta, el informe dice por qué (fotos no registradas, componentes,
nube densa insuficiente). Suele convenir **repetir la captura** de la zona antes que subir la resolución.
