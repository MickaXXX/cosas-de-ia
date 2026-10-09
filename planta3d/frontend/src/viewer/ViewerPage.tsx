import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { api, fmt, SCALE_LABEL, type Annotation, type Asset, type Calibration, type CameraPose, type ModelVersion, type Sector } from "../lib/api";
import { go, useLoad } from "../lib/hooks";
import { Modal, ScaleBadge, SourceBadge } from "../components/ui";
import { AssetForm, Documents } from "../pages/AssetsTab";
import { Viewer3D, type Mode, type PickResult } from "./engine";

type Tool = "nav" | "measure" | "annotate" | "calibrate" | "level" | "photos";
type Panel = "markers" | "calibration" | "photos" | "info";
const KIND_LABEL: Record<string, string> = { equipo: "Equipo", nota: "Nota", riesgo: "Riesgo", medicion: "Medición", inspeccion: "Inspección" };
const TOOL_HINT: Record<Tool, string> = {
  nav: "", measure: "Medir: toca dos puntos sobre la superficie.", annotate: "Marcar: toca la superficie donde quieres el marcador.",
  calibrate: "Calibrar: toca los dos extremos de una distancia medida en terreno.", level: "Nivelar: toca 3 puntos del piso.",
  photos: "Fotos: toca una pirámide amarilla para ver la escena desde donde se tomó esa foto.",
};

