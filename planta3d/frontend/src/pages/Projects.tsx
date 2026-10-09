import { useState } from "react";
import { api, fmt, type Project } from "../lib/api";
import { go, useLoad } from "../lib/hooks";
import { Empty, Loading, Modal } from "../components/ui";

export default function Projects() {
  const { data, error, loading, reload } = useLoad(() => api<Project[]>("/api/projects"), []);
  const [creating, setCreating] = useState(false);
  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 14 }}>
        <div>
          <h1>Proyectos</h1>
          <p className="muted" style={{ margin: 0 }}>Cada proyecto agrupa sectores de una planta. Cada sector se captura y reconstruye por separado.</p>
        </div>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>+ Nuevo proyecto</button>
      </div>
      {error && <p className="error">{error}</p>}
      {loading && !data ? <Loading /> : data && data.length === 0 ? (
        <Empty>Aún no hay proyectos. Crea uno para empezar (por ejemplo, «Planta 3D»).</Empty>
      ) : (
        <div className="grid">
          {data?.map((p) => (
            <div key={p.id} className="card click" onClick={() => go(`/p/${p.id}`)}>
              <h3>{p.name}</h3>
              <p className="muted" style={{ margin: 0 }}>{p.site || "Sin ubicación"}</p>
              <div className="row" style={{ marginTop: 10 }}>
                <span className="badge info">{p.sector_count} sector(es)</span>
                <span className="badge mute">{p.my_role === "owner" ? "Propietario" : p.my_role === "editor" ? "Editor" : "Lector"}</span>
                <span className="spacer" />
                <small>{fmt.date(p.created_at)}</small>
              </div>
            </div>
          ))}
        </div>
      )}
      {creating && <ProjectForm onClose={() => setCreating(false)} onDone={(p) => { setCreating(false); reload(); go(`/p/${p.id}`); }} />}
    </div>
  );
}

function ProjectForm({ onClose, onDone }: { onClose: () => void; onDone: (p: Project) => void }) {
  const [name, setName] = useState("Planta 3D");
  const [site, setSite] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      onDone(await api<Project>("/api/projects", { body: { name, site: site || null, description: description || null } }));
    } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal title="Nuevo proyecto" onClose={onClose}>
      <form onSubmit={submit}>
        <label>Nombre<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></label>
        <label>Planta / ubicación<input value={site} onChange={(e) => setSite(e.target.value)} placeholder="p. ej. Planta embotelladora, Antofagasta" /></label>
        <label>Descripción<textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary">Crear</button></div>
      </form>
    </Modal>
  );
}
