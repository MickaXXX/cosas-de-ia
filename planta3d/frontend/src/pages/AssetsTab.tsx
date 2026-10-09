import { useState } from "react";
import { api, fmt, type Asset, type DocumentLink } from "../lib/api";
import { useLoad } from "../lib/hooks";
import { Empty, Modal } from "../components/ui";

export default function AssetsTab({ sectorId, canEdit }: { sectorId: string; canEdit: boolean }) {
  const assets = useLoad(() => api<Asset[]>(`/api/sectors/${sectorId}/assets`), [sectorId]);
  const [edit, setEdit] = useState<Asset | "new" | null>(null);
  const [q, setQ] = useState("");
  const list = (assets.data ?? []).filter((a) => !q || `${a.tag} ${a.name} ${a.asset_type}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Fichas de equipos</h3>
        <input style={{ maxWidth: 260 }} placeholder="Buscar TAG o nombre" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="spacer" />
        {canEdit && <button className="btn primary" onClick={() => setEdit("new")}>+ Nueva ficha</button>}
      </div>
      <p className="muted" style={{ fontSize: ".85rem" }}>Los TAG, tipos y estados se ingresan manualmente o desde una fuente real con fecha y origen. La app no infiere estados por la apariencia del modelo.</p>
      {list.length === 0 ? <Empty>Sin fichas. Créalas aquí o desde un marcador en el visor 3D.</Empty> : (
        <div className="table-wrap card" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>TAG</th><th>Nombre</th><th>Tipo</th><th>Estado operacional</th><th></th></tr></thead>
            <tbody>{list.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.tag || "—"}</td><td>{a.name}</td><td>{a.asset_type || "—"}</td>
                <td>{a.op_status ? <>{a.op_status}<br /><small>{a.op_status_source} · {fmt.date(a.op_status_at)}</small></> : <small className="muted">No registrado</small>}</td>
                <td style={{ textAlign: "right" }}><button className="btn sm" onClick={() => setEdit(a)}>{canEdit ? "Editar" : "Ver"}</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {edit && <AssetForm sectorId={sectorId} asset={edit === "new" ? null : edit} canEdit={canEdit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); assets.reload(); }} />}
    </div>
  );
}

export function AssetForm({ sectorId, asset, canEdit, onClose, onDone }: { sectorId: string; asset: Asset | null; canEdit: boolean; onClose: () => void; onDone: (a: Asset) => void }) {
  const [f, setF] = useState({ tag: asset?.tag ?? "", name: asset?.name ?? "", asset_type: asset?.asset_type ?? "", description: asset?.description ?? "", notes: asset?.notes ?? "", op_status: asset?.op_status ?? "", op_status_source: asset?.op_status_source ?? "" });
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v || null]));
    if (asset && (f.op_status || null) === asset.op_status && (f.op_status_source || null) === asset.op_status_source) { delete body.op_status; delete body.op_status_source; }
    try {
      onDone(asset ? await api<Asset>(`/api/assets/${asset.id}`, { method: "PATCH", body }) : await api<Asset>(`/api/sectors/${sectorId}/assets`, { body }));
    } catch (err: any) { setError(err.message); }
  };
  const remove = async () => {
    if (!asset || !confirm("¿Eliminar la ficha?")) return;
    await api(`/api/assets/${asset.id}`, { method: "DELETE" });
    onDone(asset);
  };
  return (
    <Modal title={asset ? `Ficha ${asset.tag ?? asset.name}` : "Nueva ficha de equipo"} onClose={onClose} wide>
      <form onSubmit={save}>
        <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="grid2">
            <label>TAG (manual)<input value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} placeholder="p. ej. P-101A" /></label>
            <label>Nombre<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
            <label>Tipo<input value={f.asset_type} onChange={(e) => setF({ ...f, asset_type: e.target.value })} list="asset-types" /></label>
            <datalist id="asset-types">{["Bomba centrífuga", "Motor eléctrico", "Válvula", "Estanque", "Intercambiador", "Filtro", "Tablero eléctrico", "Compresor", "Instrumento"].map((t) => <option key={t} value={t} />)}</datalist>
            <div />
            <label>Estado operacional<input value={f.op_status} onChange={(e) => setF({ ...f, op_status: e.target.value })} placeholder="p. ej. En servicio" /></label>
            <label>Origen del estado (obligatorio si hay estado)<input value={f.op_status_source} onChange={(e) => setF({ ...f, op_status_source: e.target.value })} placeholder="p. ej. Inspección visual de J. Pérez / OT 1234" /></label>
          </div>
          <label>Descripción<textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <label>Notas<textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        </fieldset>
        {asset && <Documents sectorId={sectorId} assetId={asset.id} canEdit={canEdit} />}
        {error && <p className="error">{error}</p>}
        <div className="row" style={{ marginTop: 10 }}>
          {asset && canEdit && <button type="button" className="btn danger" onClick={remove}>Eliminar</button>}
          <span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cerrar</button>
          {canEdit && <button className="btn primary">Guardar</button>}
        </div>
      </form>
    </Modal>
  );
}

export function Documents({ sectorId, assetId, annotationId, canEdit }: { sectorId: string; assetId?: string; annotationId?: string; canEdit: boolean }) {
  const qs = assetId ? `asset_id=${assetId}` : `annotation_id=${annotationId}`;
  const docs = useLoad(() => api<DocumentLink[]>(`/api/sectors/${sectorId}/documents?${qs}`), [sectorId, qs]);
  const [mode, setMode] = useState<"link" | "file" | null>(null);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = async (d: DocumentLink) => {
    const r = await api<{ url: string }>(`/api/documents/${d.id}/url`);
    window.open(r.url, "_blank", "noopener");
  };
  const add = async () => {
    const fd = new FormData();
    fd.append("title", title || file?.name || url);
    if (assetId) fd.append("asset_id", assetId);
    if (annotationId) fd.append("annotation_id", annotationId);
    if (mode === "link") fd.append("url", url); else if (file) fd.append("file", file);
    try { await api(`/api/sectors/${sectorId}/documents`, { form: fd }); setMode(null); setTitle(""); setUrl(""); setFile(null); docs.reload(); } catch (e: any) { setError(e.message); }
  };
  const del = async (d: DocumentLink) => { if (confirm(`¿Quitar «${d.title}»?`)) { await api(`/api/documents/${d.id}`, { method: "DELETE" }); docs.reload(); } };
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row"><b>Documentos y enlaces</b><span className="spacer" />
        {canEdit && <><button type="button" className="btn sm" onClick={() => setMode("link")}>+ Enlace</button><button type="button" className="btn sm" onClick={() => setMode("file")}>+ Archivo / foto</button></>}
      </div>
      {docs.data?.length === 0 && <small className="muted">Sin documentos.</small>}
      {docs.data?.map((d) => (
        <div key={d.id} className="row" style={{ padding: "4px 0" }}>
          <span>{d.kind === "link" ? "🔗" : d.kind === "photo" ? "🖼" : "📄"}</span>
          <a href="#" onClick={(e) => { e.preventDefault(); open(d); }}>{d.title}</a>
          <small className="muted">{d.size_bytes ? fmt.bytes(d.size_bytes) : ""}</small>
          <span className="spacer" />{canEdit && <button type="button" className="btn ghost sm" onClick={() => del(d)}>✕</button>}
        </div>
      ))}
      {mode && (
        <div className="row" style={{ marginTop: 6 }}>
          <input style={{ flex: 1 }} placeholder="Título" value={title} onChange={(e) => setTitle(e.target.value)} />
          {mode === "link" ? <input style={{ flex: 2 }} placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
            : <input style={{ flex: 2 }} type="file" accept=".pdf,image/jpeg,image/png,.txt,.csv,.docx,.xlsx" capture={undefined} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
          <button type="button" className="btn primary sm" onClick={add}>Agregar</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
