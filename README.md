# 📈 Market Intelligence AI

App móvil (PWA) de señales cuantitativas de inversión: vigila tu cartera, analiza un universo de acciones y ETFs de EE.UU. cada día y emite recomendaciones **Compra fuerte / Compra / Mantener / Venta / Venta fuerte** por horizonte (**corto, mediano y largo plazo**), al estilo de Google Finance y TradingView, cruzando técnico, fundamentales, consenso de analistas, revisiones de EPS, riesgo y noticias.

No opera por ti: tú compras y vendes en tu broker (Racional) y registras el movimiento en la app en dos toques. La app es el cerebro; el broker es el custodio.

> Señal cuantitativa ≠ predicción segura. Es análisis educativo, no asesoría financiera.

## Estructura

```
docs/                    ← la app (GitHub Pages). Sin build, sin dependencias.
  index.html, app.js, styles.css, sw.js, manifest.webmanifest, icons/
  data/latest.json       ← snapshot diario (precios, scores, analistas, noticias)
  data/history.json      ← historial compacto de scores (120 días) para detectar cambios
scripts/update_data.py   ← motor: descarga (yfinance), indicadores, scoring, poda
config/universe.json     ← tickers que analiza el radar (edítalo para agregar/quitar)
config/weights.json      ← pesos del modelo y umbrales de señal (mejora continua)
config/investors.json    ← inversionistas de referencia y sus posiciones conocidas
config/discovered.json   ← registro del descubridor automático (qué se agregó y cuándo)
scripts/discover.py      ← agrega al radar lo que aparece en screeners y noticias
.github/workflows/update-data.yml ← ejecuta el motor a diario y publica los JSON
.github/workflows/quotes.yml      ← cotizaciones intradía cada hora (docs/data/quotes.json)
scripts/update_quotes.py          ← descarga de cotizaciones en lote
scripts/news_ai.py                ← clasificación de noticias (heurística + Claude opcional)
docs/vendor/tess/                 ← motor OCR (tesseract.js) para leer capturas de Racional
```

## Puesta en marcha (una sola vez, 5 minutos)

1. **Fusiona esta rama en `main`** (o trabaja directo en `main`).
2. **Activa GitHub Pages**: en el repo → *Settings → Pages → Build and deployment*: Source **Deploy from a branch**, Branch **main**, Folder **/docs**. Guarda. En 1–2 minutos la app queda en `https://<tu-usuario>.github.io/cosas-de-ia/`.
3. **Carga datos reales**: *Actions → "Actualizar datos de mercado" → Run workflow*. Tarda 3–6 minutos; hace commit de `docs/data/*.json` y la app deja de mostrar el aviso de "datos de demostración". Después corre solo de lunes a viernes tras el cierre de Wall Street (21:30 UTC) y el domingo por la noche.
4. **En el iPhone**: abre la URL en Safari → botón *Compartir* → *Agregar a pantalla de inicio*. Funciona como app, incluso sin conexión (muestra los últimos datos guardados).

Si Actions no puede hacer push, revisa *Settings → Actions → General → Workflow permissions* y marca **Read and write permissions**.

## Cómo se calcula la señal

Tres modelos independientes, cada uno 0–100, con explicaciones en español:

| Horizonte | Qué pesa |
|---|---|
| **Corto (1 día – 1 mes)** | tendencia (precio vs SMA20/50), RSI + retorno 1M, MACD, volumen relativo, Bandas de Bollinger |
| **Mediano (1 – 12 meses)** | consenso de analistas, potencial al precio objetivo, revisiones de EPS (30 días), crecimiento de ingresos/utilidades, momentum 3–6M y SMA200, P/E forward |
| **Largo (1 – 5 años)** | crecimiento de ingresos, margen neto y ROE, deuda/patrimonio, FCF yield, PEG y P/E forward, visión de analistas, tendencia anual |

- **Global** = 25 % corto + 40 % mediano + 35 % largo (editable en `config/weights.json`).
- **Compra fuerte** exige score ≥ 78 **y confluencia**: mediano y largo ≥ 65. Con confianza baja (p. ej. ETFs, sin fundamentales) nunca se emiten señales "fuertes".
- **Riesgo** (Bajo/Medio/Alto): beta, volatilidad 30 días, drawdown de 1 año, capitalización, liquidez y precio < 5 USD.
- **Rating técnico** estilo TradingView: cada indicador vota compra/venta/neutral.
- **Régimen de mercado** (Risk-on / Neutral / Risk-off) a partir del S&P 500 vs SMA200, VIX y momentum.

