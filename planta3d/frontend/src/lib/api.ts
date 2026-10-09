// Cliente de la API. El token vive en localStorage (solo en este navegador).

export type Role = "owner" | "editor" | "viewer";
export interface User { id: string; email: string; display_name: string; is_admin: boolean }
export interface Project { id: string; name: string; site: string | null; description: string | null; created_at: string; my_role: Role | null; sector_count: number }
export interface Layout { x?: number; y?: number; rotation?: number; width?: number; depth?: number; color?: string; level?: number }
export interface Sector { id: string; project_id: string; name: string; area_type: string | null; description: string | null; layout: Layout; created_at: string; photo_count: number; latest_model_id: string | null; latest_job_status: string | null }
export interface Batch { id: string; sector_id: string; label: string | null; status: string; created_at: string; completed_at: string | null }
export interface Photo {
  id: string; batch_id: string; original_filename: string; status: "accepted" | "rejected" | "duplicate";
  reject_reason: string | null; sha256: string | null; size_bytes: number | null; width: number | null; height: number | null;
  camera: Record<string, unknown>; camera_group: string | null; quality: { sharpness?: number; mean_luma?: number; dark_fraction?: number; bright_fraction?: number };
  flags: string[]; included: boolean; inclusion_log: { at: string; included: boolean; reason: string }[]; uploaded_at: string;
}
export interface StageRow { name: string; label: string; status: string; started_at?: string; finished_at?: string; seconds?: number; max_rss_mb?: number | null; error?: string; commands?: { args: string[]; exit_code: number; seconds: number }[] }
export type JobStatus = "queued" | "validating" | "reconstructing" | "converting" | "ready" | "failed" | "cancelling" | "cancelled";
export interface Job {
  id: string; sector_id: string; status: JobStatus; stage: string | null; stage_started_at: string | null; profile: string;
  error_code: string | null; error_message: string | null; attempts: number; created_at: string; started_at: string | null;
  finished_at: string | null; stages: StageRow[]; report: Record<string, any>; model_version_id: string | null; photo_count: number;
}
export interface JobEvent { id: number; at: string; level: string; message: string; data: Record<string, unknown> }
export interface Artifact { id: string; kind: string; size_bytes: number; sha256: string; meta: Record<string, unknown> }
export type ScaleState = "uncalibrated" | "calibrated_unverified" | "verified";
export interface ModelVersion {
  id: string; sector_id: string; number: number; label: string | null; source: "imported" | "reconstructed" | "demo"; job_id: string | null;
  coordinate_system: string; alignment: number[]; alignment_source: string | null; scale_state: ScaleState; scale_factor: number | null;
  scale_method: string | null; tolerance_abs_m: number | null; tolerance_rel: number | null; tolerance_purpose: string | null;
  stats: { triangles?: number; bytes?: number; bbox_min?: number[]; bbox_max?: number[]; registered_photos?: number; components?: number };
  notes: string | null; created_at: string; artifacts: Artifact[];
}
export interface Segment {
  id: string; label: string; point_a: number[]; point_b: number[]; real_distance: number; unit: string; real_distance_m: number;
  source: string; endpoints_description: string | null; model_distance: number | null; scaled_distance_m: number | null;
  abs_error_m: number | null; rel_error: number | null; within_tolerance: boolean | null;
}
export interface Calibration {
  scale_state: ScaleState; scale_factor: number | null; method: string | null; references: Segment[]; checks: Segment[];
  n_checks: number; min_checks_required: number; tolerance_abs_m: number | null; tolerance_rel: number | null; tolerance_purpose: string | null;
  max_abs_error_m: number | null; max_rel_error: number | null; rms_error_m: number | null; notice: string;
}
export interface Annotation { id: string; model_version_id: string; asset_id: string | null; kind: string; title: string; body: string | null; position: number[]; normal: number[] | null; extra: Record<string, any>; created_at: string; updated_at: string }
export interface Asset { id: string; sector_id: string; tag: string | null; name: string; asset_type: string | null; description: string | null; notes: string | null; op_status: string | null; op_status_source: string | null; op_status_at: string | null; created_at: string; updated_at: string }
export interface DocumentLink { id: string; sector_id: string; asset_id: string | null; annotation_id: string | null; kind: "link" | "file" | "photo"; title: string; url: string | null; mime: string | null; size_bytes: number | null; source_photo_id: string | null; created_at: string }
export interface CameraPose { photo_id: string | null; image: string; filename: string; center: number[]; world_from_cam_rotation: number[][]; camera_model: string; params: number[]; width: number; height: number }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const TOKEN_KEY = "planta3d.token";
export const auth = {
  get token(): string | null { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set token(v: string | null) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* sin almacenamiento */ } },
};

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

function detail(body: any, status: number): string {
  if (!body) return `Error ${status}`;
  if (typeof body.detail === "string") return body.detail;
  if (Array.isArray(body.detail)) return body.detail.map((d: any) => `${(d.loc || []).slice(1).join(".")}: ${d.msg}`).join("; ");
  return `Error ${status}`;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.body); }
  const r = await fetch(path, { method: opts.method || (body ? "POST" : "GET"), headers, body, signal: opts.signal });
  if (r.status === 401) { auth.token = null; onUnauthorized(); }
  if (r.status === 204) return undefined as T;
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new ApiError(r.status, detail(data, r.status));
  return data as T;
}

/** Subida de un archivo con progreso y cancelación (XHR). */
export function uploadFile(path: string, file: Blob, filename: string, onProgress: (f: number) => void, signal: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    if (auth.token) xhr.setRequestHeader("Authorization", `Bearer ${auth.token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: any = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* vacío */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, detail(data, xhr.status)));
    };
    xhr.onerror = () => reject(new ApiError(0, "Error de red"));
    xhr.onabort = () => reject(new ApiError(-1, "Cancelada"));
    signal.addEventListener("abort", () => xhr.abort());
    const fd = new FormData();
    fd.append("file", file, filename);
    xhr.send(fd);
  });
}

export const fmt = {
  bytes(n?: number | null) {
    if (n == null) return "—";
    const u = ["B", "KB", "MB", "GB"]; let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  },
  date(s?: string | null) { return s ? new Date(s).toLocaleString("es-CL", { dateStyle: "medium", timeStyle: "short" }) : "—"; },
  secs(s?: number | null) {
    if (s == null) return "—";
    if (s < 60) return `${s.toFixed(1)} s`;
    const m = Math.floor(s / 60); return `${m} min ${Math.round(s % 60)} s`;
  },
  len(m: number) { return Math.abs(m) < 1 ? `${(m * 100).toFixed(1)} cm` : `${m.toFixed(3)} m`; },
};

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: "En cola", validating: "Validando", reconstructing: "Reconstruyendo", converting: "Convirtiendo",
  ready: "Listo", failed: "Fallido", cancelling: "Cancelando", cancelled: "Cancelado",
};
export const SCALE_LABEL: Record<ScaleState, string> = {
  uncalibrated: "Sin calibrar", calibrated_unverified: "Calibrado sin verificar", verified: "Verificado",
};
export const SOURCE_LABEL = { imported: "Importado", reconstructed: "Reconstruido", demo: "Demostración" } as const;
export const FLAG_LABEL: Record<string, string> = {
  posible_desenfoque: "Posible desenfoque", nitidez_baja_relativa: "Nitidez baja vs. lote",
  posible_subexposicion: "Posible subexposición", posible_sobreexposicion: "Posible sobreexposición",
};
