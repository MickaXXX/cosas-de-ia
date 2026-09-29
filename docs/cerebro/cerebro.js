/* Cerebros — visualización de neuronas (funciones), sinapsis y sub-neuronas (mejoras).
 * Datos: data/index.json + data/<cerebro>.json, generados por `python -m cerebro ciclo`.
 * Las decisiones se guardan en este navegador hasta que se envían a GitHub como issue;
 * el workflow "Cerebro · decisiones" las aplica a la memoria del cerebro. */
(() => {
  "use strict";

  // Tipos de nodo: paleta categórica validada para fondo oscuro (orden fijo).
  const TIPOS = {
    archivo:  { nombre: "Archivo",   color: "#3987e5" },
    funcion:  { nombre: "Función",   color: "#d95926" },
    libreria: { nombre: "Librería",  color: "#199e70" },
    anidada:  { nombre: "Anidada",   color: "#c98500" },
    script:   { nombre: "Principal", color: "#d55181" },
    metodo:   { nombre: "Método",    color: "#008300" },
    mejora:   { nombre: "Mejora",    color: "#fab219" },
  };
  const NEURONA = new Set(["funcion", "anidada", "metodo", "script"]);
  // Estados: paleta de estado; siempre van acompañados de icono y texto.
  const ESTADOS = {
    pendiente: { txt: "Pendiente", ico: "●", color: "#fab219" },
    aceptada:  { txt: "Aceptada",  ico: "✓", color: "#0ca30c" },
    aplicada:  { txt: "Aplicada",  ico: "✓✓", color: "#0ca30c" },
    rechazada: { txt: "Rechazada", ico: "✗", color: "#d03b3b" },
    obsoleta:  { txt: "Obsoleta",  ico: "–", color: "#5d6b7a" },
  };
  const SALUD = {
    alta:    { txt: "Mejora urgente pendiente", color: "#d03b3b" },
    media:   { txt: "Mejora media pendiente",   color: "#ec835a" },
    baja:    { txt: "Solo mejoras menores",     color: "#fab219" },
    sana:    { txt: "Revisada, sin pendientes", color: "#0ca30c" },
    nueva:   { txt: "Aún sin revisar",          color: "#6f8196" },
  };
  const RELS = {
    define: { txt: "define", color: "rgba(90,120,160,.35)" },
    llama:  { txt: "llama",  color: "rgba(122,162,255,.55)" },
    usa:    { txt: "usa",    color: "rgba(25,158,112,.28)" },
    importa:{ txt: "importa",color: "rgba(25,158,112,.28)" },
    mejora: { txt: "mejora", color: "rgba(250,178,25,.35)" },
  };
  const SEV = { alta: 1.5, media: 1, baja: 0.6 };

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };
  const fecha = (s) => s ? new Date(s).toLocaleString("es-CL", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

  const S = {
    idx: null, id: null, d: null, byId: new Map(), mejPorNeu: new Map(),
    tipos: new Set(lsGet("cb.tipos", ["archivo", "funcion", "anidada", "metodo", "script", "libreria", "mejora"])),
    rels: new Set(lsGet("cb.rels", ["define", "llama", "usa", "importa", "mejora"])),
    ests: new Set(lsGet("cb.ests", ["pendiente", "aceptada"])),
    sel: null, hover: null, vecinos: new Set(), graph: null, objs: new Map(), vista: "grafo",
  };

  // ------------------------------------------------------------------ decisiones locales
  const decKey = () => `cb.dec.${S.id}`;
  const decisiones = () => lsGet(decKey(), {});
  const guardarDec = (d) => { lsSet(decKey(), d); pintarBandeja(); };
  const estadoDe = (m) => decisiones()[m.id]?.estado || m.estado;

  function decidir(mid, estado, nota) {
    const d = decisiones();
    const m = S.d.mejoras.find((x) => x.id === mid);
    if (!m) return;
    if (d[mid]?.estado === estado && !nota) delete d[mid];            // segundo clic = deshacer
    else if (estado === m.estado && !nota) delete d[mid];
    else d[mid] = { estado, nota: nota || d[mid]?.nota || "", t: Date.now() };
    guardarDec(d);
    refrescar();
  }

  function pintarBandeja() {
    const d = decisiones();
    const sin = Object.values(d).filter((x) => !x.env).length;
    const env = Object.values(d).filter((x) => x.env).length;
    $("#bandeja").classList.toggle("on", sin + env > 0);
    $("#b-txt").textContent = sin
      ? `${sin} decisión${sin > 1 ? "es" : ""} sin enviar` + (env ? ` · ${env} enviadas` : "")
      : `${env} enviada${env > 1 ? "s" : ""}, esperando que el workflow las aplique`;
    $("#b-enviar").hidden = !sin;
  }

  function enviar() {
    const d = decisiones();
    const lista = Object.entries(d).filter(([, v]) => !v.env).map(([id, v]) => ({ id, estado: v.estado, ...(v.nota ? { nota: v.nota } : {}) }));
    if (!lista.length) return;
    const cuerpo = "Decisiones enviadas desde la web de **Cerebros**. El workflow *Cerebro · decisiones* las aplica a la memoria y cierra este issue.\n\n"
      + lista.map((x) => { const m = S.d.mejoras.find((y) => y.id === x.id); return `- ${ESTADOS[x.estado].ico} **${x.estado}** · ${m ? m.titulo : x.id}`; }).join("\n")
      + "\n\n```json\n" + JSON.stringify({ cerebro: S.id, decisiones: lista }) + "\n```\n";
    const titulo = `[cerebro] ${lista.length} decisiones · ${S.id}`;
    const repo = S.idx.repo;
    if (!repo) { copiar(cuerpo); toast("No sé cuál es el repositorio: copié el cuerpo del issue."); return; }
    const url = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(titulo)}&body=${encodeURIComponent(cuerpo)}`;
    window.open(url, "_blank", "noopener");
    for (const x of lista) d[x.id].env = true;
    guardarDec(d);
    toast("Se abrió GitHub con el issue listo: solo presiona «Create».");
  }

  function comandos() {
    const d = decisiones();
    const txt = Object.entries(d).map(([id, v]) =>
      `python -m cerebro decidir ${S.id} ${id} ${v.estado}` + (v.nota ? ` --nota ${JSON.stringify(v.nota)}` : "")).join("\n");
    copiar(txt); toast("Comandos copiados.");
  }

  function copiar(t) { navigator.clipboard?.writeText(t).catch(() => {}); }
  function toast(t) { const el = $("#toast"); el.textContent = t; el.style.display = "block"; clearTimeout(toast.h); toast.h = setTimeout(() => (el.style.display = "none"), 3200); }

  // ------------------------------------------------------------------ carga
  async function cargar() {
    try {
      S.idx = await (await fetch("data/index.json", { cache: "no-cache" })).json();
    } catch {
      document.body.insertAdjacentHTML("beforeend", `<p class="empty" style="padding:80px 20px;text-align:center">Aún no hay cerebros exportados. Corre <code>python -m cerebro ciclo</code>.</p>`);
      return;
    }
    const sel = $("#sel-cerebro");
    sel.innerHTML = S.idx.cerebros.map((c) => `<option value="${esc(c.id)}">${esc(c.nombre)}</option>`).join("");
    const h = new URLSearchParams(location.hash.slice(1));
    const id = h.get("c") && S.idx.cerebros.some((c) => c.id === h.get("c")) ? h.get("c") : lsGet("cb.cerebro", S.idx.cerebros[0]?.id);
    await abrirCerebro(S.idx.cerebros.some((c) => c.id === id) ? id : S.idx.cerebros[0].id, h.get("n"));
    const v = h.get("v"); if (v) cambiarVista(v);
  }

  async function abrirCerebro(id, nodo) {
    S.id = id; lsSet("cb.cerebro", id);
    $("#sel-cerebro").value = id;
    S.d = await (await fetch(`data/${encodeURIComponent(id)}.json`, { cache: "no-cache" })).json();
    S.byId = new Map(S.d.nodos.map((n) => [n.id, n]));
    S.mejPorNeu = new Map();
    for (const m of S.d.mejoras) (S.mejPorNeu.get(m.neurona) || S.mejPorNeu.set(m.neurona, []).get(m.neurona)).push(m);
    // decisiones locales ya reflejadas en el servidor se limpian solas
    const d = decisiones();
    for (const [mid, v] of Object.entries(d)) {
      const m = S.d.mejoras.find((x) => x.id === mid);
      if (!m || (m.estado === v.estado && (!v.nota || m.nota === v.nota))) delete d[mid];
    }
    guardarDec(d);
    S.objs = new Map(); S.sel = null;
    $("#info").textContent = `${S.d.modelo} · ${S.d.modo} · ${fecha(S.d.generado)}`;
    pintarFiltros(); pintarArchivos(); refrescar();
    if (nodo && S.byId.has(nodo)) setTimeout(() => enfocar(nodo), 900);
  }

  // ------------------------------------------------------------------ salud y colores
  function pendientes(nid) { return (S.mejPorNeu.get(nid) || []).filter((m) => estadoDe(m) === "pendiente"); }
  function salud(n) {
    const p = pendientes(n.id);
    if (p.some((m) => m.severidad === "alta")) return "alta";
    if (p.some((m) => m.severidad === "media")) return "media";
    if (p.length) return "baja";
    return n.revisada ? "sana" : "nueva";
  }
  function colorDe(n) {
    if (n.tipo === "mejora") return ESTADOS[n.estado].color;
    if (NEURONA.has(n.tipo) && $("#o-salud").checked) return SALUD[salud(n)].color;
    return TIPOS[n.tipo]?.color || "#888";
  }
  function radio(n) {
    if (n.tipo === "mejora") return 2.4;
    if (n.tipo === "archivo") return 8;
    if (n.tipo === "libreria") return 3.6;
    const base = n.tipo === "script" ? 6 : 2.6 + Math.sqrt(n.lineas || 4) * 0.75;
    return Math.min(11, base);
  }

  // ------------------------------------------------------------------ datos del grafo
  function datosGrafo() {
    const soloPend = $("#o-pend").checked, sinStd = $("#o-std").checked;
    const nodos = [], ids = new Set();
    const obj = (base) => { let o = S.objs.get(base.id); if (!o) { o = { ...base }; S.objs.set(base.id, o); } else Object.assign(o, base); return o; };
    for (const n of S.d.nodos) {
      if (!S.tipos.has(n.tipo)) continue;
      if (n.tipo === "libreria" && sinStd && n.stdlib) continue;
      if (soloPend && NEURONA.has(n.tipo) && !pendientes(n.id).length) continue;
      nodos.push(obj(n)); ids.add(n.id);
    }
    const links = S.d.enlaces.filter((l) => S.rels.has(l.tipo) && ids.has(l.source) && ids.has(l.target))
      .map((l) => ({ source: l.source, target: l.target, tipo: l.tipo }));
    if (S.tipos.has("mejora")) {
      for (const m of S.d.mejoras) {
        const est = estadoDe(m);
        if (!S.ests.has(est) || !ids.has(m.neurona)) continue;
        const id = "mj:" + m.id;
        const padre = S.objs.get(m.neurona);
        const o = obj({ id, tipo: "mejora", nombre: m.titulo, estado: est, mid: m.id, neurona: m.neurona, severidad: m.severidad });
        if (o.x === undefined && padre?.x !== undefined) { o.x = padre.x + (Math.random() - .5) * 10; o.y = padre.y + (Math.random() - .5) * 10; }
        nodos.push(o); ids.add(id);
        if (S.rels.has("mejora")) links.push({ source: m.neurona, target: id, tipo: "mejora", estado: est });
      }
    }
    return { nodes: nodos, links };
  }

  function calcVecinos() {
    const foco = S.hover || S.sel;
    S.vecinos = new Set();
    if (!foco || !S.graph) return;
    S.vecinos.add(foco);
    for (const l of S.graph.graphData().links) {
      const a = l.source.id ?? l.source, b = l.target.id ?? l.target;
      if (a === foco) S.vecinos.add(b);
      if (b === foco) S.vecinos.add(a);
    }
  }

  // ------------------------------------------------------------------ grafo
  function crearGrafo() {
    const el = $("#grafo");
    const g = ForceGraph()(el)
      .backgroundColor("#070b10")
      .nodeId("id")
      .nodeLabel(() => "")
      .autoPauseRedraw(false)
      .cooldownTicks(220)
      .d3VelocityDecay(0.3)
      .nodeCanvasObject(dibujarNodo)
      .nodePointerAreaPaint((n, color, ctx) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(radio(n) + 3, 6), 0, 2 * Math.PI); ctx.fill(); })
      .linkColor((l) => {
        const foco = S.hover || S.sel;
        const a = l.source.id ?? l.source, b = l.target.id ?? l.target;
        const base = l.tipo === "mejora" ? rgba(ESTADOS[l.estado].color, .45) : RELS[l.tipo].color;
        if (!foco) return base;
        return a === foco || b === foco ? (l.tipo === "mejora" ? ESTADOS[l.estado].color : "rgba(170,200,255,.9)") : "rgba(60,80,100,.08)";
      })
      .linkWidth((l) => { const f = S.hover || S.sel; const a = l.source.id ?? l.source, b = l.target.id ?? l.target; return f && (a === f || b === f) ? 1.6 : (l.tipo === "llama" ? 0.9 : 0.5); })
      .linkLineDash((l) => (l.tipo === "usa" || l.tipo === "importa" ? [2, 3] : null))
      .linkDirectionalArrowLength((l) => (l.tipo === "llama" ? 3 : 0))
      .linkDirectionalArrowRelPos(0.92)
      .linkDirectionalParticles((l) => { const f = S.hover || S.sel; const a = l.source.id ?? l.source, b = l.target.id ?? l.target; return l.tipo === "llama" && f && (a === f || b === f) ? 2 : 0; })
      .linkDirectionalParticleWidth(2.2)
      .linkDirectionalParticleColor(() => "#cfe0ff")
      .onNodeHover((n) => { S.hover = n ? n.id : null; el.style.cursor = n ? "pointer" : "default"; calcVecinos(); tip(n); })
      .onNodeClick((n) => { n.tipo === "mejora" ? mostrarDetalle(n.neurona, n.mid) : mostrarDetalle(n.id); })
      .onBackgroundClick(() => cerrarDetalle());
    g.d3Force("link").distance((l) => ({ mejora: 14, define: 34, llama: 60, usa: 70, importa: 60 }[l.tipo] || 50)).strength((l) => (l.tipo === "mejora" ? 1 : l.tipo === "usa" ? 0.08 : 0.35));
    g.d3Force("charge").strength((n) => (n.tipo === "mejora" ? -12 : -140));
    const tam = () => g.width(el.clientWidth).height(el.clientHeight);
    new ResizeObserver(tam).observe(el); tam();
    el.addEventListener("mousemove", (e) => { const t = $("#tip"); const r = el.getBoundingClientRect(); t.style.left = (e.clientX - r.left + 14) + "px"; t.style.top = (e.clientY - r.top + 14) + "px"; });
    let primera = true;
    g.onEngineStop(() => { if (primera) { g.zoomToFit(500, 60); primera = false; } });
    S.graph = g;
  }

  function dibujarNodo(n, ctx, scale) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return;
    const r = radio(n), col = colorDe(n);
    const foco = S.hover || S.sel;
    const apagado = foco && !S.vecinos.has(n.id);
    const a = apagado ? 0.14 : 1;
    let halo = n.tipo === "mejora" ? 2.6 : 3.2;
    if ($("#o-anim").checked && NEURONA.has(n.tipo) && pendientes(n.id).length) {
      const fase = (n.id.length * 7) % 10;
      halo *= 1 + 0.16 * Math.sin(performance.now() / 520 + fase);
    }
    const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * halo);
    g.addColorStop(0, rgba(col, 0.55 * a)); g.addColorStop(0.35, rgba(col, 0.2 * a)); g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.x, n.y, r * halo, 0, 2 * Math.PI); ctx.fill();
    // núcleo: centro claro hacia el color
    const c = ctx.createRadialGradient(n.x - r * .3, n.y - r * .3, 0, n.x, n.y, r);
    c.addColorStop(0, `rgba(255,255,255,${0.95 * a})`); c.addColorStop(0.45, rgba(col, a)); c.addColorStop(1, rgba(col, 0.85 * a));
    ctx.fillStyle = c; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI); ctx.fill();
    if (n.tipo === "mejora" && n.estado === "aplicada") { // anillo para distinguir aplicada de aceptada
      ctx.strokeStyle = `rgba(7,11,16,${a})`; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.arc(n.x, n.y, r * .55, 0, 2 * Math.PI); ctx.stroke();
    }
    if (n.id === S.sel) { ctx.strokeStyle = "#e8f1fa"; ctx.lineWidth = 1.4 / scale; ctx.beginPath(); ctx.arc(n.x, n.y, r + 3 / scale + 1, 0, 2 * Math.PI); ctx.stroke(); }
    // etiqueta
    const ver = n.id === S.hover || n.id === S.sel || (foco && S.vecinos.has(n.id) && n.tipo !== "mejora") ||
      ($("#o-lbl").checked && n.tipo !== "mejora" && (scale > 1.15 || n.tipo === "archivo" || n.tipo === "script" || r > 7));
    if (ver && !apagado) {
      const fs = 11 / scale;
      ctx.font = `${n.tipo === "archivo" ? 600 : 400} ${fs}px -apple-system, Segoe UI, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      const txt = n.tipo === "mejora" ? n.nombre.slice(0, 48) : (n.nombre || n.id);
      ctx.fillStyle = "rgba(7,11,16,.75)";
      const w = ctx.measureText(txt).width;
      ctx.fillRect(n.x - w / 2 - 2 / scale, n.y + r + 2 / scale, w + 4 / scale, fs + 2 / scale);
      ctx.fillStyle = n.id === S.sel || n.id === S.hover ? "#ffffff" : "#b9c8d8";
      ctx.fillText(txt, n.x, n.y + r + 3 / scale);
    }
  }

  function tip(n) {
    const t = $("#tip");
    if (!n) { t.style.display = "none"; return; }
    let s = "";
    if (n.tipo === "mejora") {
      const m = S.d.mejoras.find((x) => x.id === n.mid);
      s = `<div class="t">${esc(m.titulo)}</div><div class="s">${ESTADOS[n.estado].ico} ${ESTADOS[n.estado].txt} · ${esc(m.categoria)} · impacto ${m.impacto} · esfuerzo ${m.esfuerzo}</div>`;
    } else if (NEURONA.has(n.tipo)) {
      const p = pendientes(n.id).length, sal = SALUD[salud(n)];
      s = `<div class="t">${esc(n.qual || n.nombre)}</div><div class="s">${TIPOS[n.tipo].nombre} · ${n.lineas} líneas · complejidad ${n.complejidad}</div>
        <div class="s">${esc(sal.txt)}${p ? ` · ${p} pendiente${p > 1 ? "s" : ""}` : ""}</div>${n.resumen ? `<div class="s">${esc(n.resumen)}</div>` : ""}`;
    } else if (n.tipo === "libreria") {
      s = `<div class="t">${esc(n.nombre)}</div><div class="s">Librería${n.stdlib ? " estándar" : ""}</div>`;
    } else {
      s = `<div class="t">${esc(n.nombre)}</div><div class="s">${esc(n.id)} · ${n.lineas} líneas</div>`;
    }
    t.innerHTML = s; t.style.display = "block";
  }

  function refrescar() {
    if (!S.graph) crearGrafo();
    S.graph.graphData(datosGrafo());
    calcVecinos();
    const gd = S.graph.graphData();
    $("#hud").innerHTML = `<b>${gd.nodes.length}</b> nodos / <b>${gd.links.length}</b> enlaces<br>${S.d.cobertura.revisadas}/${S.d.cobertura.neuronas} neuronas revisadas por Claude`;
    const pend = S.d.mejoras.filter((m) => estadoDe(m) === "pendiente").length;
    $("#n-pend").textContent = pend; $("#n-pend").hidden = !pend;
    pintarLeyenda(); pintarContadores();
    if (S.vista === "mejoras") pintarMejoras();
    if (S.vista === "cerebro") pintarCerebro();
    if (S.sel && $("#detalle").classList.contains("on")) mostrarDetalle(S.sel, null, true);
  }

  function pintarLeyenda() {
    const items = $("#o-salud").checked
      ? Object.values(SALUD).map((x) => [x.color, x.txt])
      : Object.entries(TIPOS).filter(([k]) => NEURONA.has(k)).map(([, x]) => [x.color, x.nombre]);
    items.push(...Object.entries(TIPOS).filter(([k]) => !NEURONA.has(k) && k !== "mejora").map(([, x]) => [x.color, x.nombre]));
    $("#leyenda").innerHTML = items.map(([c, t]) => `<span><i style="background:${c};box-shadow:0 0 6px ${c}"></i>${esc(t)}</span>`).join("")
      + `<span class="extra">· sub-neurona = mejora (● pendiente, ✓ aceptada, ✗ rechazada)</span>`;
  }

  // ------------------------------------------------------------------ filtros
  function pintarFiltros() {
    const cuentaTipo = {};
    for (const n of S.d.nodos) cuentaTipo[n.tipo] = (cuentaTipo[n.tipo] || 0) + 1;
    cuentaTipo.mejora = S.d.mejoras.length;
    $("#f-tipos").innerHTML = Object.entries(TIPOS).filter(([k]) => cuentaTipo[k]).map(([k, t]) =>
      `<button class="chip ${S.tipos.has(k) ? "on" : ""}" data-set="tipos" data-k="${k}"><span class="sw" style="background:${t.color}"></span>${t.nombre} <span class="c">${cuentaTipo[k]}</span></button>`).join("");
    const cuentaRel = {};
    for (const l of S.d.enlaces) cuentaRel[l.tipo] = (cuentaRel[l.tipo] || 0) + 1;
    cuentaRel.mejora = S.d.mejoras.length;
    $("#f-rel").innerHTML = Object.entries(RELS).filter(([k]) => cuentaRel[k]).map(([k, r]) =>
      `<button class="chip ${S.rels.has(k) ? "on" : ""}" data-set="rels" data-k="${k}">${r.txt} <span class="c">${cuentaRel[k]}</span></button>`).join("");
    pintarContadores();
  }
  function pintarContadores() {
    const c = {};
    for (const m of S.d.mejoras) { const e = estadoDe(m); c[e] = (c[e] || 0) + 1; }
    $("#f-est").innerHTML = Object.entries(ESTADOS).map(([k, e]) =>
      `<button class="chip ${S.ests.has(k) ? "on" : ""}" data-set="ests" data-k="${k}"><span class="sw" style="background:${e.color}"></span>${e.ico} ${e.txt} <span class="c">${c[k] || 0}</span></button>`).join("");
  }
  function pintarArchivos() {
    const arch = S.d.nodos.filter((n) => n.tipo === "archivo");
    $("#archivos").innerHTML = arch.map((a) => {
      const n = S.d.nodos.filter((x) => x.archivo === a.id && NEURONA.has(x.tipo)).length;
      return `<li data-go="${esc(a.id)}"><span>${esc(a.id)}</span><span class="c">${n}</span></li>`;
    }).join("");
  }
  function buscar(q) {
    q = q.trim().toLowerCase();
    const ul = $("#resultados");
    if (!q) { ul.innerHTML = ""; return; }
    const hits = S.d.nodos.filter((n) => (n.qual || n.nombre || n.id).toLowerCase().includes(q)).slice(0, 12);
    ul.innerHTML = hits.map((n) => `<li data-go="${esc(n.id)}"><span class="sw" style="background:${colorDe(n)}"></span>${esc(n.qual || n.nombre)}</li>`).join("")
      || `<li style="color:var(--muted)">Sin resultados</li>`;
  }

  function enfocar(id) {
    cambiarVista("grafo");
    const o = S.objs.get(id);
    if (o && o.x !== undefined) { S.graph.centerAt(o.x, o.y, 600); S.graph.zoom(2.4, 600); }
    mostrarDetalle(id);
    $("#side").classList.remove("on");
  }

  // ------------------------------------------------------------------ detalle
  function resaltar(codigo, desde = 1) {
    const kw = /\b(def|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|import|from|as|with|try|except|finally|raise|lambda|yield|class|pass|break|continue|del|global|nonlocal|assert)\b/g;
    return codigo.split("\n").map((linea, i) => {
      let h = esc(linea);
      const com = h.indexOf("#");
      let cola = "";
      if (com >= 0 && !/(['"]).*#.*\1/.test(linea)) { cola = `<span class="c">${h.slice(com)}</span>`; h = h.slice(0, com); }
      h = h.replace(/(&quot;.*?&quot;|&#39;.*?&#39;|f&quot;.*?&quot;)/g, '<span class="s">$1</span>')
        .replace(/\b(\d+\.?\d*)\b/g, '<span class="nu">$1</span>')
        .replace(kw, '<span class="k">$1</span>')
        .replace(/\b([a-zA-Z_]\w*)(?=\()/g, '<span class="f">$1</span>');
      return `<tr><td class="ln">${desde + i}</td><td>${h}${cola}</td></tr>`;
    }).join("");
  }

  function tarjeta(m, conNeurona) {
    const est = estadoDe(m), loc = decisiones()[m.id];
    const n = S.byId.get(m.neurona);
    const valor = (m.impacto / m.esfuerzo).toFixed(1);
    const botones = [["aceptada", "ok", "✓ Aceptar"], ["rechazada", "no", "✗ Rechazar"], ["aplicada", "ap", "✓✓ Ya aplicada"]]
      .map(([e, cls, t]) => `<button class="btn ${cls}" data-dec="${e}" data-mid="${m.id}" aria-pressed="${est === e}" ${est === e ? 'style="border-color:currentColor"' : ""}>${t}</button>`).join("");
    return `<div class="mj" data-estado="${est}" id="mj-${m.id}">
      <div class="h"><span class="t">${esc(m.titulo)}</span><span class="tag est ${est}">${ESTADOS[est].ico} ${ESTADOS[est].txt}</span></div>
      <div class="meta">
        <span class="tag">${esc(m.categoria)}</span>
        <span class="tag ${m.severidad}">severidad ${m.severidad}</span>
        <span class="tag" title="impacto / esfuerzo">impacto ${m.impacto} · esfuerzo ${m.esfuerzo} · valor ${valor}</span>
        <span class="tag">${m.origen === "claude" ? "Claude" + (m.confianza ? ` · ${Math.round(m.confianza * 100)}%` : "") : "reflejo estático"}</span>
        ${m.codigo_cambio ? `<span class="tag warn">el código cambió: se re-verificará</span>` : ""}
        ${loc ? `<span class="tag local">${loc.env ? "enviada" : "sin enviar"}</span>` : ""}
      </div>
      ${conNeurona && n ? `<button class="neu" data-go="${esc(n.id)}">↳ ${esc(n.qual || n.nombre)}</button>` : ""}
      <div class="porque">${esc(m.porque)}</div>
      ${m.propuesta ? `<pre>${esc(m.propuesta)}</pre>` : ""}
      ${m.nota ? `<div class="porque"><b>Tu nota:</b> ${esc(m.nota)}</div>` : ""}
      ${m.nota_sistema ? `<div class="porque" style="color:var(--muted)">${esc(m.nota_sistema)}</div>` : ""}
      <div class="acc"><input placeholder="Nota (opcional): el cerebro aprende de ella" data-nota="${m.id}" value="${esc(loc?.nota || "")}">${botones}</div>
      <details><summary>Historial · ${fecha(m.fecha)}</summary><ul class="hist">${(m.historial || []).map((h) =>
        `<li>${fecha(h.fecha)} · ${ESTADOS[h.estado]?.ico || ""} ${esc(h.estado)} <span style="color:var(--dim)">por ${esc(h.por)}</span>${h.nota ? ` — ${esc(h.nota)}` : ""}</li>`).join("")}</ul></details>
    </div>`;
  }

  function mostrarDetalle(id, mid, silencioso) {
    const n = S.byId.get(id);
    if (!n) return;
    S.sel = id; calcVecinos();
    if (!silencioso) { const h = new URLSearchParams(location.hash.slice(1)); h.set("c", S.id); h.set("n", id); history.replaceState(null, "", "#" + h); }
    const box = $("#detalle");
    const scroll = silencioso ? box.scrollTop : 0;
    let html = `<button class="close" id="cerrar">✕</button>`;
    const link = (x) => { const o = S.byId.get(x); return `<button class="link" data-go="${esc(x)}">${esc(o ? (o.qual || o.nombre) : x)}</button>`; };
    if (NEURONA.has(n.tipo)) {
      const ms = (S.mejPorNeu.get(id) || []).slice().sort((a, b) => (estadoDe(a) === "pendiente" ? 0 : 1) - (estadoDe(b) === "pendiente" ? 0 : 1) || valor(b) - valor(a));
      const act = ms.filter((m) => ["pendiente", "aceptada"].includes(estadoDe(m)));
      const hist = ms.filter((m) => !["pendiente", "aceptada"].includes(estadoDe(m)));
      const sal = SALUD[salud(n)];
      html += `<h2>${esc(n.qual)}</h2><div class="sub">${esc(n.archivo)}:${n.linea}–${n.fin} · ${TIPOS[n.tipo].nombre}</div>
        <div class="tag" style="display:inline-block;background:none;border:1px solid ${sal.color};color:var(--text)">● ${sal.txt}</div>
        ${n.resumen ? `<div class="resumen">${esc(n.resumen)}</div>` : ""}
        <div class="stats">
          <div class="stat"><b>${n.lineas}</b><span>líneas</span></div>
          <div class="stat"><b>${n.complejidad}</b><span>complejidad</span></div>
          <div class="stat"><b>${n.revisiones}</b><span>revisiones</span></div>
          <div class="stat"><b>${pendientes(id).length}</b><span>pendientes</span></div>
        </div>
        <div class="sub">Última revisión: ${n.revisada ? fecha(n.revisada) + (n.al_dia ? " · al día" : " · el código cambió después") : "aún no"}${n.intervalo && n.revisada ? ` · próxima en ≤ ${n.intervalo} días` : ""}</div>
        <div class="firma">${esc(n.firma)}${n.doc ? `\n# ${esc(n.doc)}` : ""}</div>
        <div class="sec"><h3>Conexiones</h3>
          ${n.llama.length ? `<div class="sub">Llama a</div><div class="links">${n.llama.map(link).join("")}</div>` : ""}
          ${n.llamadores.length ? `<div class="sub" style="margin-top:8px">La llaman</div><div class="links">${n.llamadores.map(link).join("")}</div>` : ""}
          ${n.libs.length ? `<div class="sub" style="margin-top:8px">Usa</div><div class="links">${n.libs.map((l) => link("lib:" + l)).join("")}</div>` : ""}
          <div class="sub" style="margin-top:8px">Vive en</div><div class="links">${link(n.padre || n.archivo)}</div>
        </div>
        <div class="sec"><h3>Sub-neuronas activas · ${act.length}</h3>${act.map((m) => tarjeta(m)).join("") || `<div class="empty" style="padding:6px 0">Sin mejoras activas.</div>`}</div>
        ${hist.length ? `<div class="sec"><details><summary>Historial de mejoras · ${hist.length}</summary><div style="margin-top:8px">${hist.map((m) => tarjeta(m)).join("")}</div></details></div>` : ""}
        <div class="sec"><details ${act.length ? "" : "open"}><summary>Código (${n.lineas} líneas)</summary><div class="code"><table>${resaltar(n.codigo, n.tipo === "script" ? 1 : n.linea)}</table></div></details></div>`;
    } else if (n.tipo === "archivo") {
      const hijos = S.d.nodos.filter((x) => x.archivo === id && NEURONA.has(x.tipo));
      html += `<h2>${esc(n.nombre)}</h2><div class="sub">${esc(id)} · ${n.lineas} líneas</div>
        <div class="sec"><h3>Neuronas · ${hijos.length}</h3><div class="links">${hijos.map((x) => link(x.id)).join("")}</div></div>`;
    } else if (n.tipo === "libreria") {
      const usan = S.d.enlaces.filter((l) => l.target === id && l.tipo === "usa").map((l) => l.source);
      html += `<h2>${esc(n.nombre)}</h2><div class="sub">Librería${n.stdlib ? " estándar" : " externa"}</div>
        <div class="sec"><h3>La usan · ${usan.length}</h3><div class="links">${usan.map(link).join("")}</div></div>`;
    }
    box.innerHTML = html;
    box.classList.add("on");
    box.scrollTop = scroll;
    if (mid) { const el = document.getElementById("mj-" + mid); el?.closest("details")?.setAttribute("open", ""); el?.scrollIntoView({ block: "center" }); el?.animate([{ outline: "2px solid #fab219" }, { outline: "2px solid transparent" }], 1400); }
  }
  function cerrarDetalle() { S.sel = null; calcVecinos(); $("#detalle").classList.remove("on"); }
  const valor = (m) => (m.impacto / m.esfuerzo) * (SEV[m.severidad] || 1) * (m.confianza || 0.7);

  // ------------------------------------------------------------------ vista mejoras
  function pintarMejoras() {
    const cats = [...new Set(S.d.mejoras.map((m) => m.categoria))].sort();
    const selCat = $("#m-cat"), actual = selCat.value;
    selCat.innerHTML = `<option value="">Toda categoría</option>` + cats.map((c) => `<option ${c === actual ? "selected" : ""}>${esc(c)}</option>`).join("");
    const est = $("#m-est").value, cat = selCat.value, ori = $("#m-ori").value, ord = $("#m-ord").value, q = $("#m-q").value.toLowerCase();
    let ms = S.d.mejoras.filter((m) => (!est || estadoDe(m) === est) && (!cat || m.categoria === cat) && (!ori || m.origen === ori)
      && (!q || (m.titulo + " " + m.porque + " " + m.neurona).toLowerCase().includes(q)));
    ms.sort(ord === "fecha" ? (a, b) => b.fecha.localeCompare(a.fecha) : ord === "neurona" ? (a, b) => a.neurona.localeCompare(b.neurona) : (a, b) => valor(b) - valor(a));
    $("#m-count").textContent = `${ms.length} mejora${ms.length === 1 ? "" : "s"}`;
    $("#m-lista").innerHTML = ms.map((m) => tarjeta(m, true)).join("") || `<div class="empty">Nada por aquí con estos filtros.</div>`;
  }

  // ------------------------------------------------------------------ vista cerebro
  function pintarCerebro() {
    const d = S.d, u = d.uso.total || {}, hoy = new Date().toISOString().slice(0, 10), uh = d.uso.dias?.[hoy] || {};
    const usadoHoy = (uh.entrada || 0) + (uh.salida || 0);
    const c = {}; for (const m of d.mejoras) { const e = estadoDe(m); c[e] = (c[e] || 0) + 1; }
    const l = d.lecciones || {};
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
    const dias = Object.entries(d.uso.dias || {}).slice(-7);
    $("#v-cerebro").innerHTML = `
      <h1 class="v">${esc(d.nombre)}</h1>
      <p class="lead">${esc(d.objetivo)}</p>
      <div class="grid">
        <div class="card"><h3>Cobertura</h3><div class="big">${d.cobertura.revisadas} / ${d.cobertura.neuronas}</div>
          <div class="meter" role="img" aria-label="${pct(d.cobertura.revisadas, d.cobertura.neuronas)}% revisado"><i style="width:${pct(d.cobertura.revisadas, d.cobertura.neuronas)}%"></i></div>
          <div class="small">neuronas revisadas por Claude (${pct(d.cobertura.revisadas, d.cobertura.neuronas)} %). Los reflejos estáticos revisan todas en cada ciclo.</div></div>
        <div class="card"><h3>Mejoras</h3><div class="big">${c.pendiente || 0} <span class="small">pendientes</span></div>
          <div class="small">${Object.entries(ESTADOS).map(([k, e]) => `${e.ico} ${e.txt}: ${c[k] || 0}`).join(" · ")}</div></div>
        <div class="card"><h3>Tokens hoy</h3><div class="big">${usadoHoy.toLocaleString("es-CL")}</div>
          <div class="meter" role="img" aria-label="${pct(usadoHoy, d.tokens_por_dia)}% del presupuesto diario"><i style="width:${Math.min(100, pct(usadoHoy, d.tokens_por_dia))}%"></i></div>
          <div class="small">de ${d.tokens_por_dia.toLocaleString("es-CL")} de presupuesto diario${uh.reservado ? ` · ${uh.reservado.toLocaleString("es-CL")} reservados en lote` : ""}</div></div>
        <div class="card"><h3>Costo acumulado</h3><div class="big">US$ ${(u.costo_usd || 0).toFixed(3)}</div>
          <div class="small">${(u.entrada || 0).toLocaleString("es-CL")} entrada · ${(u.salida || 0).toLocaleString("es-CL")} salida · ${(u.cache || 0).toLocaleString("es-CL")} caché · ${u.llamadas || 0} revisiones<br>${esc(d.modelo)} · modo ${esc(d.modo)}${d.modo === "lote" ? " (−50 %)" : ""}</div>
          ${dias.length ? `<table class="small" style="margin-top:8px;width:100%"><tr><th align="left">Día</th><th align="right">Tokens</th><th align="right">US$</th></tr>${dias.map(([k, v]) => `<tr><td>${k.slice(5)}</td><td align="right">${((v.entrada || 0) + (v.salida || 0)).toLocaleString("es-CL")}</td><td align="right">${(v.costo_usd || 0).toFixed(3)}</td></tr>`).join("")}</table>` : ""}</div>
        <div class="card"><h3>Próximas en la agenda</h3>${d.lote ? `<div class="small">Lote en curso desde ${fecha(d.lote.enviado)} (${Object.keys(d.lote.neuronas).length} neuronas)</div>` : ""}
          <ul>${(d.agenda || []).map((q) => `<li><code>${esc(q)}</code></li>`).join("") || "<li>Todo al día</li>"}</ul></div>
        <div class="card"><h3>Lo que aprendió de ti</h3>
          ${l.decididas ? `<div class="small">${l.decididas} decisiones tomadas</div>
          ${l.valora?.length ? `<p>Valoras: <b>${l.valora.map(esc).join(", ")}</b></p>` : ""}
          ${l.evita?.length ? `<p>Sueles rechazar: <b>${l.evita.map(esc).join(", ")}</b></p>` : ""}
          ${l.rechazos?.length ? `<div class="small">Últimos rechazos:</div><ul>${l.rechazos.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}`
          : `<div class="small">Aún no hay decisiones. Cada vez que aceptas o rechazas una mejora (con una nota, idealmente), esas preferencias se le envían a Claude en la próxima revisión.</div>`}</div>
        <div class="card" style="grid-column:1/-1"><h3>Bitácora</h3><ul class="log">${(d.bitacora || []).slice().reverse().map((b) =>
          `<li><span class="d">${fecha(b.fecha)}</span><span><b>${esc(b.evento)}</b> ${esc(b.detalle)}</span></li>`).join("")}</ul></div>
        <div class="card"><h3>Cerebros</h3><div class="brains">${S.idx.cerebros.map((x) =>
          `<button class="${x.id === S.id ? "on" : ""}" data-cerebro="${esc(x.id)}"><b>${esc(x.nombre)}</b><br><span class="small">${x.neuronas} neuronas · ${x.pendientes} pendientes · US$ ${(x.costo_usd || 0).toFixed(2)}</span></button>`).join("")}</div>
          <div class="small" style="margin-top:8px">Nuevo cerebro: <code>python -m cerebro nuevo &lt;id&gt; --rutas carpeta</code></div></div>
      </div>`;
  }

  // ------------------------------------------------------------------ eventos
  function cambiarVista(v) {
    S.vista = v;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.v === v));
    document.querySelectorAll(".view").forEach((s) => s.classList.toggle("on", s.id === "v-" + v));
    if (v !== "grafo") $("#detalle").classList.remove("on");
    if (v === "mejoras") pintarMejoras();
    if (v === "cerebro") pintarCerebro();
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("button, li[data-go]");
    if (!t) return;
    if (t.dataset.v) return cambiarVista(t.dataset.v);
    if (t.dataset.go) return enfocar(t.dataset.go);
    if (t.dataset.cerebro) return abrirCerebro(t.dataset.cerebro);
    if (t.dataset.dec) {
      const nota = document.querySelector(`[data-nota="${t.dataset.mid}"]`)?.value.trim();
      return decidir(t.dataset.mid, t.dataset.dec, nota);
    }
    if (t.dataset.set) {
      const set = S[t.dataset.set], k = t.dataset.k;
      set.has(k) ? set.delete(k) : set.add(k);
      lsSet("cb." + t.dataset.set, [...set]);
      t.classList.toggle("on", set.has(k));
      return refrescar();
    }
    if (t.dataset.all || t.dataset.none) {
      const k = t.dataset.all || t.dataset.none;
      S[k] = new Set(t.dataset.all ? Object.keys(TIPOS) : []);
      lsSet("cb." + k, [...S[k]]); pintarFiltros(); return refrescar();
    }
    if (t.id === "cerrar") return cerrarDetalle();
  });
  $("#sel-cerebro").addEventListener("change", (e) => abrirCerebro(e.target.value));
  $("#q").addEventListener("input", (e) => buscar(e.target.value));
  for (const id of ["o-salud", "o-pend", "o-std", "o-lbl", "o-anim"]) {
    const el = $("#" + id);
    const guardado = lsGet("cb." + id, null);
    if (guardado !== null) el.checked = guardado;
    el.addEventListener("change", () => { lsSet("cb." + id, el.checked); refrescar(); });
  }
  for (const id of ["m-est", "m-cat", "m-ori", "m-ord", "m-q"]) $("#" + id).addEventListener("input", pintarMejoras);
  $("#z-fit").addEventListener("click", () => S.graph?.zoomToFit(500, 60));
  $("#z-reheat").addEventListener("click", () => S.graph?.d3ReheatSimulation());
  $("#bt-side").addEventListener("click", () => $("#side").classList.toggle("on"));
  $("#b-enviar").addEventListener("click", enviar);
  $("#b-cli").addEventListener("click", comandos);
  $("#b-borrar").addEventListener("click", () => { if (confirm("¿Descartar las decisiones guardadas en este navegador?")) { guardarDec({}); refrescar(); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrarDetalle(); });

  cargar();
})();