Todo se calcula en `scripts/update_data.py`; nada es una caja negra.

## Novedades v1.6 — la app abre al instante

El service worker de la v1.4.2 pedía **todo por red antes de pintar nada**: cada apertura descargaba los 2,9 MB del snapshot completo, y con señal débil la app se quedaba colgada en blanco. Además guardaba una copia de 2,7 MB en `localStorage`, al filo de la cuota del navegador.

- **Shell desde caché, datos en segundo plano.** El armazón (html/js/css) se sirve de caché y se revalida detrás; si hay versión nueva, la app avisa con un botón para recargar. Los datos usan *stale-while-revalidate*: se muestra lo guardado al instante y se actualiza solo. Medido en pruebas: **primer contenido en 0,2 s** contra los ~3,5 s de antes, y la app abre sin internet.
- **Carga en dos tramos.** Primero lo necesario para pintar (análisis, cotizaciones, cartera, mesas) y después el historial de precios de 380 KB, que solo usan Rendimiento y las fichas.
- **Se eliminó la copia gigante en `localStorage`** (ahora la mantiene el service worker): sin riesgo de llenar la cuota ni de congelar el teléfono serializando 2,7 MB en cada carga.
- **Si algo falla, se ve.** En vez de una pantalla muerta, aparece el error concreto y un botón de reintentar.
- **Snapshot 18% más liviano** (596 → 491 KB comprimido): se quita el resumen en inglés de cada noticia, que la app nunca mostraba, y los motivos del modelo se limitan a tres.

### Lo nuevo que ayuda a decidir

- **"Desde tu última visita"**: al abrir, una tarjeta resume cuánto subió o bajó la cartera, qué señales cambiaron de veredicto, qué posiciones son nuevas y cuáles se movieron más hoy.
- **Alertas de stop y objetivo**: avisa cuando una posición cae bajo su stop técnico (2,5 ATR bajo tu precio promedio), cuando llega al objetivo medio de los analistas, y cuando ganas más de 25% y el modelo ya dejó de decir compra.
- **Alertas ordenadas por lo accionable**: antes ganaba el orden de llegada y los titulares tapaban los cambios de señal. Además un mismo titular ya no ocupa tres alertas.
- Titulares con entidades HTML (`Kratos&#39;`) ahora se decodifican en el origen.

## Novedades v1.5 — las mesas de análisis

### Comprobantes, botón de actualizar y radar (v1.5.2)

- **Sube la captura del comprobante y listo.** De "Mi compra de SKHY" o "Mi venta de CAT" la app saca tipo, ticker, acciones exactas, precio, fecha y número de orden, y **suma el movimiento** a la cartera sin borrar nada. El monto del comprobante hace de juez: si acciones × precio no cuadra con el monto, las acciones se recalculan (el OCR pierde comas y lee las barras de las fechas como sietes). El mismo comprobante dos veces no se duplica: se reconoce por su número de orden y, si el OCR lo leyó mal, por el movimiento completo.
- **El botón "Actualizar mercado" ahora actualiza.** Primero recarga lo publicado; si eso ya está viejo, pide al repositorio un run de cotizaciones (un issue de un toque, sin credenciales) y espera: reintenta cada 15 segundos y carga los precios nuevos en cuanto aparecen, sin que haya que hacer nada más.
- **Corregido el fallo que dejaba las compras nuevas fuera del radar.** El motor arma el universo con `stocks` + `etfs`; `core` solo marca prioridad. Al agregar una compra solo a `core`, se analizaba una vez y desaparecía en el run siguiente (NKTX entró y se perdió). Ahora las posiciones entran también en `stocks`, y "nuevo" pasó a significar *sin ficha en el radar* en vez de *ausente del archivo*, así que un símbolo a medio agregar se reintenta solo.

### Lo que compras entra solo al radar (v1.5.1)

