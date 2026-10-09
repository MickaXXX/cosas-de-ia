import { useMemo, useRef, useState } from "react";
import { api, ApiError, FLAG_LABEL, fmt, uploadFile, type Batch, type Photo } from "../lib/api";
import { useLoad, usePersisted } from "../lib/hooks";
import { quickQuality, qualityHint, sniffFile, SNIFF_HELP, type QuickQuality } from "../lib/quality";
import { Modal } from "../components/ui";

interface QueueItem {
  key: string; file: File; status: "revisando" | "pendiente" | "subiendo" | "ok" | "rechazada" | "duplicada" | "error" | "cancelada" | "no_admitida";
  progress: number; attempts: number; message?: string; q?: QuickQuality | null;
}

const MAX_ATTEMPTS = 3;
const CONCURRENCY = 3;

export default function CaptureTab({ sectorId, canEdit }: { sectorId: string; canEdit: boolean }) {
  const photos = useLoad(() => api<Photo[]>(`/api/sectors/${sectorId}/photos`), [sectorId]);
  const thumbs = useLoad(() => api<Record<string, string>>(`/api/sectors/${sectorId}/photos/thumbs`), [sectorId, photos.data?.length]);
  const diag = useLoad(() => api<any>(`/api/sectors/${sectorId}/diagnostics`), [sectorId, photos.data]);
  const batches = useLoad(() => api<Batch[]>(`/api/sectors/${sectorId}/batches`), [sectorId]);
  const [guide, setGuide] = usePersisted("planta3d.guide.open", true);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [running, setRunning] = useState(false);
  const [meta, setMeta] = useState({ label: "", capture_date: new Date().toISOString().slice(0, 10), operating_condition: "", device_notes: "" });
  const [detail, setDetail] = useState<Photo | null>(null);
  const [filter, setFilter] = useState<"todas" | "marcadas" | "excluidas" | "rechazadas">("todas");
  const aborts = useRef<Map<string, AbortController>>(new Map());
  const stopRef = useRef(false);
  const camInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const openBatch = batches.data?.find((b) => b.status === "uploading") ?? null;
  const median = useMemo(() => {
    const v = queue.map((q) => q.q?.sharpness).filter((x): x is number => !!x).sort((a, b) => a - b);
    return v.length >= 5 ? v[Math.floor(v.length / 2)] : null;
  }, [queue]);

  const patch = (key: string, p: Partial<QueueItem>) => setQueue((qs) => qs.map((q) => (q.key === key ? { ...q, ...p } : q)));

  const addFiles = async (files: FileList | File[]) => {
    const items: QueueItem[] = Array.from(files).map((f) => ({ key: `${f.name}-${f.size}-${f.lastModified}-${Math.random()}`, file: f, status: "revisando", progress: 0, attempts: 0 }));
    setQueue((qs) => [...qs, ...items]);
    for (const it of items) {
      const kind = await sniffFile(it.file);
      if (kind !== "jpeg" && kind !== "png") { patch(it.key, { status: "no_admitida", message: SNIFF_HELP[kind] }); continue; }
      const q = await quickQuality(it.file);
      patch(it.key, { status: "pendiente", q });
    }
  };

  const ensureBatch = async (): Promise<Batch> => {
    if (batch && batch.status === "uploading") return batch;
    if (openBatch) { setBatch(openBatch); return openBatch; }
    const b = await api<Batch>(`/api/sectors/${sectorId}/batches`, {
      body: { label: meta.label || null, capture_date: meta.capture_date || null, operating_condition: meta.operating_condition || null, device_notes: meta.device_notes || null, expected_count: queue.filter((q) => q.status === "pendiente").length || null },
    });
    setBatch(b);
    batches.reload();
    return b;
  };

  const start = async () => {
    stopRef.current = false;
    setRunning(true);
    try {
      const b = await ensureBatch();
      const work = () => queueRef.current.find((q) => q.status === "pendiente");
      const worker = async () => {
        for (;;) {
          if (stopRef.current) return;
          const it = work();
          if (!it) return;
          patch(it.key, { status: "subiendo", progress: 0 });
          queueRef.current = queueRef.current.map((q) => (q.key === it.key ? { ...q, status: "subiendo" } : q));
          let attempts = it.attempts;
          for (;;) {
            const ac = new AbortController();
            aborts.current.set(it.key, ac);
            try {
              attempts++;
              const r = await uploadFile(`/api/batches/${b.id}/photos`, it.file, it.file.name, (p) => patch(it.key, { progress: p }), ac.signal);
              const st = r.status === "accepted" ? "ok" : r.status === "duplicate" ? "duplicada" : "rechazada";
              patch(it.key, { status: st, progress: 1, attempts, message: r.reject_reason ?? undefined });
              break;
            } catch (e) {
              const err = e as ApiError;
              if (err.status === -1) { patch(it.key, { status: "cancelada", attempts }); break; }
              const retryable = err.status === 0 || err.status >= 500 || err.status === 429;
              if (!retryable || attempts >= MAX_ATTEMPTS) { patch(it.key, { status: "error", attempts, message: err.message }); break; }
              patch(it.key, { message: `Reintentando (${attempts}/${MAX_ATTEMPTS})…`, attempts });
              await new Promise((r) => setTimeout(r, 1000 * 2 ** attempts));
            } finally {
              aborts.current.delete(it.key);
            }
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (!stopRef.current && !queueRef.current.some((q) => q.status === "pendiente" || q.status === "error")) {
        await api(`/api/batches/${b.id}/complete`, { method: "POST" });
        setBatch(null);
        batches.reload();
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      setRunning(false);
      photos.reload();
    }
  };
  const queueRef = useRef<QueueItem[]>([]);
  queueRef.current = queue;

  const stop = () => {
    stopRef.current = true;
    aborts.current.forEach((a) => a.abort());
  };
  const retryFailed = () => setQueue((qs) => qs.map((q) => (q.status === "error" || q.status === "cancelada" ? { ...q, status: "pendiente", attempts: 0, message: undefined } : q)));
  const finishBatch = async () => {
    const b = batch ?? openBatch;
    if (!b) return;
    await api(`/api/batches/${b.id}/complete`, { method: "POST" });
    setBatch(null); batches.reload(); photos.reload();
  };
  const discardBatch = async () => {
    const b = batch ?? openBatch;
    if (!b || !confirm("Las fotos ya recibidas de este lote se conservarán pero quedarán excluidas (con registro). ¿Continuar?")) return;
    await api(`/api/batches/${b.id}/cancel`, { method: "POST" });
    setBatch(null); batches.reload(); photos.reload();
  };

  const counts = queue.reduce<Record<string, number>>((a, q) => ((a[q.status] = (a[q.status] || 0) + 1), a), {});
  const shown = (photos.data ?? []).filter((p) => filter === "todas" ? true : filter === "marcadas" ? p.flags.length > 0 && p.status === "accepted"
    : filter === "excluidas" ? p.status === "accepted" && !p.included : p.status !== "accepted");
  const d = diag.data;

  return (
    <div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row"><h3 style={{ margin: 0 }}>Cómo capturar</h3><span className="spacer" /><button className="btn sm ghost" onClick={() => setGuide(!guide)}>{guide ? "Ocultar" : "Mostrar"}</button></div>
        {guide && (
          <ol className="steps" style={{ marginTop: 10, fontSize: ".92rem" }}>
            <li><b>Desplázate</b> por el sector y detente en cada toma. Girar el teléfono desde un mismo punto aporta poca geometría.</li>
            <li>Busca <b>70–80 % de superposición</b> entre fotos vecinas; cada superficie debe verse desde varias posiciones.</li>
            <li>Cámara principal a <b>1×</b>, sin modo retrato, filtros ni zoom digital. Misma configuración toda la secuencia.</li>
            <li>Fotos <b>nítidas</b> y con luz estable. Evita reflejos quemados, personas o equipos en movimiento, vapor y agua.</li>
            <li>Haz recorridos a distintas alturas y <b>conecta</b> vistas generales, intermedias y de detalle con zonas comunes.</li>
            <li>Fotografía una <b>referencia de distancia conocida</b> y mide al menos 3 distancias más para comprobar (anota extremos e instrumento).</li>
            <li>Captura solo desde zonas habilitadas, sin intervenir equipos.</li>
          </ol>
        )}
      </div>

      {canEdit && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Cargar fotografías</h3>
          <div className="grid2">
            <label>Etiqueta del lote<input value={meta.label} onChange={(e) => setMeta({ ...meta, label: e.target.value })} placeholder="p. ej. Recorrido 1 – nivel piso" /></label>
            <label>Fecha de captura<input type="date" value={meta.capture_date} onChange={(e) => setMeta({ ...meta, capture_date: e.target.value })} /></label>
            <label>Condición de operación<input value={meta.operating_condition} onChange={(e) => setMeta({ ...meta, operating_condition: e.target.value })} placeholder="p. ej. Bombas detenidas por mantención" /></label>
            <label>Teléfono / cámara<input value={meta.device_notes} onChange={(e) => setMeta({ ...meta, device_notes: e.target.value })} placeholder="Modelo, cámara principal 1×" /></label>
          </div>
          <div className={`drop ${over ? "over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}>
            <div className="row" style={{ justifyContent: "center" }}>
              <button className="btn primary" onClick={() => camInput.current?.click()}>📷 Tomar fotos</button>
              <button className="btn" onClick={() => fileInput.current?.click()}>Elegir archivos</button>
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>o arrastra aquí. JPEG o PNG originales (sin compresión de mensajería). Máx. por foto según configuración del servidor.</p>
            <input ref={camInput} type="file" accept="image/jpeg,image/png" capture="environment" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
            <input ref={fileInput} type="file" accept="image/jpeg,image/png,.heic,.dng" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
          </div>
          {queue.length > 0 && (
            <>
              <div className="row" style={{ marginTop: 12 }}>
                {Object.entries(counts).map(([k, v]) => <span key={k} className={`badge ${k === "ok" ? "ok" : k === "error" || k === "rechazada" || k === "no_admitida" ? "bad" : k === "duplicada" || k === "cancelada" ? "warn" : "info"}`}>{k}: {v}</span>)}
                <span className="spacer" />
                {!running && <button className="btn primary" disabled={!queue.some((q) => q.status === "pendiente")} onClick={start}>Subir {queue.filter((q) => q.status === "pendiente").length}</button>}
                {running && <button className="btn danger" onClick={stop}>Detener carga</button>}
                {!running && queue.some((q) => q.status === "error" || q.status === "cancelada") && <button className="btn" onClick={retryFailed}>Reintentar fallidas</button>}
                {!running && <button className="btn ghost" onClick={() => setQueue((qs) => qs.filter((q) => q.status === "pendiente" || q.status === "subiendo"))}>Limpiar terminadas</button>}
              </div>
              <div className="table-wrap" style={{ maxHeight: 260, overflow: "auto", marginTop: 8 }}>
                <table><tbody>
                  {queue.map((q) => {
                    const h = q.q !== undefined ? qualityHint(q.q, median) : null;
                    return (
                      <tr key={q.key}>
                        <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.file.name}<br /><small>{fmt.bytes(q.file.size)}</small></td>
                        <td>{h && <span className={`badge ${h.level}`}>{h.text}</span>}</td>
                        <td style={{ width: 140 }}>{q.status === "subiendo" ? <div className="progress"><div style={{ width: `${q.progress * 100}%` }} /></div> : <span>{q.status}</span>}
                          {q.message && <><br /><small className={q.status === "error" || q.status === "rechazada" || q.status === "no_admitida" ? "error" : "muted"}>{q.message}</small></>}</td>
                      </tr>
                    );
                  })}
                </tbody></table>
              </div>
              <p className="muted" style={{ fontSize: ".8rem" }}>Indicadores del dispositivo: orientativos, calculados a baja resolución. El servidor valida formato real, dimensiones, duplicados y calidad, y conserva el original inmutable.</p>
            </>
          )}
          {(batch || openBatch) && !running && (
            <div className="notice info row">
              <span>Lote abierto: {(batch ?? openBatch)!.label || "sin etiqueta"}</span><span className="spacer" />
              <button className="btn sm" onClick={finishBatch}>Finalizar lote</button>
              <button className="btn sm danger" onClick={discardBatch}>Descartar lote</button>
            </div>
          )}
        </div>
      )}

      {d && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Diagnóstico de captura</h3>
          <div className="kpis">
            <div className="kpi"><b>{d.total}</b><span>recibidas</span></div>
            <div className="kpi"><b>{d.included}</b><span>incluidas</span></div>
            <div className="kpi"><b>{d.excluded}</b><span>excluidas</span></div>
            <div className="kpi"><b>{(d.by_status.rejected || 0) + (d.by_status.duplicate || 0)}</b><span>rechazadas / duplicadas</span></div>
            <div className="kpi"><b>{Object.keys(d.camera_groups).length}</b><span>grupos de cámara</span></div>
          </div>
          {d.advice.map((a: string) => <div key={a} className="notice">{a}</div>)}
          {Object.entries(d.camera_groups).length > 0 && (
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table>
                <thead><tr><th>Grupo</th><th>Cámara</th><th>Resolución</th><th>Fotos</th><th>Focal inicial</th></tr></thead>
                <tbody>{Object.entries(d.camera_groups).map(([k, g]: [string, any]) => (
                  <tr key={k}><td className="mono">{k.slice(0, 8)}</td><td>{[g.make, g.model].filter(Boolean).join(" ") || "Sin EXIF"}{g.focal_mm ? ` · ${g.focal_mm} mm` : ""}</td><td>{g.resolution}</td><td>{g.count}</td>
                    <td>{g.focal_prior_px ? `${Math.round(g.focal_prior_px)} px` : "—"}<br /><small>{g.focal_prior_source}</small></td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Fotografías</h3><span className="spacer" />
        {(["todas", "marcadas", "excluidas", "rechazadas"] as const).map((f) => <button key={f} className={`btn sm ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>{f}</button>)}
      </div>
      <div className="photos">
        {shown.map((p) => (
          <div key={p.id} className={`photo ${!p.included ? "excluded" : ""}`} onClick={() => setDetail(p)} style={{ cursor: "pointer" }}>
            {p.status === "accepted" && thumbs.data?.[p.id] ? <img src={thumbs.data[p.id]} alt={p.original_filename} loading="lazy" /> :
              <div style={{ padding: 8, fontSize: ".75rem" }} className="error">{p.status === "duplicate" ? "Duplicada" : "Rechazada"}: {p.reject_reason}</div>}
            <div className="flags">{p.flags.filter((f) => FLAG_LABEL[f]).map((f) => <span key={f} className="dot" title={FLAG_LABEL[f]} style={{ background: f.includes("desenfoque") || f.includes("nitidez") ? "var(--bad)" : "var(--warn)" }} />)}</div>
            <div className="meta">{p.original_filename}</div>
          </div>
        ))}
      </div>
      {detail && <PhotoDetail photo={detail} canEdit={canEdit} onClose={() => setDetail(null)} onChanged={() => { setDetail(null); photos.reload(); }} />}
    </div>
  );
}

function PhotoDetail({ photo, canEdit, onClose, onChanged }: { photo: Photo; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const url = useLoad(() => photo.status === "accepted" ? api<{ url: string }>(`/api/photos/${photo.id}/url?variant=working`) : Promise.resolve(null), [photo.id]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    try { await api(`/api/photos/${photo.id}`, { method: "PATCH", body: { included: !photo.included, reason } }); onChanged(); } catch (e: any) { setError(e.message); }
  };
  const q = photo.quality;
  return (
    <Modal title={photo.original_filename} onClose={onClose} wide>
      {url.data && <img src={url.data.url} alt="" style={{ width: "100%", borderRadius: 8, maxHeight: "50vh", objectFit: "contain", background: "#000" }} />}
      {photo.reject_reason && <div className="notice bad">{photo.reject_reason}</div>}
      <div className="grid2" style={{ marginTop: 10, fontSize: ".88rem" }}>
        <div>
          <b>Archivo</b><br />{fmt.bytes(photo.size_bytes)} · {photo.width}×{photo.height} px (orientada)<br />
          Orientación EXIF original: {photo.exif_orientation ?? "—"}<br />
          <span className="mono" title={photo.sha256 ?? ""}>SHA-256 {photo.sha256?.slice(0, 16)}…</span>
        </div>
        <div>
          <b>Indicadores</b> <small>(no concluyentes)</small><br />
          Nitidez (var. laplaciano): {q.sharpness?.toFixed(1) ?? "—"}<br />
          Píxeles oscuros: {q.dark_fraction != null ? (q.dark_fraction * 100).toFixed(1) + " %" : "—"} · saturados: {q.bright_fraction != null ? (q.bright_fraction * 100).toFixed(1) + " %" : "—"}<br />
          {photo.flags.map((f) => <span key={f} className="badge warn" style={{ marginRight: 4 }}>{FLAG_LABEL[f] ?? f}</span>)}
        </div>
        <div><b>Cámara</b><br />{String(photo.camera.make ?? "—")} {String(photo.camera.model ?? "")}<br />Focal: {String(photo.camera.focal_mm ?? "—")} mm · 35 mm eq.: {String(photo.camera.focal_35mm ?? "—")}<br />GPS en original: {photo.camera.has_gps ? "sí (no se almacena)" : "no"}</div>
        <div><b>Registro de inclusión</b><br />{photo.inclusion_log.length === 0 ? <small>Sin cambios</small> : photo.inclusion_log.map((l, i) => <div key={i}><small>{fmt.date(l.at)} · {l.included ? "incluida" : "excluida"} · {l.reason}</small></div>)}</div>
      </div>
      {canEdit && photo.status === "accepted" && (
        <div className="row" style={{ marginTop: 12 }}>
          <input style={{ flex: 1 }} placeholder="Motivo (obligatorio)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className={`btn ${photo.included ? "danger" : "primary"}`} disabled={reason.trim().length < 3} onClick={toggle}>{photo.included ? "Excluir" : "Incluir"}</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