export default function ViewerPage({ sectorId, modelId }: { sectorId: string; modelId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer3D | null>(null);
  const sector = useLoad(() => api<Sector>(`/api/sectors/${sectorId}`), [sectorId]);
  const models = useLoad(() => api<ModelVersion[]>(`/api/sectors/${sectorId}/models`), [sectorId]);
  const model = useLoad(() => api<ModelVersion>(`/api/models/${modelId}`), [modelId]);
  const calib = useLoad(() => api<Calibration>(`/api/models/${modelId}/calibration`), [modelId]);
  const anns = useLoad(() => api<Annotation[]>(`/api/models/${modelId}/annotations`), [modelId]);
  const assets = useLoad(() => api<Asset[]>(`/api/sectors/${sectorId}/assets`), [sectorId]);
  const project = useLoad(() => sector.data ? api<any>(`/api/projects/${sector.data.project_id}`) : Promise.resolve(null), [sector.data?.project_id]);
  const canEdit = project.data?.my_role === "owner" || project.data?.my_role === "editor";
  const [cams, setCams] = useState<CameraPose[]>([]);
  const [loadState, setLoadState] = useState<{ progress: number; error: string | null; done: boolean }>({ progress: 0, error: null, done: false });
  const [mode, setModeState] = useState<Mode>("orbit");
  const [tool, setTool] = useState<Tool>("nav");
  const [panel, setPanel] = useState<Panel | null>(() => (window.innerWidth > 760 ? "markers" : null));
  const [picks, setPicks] = useState<PickResult[]>([]);
  const [clip, setClip] = useState({ on: false, h: 0.85 });
  const [selected, setSelected] = useState<string | null>(null);
  const [newMarker, setNewMarker] = useState<PickResult | null>(null);
  const [calDraft, setCalDraft] = useState<[PickResult, PickResult] | null>(null);
  const [photo, setPhoto] = useState<{ pose: CameraPose; url: string | null } | null>(null);
  const [assetEdit, setAssetEdit] = useState<Asset | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const m = model.data;
  const scale = m && m.scale_state !== "uncalibrated" ? m.scale_factor : null;

  // ---------- inicialización del motor y carga del GLB
  useEffect(() => {
    if (!host.current) return;
    const v = new Viewer3D(host.current);
    viewer.current = v;
    let alive = true;
    (async () => {
      try {
        const mv = await api<ModelVersion>(`/api/models/${modelId}`);
        v.setAlignment(mv.alignment);
        const { url } = await api<{ url: string }>(`/api/models/${modelId}/artifacts/web_glb/url`);
        await v.load(url, (f) => alive && setLoadState((s) => ({ ...s, progress: f })));
        if (!alive) return;
        setLoadState({ progress: 1, error: null, done: true });
        const c = await api<{ cameras: CameraPose[] }>(`/api/models/${modelId}/cameras`);
        if (alive) setCams(c.cameras);
      } catch (e: any) {
        if (alive) setLoadState({ progress: 0, error: e?.message || "No se pudo cargar el modelo (verifica formato o decodificadores de compresión)", done: false });
      }
    })();
    return () => { alive = false; v.dispose(); viewer.current = null; };
  }, [modelId]);

  useEffect(() => { if (viewer.current && m) { viewer.current.setAlignment(m.alignment); viewer.current.metersPerUnit = scale; } }, [m, scale]);
  useEffect(() => { viewer.current?.setCameraPoses(cams, tool === "photos" || panel === "photos"); }, [cams, tool, panel, loadState.done]);
  useEffect(() => { viewer.current?.setClip(clip.on, clip.h); }, [clip, loadState.done]);

  // ---------- superposiciones (mediciones, calibración, selección)
  useEffect(() => {
    const v = viewer.current;
    if (!v || !loadState.done) return;
    const segs: { a: number[]; b: number[]; color: number }[] = [];
    const pts: { p: number[]; color: number }[] = [];
    picks.forEach((p) => pts.push({ p: p.model.toArray(), color: 0xfbbf24 }));
    if (picks.length === 2 && tool === "measure") segs.push({ a: picks[0].model.toArray(), b: picks[1].model.toArray(), color: 0xfbbf24 });
    if (panel === "calibration") {
      calib.data?.references.forEach((r) => segs.push({ a: r.point_a, b: r.point_b, color: 0x38bdf8 }));
      calib.data?.checks.forEach((c) => segs.push({ a: c.point_a, b: c.point_b, color: c.within_tolerance === false ? 0xf87171 : 0x34d399 }));
    }
    anns.data?.filter((a) => a.kind === "medicion" && a.extra?.point_b).forEach((a) => segs.push({ a: a.position, b: a.extra.point_b, color: 0xa78bfa }));
    anns.data?.forEach((a) => pts.push({ p: a.position, color: a.id === selected ? 0x38bdf8 : 0xe6edf3 }));
    v.setOverlay(segs, pts);
  }, [picks, tool, panel, calib.data, anns.data, selected, loadState.done]);

  // ---------- etiquetas HTML proyectadas cada cuadro
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    v.onFrame = () => {
      const box = labelsRef.current;
      if (!box) return;
      box.querySelectorAll<HTMLElement>("[data-p]").forEach((el) => {
        const p = JSON.parse(el.dataset.p!);
        const s = v.project(p);
        if (!s) { el.style.display = "none"; return; }
        el.style.display = "";
        el.style.left = `${s.x}px`;
        el.style.top = `${s.y}px`;
      });
    };
  }, [loadState.done]);

  const setMode = (md: Mode) => { viewer.current?.setMode(md); setModeState(md); };

  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const fmtDist = (d: number) => scale ? `${fmt.len(d * scale)}${m?.scale_state === "verified" ? "" : " (estimación)"}` : `${d.toFixed(3)} u (sin escala)`;

  // ---------- interacción con el lienzo
  const down = useRef<{ x: number; y: number; t: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => { down.current = { x: e.clientX, y: e.clientY, t: Date.now() }; };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || Date.now() - d.t > 600) return; // fue un arrastre
    const v = viewer.current;
    if (!v) return;
    if (tool === "photos") {
      const pose = v.nearestPose(e.clientX, e.clientY);
      if (pose) openPhoto(pose);
      return;
    }
    if (tool === "nav") return;
    const hit = v.pick(e.clientX, e.clientY);
    if (!hit) { flash("No hay superficie del modelo en ese punto"); return; }
    if (tool === "annotate") { setNewMarker(hit); return; }
    const next = [...(picks.length >= (tool === "level" ? 3 : 2) ? [] : picks), hit];
    setPicks(next);
    if (tool === "calibrate" && next.length === 2) setCalDraft([next[0], next[1]]);
    if (tool === "level" && next.length === 3) levelFloor(next);
  };

  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(null), 2600); };

  const openPhoto = async (pose: CameraPose) => {
    setPhoto({ pose, url: null });
    viewer.current?.flyToPhoto(pose);
    if (pose.photo_id) {
      try { const r = await api<{ url: string }>(`/api/photos/${pose.photo_id}/url?variant=working`); setPhoto({ pose, url: r.url }); } catch { /* sin foto */ }
    }
  };
  const stepPhoto = (dir: number) => {
    if (!cams.length) return;
    const i = photo ? cams.findIndex((c) => c.image === photo.pose.image) : -1;
    openPhoto(cams[(i + dir + cams.length) % cams.length]);
  };

  const changeTool = (t: Tool) => {
    setPicks([]);
    setTool(tool === t ? "nav" : t);
    if (t === "calibrate") setPanel("calibration");
    if (t === "photos") setPanel("photos");
    if (t !== "photos") setPhoto(null);
  };

  // ---------- nivelar: el plano de 3 puntos del piso pasa a ser horizontal (y=0)
  const levelFloor = async (p: PickResult[]) => {
    if (!m) return;
    const [a, b, c] = p.map((x) => x.display);
    let n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    if (n.y < 0) n = n.negate();
    const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 1, 0));
    const R = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const M = new THREE.Matrix4().set(...(m.alignment as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]));
    const NM = R.multiply(M);
    const a2 = p[0].model.clone().applyMatrix4(NM);
    NM.premultiply(new THREE.Matrix4().makeTranslation(0, -a2.y, 0));
    const rowMajor = NM.clone().transpose().toArray(); // three guarda columna-mayor
    try {
      await api(`/api/models/${m.id}`, { method: "PATCH", body: { alignment: rowMajor, alignment_source: "Nivelada con 3 puntos del piso" } });
      setPicks([]); setTool("nav"); model.reload(); flash("Orientación actualizada. Las coordenadas del modelo y los marcadores no cambian.");
      setTimeout(() => viewer.current?.frame(), 300);
    } catch (e: any) { flash(e.message); }
  };

  const rotateUp = async (axis: "y90" | "x180") => {
    if (!m) return;
    const R = axis === "y90" ? new THREE.Matrix4().makeRotationY(Math.PI / 2) : new THREE.Matrix4().makeRotationX(Math.PI);
    const M = new THREE.Matrix4().set(...(m.alignment as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]));
    const NM = R.multiply(M);
    await api(`/api/models/${m.id}`, { method: "PATCH", body: { alignment: NM.clone().transpose().toArray(), alignment_source: axis === "y90" ? "Girada 90° manualmente" : "Invertida manualmente" } });
    model.reload();
    setTimeout(() => viewer.current?.frame(), 300);
  };

  const saveMeasure = async () => {
    if (picks.length !== 2) return;
    const d = dist(picks[0].model.toArray(), picks[1].model.toArray());
    const title = prompt("Nombre de la medición", `Medición ${fmtDist(d)}`);
    if (!title) return;
    await api(`/api/models/${modelId}/annotations`, { body: { title, kind: "medicion", position: picks[0].model.toArray(), extra: { point_b: picks[1].model.toArray(), model_distance: d, meters_at_save: scale ? d * scale : null, scale_state_at_save: m?.scale_state } } });
    setPicks([]); anns.reload();
  };

  const exportGlb = async (metric: boolean) => {
    try {
      const r = await api<{ url: string }>(`/api/models/${modelId}/export?metric=${metric}`, { method: "POST" });
      window.location.href = r.url;
    } catch (e: any) { flash(e.message); }
  };
  const exportCsv = () => {
    const M = new THREE.Matrix4().set(...((m?.alignment ?? []) as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]));
    const rows = [["id", "titulo", "tipo", "tag_activo", "x_modelo", "y_modelo", "z_modelo", `x_${scale ? "m" : "u"}`, `y_${scale ? "m" : "u"}`, `z_${scale ? "m" : "u"}`, "estado_escala"]];
    for (const a of anns.data ?? []) {
      const p = new THREE.Vector3(...(a.position as [number, number, number])).applyMatrix4(M).multiplyScalar(scale ?? 1);
      rows.push([a.id, a.title, a.kind, assets.data?.find((x) => x.id === a.asset_id)?.tag ?? "", ...a.position.map((x) => x.toFixed(4)), ...p.toArray().map((x) => x.toFixed(4)), m?.scale_state ?? ""]);
    }
    const blob = new Blob(["﻿" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `marcadores-v${m?.number}.csv`; a.click();
  };
  const screenshot = () => {
    const url = viewer.current?.screenshot();
    if (!url) return;
    const a = document.createElement("a"); a.href = url; a.download = `captura-${sector.data?.name ?? "modelo"}.jpg`; a.click();
  };

  const sel = anns.data?.find((a) => a.id === selected) ?? null;
  const focusAnn = useCallback((a: Annotation) => {
    setSelected(a.id);
    const v = viewer.current;
    if (!v) return;
    const p = v.toDisplay(a.position);
    if (v.mode === "plan") { v.controls.target.copy(p); v.ortho.position.set(p.x, v.ortho.position.y, p.z); v.controls.update(); return; }
    if (v.mode === "walk") v.setMode("orbit");
    const off = new THREE.Vector3().subVectors(v.persp.position, v.controls.target).normalize().multiplyScalar(v.diag * 0.18);
    v.controls.target.copy(p);
    v.persp.position.copy(p).add(off);
    v.controls.update();
    setModeState(v.mode);
  }, []);

  const labels = useMemo(() => anns.data ?? [], [anns.data]);

  return (
    <div className="viewer-shell">
      <div className="viewer-bar">
        <button className="btn sm" onClick={() => go(`/s/${sectorId}/modelos`)}>← Sector</button>
        <b style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 260 }}>{sector.data?.name}</b>
        {models.data && (
          <select style={{ width: "auto", minHeight: 30, padding: "2px 8px" }} value={modelId} onChange={(e) => go(`/s/${sectorId}/visor/${e.target.value}`)}>
            {models.data.map((x) => <option key={x.id} value={x.id}>v{x.number} · {x.label}</option>)}
          </select>
        )}
        {m && <div className="status-chip"><SourceBadge source={m.source} /><ScaleBadge state={m.scale_state} /><span className="badge mute">{fmt.date(m.created_at)}</span></div>}
        <span className="spacer" />
        {(["markers", "calibration", "photos", "info"] as Panel[]).map((p) => (
          <button key={p} className={`btn sm ${panel === p ? "active" : ""}`} onClick={() => setPanel(panel === p ? null : p)}>
            {{ markers: "Marcadores", calibration: "Escala", photos: "Fotos", info: "Modelo" }[p]}
          </button>
        ))}
      </div>
      <div className="viewer-main">
        <div ref={host} className="viewer-canvas" onPointerDown={onPointerDown} onPointerUp={onPointerUp} style={{ cursor: tool === "nav" ? "grab" : "crosshair" }} />
        <div ref={labelsRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden", zIndex: 2 }}>
          {labels.map((a) => (
            <div key={a.id} data-p={JSON.stringify(a.kind === "medicion" && a.extra?.point_b ? a.position.map((x, i) => (x + a.extra.point_b[i]) / 2) : a.position)}
              className={a.kind === "medicion" ? "measure-label" : `label3d k-${a.kind} ${a.id === selected ? "sel" : ""}`}
              style={{ pointerEvents: a.kind === "medicion" ? "none" : "auto" }} onClick={() => { setSelected(a.id); setPanel("markers"); }}>
              {a.kind === "medicion" ? `${a.title}` : `${a.asset_id ? (assets.data?.find((x) => x.id === a.asset_id)?.tag ?? "") + " " : ""}${a.title}`}
            </div>
          ))}
          {picks.length === 2 && tool === "measure" && (
            <div className="measure-label" data-p={JSON.stringify(picks[0].model.toArray().map((x, i) => (x + picks[1].model.toArray()[i]) / 2))}>
              {fmtDist(dist(picks[0].model.toArray(), picks[1].model.toArray()))}
            </div>
          )}
        </div>
        {photo && (
          <div className={`photo-overlay ${photo.url ? "on" : ""}`}>{photo.url && <img src={photo.url} alt="" />}</div>
        )}
        <div className="tools">
          <button className={`btn ${mode === "orbit" ? "active" : ""}`} onClick={() => setMode("orbit")} title="Órbita: arrastrar para girar, rueda/pellizco para acercar, botón derecho/dos dedos para desplazar">🛰 <span className="t">Órbita</span></button>
          <button className={`btn ${mode === "walk" ? "active" : ""}`} onClick={() => setMode("walk")} title="Recorrido: WASD/flechas para caminar, Q/E bajar/subir, arrastrar para mirar">🚶 <span className="t">Recorrido</span></button>
          <button className={`btn ${mode === "plan" ? "active" : ""}`} onClick={() => setMode("plan")} title="Vista de planta (ortográfica, desde arriba)">🗺 <span className="t">Planta</span></button>
          <button className={`btn ${clip.on ? "active" : ""}`} onClick={() => setClip({ ...clip, on: !clip.on })} title="Corte horizontal para ver el interior">✂ <span className="t">Corte</span></button>
          <button className={`btn ${tool === "measure" ? "active" : ""}`} onClick={() => changeTool("measure")}>📏 <span className="t">Medir</span></button>
          {canEdit && <button className={`btn ${tool === "annotate" ? "active" : ""}`} onClick={() => changeTool("annotate")}>📍 <span className="t">Marcar</span></button>}
          {canEdit && <button className={`btn ${tool === "calibrate" ? "active" : ""}`} onClick={() => changeTool("calibrate")}>📐 <span className="t">Calibrar</span></button>}
          {cams.length > 0 && <button className={`btn ${tool === "photos" ? "active" : ""}`} onClick={() => changeTool("photos")}>📷 <span className="t">Fotos</span></button>}
          <button className="btn" onClick={() => viewer.current?.frame()} title="Encuadrar el sector">⛶ <span className="t">Encuadrar</span></button>
        </div>
        {clip.on && (
          <div className="hud" style={{ bottom: tool !== "nav" ? 60 : 14 }}>
            Altura de corte <input type="range" min={0} max={1} step={0.005} value={clip.h} onChange={(e) => setClip({ ...clip, h: Number(e.target.value) })} style={{ width: 160, verticalAlign: "middle", minHeight: 0 }} />
          </div>
        )}
        {tool !== "nav" && (
          <div className="hud">
            {TOOL_HINT[tool]}
            {tool === "measure" && picks.length === 2 && <> · <b>{fmtDist(dist(picks[0].model.toArray(), picks[1].model.toArray()))}</b> {canEdit && <button className="btn sm" style={{ marginLeft: 6 }} onClick={saveMeasure}>Guardar</button>}</>}
            {tool === "measure" && !scale && <><br /><small>Sin calibrar: no son metros. Calibra con una distancia conocida.</small></>}
            {tool === "photos" && photo && <> · {photo.pose.filename} <button className="btn sm" onClick={() => stepPhoto(-1)}>◀</button> <button className="btn sm" onClick={() => stepPhoto(1)}>▶</button> <button className="btn sm" onClick={() => setPhoto(null)}>Ocultar foto</button></>}
          </div>
        )}
        {mode === "walk" && <Joystick onMove={(x, y) => viewer.current?.setJoystick(x, y)} />}
        {toast && <div className="hud" style={{ bottom: 70, borderColor: "var(--warn)" }}>{toast}</div>}
        {!loadState.done && (
          <div className="hud" style={{ bottom: "50%" }}>
            {loadState.error ? <span className="error">{loadState.error}</span> : <>Cargando modelo… {Math.round(loadState.progress * 100)} %</>}
          </div>
        )}

        {panel && (
          <aside className="side">
            <header><b>{{ markers: "Marcadores", calibration: "Escala y validación", photos: "Fotos registradas", info: "Modelo" }[panel]}</b><span className="spacer" /><button className="btn ghost sm" onClick={() => setPanel(null)}>✕</button></header>
            <div className="body">
              {panel === "markers" && (sel ? (
                <MarkerDetail ann={sel} sectorId={sectorId} assets={assets.data ?? []} canEdit={canEdit} fmtDist={fmtDist}
                  onBack={() => setSelected(null)} onChanged={() => { anns.reload(); assets.reload(); }} onEditAsset={setAssetEdit} />
              ) : (
                <>
                  {canEdit && <p className="muted" style={{ fontSize: ".85rem" }}>Usa 📍 Marcar y toca una superficie. Los marcadores se guardan en coordenadas de esta versión del modelo.</p>}
                  {(anns.data ?? []).length === 0 && <small className="muted">Sin marcadores.</small>}
                  {(anns.data ?? []).map((a) => (
                    <div key={a.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid #22313f", cursor: "pointer" }} onClick={() => focusAnn(a)}>
                      <span className="badge mute">{KIND_LABEL[a.kind] ?? a.kind}</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.title}</span>
                      {a.kind === "medicion" && a.extra?.model_distance != null && <small>{fmtDist(a.extra.model_distance)}</small>}
                    </div>
                  ))}
                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="btn sm" onClick={exportCsv}>Exportar CSV</button>
                  </div>
                </>
              ))}
              {panel === "calibration" && m && calib.data && (
                <CalibrationPanel model={m} cal={calib.data} canEdit={canEdit} onChanged={() => { calib.reload(); model.reload(); }}
                  onStart={() => changeTool("calibrate")} />
              )}
              {panel === "photos" && (
                <>
                  <p className="muted" style={{ fontSize: ".85rem" }}>{cams.length} fotos con pose estimada. Elige una para ver el modelo desde esa posición y superponer la foto original.</p>
                  {cams.length === 0 && <small className="muted">Esta versión no tiene poses de cámara (p. ej. modelo importado).</small>}
                  {cams.map((c) => (
                    <div key={c.image} className="row" style={{ padding: "5px 0", cursor: "pointer", color: photo?.pose.image === c.image ? "var(--accent)" : undefined }} onClick={() => { setTool("photos"); openPhoto(c); }}>
                      📷 <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.filename}</span>
                    </div>
                  ))}
                </>
              )}
              {panel === "info" && m && (
                <div style={{ fontSize: ".88rem" }}>
                  <p><b>v{m.number}</b> · {m.label}</p>
                  <p><SourceBadge source={m.source} /> <ScaleBadge state={m.scale_state} /></p>
                  {m.source === "demo" && <div className="notice">Modelo de demostración: no corresponde al sector real.</div>}
                  {m.source === "imported" && <div className="notice info">Modelo importado: no proviene de la reconstrucción de esta app.</div>}
                  <p className="muted">{m.coordinate_system}</p>
                  <p><b>Orientación:</b> {m.alignment_source}</p>
                  {canEdit && (
                    <div className="row" style={{ marginBottom: 10 }}>
                      <button className="btn sm" onClick={() => changeTool("level")}>Nivelar con 3 puntos</button>
                      <button className="btn sm" onClick={() => rotateUp("y90")}>Girar 90°</button>
                      <button className="btn sm" onClick={() => rotateUp("x180")}>Invertir</button>
                    </div>
                  )}
                  <p>Triángulos: {m.stats.triangles?.toLocaleString("es-CL") ?? "—"} · GLB {fmt.bytes(m.stats.bytes)}</p>
                  {m.stats.registered_photos != null && <p>Fotos registradas: {m.stats.registered_photos} · componentes: {m.stats.components}</p>}
                  <p>Escala: {m.scale_factor ? `${m.scale_factor.toPrecision(6)} m por unidad (${m.scale_method})` : "sin calibrar"}</p>
                  <div className="notice info" style={{ fontSize: ".8rem" }}>Las zonas naranjas de la textura no tienen imagen asignada: no son evidencia observada. Las superficies nunca fotografiadas pueden faltar o estar interpoladas.</div>
                  <h3 style={{ marginTop: 12 }}>Exportar</h3>
                  <div className="row">
                    <button className="btn sm" disabled={!scale} onClick={() => exportGlb(true)} title={scale ? "" : "Requiere calibración"}>GLB en metros</button>
                    <button className="btn sm" onClick={() => exportGlb(false)}>GLB orientado</button>
                    <button className="btn sm" onClick={screenshot}>Captura JPG</button>
                  </div>
                  <small className="muted">El GLB exportado incluye la transformación (escala · orientación) en un nodo raíz y los marcadores como nodos. El maestro no se modifica.</small>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
      {newMarker && m && <NewMarker pick={newMarker} modelId={modelId} sectorId={sectorId} assets={assets.data ?? []}
        onClose={() => setNewMarker(null)} onDone={(a) => { setNewMarker(null); anns.reload(); assets.reload(); setSelected(a.id); setPanel("markers"); }} />}
      {calDraft && m && <CalibrationDialog model={m} picks={calDraft} onClose={() => { setCalDraft(null); setPicks([]); }}
        onDone={() => { setCalDraft(null); setPicks([]); calib.reload(); model.reload(); }} />}
      {assetEdit && <AssetForm sectorId={sectorId} asset={assetEdit} canEdit={canEdit} onClose={() => setAssetEdit(null)} onDone={() => { setAssetEdit(null); assets.reload(); }} />}
    </div>
  );
}

function Joystick({ onMove }: { onMove: (x: number, y: number) => void }) {
  const [k, setK] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const upd = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    let x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
    setK({ x, y }); onMove(x, -y);
  };
  return (
    <div ref={ref} className="joystick" onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); upd(e); }}
      onPointerMove={(e) => e.buttons && upd(e)} onPointerUp={() => { setK({ x: 0, y: 0 }); onMove(0, 0); }}>
      <div className="knob" style={{ transform: `translate(${k.x * 33}px, ${k.y * 33}px)` }} />
    </div>
  );
}

