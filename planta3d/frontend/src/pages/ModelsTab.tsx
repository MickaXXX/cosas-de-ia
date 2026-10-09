import { useState } from "react";
import { api, fmt, type ModelVersion } from "../lib/api";
import { go, useLoad } from "../lib/hooks";
import { Empty, Modal, ScaleBadge, SourceBadge } from "../components/ui";
import { Report } from "./JobsTab";

export default function ModelsTab({ sectorId, canEdit }: { sectorId: string; canEdit: boolean }) {
  const models = useLoad(() => api<ModelVersion[]>(`/api/sectors/${sectorId}/models`), [sectorId]);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Versiones del modelo</h3><span className="spacer" />
        {canEdit && <button className="btn" onClick={() => setImporting(true)}>Importar GLB</button>}
      </div>
      <p className="muted" style={{ fontSize: ".85rem" }}>Cada versión conserva sus propias coordenadas, calibración y marcadores. Cambiar de versión no traslada marcadores automáticamente.</p>
      {models.data?.length === 0 && <Empty>Sin modelos. Reconstruye desde fotos o importa un GLB (la importación no reemplaza la reconstrucción desde fotos).</Empty>}
      <div className="grid">
        {models.data?.map((m) => (
          <div key={m.id} className="card">
            <h3>v{m.number} · {m.label}</h3>
            <div className="row" style={{ marginBottom: 8 }}><SourceBadge source={m.source} /><ScaleBadge state={m.scale_state} /></div>
            <small className="muted">{fmt.date(m.created_at)} · {m.stats.triangles ? `${(m.stats.triangles / 1000).toFixed(0)} k triángulos` : ""} · {fmt.bytes(m.stats.bytes)}
              {m.stats.registered_photos ? ` · ${m.stats.registered_photos} fotos registradas` : ""}</small>
            {m.scale_factor && <p style={{ fontSize: ".85rem" }}>Escala: {m.scale_factor.toPrecision(6)} m/unidad</p>}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn primary sm" onClick={() => go(`/s/${sectorId}/visor/${m.id}`)}>Abrir visor</button>
              {m.source === "reconstructed" && <button className="btn sm" onClick={() => setReport(m.id)}>Informe</button>}
            </div>
          </div>
        ))}
      </div>
      {importing && <ImportGlb sectorId={sectorId} onClose={() => setImporting(false)} onDone={() => { setImporting(false); models.reload(); }} />}
      {report && <ReportModal modelId={report} onClose={() => setReport(null)} />}
    </div>
  );
}

function ReportModal({ modelId, onClose }: { modelId: string; onClose: () => void }) {
  const r = useLoad(() => api<any>(`/api/models/${modelId}/report`), [modelId]);
  return <Modal title="Informe de reconstrucción" onClose={onClose} wide>{r.error ? <p className="error">{r.error}</p> : r.data ? <>
    <Report r={r.data} />
    <h3>Etapas</h3>
    <div className="table-wrap"><table><thead><tr><th>Etapa</th><th>Estado</th><th>Tiempo</th><th>Memoria pico</th></tr></thead><tbody>
      {r.data.stages.map((s: any) => <tr key={s.name}><td>{s.label}</td><td>{s.status}</td><td>{fmt.secs(s.seconds)}</td><td>{s.max_rss_mb ? `${Math.round(s.max_rss_mb)} MB` : "—"}</td></tr>)}
    </tbody></table></div>
  </> : <p className="muted">Cargando…</p>}</Modal>;
}

function ImportGlb({ sectorId, onClose, onDone }: { sectorId: string; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("label", label || file.name);
    fd.append("is_demo", String(demo));
    try { await api(`/api/sectors/${sectorId}/models/import`, { form: fd }); onDone(); } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Importar modelo GLB" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted" style={{ fontSize: ".85rem" }}>Se verifica la estructura del archivo. El formato no demuestra que las dimensiones sean reales: el modelo quedará «sin calibrar».</p>
        <label>Archivo .glb<input type="file" accept=".glb,model/gltf-binary" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required /></label>
        <label>Etiqueta<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="p. ej. Modelo procesado externamente" /></label>
        <label style={{ display: "flex", gap: 8, color: "var(--text)" }}><input type="checkbox" style={{ width: "auto", minHeight: 0 }} checked={demo} onChange={(e) => setDemo(e.target.checked)} /> Es un modelo de demostración (no corresponde al sector real)</label>
        {error && <p className="error">{error}</p>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || !file}>{busy ? "Subiendo…" : "Importar"}</button></div>
      </form>
    </Modal>
  );
}
