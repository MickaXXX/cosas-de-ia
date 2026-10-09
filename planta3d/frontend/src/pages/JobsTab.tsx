import { useEffect, useRef, useState } from "react";
import { api, fmt, JOB_STATUS_LABEL, type Job, type JobEvent } from "../lib/api";
import { go, useInterval, useLoad } from "../lib/hooks";
import { Empty, JobBadge, Modal } from "../components/ui";

const ACTIVE = ["queued", "validating", "reconstructing", "converting", "cancelling"];
const PROFILES = {
  rapido: "Rápido — fotos de trabajo a 1600 px. Para validar la captura.",
  estandar: "Estándar — 2400 px. Equilibrio entre detalle y tiempo.",
  detalle: "Detalle — 3200 px y profundidad a resolución completa. Más lento y exigente en memoria.",
};

export default function JobsTab({ sectorId, canEdit, onReady }: { sectorId: string; canEdit: boolean; onReady: () => void }) {
  const jobs = useLoad(() => api<Job[]>(`/api/sectors/${sectorId}/jobs`), [sectorId]);
  const caps = useLoad(() => api<any>("/api/system/capabilities"), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const active = jobs.data?.some((j) => ACTIVE.includes(j.status));
  useInterval(() => jobs.reload(), active ? 3000 : null);
  const prevActive = useRef(active);
  useEffect(() => { if (prevActive.current && !active) onReady(); prevActive.current = active; }, [active, onReady]);
  const sel = jobs.data?.find((j) => j.id === selected) ?? jobs.data?.[0];
  const c = caps.data;

  return (
    <div>
      {c && (
        <div className={`notice ${c.reconstruction_available ? "info" : "bad"}`}>
          <b>Motor:</b> {c.engine}. {c.reconstruction_available ? "Disponible" : "No disponible"} en este equipo
          {" · "}CPU {c.hardware.cpu_count} núcleos · RAM {c.hardware.ram_gb} GB · GPU: {c.hardware.gpu}.
          {c.reasons.map((r: string) => <div key={r}>{r}</div>)}
          {!c.reconstruction_available && <div>Puedes importar un GLB en «Modelos» mientras tanto. La app no simula reconstrucciones.</div>}
        </div>
      )}
      <div className="row" style={{ margin: "10px 0" }}>
        <h3 style={{ margin: 0 }}>Trabajos de reconstrucción</h3><span className="spacer" />
        {canEdit && <button className="btn primary" disabled={!c?.reconstruction_available || !!active} onClick={() => setStarting(true)}>Reconstruir con fotos incluidas</button>}
      </div>
      {jobs.data && jobs.data.length === 0 && <Empty>Sin trabajos aún. Sube fotos en «Captura» y luego inicia la reconstrucción.</Empty>}
      {jobs.data && jobs.data.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 260px) minmax(0, 1fr)", gap: 14 }} className="jobs-layout">
          <div className="card" style={{ padding: 8 }}>
            {jobs.data.map((j) => (
              <div key={j.id} onClick={() => setSelected(j.id)} style={{ padding: 8, borderRadius: 8, cursor: "pointer", background: sel?.id === j.id ? "var(--bg-elev-2)" : undefined }}>
                <div className="row"><JobBadge status={j.status} /><span className="spacer" /><small>{j.profile}</small></div>
                <small>{fmt.date(j.created_at)} · {j.photo_count} fotos</small>
              </div>
            ))}
          </div>
          {sel && <JobDetail job={sel} canEdit={canEdit} onChange={jobs.reload} />}
        </div>
      )}
      {starting && <StartJob sectorId={sectorId} onClose={() => setStarting(false)} onDone={(j) => { setStarting(false); setSelected(j.id); jobs.reload(); }} />}
      <style>{`@media (max-width: 760px){ .jobs-layout{ grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

function Elapsed({ since }: { since: string | null }) {
  const [, setT] = useState(0);
  useInterval(() => setT((t) => t + 1), 1000);
  if (!since) return null;
  return <>{fmt.secs((Date.now() - new Date(since).getTime()) / 1000)}</>;
}

function JobDetail({ job, canEdit, onChange }: { job: Job; canEdit: boolean; onChange: () => void }) {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const isActive = ACTIVE.includes(job.status);
  const load = async () => {
    const last = events.length ? events[events.length - 1].id : 0;
    const more = await api<JobEvent[]>(`/api/jobs/${job.id}/events?after=${last}`);
    if (more.length) setEvents((e) => [...e, ...more]);
  };
  useEffect(() => { setEvents([]); }, [job.id]);
  useEffect(() => { load(); }, [job.id, job.status, job.stage]); // eslint-disable-line react-hooks/exhaustive-deps
  useInterval(load, isActive ? 2500 : null);
  const cancel = async () => {
    if (!confirm("¿Cancelar el trabajo? Se terminarán los procesos del motor.")) return;
    await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    onChange();
  };
  const r = job.report || {};
  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>{JOB_STATUS_LABEL[job.status]}</h3>
        {isActive && job.stage && <span className="badge info">Etapa: {job.stages.find((s) => s.name === job.stage)?.label ?? job.stage} · <Elapsed since={job.stage_started_at} /></span>}
        <span className="spacer" />
        {canEdit && isActive && job.status !== "cancelling" && <button className="btn danger sm" onClick={cancel}>Cancelar</button>}
        {job.model_version_id && <button className="btn primary sm" onClick={() => go(`/s/${job.sector_id}/visor/${job.model_version_id}`)}>Ver modelo</button>}
      </div>
      <p className="muted" style={{ fontSize: ".85rem" }}>
        Inicio {fmt.date(job.started_at)} · {job.finished_at ? `fin ${fmt.date(job.finished_at)}` : isActive ? <>transcurrido <Elapsed since={job.started_at ?? job.created_at} /></> : ""} · intentos {job.attempts}.
        {isActive && " El motor no informa un progreso cuantitativo fiable: se muestra la etapa actual y el tiempo transcurrido."}
      </p>
      {job.error_message && <div className="notice bad"><b>{job.error_code}</b>: {job.error_message}{r.failure?.detail && <pre className="log" style={{ whiteSpace: "pre-wrap" }}>{r.failure.detail}</pre>}</div>}
      {(r.warnings ?? []).map((w: string) => <div key={w} className="notice">{w}</div>)}
      <ul className="timeline">
        {job.stages.map((s, i) => (
          <li key={`${s.name}-${i}`} className={s.status}>
            <span className="ic" /><span>{s.label}{s.status === "reused" && <small> · reutilizada (verificada)</small>}{s.error && <><br /><small className="error">{s.error}</small></>}</span>
            <small>{s.seconds != null ? fmt.secs(s.seconds) : s.status === "running" ? "…" : ""}{s.max_rss_mb ? ` · ${Math.round(s.max_rss_mb)} MB` : ""}</small>
          </li>
        ))}
      </ul>
      {job.status === "ready" && r.photos && <Report r={r} />}
      <h3 style={{ marginTop: 14 }}>Registro</h3>
      <div className="log">{events.map((e) => <div key={e.id} className={e.level}>{new Date(e.at).toLocaleTimeString("es-CL")} {e.message}</div>)}</div>
    </div>
  );
}

export function Report({ r }: { r: any }) {
  const total = r.stages?.reduce((a: number, s: any) => a + (s.seconds ?? 0), 0);
  return (
    <div style={{ marginTop: 12 }}>
      <h3>Informe de calidad</h3>
      <div className="kpis">
        <div className="kpi"><b>{r.photos.registered_presented}/{r.photos.job_input}</b><span>fotos registradas</span></div>
        <div className="kpi"><b>{r.components.length}</b><span>componente(s)</span></div>
        <div className="kpi"><b>{r.reprojection_error_px?.toFixed(2)} px</b><span>error de reproyección</span></div>
        <div className="kpi"><b>{(r.web_model.triangles / 1000).toFixed(0)} k</b><span>triángulos web</span></div>
        <div className="kpi"><b>{fmt.bytes(r.web_model.bytes)}</b><span>GLB web</span></div>
        <div className="kpi"><b>{fmt.secs(total)}</b><span>tiempo total</span></div>
        <div className="kpi"><b>{r.unobserved_area_fraction != null ? (r.unobserved_area_fraction * 100).toFixed(1) + " %" : "—"}</b><span>área sin imagen asignada</span></div>
        <div className="kpi"><b>{r.texture_check?.status === "concluyente" ? "OK" : "—"}</b><span>textura vs. fotos</span></div>
      </div>
      <p className="muted" style={{ fontSize: ".8rem" }}>
        El error de reproyección y la tasa de registro no equivalen a exactitud dimensional. {r.coverage} Hardware: {r.hardware?.cpu} ({r.hardware?.cpu_count} núcleos, {r.hardware?.ram_gb} GB, GPU {r.hardware?.gpu}).
        Motor: COLMAP {r.engine?.colmap?.version}, {r.engine?.openmvs?.version}. Resolución de trabajo: {r.working_resolution_max_side} px.
      </p>
      {r.photos.unregistered?.length > 0 && <div className="notice">Fotos no registradas: {r.photos.unregistered.join(", ")}</div>}
      {r.intrinsics_assumptions?.map((a: string) => <div key={a} className="notice info">{a}</div>)}
    </div>
  );
}

function StartJob({ sectorId, onClose, onDone }: { sectorId: string; onClose: () => void; onDone: (j: Job) => void }) {
  const [profile, setProfile] = useState<keyof typeof PROFILES>("estandar");
  const [note, setNote] = useState("");
  const diag = useLoad(() => api<any>(`/api/sectors/${sectorId}/diagnostics`), [sectorId]);
  const [focal, setFocal] = useState<Record<string, string>>({});
  // Clave de idempotencia fija para este formulario: un doble clic no crea dos trabajos.
  const [key] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const overrides = Object.fromEntries(Object.entries(focal).filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, Number(v)]));
      onDone(await api<Job>(`/api/sectors/${sectorId}/jobs`, { body: { idempotency_key: key, profile, focal_overrides: overrides, note: note || null } }));
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const d = diag.data;
  return (
    <Modal title="Nueva reconstrucción" onClose={onClose}>
      {d && <p>Se usarán <b>{d.included}</b> fotos incluidas{d.excluded ? ` (${d.excluded} excluidas)` : ""}.</p>}
      {d?.advice?.map((a: string) => <div key={a} className="notice">{a}</div>)}
      {(Object.keys(PROFILES) as (keyof typeof PROFILES)[]).map((p) => (
        <label key={p} style={{ display: "flex", gap: 8, alignItems: "flex-start", color: "var(--text)" }}>
          <input type="radio" style={{ width: "auto", minHeight: 0, marginTop: 3 }} checked={profile === p} onChange={() => setProfile(p)} /> {PROFILES[p]}
        </label>
      ))}
      {d && Object.keys(d.camera_groups).length > 0 && (
        <details style={{ margin: "8px 0" }}>
          <summary className="muted">Corrección de focal por grupo de cámara (avanzado)</summary>
          {Object.entries(d.camera_groups).map(([g, info]: [string, any]) => (
            <label key={g}>{[info.make, info.model].filter(Boolean).join(" ") || g.slice(0, 8)} · {info.resolution} — focal en px (estimada: {info.focal_prior_px ? Math.round(info.focal_prior_px) : "desconocida"})
              <input type="number" min={1} value={focal[g] ?? ""} onChange={(e) => setFocal({ ...focal, [g]: e.target.value })} placeholder="dejar vacío para usar la estimación" />
            </label>
          ))}
        </details>
      )}
      <label>Nota<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <div className="row"><span className="spacer" /><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy} onClick={submit}>Iniciar</button></div>
    </Modal>
  );
}