function NewMarker({ pick, modelId, sectorId, assets, onClose, onDone }: { pick: PickResult; modelId: string; sectorId: string; assets: Asset[]; onClose: () => void; onDone: (a: Annotation) => void }) {
  const [f, setF] = useState({ title: "", kind: "equipo", body: "", asset_id: "", new_tag: "", new_type: "" });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      let assetId = f.asset_id || null;
      if (f.asset_id === "__new") {
        const a = await api<Asset>(`/api/sectors/${sectorId}/assets`, { body: { name: f.title, tag: f.new_tag || null, asset_type: f.new_type || null } });
        assetId = a.id;
      }
      const a = await api<Annotation>(`/api/models/${modelId}/annotations`, { body: { title: f.title, kind: f.kind, body: f.body || null, position: pick.model.toArray(), normal: pick.normalModel?.toArray() ?? null, asset_id: assetId } });
      onDone(a);
    } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal title="Nuevo marcador" onClose={onClose}>
      <form onSubmit={submit}>
        <label>Título<input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required placeholder="p. ej. Bomba de alimentación" /></label>
        <label>Tipo<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND_LABEL).filter(([k]) => k !== "medicion").map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Ficha de equipo vinculada
          <select value={f.asset_id} onChange={(e) => setF({ ...f, asset_id: e.target.value })}>
            <option value="">— ninguna —</option><option value="__new">+ Crear ficha nueva</option>
            {assets.map((a) => <option key={a.id} value={a.id}>{a.tag ? `${a.tag} · ` : ""}{a.name}</option>)}
          </select>
        </label>
        {f.asset_id === "__new" && <div className="grid2"><label>TAG (manual)<input value={f.new_tag} onChange={(e) => setF({ ...f, new_tag: e.target.value })} /></label><label>Tipo de equipo<input value={f.new_type} onChange={(e) => setF({ ...f, new_type: e.target.value })} /></label></div>}
        <label>Descripción / notas<textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
        <small className="muted">Posición (coordenadas del modelo): {pick.model.toArray().map((x) => x.toFixed(3)).join(", ")}</small>
        {error && <p className="error">{error}</p>}
        <div className="row" style={{ marginTop: 10 }}><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary">Guardar</button></div>
      </form>
    </Modal>
  );
}

