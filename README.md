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
.github/workflows/update-data.yml ← ejecuta el motor a diario y publica los JSON
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

## Qué hace la app

- **Cartera**: valor en USD y CLP, ganancia abierta/realizada/del día, señal ponderada, alertas (cambios de señal, ventas, RSI extremo, resultados próximos, pérdidas > 15 %), distribución por activo/sector/señal, aviso de concentración, y "mis decisiones vs. el modelo" (qué decía el modelo cuando compraste y cómo fue el precio desde entonces).
- **Radar**: todo el universo ordenado por score global o por horizonte, filtros por señal/tipo/favoritos, buscador y top 3 oportunidades.
- **Detalle**: precio y gráfico 6 meses, barras por horizonte con desglose, motivos, consenso de Wall Street (distribución de recomendaciones y rango de precio objetivo), técnico, fundamentales, evolución del score, noticias, y botones **Compré / Vendí**.
- **Hoy**: índices, VIX, bono 10 años, dólar, USD/CLP, petróleo, oro, bitcoin; régimen; cambios de señal; top oportunidades por horizonte; mayores movimientos; próximos resultados; noticias del día (cartera primero).
- **IA**: superprompt con todos los datos del activo (o de la cartera) para pegar en ChatGPT/Claude/Gemini, más la biblioteca de 10 prompts institucionales (Goldman, Morgan Stanley, Bridgewater, JPMorgan, BlackRock, Citadel, Harvard, Bain, Renaissance, McKinsey) auto-rellenados.
- **Ajustes**: estado de los datos, respaldo/restauración de la cartera (JSON), bitácora de mejora continua, explicación del modelo.

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
