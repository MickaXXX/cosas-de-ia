import { useRef, useState } from "react";
import { api, type Project, type Sector, type Layout } from "../lib/api";
import { go, useLoad } from "../lib/hooks";
import { Empty, JobBadge, Loading, Modal } from "../components/ui";

const PX_PER_M = 12;

export default function ProjectPage({ projectId }: { projectId: string }) {
  const project = useLoad(() => api<Project>(`/api/projects/${projectId}`), [projectId]);
  const sectors = useLoad(() => api<Sector[]>(`/api/projects/${projectId}/sectors`), [projectId]);
  const [creating, setCreating] = useState(false);
  const [members, setMembers] = useState(false);
  const p = project.data;
  const canEdit = p?.my_role === "owner" || p?.my_role === "editor";
  return (
    <div className="page">
      <div className="crumbs"><a href="#/">Proyectos</a> › <span>{p?.name ?? "…"}</span></div>
      <div className="row" style={{ margin: "8px 0 14px" }}>
        <div>
          <h1>{p?.name}</h1>
          <p className="muted" style={{ margin: 0 }}>{p?.site}</p>
        </div>
        <span className="spacer" />
        {p?.my_role === "owner" && <button className="btn" onClick={() => setMembers(true)}>Miembros</button>}
        {canEdit && <button className="btn primary" onClick={() => setCreating(true)}>+ Nuevo sector</button>}
      </div>
      {project.error && <p className="error">{project.error}</p>}
      {sectors.loading && !sectors.data ? <Loading /> : sectors.data && sectors.data.length === 0 ? (
        <Empty>Crea el primer sector: un conjunto de bombas, un skid o un tramo accesible de una sala de servicios.</Empty>
      ) : sectors.data && (
        <>
          <h2>Plano de planta</h2>
          <p className="muted" style={{ fontSize: ".85rem" }}>Ubicación esquemática de sectores (arrastra para ordenar). <b>No es un registro geométrico entre modelos</b>: cada sector conserva su propio sistema de coordenadas.</p>
          <PlantPlan sectors={sectors.data} editable={!!canEdit} onMoved={sectors.reload} />
          <h2 style={{ marginTop: 22 }}>Sectores</h2>
          <div className="grid">
            {sectors.data.map((s) => (
              <div key={s.id} className="card click" onClick={() => go(`/s/${s.id}`)}>
                <h3>{s.name}</h3>
                <p className="muted" style={{ margin: 0 }}>{s.area_type || "—"}</p>
                <div className="row" style={{ marginTop: 10 }}>
                  <span className="badge mute">{s.photo_count} fotos</span>
                  <JobBadge status={s.latest_job_status} />
                  {s.latest_model_id && <span className="badge ok">Con modelo</span>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {creating && <SectorForm projectId={projectId} onClose={() => setCreating(false)} onDone={(s) => go(`/s/${s.id}`)} />}
      {members && <Members projectId={projectId} onClose={() => setMembers(false)} />}
    </div>
  );
}

function PlantPlan({ sectors, editable, onMoved }: { sectors: Sector[]; editable: boolean; onMoved: () => void }) {
  const [pos, setPos] = useState<Record<string, Layout>>({});
  const drag = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const L = (s: Sector): Layout => ({ x: 0, y: 0, width: 10, depth: 8, ...s.layout, ...pos[s.id] });
  const down = (e: React.PointerEvent, s: Sector) => {
    if (!editable) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const l = L(s);
    drag.current = { id: s.id, sx: e.clientX, sy: e.clientY, ox: l.x ?? 0, oy: l.y ?? 0, moved: false };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / PX_PER_M, dy = (e.clientY - d.sy) / PX_PER_M;
    if (Math.abs(dx) + Math.abs(dy) > 0.3) d.moved = true;
    setPos((p) => ({ ...p, [d.id]: { x: Math.max(0, Math.round((d.ox + dx) * 2) / 2), y: Math.max(0, Math.round((d.oy + dy) * 2) / 2) } }));
  };
  const up = async (s: Sector) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) { go(`/s/${s.id}`); return; }
    const l = L(s);
    await api(`/api/sectors/${s.id}`, { method: "PATCH", body: { layout: { x: l.x, y: l.y } } });
    onMoved();
  };
  return (
    <div className="plan" onPointerMove={move}>
      {sectors.map((s) => {
        const l = L(s);
        return (
          <div key={s.id} className={`sec ${drag.current?.id === s.id ? "drag" : ""}`}
            style={{ left: (l.x ?? 0) * PX_PER_M + 10, top: (l.y ?? 0) * PX_PER_M + 10, width: (l.width ?? 10) * PX_PER_M, height: (l.depth ?? 8) * PX_PER_M,
              borderColor: s.latest_model_id ? "var(--ok)" : "var(--accent)" }}
            onPointerDown={(e) => down(e, s)} onPointerUp={() => up(s)}>
            <b>{s.name}</b>
            <small>{l.width}×{l.depth} m (esquemático)</small>
          </div>
        );
      })}
    </div>
  );
}

function SectorForm({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: (s: Sector) => void }) {
  const [name, setName] = useState("");
  const [areaType, setAreaType] = useState("Sala de bombas");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      onDone(await api<Sector>(`/api/projects/${projectId}/sectors`, { body: { name, area_type: areaType || null, description: description || null } }));
    } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal title="Nuevo sector" onClose={onClose}>
      <form onSubmit={submit}>
        <label>Nombre<input value={name} onChange={(e) => setName(e.target.value)} required placeholder="p. ej. Skid de bombeo agua tratada" /></label>
        <label>Tipo de área
          <select value={areaType} onChange={(e) => setAreaType(e.target.value)}>
            {["Sala de bombas", "Skid", "Sala de equipos", "Tramo de instalaciones", "Sala eléctrica", "Línea de producción", "Bodega", "Otro"].map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label>Alcance / superficies a documentar<textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Qué equipos y superficies se necesita ver" /></label>
        {error && <p className="error">{error}</p>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary">Crear sector</button></div>
      </form>
    </Modal>
  );
}

function Members({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const list = useLoad(() => api<any[]>(`/api/projects/${projectId}/members`), [projectId]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [error, setError] = useState<string | null>(null);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api(`/api/projects/${projectId}/members`, { body: { email, role } }); setEmail(""); list.reload(); } catch (err: any) { setError(err.message); }
  };
  const remove = async (id: string) => {
    try { await api(`/api/projects/${projectId}/members/${id}`, { method: "DELETE" }); list.reload(); } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal title="Miembros del proyecto" onClose={onClose}>
      <p className="muted" style={{ fontSize: ".85rem" }}>El acceso se valida en cada petición. Lectores ven modelos y fichas; editores cargan fotos y reconstruyen; propietarios gestionan miembros.</p>
      <table><tbody>
        {list.data?.map((m) => (
          <tr key={m.id}><td>{m.user.display_name}<br /><small>{m.user.email}</small></td><td>{m.role}</td>
            <td style={{ textAlign: "right" }}><button className="btn sm danger" onClick={() => remove(m.id)}>Quitar</button></td></tr>
        ))}
      </tbody></table>
      <form onSubmit={add} className="row" style={{ marginTop: 12 }}>
        <input style={{ flex: 2 }} type="email" placeholder="correo de un usuario existente" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <select style={{ flex: 1 }} value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="viewer">Lector</option><option value="editor">Editor</option><option value="owner">Propietario</option>
        </select>
        <button className="btn primary">Agregar</button>
      </form>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