function MarkerDetail({ ann, sectorId, assets, canEdit, fmtDist, onBack, onChanged, onEditAsset }: { ann: Annotation; sectorId: string; assets: Asset[]; canEdit: boolean; fmtDist: (d: number) => string; onBack: () => void; onChanged: () => void; onEditAsset: (a: Asset) => void }) {
  const [f, setF] = useState({ title: ann.title, body: ann.body ?? "", kind: ann.kind, asset_id: ann.asset_id ?? "" });
  useEffect(() => setF({ title: ann.title, body: ann.body ?? "", kind: ann.kind, asset_id: ann.asset_id ?? "" }), [ann]);
  const asset = assets.find((a) => a.id === ann.asset_id);
  const save = async () => { await api(`/api/annotations/${ann.id}`, { method: "PATCH", body: { title: f.title, body: f.body || null, kind: f.kind, asset_id: f.asset_id || null } }); onChanged(); };
  const del = async () => { if (confirm("¿Eliminar el marcador?")) { await api(`/api/annotations/${ann.id}`, { method: "DELETE" }); onBack(); onChanged(); } };
  return (
    <div>
      <button className="btn ghost sm" onClick={onBack}>← Lista</button>
      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: "8px 0" }}>
        <label>Título<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label>Tipo<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Ficha vinculada<select value={f.asset_id} onChange={(e) => setF({ ...f, asset_id: e.target.value })}><option value="">— ninguna —</option>{assets.map((a) => <option key={a.id} value={a.id}>{a.tag ? `${a.tag} · ` : ""}{a.name}</option>)}</select></label>
        <label>Notas<textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
      </fieldset>
      {ann.kind === "medicion" && ann.extra?.model_distance != null && <p>Distancia: <b>{fmtDist(ann.extra.model_distance)}</b><br /><small className="muted">Al guardarla: {ann.extra.meters_at_save != null ? fmt.len(ann.extra.meters_at_save) : "sin escala"} ({SCALE_LABEL[ann.extra.scale_state_at_save as keyof typeof SCALE_LABEL] ?? "—"})</small></p>}
      {ann.extra?.transferred && <div className="notice info">Transferido desde otra versión con revisión: {ann.extra.transferred.review_note}</div>}
      {asset && (
        <div className="card" style={{ background: "#0b1117", borderColor: "#2b3b4b", padding: 10, marginBottom: 8 }}>
          <div className="row"><b className="mono">{asset.tag || "sin TAG"}</b><span>{asset.name}</span><span className="spacer" /><button className="btn sm" onClick={() => onEditAsset(asset)}>Ficha</button></div>
          <small className="muted">{asset.asset_type || "—"} · {asset.op_status ? `${asset.op_status} (${asset.op_status_source}, ${fmt.date(asset.op_status_at)})` : "estado no registrado"}</small>
        </div>
      )}
      <Documents sectorId={sectorId} annotationId={ann.id} canEdit={canEdit} />
      <small className="muted" style={{ display: "block", marginTop: 8 }}>Coordenadas del modelo: {ann.position.map((x) => x.toFixed(3)).join(", ")}</small>
      {canEdit && <div className="row" style={{ marginTop: 10 }}><button className="btn danger sm" onClick={del}>Eliminar</button><span className="spacer" /><button className="btn primary sm" onClick={save}>Guardar</button></div>}
    </div>
  );
}

