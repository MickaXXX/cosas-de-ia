import { useState } from "react";
import { api, type Project, type Sector } from "../lib/api";
import { go, useLoad } from "../lib/hooks";
import { Loading, Modal } from "../components/ui";
import CaptureTab from "./CaptureTab";
import JobsTab from "./JobsTab";
import ModelsTab from "./ModelsTab";
import AssetsTab from "./AssetsTab";

const TABS = [
  ["captura", "1 · Captura"],
  ["reconstruccion", "2 · Reconstrucción"],
  ["modelos", "3 · Modelos y visor"],
  ["activos", "Fichas de equipos"],
] as const;

export default function SectorPage({ sectorId, tab }: { sectorId: string; tab?: string }) {
  const sector = useLoad(() => api<Sector>(`/api/sectors/${sectorId}`), [sectorId]);
  const project = useLoad(() => sector.data ? api<Project>(`/api/projects/${sector.data.project_id}`) : Promise.resolve(undefined), [sector.data?.project_id]);
  const [editing, setEditing] = useState(false);
  const s = sector.data;
  const role = project.data?.my_role;
  const canEdit = role === "owner" || role === "editor";
  const current = TABS.some(([k]) => k === tab) ? tab! : "captura";
  if (sector.error) return <div className="page"><p className="error">{sector.error}</p></div>;
  if (!s) return <div className="page"><Loading /></div>;
  return (
    <div className="page">
      <div className="crumbs"><a href="#/">Proyectos</a> › <a href={`#/p/${s.project_id}`}>{project.data?.name ?? "…"}</a> › <span>{s.name}</span></div>
      <div className="row" style={{ marginTop: 8 }}>
        <div><h1>{s.name}</h1><p className="muted" style={{ margin: 0 }}>{s.area_type}{s.description ? ` · ${s.description}` : ""}</p></div>
        <span className="spacer" />
        {canEdit && <button className="btn" onClick={() => setEditing(true)}>Editar sector</button>}
        {s.latest_model_id && <button className="btn primary" onClick={() => go(`/s/${s.id}/visor/${s.latest_model_id}`)}>Abrir visor 3D</button>}
      </div>
      <nav className="tabs">
        {TABS.map(([k, label]) => <button key={k} className={current === k ? "on" : ""} onClick={() => go(`/s/${sectorId}/${k}`)}>{label}</button>)}
      </nav>
      {current === "captura" && <CaptureTab sectorId={sectorId} canEdit={canEdit} />}
      {current === "reconstruccion" && <JobsTab sectorId={sectorId} canEdit={canEdit} onReady={sector.reload} />}
      {current === "modelos" && <ModelsTab sectorId={sectorId} canEdit={canEdit} />}
      {current === "activos" && <AssetsTab sectorId={sectorId} canEdit={canEdit} />}
      {editing && <EditSector sector={s} onClose={() => setEditing(false)} onDone={() => { setEditing(false); sector.reload(); }} />}
    </div>
  );
}

function EditSector({ sector, onClose, onDone }: { sector: Sector; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: sector.name, area_type: sector.area_type ?? "", description: sector.description ?? "", width: sector.layout.width ?? 10, depth: sector.layout.depth ?? 8 });
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api(`/api/sectors/${sector.id}`, { method: "PATCH", body: { name: f.name, area_type: f.area_type || null, description: f.description || null, layout: { width: Number(f.width), depth: Number(f.depth) } } });
      onDone();
    } catch (err: any) { setError(err.message); }
  };
  const remove = async () => {
    if (!confirm("¿Eliminar el sector con sus fotos, modelos y fichas? Esta acción no se puede deshacer.")) return;
    try { await api(`/api/sectors/${sector.id}`, { method: "DELETE" }); go(`/p/${sector.project_id}`); } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal title="Editar sector" onClose={onClose}>
      <form onSubmit={save}>
        <label>Nombre<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
        <label>Tipo de área<input value={f.area_type} onChange={(e) => setF({ ...f, area_type: e.target.value })} /></label>
        <label>Alcance<textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        <div className="grid2">
          <label>Ancho en el plano esquemático (m)<input type="number" min={1} step={0.5} value={f.width} onChange={(e) => setF({ ...f, width: Number(e.target.value) })} /></label>
          <label>Fondo en el plano esquemático (m)<input type="number" min={1} step={0.5} value={f.depth} onChange={(e) => setF({ ...f, depth: Number(e.target.value) })} /></label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row"><button type="button" className="btn danger" onClick={remove}>Eliminar sector</button><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary">Guardar</button></div>
      </form>
    </Modal>
  );
}
