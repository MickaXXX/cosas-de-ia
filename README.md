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

## Novedades v1.4

- **Varias carteras con selector.** El nombre de la cartera activa está en la barra superior: cámbiala, crea otras y compáralas. Toda la app (posiciones, alertas, noticias, chat) se ajusta a la que tengas activa.
- **Compartir en solo lectura.** Un enlace lleva la cartera comprimida dentro del `#` de la URL: quien lo abra la ve pero no puede editarla, y puede duplicarla o crear la suya. Sin servidores ni cuentas.
- **Chat con Claude.** La pestaña IA deja de ser una biblioteca de prompts para copiar: con una clave de la API responde con tu cartera, el régimen del mercado y las señales del día ya cargados. Los 10 prompts institucionales se responden con un toque. Se reinicia cada día.
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
- **Radar ampliado**: ~780 activos (S&P 500, Nasdaq 100, mid/small caps populares, ADRs latinoamericanos, semis, IA, energía, uranio, litio, cripto-mineras, defensa, espacio y ETFs). Los tickers que faltan se pueden pedir desde la app y, con token de GitHub, agregarlos al radar en un toque.
- **Precios que se mueven**: `quotes.yml` baja cotizaciones de todo el universo cada hora en horario de mercado (`docs/data/quotes.json`), y opcionalmente Finnhub (clave gratuita) refresca en vivo cada minuto tus posiciones y el activo abierto.
- **Noticias priorizadas**: clasificación heurística siempre (Importante / Media / Baja por tipo de noticia + peso de tu cartera) y, si defines el secreto `ANTHROPIC_API_KEY`, Claude traduce, resume y afina la prioridad de hasta 250 titulares por día (`scripts/news_ai.py`).
- **Conexión opcional con GitHub** (token fine-grained): pedir cotizaciones al instante, lanzar el análisis completo y agregar tickers al radar sin editar archivos.

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
| Botón "Actualizar mercado" que pide cotizaciones nuevas, análisis completo bajo demanda y agregar tickers al radar | Token fine-grained de GitHub para este repo (Actions + Contents: read/write) | App → Ajustes → Conexión con GitHub |
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