- **El radar sigue a tu cartera.** En cada análisis, `discover.py` lee las carteras publicadas y pone todas sus posiciones en `core` de `config/universe.json`: se analizan completas todos los días y la poda automática nunca las toca. Lo que vendes sale de `core` pero sigue en el radar general.
- **Tus compras nuevas llegan sin credenciales.** Si tienes una acción que el radar no cubre, la app lo avisa en Cartera y con un toque abre un issue de GitHub **ya rellenado** con tu cartera; basta pulsar *Submit new issue*. El workflow `portfolio.yml` la publica, mete los símbolos nuevos al radar, los analiza al momento, recalcula las mesas y cierra el issue con el resumen. Solo acepta issues del dueño del repositorio, y valida cada símbolo antes de escribir nada.
- De paso, la cartera queda publicada, así que el teléfono y el computador ven lo mismo.
- **Corregido**: `update_data.py --only` reescribía `latest.json` con solo esos tickers y borraba el resto del radar. Ahora fusiona lo analizado con el snapshot anterior.

La pestaña IA deja de ser un chat que hay que activar. Ahora son **diez mesas institucionales que revisan tu cartera todos los días y ya están escritas cuando abres la app**, sin claves ni configuración:

| Mesa | Qué responde con tus datos |
|---|---|
| 🏦 Goldman Sachs | Las 10 mejores ideas del radar: P/E contra la mediana de su propio sector, crecimiento, deuda, ventaja competitiva, objetivo a 12 meses y stop |
| 📐 Morgan Stanley | DCF a 10 años y, sobre todo, el **crecimiento implícito**: el que el precio de hoy ya da por hecho, contra el que la empresa realmente tiene |
| 🛡️ Bridgewater | Concentración por sector, beta de la cartera, prueba de estrés (−20% del S&P, VIX a 35) y coberturas concretas |
| 📅 JPMorgan | Qué posiciones reportan en 60 días, movimiento típico de un día de resultados y hacia dónde apuntan las revisiones |
| 🧩 BlackRock | Peso actual contra peso objetivo posición por posición, y cuántos dólares hay que mover |
| 📊 Citadel | Ficha técnica de cada posición: tendencia, soporte, resistencia, stop a dos ATR y relación riesgo/beneficio |
| 💵 Harvard Endowment | Cuánta renta genera hoy tu cartera y los pagadores más sólidos del radar, con puntaje de seguridad del dividendo |
| ⚔️ Bain & Company | Cada posición contra sus rivales de la misma industria: tamaño, márgenes, crecimiento y quién lidera |
| 🔬 Renaissance | Anomalías del día: volumen inusual, extremos de RSI, giros de tendencia, máximos anuales, revisiones en bloque |
| 🌍 McKinsey | Régimen de mercado, cuánto pesa el perfil crecimiento en tu cartera, exposición a tasas y al dólar |

- **Todo el cálculo es determinista** (`scripts/desks.py`): sale de los precios, fundamentales, analistas y técnico que la app ya descargó. Funciona sin ninguna clave de API. Se recalcula en el análisis diario y otra vez cada 3 horas con los precios nuevos.
- **Con `ANTHROPIC_API_KEY` en los secretos del repo**, Claude reescribe encima el veredicto, el resumen y los puntos de cada mesa a partir de esos mismos números, y agrega una lista de "qué haría esta mesa" por posición. Sin la clave, se muestra el texto calculado.
- **Asistente que responde sin conexión ni claves.** Pregúntale por una acción ("¿cómo viene SNDK?"), por tu riesgo, por dividendos, por valoración o por lo que reporta pronto: contesta leyendo las mesas y los datos del día. La clave de Claude pasa a ser opcional y vive en Ajustes, solo para conversar en vivo.
- Cada mesa trae su **prompt institucional original** ya rellenado con tus datos, por si quieres pegarlo en otra IA.

## Novedades v1.4

