import { type ReactNode, useEffect } from "react";
import type { JobStatus, ScaleState } from "../lib/api";
import { JOB_STATUS_LABEL, SCALE_LABEL, SOURCE_LABEL } from "../lib/api";

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={wide ? { maxWidth: 860 } : undefined} role="dialog" aria-label={title}>
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function JobBadge({ status }: { status: JobStatus | string | null }) {
  if (!status) return <span className="badge mute">Sin trabajos</span>;
  const cls = status === "ready" ? "ok" : status === "failed" ? "bad" : status === "cancelled" || status === "cancelling" ? "warn" : "info";
  return <span className={`badge ${cls}`}>{JOB_STATUS_LABEL[status as JobStatus] ?? status}</span>;
}

export function ScaleBadge({ state }: { state: ScaleState }) {
  const cls = state === "verified" ? "ok" : state === "calibrated_unverified" ? "warn" : "mute";
  return <span className={`badge ${cls}`} title="Estado de escala">{SCALE_LABEL[state]}</span>;
}

export function SourceBadge({ source }: { source: keyof typeof SOURCE_LABEL }) {
  return <span className={`badge ${source === "reconstructed" ? "info" : source === "demo" ? "warn" : "mute"}`}>{SOURCE_LABEL[source]}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="card" style={{ textAlign: "center", color: "var(--muted)", padding: 30 }}>{children}</div>;
}

export function Loading() {
  return <p className="muted">Cargando…</p>;
}