function CalibrationDialog({ model, picks, onClose, onDone }: { model: ModelVersion; picks: [PickResult, PickResult]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ role: "fit", label: "", real_distance: "", unit: "m", source: "", endpoints_description: "" });
  const [error, setError] = useState<string | null>(null);
  const d = picks[0].model.distanceTo(picks[1].model);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api(`/api/models/${model.id}/${f.role === "fit" ? "references" : "checks"}`, {
        body: { label: f.label, point_a: picks[0].model.toArray(), point_b: picks[1].model.toArray(), real_distance: Number(f.real_distance), unit: f.unit, source: f.source, endpoints_description: f.endpoints_description || null },
      });
      onDone();
    } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal title="Distancia medida en terreno" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted" style={{ fontSize: ".85rem" }}>Distancia en el modelo: {d.toFixed(4)} unidades. Usa una medición de terreno con instrumento, no una dimensión nominal del equipo.</p>
        <label>Uso de esta medida
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="fit">Referencia para ajustar la escala</option>
            <option value="check">Comprobación reservada (no se usa para ajustar)</option>
          </select>
        </label>
        <label>Nombre<input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} required placeholder="p. ej. Ancho de base del skid" /></label>
        <div className="grid2">
          <label>Distancia real<input type="number" step="any" min="0" value={f.real_distance} onChange={(e) => setF({ ...f, real_distance: e.target.value })} required /></label>
          <label>Unidad<select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>{["m", "cm", "mm", "in", "ft"].map((u) => <option key={u}>{u}</option>)}</select></label>
        </div>
        <label>Instrumento y procedencia<input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} required placeholder="p. ej. Huincha 5 m, medido por J. Pérez 08-10-2026" /></label>
        <label>Extremos medidos<textarea value={f.endpoints_description} onChange={(e) => setF({ ...f, endpoints_description: e.target.value })} placeholder="p. ej. Borde exterior de perno de anclaje A a perno B" /></label>
        {error && <p className="error">{error}</p>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary">Guardar</button></div>
      </form>
    </Modal>
  );
}