- **Varias carteras con selector.** El nombre de la cartera activa está en la barra superior: cámbiala, crea otras y compáralas. Toda la app (posiciones, alertas, noticias, chat) se ajusta a la que tengas activa.
- **Cartera publicada en el propio enlace** (`docs/data/portfolios.json`): vive en el sitio, así que se ve igual en el teléfono, en el computador y para cualquiera que abra la URL. Si un dispositivo no tiene cartera propia, la app abre la publicada sola; al editar algo se copia a ese dispositivo y sigue siendo tuya.
- **Compartir puntual por enlace.** La cartera viaja comprimida dentro del `#` de la URL y se agrega en solo lectura.
- **Chat con Claude.** La pestaña IA deja de ser una biblioteca de prompts para copiar: con una clave de la API responde con tu cartera, el régimen del mercado y las señales del día ya cargados. Se reinicia cada día. (En v1.5 los prompts institucionales pasaron a ser las mesas de análisis, que ya no necesitan clave.)
- **Resumen del día** generado por Claude en el run diario (`brief` en `latest.json`): qué pasa, qué vigilar y cuál es el riesgo principal.
- **Valoración de analistas estilo Google Finance**: anillo de Compra / Mantenimiento / Venta y previsión de 12 meses con máximo, medio y mínimo frente al precio actual. Está en el detalle de cada activo y en la vista **🎯 Analistas** del radar, con el top 20 del filtro actual.
- **Rendimiento de la cartera**: evolución del valor, mejores y peores días, calendario mensual con color por resultado, últimas ocho semanas y resumen por mes. Se reconstruye con el historial de precios del radar.
- **Objetivos de precio**: potencial agregado de la cartera a 12 meses (medio, alto y bajo) y desglose posición por posición.
- **Noticias cada 3 horas** con un modo `news` barato que solo refresca titulares.

## Novedades v1.3

- **Actualización rápida.** El motor se reescribió: precios de todo el universo en lotes (`yf.download`), **una sola** petición de metadatos por activo en vez de seis, descargas en paralelo y caché rotativa de fundamentales. El run diario pasó de ~40 min a **3-6 min**; el modo `fast` (solo precios y técnico) tarda **~2 min**.
- **Tres modos**: `--mode fast | daily | full`. El botón *Actualizar mercado* de la app dispara precios + análisis rápido y espera a que GitHub publique, sin que tengas que entrar a Actions.
- **Inversionistas de referencia** (`config/investors.json`): 22 gestoras y gurús (Buffett, Ackman, Tepper, Loeb, Druckenmiller, Icahn, ARK, Fundsmith, Akre, Li Lu, Klarman, Tiger, Coatue, Lone Pine, Viking, Bridgewater, Renaissance, Gates, Trian, Elliott, ValueAct, Baillie Gifford). Cada acción muestra **quiénes la tienen** y el Radar tiene filtro **🏆 Gurús**.
- **Radar que se alimenta solo** (`scripts/discover.py`): cada día revisa los screeners de Yahoo (más activas, mayores alzas/bajas, small caps al alza, crecimiento) y las **menciones en las noticias**; valida precio, volumen y bolsa de EE.UU., y agrega hasta 25 tickers nuevos ordenados por relevancia. También **limpia solo**: quita los que llevan 21 días sin aparecer y no están en tu cartera, y elimina los que fallan dos runs seguidos por adquisición, deslistado o cambio de símbolo (con mapa de renombres en `universe.json`).
- **Tu cartera es prioritaria**: los tickers de `core` (tus posiciones en Racional) se refrescan completos en cada run, junto con los de los gurús y los que cambiaron de señal.

## Novedades v1.2

