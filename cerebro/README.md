# 🧠 Cerebros

Cerebros que revisan un proyecto **neurona por neurona**, guardan cada mejora como una
**sub-neurona** de la función que mejora y **aprenden de lo que aceptas o rechazas**.

- **Neurona** = una función (también las anidadas y el bloque principal del script).
- **Sinapsis** = una llamada entre funciones (o una función pasada como argumento, p. ej. a `df.apply`).
- **Sub-neurona** = una mejora propuesta para esa neurona, con su historial de estados.
- **Visor**: `docs/cerebro/` → `https://mickaxxx.github.io/cosas-de-ia/cerebro/`

```
cerebro/
  cerebros.json              ← la lista de cerebros y su configuración
  cerebros/<id>/memoria.json ← la memoria (neuronas, mejoras, decisiones, uso de tokens, bitácora)
  anatomia.py                ← código → neuronas + sinapsis (análisis estático, gratis)
  reflejos.py                ← 13 detecciones estáticas (gratis): apply(axis=1), iterrows, parámetros sin uso…
  corteza.py                 ← la revisión con Claude y todo el ahorro de tokens
  memoria.py                 ← agenda, deduplicación, aprendizaje, presupuesto
  web.py                     ← exporta a docs/cerebro/data/*.json
codigo/tesis/                ← el primer cerebro revisa este código
.github/workflows/cerebro.yml             ← ciclo cada hora
.github/workflows/cerebro-decisiones.yml  ← aplica lo que decides en la web
```

## Cómo funciona un ciclo (cada hora)

1. **Escaneo** (0 tokens): se leen los `.py`, se arma el grafo y se calcula la huella de cada
   función. La huella ignora comentarios y espacios: reformatear no dispara revisiones.
2. **Reflejos** (0 tokens): detectan lo obvio. Si un reflejo deja de dispararse, la mejora pasa
   sola a **aplicada** (el cerebro nota que la corregiste).
3. **Corteza** (tokens): de la agenda salen las neuronas que más valen la pena, dentro del
   presupuesto diario, y se mandan a Claude.
4. **Memoria + visor**: se hace commit de `memoria.json` y de los datos del visor.

### Cómo optimiza los tokens

| Palanca | Efecto |
|---|---|
| Solo revisa neuronas **nuevas o cambiadas**; las demás vuelven tras 7 días y, si la revisión no aportó nada, el plazo se **duplica** (hasta 60) | La mayoría de los ciclos no gastan nada |
| **Contexto mínimo**: el código de una función + una línea (la firma) por cada vecina. Las funciones anidadas van colapsadas (se revisan aparte) | ~1–3 mil tokens de entrada por neurona, no el archivo entero |
| Los reflejos y las mejoras previas van como "ya detectado / no repetir" | Claude no gasta salida en lo que un linter ya vio |
| **Modo lote** (Batches API): se envía en un ciclo y se recoge en el siguiente | **−50 %** en todo el costo |
| Salida JSON con esquema, máx. 3 mejoras por neurona, textos acotados | Respuestas cortas |
| Prompt de sistema fijo por cerebro con `cache_control` | Reutilizable cuando supera el mínimo cacheable |
| **Presupuesto diario** (`tokens_por_dia`) con reserva de lo enviado en lote | Nunca se pasa del tope |

Costo estimado con `claude-opus-5-5` (esfuerzo `medium`) en modo lote: **~US$ 0,02–0,05 por neurona
revisada** (el razonamiento cuenta como salida). Una pasada completa del código de la tesis (18 neuronas)
≈ US$ 0,40–0,90; después solo se paga por lo que cambias. La pestaña **Cerebro** del visor muestra
los tokens y el costo reales por día: con eso se ajusta la estimación.

## Evaluar las mejoras

En el visor, pestaña **Mejoras** (o haciendo clic en una neurona): cada tarjeta trae el porqué,
la propuesta lista para pegar, impacto/esfuerzo y confianza. Tres botones:

- **✓ Aceptar** — la harás. Si más adelante el código cambia, Claude verifica si quedó resuelta.
- **✗ Rechazar** — escribe una nota corta ("prefiero legibilidad", "esto es intencional"):
  es lo que más le enseña al cerebro.
- **✓✓ Ya aplicada** — ya está en el código.

Las decisiones quedan en tu navegador hasta que presionas **Enviar a GitHub**: se abre un issue
prellenado, lo creas, y el workflow *Cerebro · decisiones* las aplica, publica y cierra el issue.
También puedes decidir desde la terminal:

```bash
python -m cerebro decidir codigo-tesis m3ec377f6 aceptada --nota "sí"
```

### Qué aprende

Con tus decisiones arma unas **lecciones** (categorías que valoras o rechazas, tus últimos
rechazos con su nota, lo último que aceptaste) que se envían a Claude en cada revisión, en
menos de 900 caracteres. Se ven en la pestaña **Cerebro → Lo que aprendió de ti**.

## Más de un cerebro

Agrega una entrada en `cerebros.json` (o usa el comando) — cada cerebro tiene su objetivo,
modelo, esfuerzo, presupuesto y memoria propios, y el visor los muestra en el selector:

```bash
python -m cerebro nuevo app-mercado --rutas scripts --nombre "App de mercado" \
  --objetivo "Scripts que bajan y puntúan datos de mercado; importa la robustez ante datos faltantes"
python -m cerebro ciclo --cerebro app-mercado --sin-ia
```

El tipo `codigo` es el primer "adaptador". Para otras labores (documentos, tareas, datos), un
adaptador nuevo solo tiene que devolver neuronas con `id`, `codigo`/contenido y `hash`; se
registra en `ADAPTADORES` de `__main__.py` y el resto (agenda, memoria, aprendizaje, visor) se reutiliza.

## Puesta en marcha

1. El secret `ANTHROPIC_API_KEY` ya existe en el repo (lo usan los otros workflows).
2. GitHub Pages ya publica `/docs`: el visor queda en `/cerebro/`.
3. *Actions → Cerebro · ciclo horario → Run workflow* para la primera corrida.
4. Opcional: el modelo, el esfuerzo y el presupuesto se cambian en `cerebros.json`.

### Sin API key (usando una sesión de Claude Code)

```bash
python -m cerebro contexto codigo-tesis           # imprime el prompt compacto de la próxima neurona
python -m cerebro registrar codigo-tesis "<id>" resultado.json   # guarda la respuesta JSON
```

Así se hizo la primera pasada de revisión de este cerebro.

## Comandos

```bash
python -m cerebro ciclo [--cerebro ID] [--sin-ia] [--modo lote|directo]
python -m cerebro estado
python -m cerebro decidir ID MEJORA aceptada|rechazada|aplicada|pendiente|obsoleta [--nota "..."]
python -m unittest discover tests
```