function CalibrationPanel({ model, cal, canEdit, onChanged, onStart }: { model: ModelVersion; cal: Calibration; canEdit: boolean; onChanged: () => void; onStart: () => void }) {
  const [tol, setTol] = useState({ abs: model.tolerance_abs_m != null ? String(model.tolerance_abs_m * 100) : "", rel: model.tolerance_rel != null ? String(model.tolerance_rel * 100) : "", purpose: model.tolerance_purpose ?? "" });
  const saveTol = async () => {
    await api(`/api/models/${model.id}`, { method: "PATCH", body: { tolerance_abs_m: tol.abs ? Number(tol.abs) / 100 : null, tolerance_rel: tol.rel ? Number(tol.rel) / 100 : null, tolerance_purpose: tol.purpose || null } });
    onChanged();
  };
  const del = async (kind: "references" | "checks", id: string) => { if (confirm("¿Eliminar?")) { await api(`/api/models/${model.id}/${kind}/${id}`, { method: "DELETE" }); onChanged(); } };
  return (
    <div style={{ fontSize: ".86rem" }}>
      <div className={`notice ${cal.scale_state === "verified" ? "ok" : cal.scale_state === "uncalibrated" ? "" : "info"}`}>{cal.notice}</div>
      {cal.scale_factor && <p>Factor: <b>{cal.scale_factor.toPrecision(6)}</b> m/unidad · {cal.method}</p>}
      {canEdit && <button className="btn primary sm" onClick={onStart}>📐 Agregar medida (toca 2 puntos)</button>}
      <h3 style={{ marginTop: 12 }}>Referencias de ajuste ({cal.references.length})</h3>
      {cal.references.map((r) => (
        <div key={r.id} style={{ borderBottom: "1px solid #22313f", padding: "5px 0" }}>
          <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}><b style={{ color: "#38bdf8", flex: 1, minWidth: 0 }}>{r.label}</b>{canEdit && <button className="btn ghost sm" onClick={() => del("references", r.id)}>✕</button>}</div>
          <small>Real {fmt.len(r.real_distance_m)} · modelo {r.model_distance?.toFixed(4)} u{r.abs_error_m != null && cal.references.length > 1 ? ` · residuo ${fmt.len(r.abs_error_m)}` : ""}<br />{r.source}</small>
        </div>
      ))}
      <h3 style={{ marginTop: 12 }}>Comprobaciones reservadas ({cal.n_checks}/{cal.min_checks_required} mínimas)</h3>
      {cal.checks.map((c) => (
        <div key={c.id} style={{ borderBottom: "1px solid #22313f", padding: "5px 0" }}>
          <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
            <span style={{ flex: 1, minWidth: 0 }}><b style={{ color: c.within_tolerance === false ? "#f87171" : "#34d399" }}>{c.label}</b>{" "}
              {c.within_tolerance != null && <span className={`badge ${c.within_tolerance ? "ok" : "bad"}`}>{c.within_tolerance ? "en tolerancia" : "fuera"}</span>}</span>
            {canEdit && <button className="btn ghost sm" onClick={() => del("checks", c.id)}>✕</button>}</div>
          <small>Real {fmt.len(c.real_distance_m)}{c.scaled_distance_m != null ? ` · modelo ${fmt.len(c.scaled_distance_m)} · error ${fmt.len(c.abs_error_m!)} (${(c.rel_error! * 100).toFixed(2)} %)` : " · sin escala aún"}<br />{c.source}</small>
        </div>
      ))}
      {cal.n_checks > 0 && <p>Error máx. {cal.max_abs_error_m != null ? fmt.len(cal.max_abs_error_m) : "—"} · máx. relativo {cal.max_rel_error != null ? (cal.max_rel_error * 100).toFixed(2) + " %" : "—"} · RMS {cal.rms_error_m != null ? fmt.len(cal.rms_error_m) : "—"}</p>}
      <h3 style={{ marginTop: 12 }}>Tolerancia según uso</h3>
      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid2">
          <label>Absoluta (cm)<input type="number" step="any" min="0" value={tol.abs} onChange={(e) => setTol({ ...tol, abs: e.target.value })} placeholder="p. ej. 5" /></label>
          <label>Relativa (%)<input type="number" step="any" min="0" value={tol.rel} onChange={(e) => setTol({ ...tol, rel: e.target.value })} placeholder="p. ej. 2" /></label>
        </div>
        <label>Uso previsto<input value={tol.purpose} onChange={(e) => setTol({ ...tol, purpose: e.target.value })} placeholder="p. ej. Inventario espacial y medidas aproximadas" /></label>
        {canEdit && <button className="btn sm" onClick={saveTol}>Guardar tolerancia</button>}
      </fieldset>
      <p className="muted" style={{ marginTop: 10 }}>Una comprobación pasa si cumple todas las tolerancias registradas. «Verificado» exige tolerancia registrada y al menos {cal.min_checks_required} comprobaciones dentro de ella. No es una certificación.</p>
    </div>
  );
}