- **Cabecera "Actualizado"** en Cartera con hora del análisis, de los precios intradía y de los precios en vivo, más el botón **Actualizar mercado**.
- **Importar desde capturas de Racional**: sube las capturas de la pantalla Inicio en sus dos vistas (**Último Precio** da la cantidad exacta de acciones, **Ganancia Total** da tu resultado) y la app las lee con OCR en el teléfono, sin enviar nada a internet. El valor se calcula con el precio de mercado actual y el costo sale de restar la ganancia, así que el precio promedio de compra queda exacto. Motor: tesseract.js incluido en `docs/vendor/tess` (≈7 MB, se descarga una sola vez).
- **Radar ampliado**: ~780 activos (S&P 500, Nasdaq 100, mid/small caps populares, ADRs latinoamericanos, semis, IA, energía, uranio, litio, cripto-mineras, defensa, espacio y ETFs). Los tickers que faltan se pueden pedir desde la app y el descubridor diario los agrega solo cuando aparecen en noticias o en carteras de gurús.
- **Precios que se mueven**: `quotes.yml` baja cotizaciones de todo el universo cada hora en horario de mercado (`docs/data/quotes.json`), y opcionalmente Finnhub (clave gratuita) refresca en vivo cada minuto tus posiciones y el activo abierto.
- **Noticias priorizadas**: clasificación heurística siempre (Importante / Media / Baja por tipo de noticia + peso de tu cartera) y, si defines el secreto `ANTHROPIC_API_KEY`, Claude traduce, resume y afina la prioridad de hasta 250 titulares por día (`scripts/news_ai.py`).
- **Cero configuración (v1.4.2)**: la app ya no pide token de GitHub. Precios, señales, noticias, carteras publicadas y análisis completo se generan solos en GitHub Actions; el botón "Actualizar mercado" solo recarga lo último publicado. El service worker sirve la red primero, así que cada dispositivo recibe la versión nueva sin borrar caché.

## Qué hace la app

- **Cartera**: valor en USD y CLP, ganancia abierta/realizada/del día, señal ponderada, alertas (cambios de señal, ventas, RSI extremo, resultados próximos, pérdidas > 15 %), distribución por activo/sector/señal, aviso de concentración, y "mis decisiones vs. el modelo" (qué decía el modelo cuando compraste y cómo fue el precio desde entonces).
- **Radar**: todo el universo ordenado por score global o por horizonte, filtros por señal/tipo/favoritos, buscador y top 3 oportunidades.
- **Detalle**: precio y gráfico 6 meses, barras por horizonte con desglose, motivos, consenso de Wall Street (distribución de recomendaciones y rango de precio objetivo), técnico, fundamentales, evolución del score, noticias, y botones **Compré / Vendí**.
- **Hoy**: índices, VIX, bono 10 años, dólar, USD/CLP, petróleo, oro, bitcoin; régimen; cambios de señal; top oportunidades por horizonte; mayores movimientos; próximos resultados; noticias del día (cartera primero).
- **IA**: superprompt con todos los datos del activo (o de la cartera) para pegar en ChatGPT/Claude/Gemini, más la biblioteca de 10 prompts institucionales (Goldman, Morgan Stanley, Bridgewater, JPMorgan, BlackRock, Citadel, Harvard, Bain, Renaissance, McKinsey) auto-rellenados.
- **Ajustes**: estado de los datos, respaldo/restauración de la cartera (JSON), bitácora de mejora continua, explicación del modelo.

## Opcionales (todos gratis salvo la IA)

| Función | Qué configurar | Dónde |
|---|---|---|
| Precios en vivo cada minuto | Clave gratuita de finnhub.io | App → Ajustes → Precios en vivo |
| Noticias traducidas, resumidas y priorizadas por Claude | Secreto `ANTHROPIC_API_KEY` (opcional: variables `NEWS_MODEL`, `NEWS_AI_MAX`) | GitHub → Settings → Secrets and variables → Actions |

## Almacenamiento auto-gestionado

- El repo solo guarda **el último snapshot** (`latest.json`, ~250 KB) y un historial compacto de scores (`history.json`, 120 días, ~30 KB). Los tickers que salen del universo se eliminan solos.
- Noticias: máximo 5 por activo y 7 días de antigüedad; 12 titulares de mercado.
- En el teléfono: la cartera vive en `localStorage` (KB, no MB) con límites suaves (200 notas, 2 000 movimientos); el service worker borra cachés de versiones anteriores.

## Mejora continua

1. Anota en **Ajustes → Bitácora** lo que quieres cambiar (pesos, tickers, ideas, errores) y cópiala al chat.
2. Los pesos y umbrales viven en `config/weights.json`; los tickers en `config/universe.json`. Un cambio + *Run workflow* recalcula todo.
3. Ideas en cola: notificaciones push/Telegram, importar cartola de Racional, backtesting de señales, cotizaciones intradía, más mercados.

## Ejecutar localmente

```bash
pip install -r scripts/requirements.txt
python scripts/update_data.py            # datos reales
python scripts/update_data.py --demo     # datos sintéticos para probar la UI
python -m http.server 8000 --directory docs   # abre http://localhost:8000
```
